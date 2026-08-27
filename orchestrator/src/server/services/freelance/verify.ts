/**
 * Freelance adapter verification harness (shared by the CLI script
 * `scripts/freelance-verify.ts` and POST /api/freelance/verify/:platform).
 *
 * For one platform it checks:
 *   1. credentials — which env vars / credential files are configured
 *   2. discovery   — calls the provider's findGigs (timeout-guarded, errors
 *                    reported as error class, never crash the run)
 *   3. apply       — dry-run (ctx.dryRun=true) of the manifest's applyToGig
 *   4. live        — REAL submission, only when the caller opts in with
 *                    `live: true` and discovery found at least one gig
 *
 * Verdict rules:
 *   not-applicable — the platform structurally has no per-gig apply
 *                    (audit `apply` = "not-applicable"/"missing": boards,
 *                    vetted networks, batch-export webhooks)
 *   verified       — discovery ok AND dry-run apply returned skipped/drafted
 *   blocked        — missing credentials or discovery/apply errors
 */
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelancePlatformId,
  FreelanceProviderManifest,
} from "@shared/types/freelance";
import {
  buildDeterministicProposal,
  getFreelanceRateLimit,
} from "./apply-adapter";
import {
  credentialStatus,
  FREELANCE_CREDENTIAL_TABLE,
  type FreelanceApplyKind,
} from "./credentials";
import { resolveFreelanceProvider } from "./registry";

export type AdapterVerdict = "verified" | "blocked" | "not-applicable";

export interface VerifyApplyStep {
  status: FreelanceApplyResult["status"] | "error";
  error?: string;
}

export interface VerifyReport {
  platform: FreelancePlatformId;
  credential: {
    required: string[];
    present: string[];
    missing: string[];
    format: string;
    configured: boolean;
  };
  discovery: {
    ok: boolean;
    count: number;
    sample?: string;
    error?: string;
  };
  apply: {
    supported: boolean;
    kind: FreelanceApplyKind;
    dryRun: VerifyApplyStep | null;
    live: VerifyApplyStep | null;
  };
  verdict: AdapterVerdict;
  blockers: string[];
}

export interface VerifyAdapterOptions {
  /** Opt-in: attempt a REAL submission against the first discovered gig. */
  live?: boolean;
  /** Discovery timeout. Default 60s (CLI) / 90s (API). */
  discoveryTimeoutMs?: number;
  /** Apply (dry-run and live) timeout. Default 90s. */
  applyTimeoutMs?: number;
  /** Search terms passed to the finder (default: no filter). */
  searchTerms?: string[];
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
const DEFAULT_APPLY_TIMEOUT_MS = 90_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      ? `${error.name}: ${error.message}`
      : error.name || "Error";
  }
  return String(error);
}

function buildVerifyApplyContext(
  platform: FreelancePlatformId,
  gigId: string,
  dryRun: boolean,
): FreelanceApplyContext {
  // Real (deterministic) cover letter so adapters that require a tailored
  // letter get one even when no resume is configured.
  const draft = buildDeterministicProposal({
    gigId,
    platform,
    gigTitle: "Adapter verification",
    gigDescription:
      "Freelance adapter verification harness — synthetic gig used for " +
      "dry-run capability checks only.",
  });
  return {
    platform,
    gigId,
    dryRun,
    allowCaptcha: process.env.JOBOPS_FREELANCE_ALLOW_CAPTCHA === "true",
    rateBudget: getFreelanceRateLimit(platform),
    profile: {
      name: "",
      email: "",
      headline: "",
      skills: [],
      coverLetter: draft.coverLetter,
    },
  };
}

/**
 * Run the full verification for one platform. Never throws for adapter
 * failures — everything is captured in the report.
 */
