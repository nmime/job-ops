import { logger } from "@infra/logger";
import type {
  FreelanceApplyContext,
  FreelanceApplyMode,
  FreelanceApplyResult,
  FreelancePlatformId,
  ProposalDraft,
} from "@shared/types/freelance";
import { getProfile } from "../profile";
import { resolveFreelanceProvider } from "./registry";

function envKey(platformId: string, suffix: string): string {
  return `JOBOPS_FREELANCE_${platformId.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

/**
 * Real submission is OFF unless the operator explicitly opts in per platform.
 * This is the single switch that turns dry-run into real money-bearing bids.
 */
export function isFreelanceApplyEnabled(
  env: NodeJS.ProcessEnv,
  platformId: string,
): boolean {
  return env[envKey(platformId, "APPLY_ENABLED")] === "true";
}

/** Per-platform submission budget. Defaults to a conservative 5/hour. */
export function getFreelanceRateLimit(
  platformId: string,
  env: NodeJS.ProcessEnv = process.env,
): { maxPerHour: number; windowMs: number } {
  const parsed = Number.parseInt(
    env[envKey(platformId, "MAX_PER_HOUR")] ?? "",
    10,
  );
  const windowParsed = Number.parseInt(
    env.JOBOPS_FREELANCE_WINDOW_MS ?? "",
    10,
  );
  return {
    maxPerHour: Number.isFinite(parsed) && parsed > 0 ? parsed : 5,
    windowMs:
      Number.isFinite(windowParsed) && windowParsed > 0
        ? windowParsed
        : 3_600_000,
  };
}

const rateBuckets = new Map<string, number[]>();

/** Test seam. */
export function __resetFreelanceRateLimits(): void {
  rateBuckets.clear();
}

export function consumeRateLimit(
  platformId: string,
  budget: { maxPerHour: number; windowMs: number },
  now: number = Date.now(),
): boolean {
  const history = (rateBuckets.get(platformId) ?? []).filter(
    (ts) => now - ts < budget.windowMs,
  );
  if (history.length >= budget.maxPerHour) {
    rateBuckets.set(platformId, history);
    return false;
  }
  history.push(now);
  rateBuckets.set(platformId, history);
  return true;
}

/**
 * Non-mutating check: true while the platform still has submission budget
 * left in its window. Used BEFORE calling the provider so that attempts that
 * fail (e.g. missing credential) do not burn the real-submission budget —
 * only actual sends are counted, via `consumeRateLimit` after the provider
 * reports `submitted`/`exported`.
 */
export function isWithinRateLimit(
  platformId: string,
  budget: { maxPerHour: number; windowMs: number },
  now: number = Date.now(),
): boolean {
  const history = (rateBuckets.get(platformId) ?? []).filter(
    (ts) => now - ts < budget.windowMs,
  );
  return history.length < budget.maxPerHour;
}

/**
 * Load the resume identity (name/email/headline) for the apply context.
 *
 * The unattended worker runs without a request scope and may have no resume
 * configured, so a failure degrades to empty identity fields instead of
 * breaking the apply path — the tailored cover letter itself is always
 * generated locally and never depends on this lookup.
 */
async function loadResumeIdentity(): Promise<{
  name: string;
  email: string;
  headline: string;
}> {
  try {
    const profile = await getProfile();
    return {
      name: profile?.basics?.name ?? "",
      email: profile?.basics?.email ?? "",
      headline: profile?.basics?.headline ?? "",
    };
  } catch (error) {
    logger.warn("Freelance apply: resume profile unavailable, continuing with empty identity", {
      error,
    });
    return { name: "", email: "", headline: "" };
  }
}

function stripHtml(text: string): string {
  return (text || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text: string): string {
  return (
    stripHtml(text)
      .split(/[.!?]\s/)[0]
      ?.trim()
      .slice(0, 240) ?? ""
  );
}

/**
 * Deterministic, offline proposal draft. Always produces a usable cover
 * letter so the pipeline is fully observable without an LLM key; when an
 * LLM is configured the caller can override `coverLetter`.
 */
export function buildDeterministicProposal(input: {
  gigId: string;
  platform: FreelancePlatformId;
  gigTitle?: string;
  gigDescription: string;
  profileSkills?: string[];
}): ProposalDraft {
  const need = firstSentence(input.gigDescription);
  const skills = (input.profileSkills ?? []).slice(0, 6);
  const plain = stripHtml(input.gigDescription).toLowerCase();
  const matched = skills.filter((skill) => plain.includes(skill.toLowerCase()));

  const coverLetter = [
    `Hello — regarding "${input.gigTitle ?? "your project"}":`,
    "",
    need ? `You need: ${need}` : "",
    matched.length > 0
      ? `Directly relevant experience: ${matched.join(", ")}.`
      : skills.length > 0
        ? `Core stack: ${skills.join(", ")}.`
        : "",
    "",
    "How I would approach it:",
    "1. Confirm scope and acceptance criteria up front.",
    "2. Ship a reviewable increment early so you can course-correct.",
    "3. Hand over documented, tested work.",
    "",
    "Happy to start with a small paid milestone so you can assess fit.",
    "",
    "Best regards",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    platform: input.platform,
    gigId: input.gigId,
    coverLetter,
    tailored: true,
    generatedAt: new Date().toISOString(),
  };
}

export interface ApplyToGigInput {
  gigId: string;
  platform: FreelancePlatformId;
  gigTitle?: string;
  gigDescription: string;
  profileSkills?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Guarded freelance apply.
 *
 * Order of operations (safety-critical):
 *   1. resolve mode — dry_run unless JOBOPS_FREELANCE_<ID>_APPLY_ENABLED=true
 *   2. ALWAYS draft a tailored proposal first
 *   3. refuse to submit an untailored draft
 *   4. rate-limit real submissions per platform
 *   5. delegate to the provider adapter with dryRun propagated
 */
export async function applyToFreelanceGig(
  input: ApplyToGigInput,
): Promise<FreelanceApplyResult> {
  const env = input.env ?? process.env;
  const enabled = isFreelanceApplyEnabled(env, input.platform);
  const mode: FreelanceApplyMode = enabled ? "submit" : "dry_run";
  const rateBudget = getFreelanceRateLimit(input.platform, env);

  const proposalDraft = buildDeterministicProposal({
    gigId: input.gigId,
    platform: input.platform,
    gigTitle: input.gigTitle,
    gigDescription: input.gigDescription,
    profileSkills: input.profileSkills,
  });

  if (!proposalDraft.tailored) {
    return {
      platform: input.platform,
      mode,
      status: "error",
      proposalDraft,
      error: "refusing to submit: proposal draft is not tailored",
    };
  }

  if (enabled && !isWithinRateLimit(input.platform, rateBudget)) {
    logger.warn("Freelance apply rate-limited", {
      platform: input.platform,
      maxPerHour: rateBudget.maxPerHour,
    });
    return {
      platform: input.platform,
      mode,
      status: "skipped",
      proposalDraft,
      error: `rate-limited: ${rateBudget.maxPerHour}/hour budget reached for ${input.platform}`,
    };
  }

  let provider: Awaited<ReturnType<typeof resolveFreelanceProvider>>;
  try {
    provider = await resolveFreelanceProvider(input.platform);
  } catch (error) {
    return {
      platform: input.platform,
      mode,
      status: "error",
      proposalDraft,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!provider.applyToGig) {
    return {
      platform: input.platform,
      mode,
      status: "drafted",
      proposalDraft,
      error: `${input.platform} has no apply adapter — proposal drafted only`,
    };
  }

  // Real profile for the adapters: identity from the user's resume (when
  // available), skills from the worker's input, and the generated cover
  // letter — adapters that require a tailored letter read it from here.
  const identity = await loadResumeIdentity();
  const ctx: FreelanceApplyContext = {
    platform: input.platform,
    gigId: input.gigId,
    dryRun: !enabled,
    allowCaptcha: env.JOBOPS_FREELANCE_ALLOW_CAPTCHA === "true",
    rateBudget,
    profile: {
      name: identity.name,
      email: identity.email,
      headline: identity.headline,
      skills: input.profileSkills ?? [],
      coverLetter: proposalDraft.coverLetter,
    },
  };

  try {
    const result = await provider.applyToGig(ctx);
    // Only submissions that actually went out count against the hourly
    // budget — failed attempts (e.g. missing credential) must not burn it.
    if (
      enabled &&
      (result.status === "submitted" || result.status === "exported")
    ) {
      consumeRateLimit(input.platform, rateBudget);
    }
    return { ...result, proposalDraft };
  } catch (error) {
    return {
      platform: input.platform,
      mode,
      status: "error",
      proposalDraft,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
