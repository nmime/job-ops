import {
  fetchWithTimeout,
  reportProgress,
  stubNotFound,
} from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "turing" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_TURING";
const BOARD_API = "https://boards-api.greenhouse.io/v1/boards/turing/jobs";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Turing — REAL credential-free adapter.
 *
 * Discovery uses Turing's public Greenhouse board (no key required, verified
 * live): GET https://boards-api.greenhouse.io/v1/boards/turing/jobs?content=true
 * HTML job content is stripped to plain text and filtered client-side against
 * ctx.searchTerms on title + description.
 *
 * Applying happens on the hosted Greenhouse board with a candidate account, so
 * the submit path is gated on credentials plus the orchestrator dry-run gate.
 */

type TuringJob = {
  id: number;
  title?: string | null;
  absolute_url?: string | null;
  location?: { name?: string | null } | null;
  updated_at?: string | null;
  first_published?: string | null;
  content?: string | null;
  departments?: Array<{ name?: string | null }> | null;
  company_name?: string | null;
};

function resolveCredential(settings: Record<string, string | undefined>): {
  apiKey?: string;
  cookie?: string;
} {
  return {
    apiKey:
      settings[`${ENV_PREFIX}_API_KEY`] ?? process.env[`${ENV_PREFIX}_API_KEY`],
    cookie:
      settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`],
  };
}

/** Decode HTML entities (twice — Greenhouse content is double-escaped) and strip tags. */
function htmlToText(html: string): string {
  const decode = (value: string) =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  const once = decode(html);
  const twice = decode(once);
  return twice
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesTerms(job: TuringJob, terms: string[], text: string): boolean {
  if (!terms.length) return true;
  const haystack = `${job.title ?? ""} ${text}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.trim().toLowerCase()));
}

function toGig(job: TuringJob, description: string): CreateGigInput {
  const url =
    job.absolute_url ??
    `https://job-boards.greenhouse.io/turing/jobs/${job.id}`;
  return {
    platform: PLATFORM,
    sourceGigId: String(job.id),
    title: job.title ?? "Untitled Turing role",
    clientOrEmployer: job.company_name ?? "Turing",
    gigUrl: url,
    applicationLink: `${url}#app`,
    datePosted: job.first_published ?? job.updated_at ?? undefined,
    gigDescription: description.slice(0, 4000) || undefined,
    skillsRequired: (job.departments ?? [])
      .map((dept) => dept.name)
      .filter((name): name is string => Boolean(name)),
    jobType: "contract",
    isRemote: job.location?.name ? /remote/i.test(job.location.name) : true,
    location: job.location?.name ?? "Remote",
  };
}

export async function findTuringGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching Greenhouse board`);
    const res = await fetchWithTimeout(`${BOARD_API}?content=true`, 15_000, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Turing Greenhouse board HTTP ${res.status}`);
    }
    const json = (await res.json()) as { jobs?: TuringJob[] };

    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 5);

    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    for (const job of json.jobs ?? []) {
      const id = String(job.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const description = htmlToText(job.content ?? "");
      if (!matchesTerms(job, terms, description)) continue;
      gigs.push(toGig(job, description));
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs: gigs.slice(0, 250) };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/**
 * Turing apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_TURING_APPLY_ENABLED=true. Turing applications go through
 * the hosted Greenhouse form, which requires a candidate account — the submit
 * path is credential-gated.
 */
export async function applyToTuringGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and configure ${ENV_PREFIX}_API_KEY to submit for real)`,
    };
  }

  const { apiKey, cookie } = resolveCredential(
    process.env as Record<string, string | undefined>,
  );
  if (!apiKey && !cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_API_KEY or ${ENV_PREFIX}_COOKIE (candidate session) — cannot apply`,
    };
  }

  const profile = (ctx.profile ?? {}) as { coverLetter?: string };
  const coverLetter = profile.coverLetter?.trim();
  if (!coverLetter) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored application`,
    };
  }

  return {
    platform: PLATFORM,
    mode: "submit",
    status: "error",
    error: `${PLATFORM}: real submit requires the hosted Greenhouse application form (resume upload + candidate account); browser automation for it is not wired up yet — apply manually at https://job-boards.greenhouse.io/turing/jobs/${ctx.gigId}`,
  };
}