export async function verifyFreelanceAdapter(
  platform: FreelancePlatformId,
  options: VerifyAdapterOptions = {},
): Promise<VerifyReport> {
  const discoveryTimeoutMs =
    options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const applyTimeoutMs = options.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  const entry = FREELANCE_CREDENTIAL_TABLE[platform];
  const structurallyNa =
    entry !== undefined &&
    (entry.apply === "not-applicable" || entry.apply === "missing");

  const credential = credentialStatus(platform);
  const blockers: string[] = [];
  if (credential.format !== "none" && credential.present.length === 0) {
    blockers.push(`missing credentials: ${credential.missing.join(", ")}`);
  }

  let manifest: FreelanceProviderManifest | null = null;
  let discovery: VerifyReport["discovery"] = { ok: false, count: 0 };
  let firstGig: CreateGigInput | null = null;

  try {
    manifest = await resolveFreelanceProvider(platform);
  } catch (error) {
    discovery.error = describeError(error);
    blockers.push(`provider failed to load: ${discovery.error}`);
  }

  if (manifest) {
    // Same context shape the aggregator uses; finders that read limits read
    // them from `settings` (the process env).
    const finderCtx: FreelanceFinderContext = {
      platform,
      searchTerms: options.searchTerms ?? [],
      selectedCountry: "",
      settings: process.env as Record<string, string | undefined>,
    };
    try {
      const result = await withTimeout(
        manifest.findGigs(finderCtx),
        discoveryTimeoutMs,
        `discovery(${platform})`,
      );
      firstGig = result.gigs[0] ?? null;
      discovery = {
        ok: result.success === true,
        count: result.gigs.length,
        sample: firstGig?.title,
        error: result.success
          ? undefined
          : (result.error ?? "finder reported failure"),
      };
      if (!result.success) {
        blockers.push(`discovery failed: ${discovery.error}`);
      }
    } catch (error) {
      discovery.error = describeError(error);
      blockers.push(`discovery failed: ${discovery.error}`);
    }
  }

  const applyFn = manifest ? manifest.applyToGig : undefined;
  const supported = typeof applyFn === "function";

  let dryRun: VerifyApplyStep | null = null;
  let live: VerifyApplyStep | null = null;

  if (applyFn) {
    // Synthetic gig id when discovery found nothing — dry-run adapters
    // short-circuit before touching the network with it.
    const dryRunGigId = firstGig?.sourceGigId ?? "verify";
    try {
      const result = await withTimeout(
        applyFn(buildVerifyApplyContext(platform, dryRunGigId, true)),
        applyTimeoutMs,
        `apply dry-run(${platform})`,
      );
      dryRun = { status: result.status, error: result.error };
      if (result.status === "error") {
        blockers.push(
          `apply dry-run returned error: ${result.error ?? "unknown"}`,
        );
      }
    } catch (error) {
      dryRun = { status: "error", error: describeError(error) };
      blockers.push(`apply dry-run threw: ${dryRun.error}`);
    }
  }

  // LIVE: real submission. Only when explicitly opted in AND discovery
  // actually found a gig to submit against.
  if (options.live === true && applyFn && firstGig) {
    const liveGigId = firstGig.sourceGigId ?? firstGig.title;
    try {
      const result = await withTimeout(
        applyFn(buildVerifyApplyContext(platform, liveGigId, false)),
        Math.max(applyTimeoutMs, 120_000),
        `live apply(${platform})`,
      );
      live = { status: result.status, error: result.error };
      if (result.status === "error") {
        blockers.push(
          `live apply returned error: ${result.error ?? "unknown"}`,
        );
      }
    } catch (error) {
      live = { status: "error", error: describeError(error) };
      blockers.push(`live apply threw: ${live.error}`);
    }
  }

  let verdict: AdapterVerdict;
  if (structurallyNa) {
    verdict = "not-applicable";
  } else {
    const credentialsOk =
      credential.format === "none" || credential.present.length > 0;
    const discoveryOk = discovery.ok === true;
    const dryRunOk =
      !supported ||
      (dryRun !== null &&
        (dryRun.status === "skipped" || dryRun.status === "drafted"));
    verdict = credentialsOk && discoveryOk && dryRunOk ? "verified" : "blocked";
  }

  return {
    platform,
    credential: {
      required: credential.envVars,
      present: credential.present,
      missing: credential.missing,
      format: credential.format,
      configured: credential.configured,
    },
    discovery,
    apply: {
      supported,
      kind: entry?.applyKind ?? "none",
      dryRun,
      live,
    },
    verdict,
    blockers,
  };
}
