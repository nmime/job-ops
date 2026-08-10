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

const PLATFORM = "braintrust" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_BRAINTRUST";
const API_BASE = "https://app.usebraintrust.com";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Braintrust — REAL credential-free adapter.
 *
 * Discovery uses the public jobs API (no key required, verified live):
 *   GET https://app.usebraintrust.com/api/jobs/?page_size=100&page=N
 * Results are filtered client-side against ctx.searchTerms on
 * title + role + skills.
 *
 * Applying is only possible from an authenticated Braintrust session, so the
 * submit path is gated on JOBOPS_FREELANCE_BRAINTRUST_COOKIE (or _API_KEY) and
 * on the orchestrator's dry-run gate.
 */

type BraintrustEmployer =
  | string
  | { id?: number; name?: string | null }
  | null
  | undefined;

type BraintrustSkill = { name?: string | null } | string;

type BraintrustJob = {
  id: number;
  title?: string | null;
  employer?: BraintrustEmployer;
  budget_minimum_usd?: string | number | null;
  budget_maximum_usd?: string | number | null;
  payment_type?: string | null;
  main_skills?: BraintrustSkill[] | null;
  created?: string | null;
  contract_type?: string | null;
  deadline?: string | null;
  expected_hours_per_week?: number | null;
  role?: { name?: string | null } | string | null;
  locations?: Array<{ name?: string | null } | string> | null;
  job_type?: string | null;
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

function employerName(employer: BraintrustEmployer): string {
  if (!employer) return "Braintrust employer";
  if (typeof employer === "string") return employer;
  return employer.name ?? "Braintrust employer";
}

function skillNames(skills: BraintrustSkill[] | null | undefined): string[] {
  return (skills ?? [])
    .map((skill) => (typeof skill === "string" ? skill : skill?.name))
    .filter((name): name is string => Boolean(name));
}

function toNumber(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function matchesTerms(job: BraintrustJob, terms: string[]): boolean {
  if (!terms.length) return true;
  const roleName =
    typeof job.role === "string" ? job.role : (job.role?.name ?? "");
  const haystack = [job.title ?? "", roleName, ...skillNames(job.main_skills)]
    .join(" ")
    .toLowerCase();
  return terms.some((term) => haystack.includes(term.trim().toLowerCase()));
}

function locationLabel(
  locations: BraintrustJob["locations"],
): string | undefined {
  const names = (locations ?? [])
    .map((loc) => (typeof loc === "string" ? loc : loc?.name))
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join(", ") : undefined;
}

function toGig(job: BraintrustJob): CreateGigInput {
  const budgetMin = toNumber(job.budget_minimum_usd);
  const budgetMax = toNumber(job.budget_maximum_usd);
  const interval = job.payment_type === "hourly" ? "hourly" : "fixed";
  return {
    platform: PLATFORM,
    sourceGigId: String(job.id),
    title: job.title ?? "Untitled Braintrust job",
    clientOrEmployer: employerName(job.employer),
    gigUrl: `${API_BASE}/jobs/${job.id}/`,
    applicationLink: `${API_BASE}/jobs/${job.id}/`,
    budget:
      budgetMin != null
        ? `${budgetMin}-${budgetMax ?? ""} USD/${interval === "hourly" ? "hr" : "fixed"}`
        : undefined,
    budgetMin,
    budgetMax,
    budgetCurrency: budgetMin != null || budgetMax != null ? "USD" : undefined,
    budgetInterval: interval,
    datePosted: job.created ?? undefined,
    deadline: job.deadline ?? undefined,
    gigDescription: [
      typeof job.role === "string" ? job.role : job.role?.name,
      job.contract_type ? `Contract: ${job.contract_type}` : undefined,
      job.expected_hours_per_week
        ? `${job.expected_hours_per_week} hrs/week`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    skillsRequired: skillNames(job.main_skills),
    jobType: job.job_type ?? job.contract_type ?? undefined,
    isRemote: true,
    location: locationLabel(job.locations),
    duration:
      job.expected_hours_per_week != null
        ? `${job.expected_hours_per_week} hrs/week`
        : undefined,
    verifiedClient: Boolean(job.employer),
  };
}

async function fetchJobsPage(
  page: number,
  cookie?: string,
): Promise<{ results: BraintrustJob[]; hasNext: boolean }> {
  const url = `${API_BASE}/api/jobs/?page_size=100&page=${page}`;
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "application/json",
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetchWithTimeout(url, 15_000, { headers });
  if (!res.ok) {
    throw new Error(`Braintrust jobs API HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    next?: string | null;
    results?: BraintrustJob[];
  };
  return {
    results: json.results ?? [],
    hasNext: Boolean(json.next),
  };
}

export async function findBraintrustGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    const { cookie } = resolveCredential(ctx.settings);
    reportProgress(ctx, `${PLATFORM}: fetching public jobs feed`);

    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 5);

    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= 2; page++) {
      try {
        const { results, hasNext } = await fetchJobsPage(page, cookie);
        for (const job of results) {
          const id = String(job.id);
          if (seen.has(id)) continue;
          seen.add(id);
          if (!matchesTerms(job, terms)) continue;
          gigs.push(toGig(job));
        }
        if (!hasNext) break;
      } catch (error) {
        reportProgress(
          ctx,
          `${PLATFORM}: page ${page} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }
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
 * Braintrust apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_BRAINTRUST_APPLY_ENABLED=true. Braintrust has no public
 * apply endpoint — a real submit needs an authenticated session
 * (JOBOPS_FREELANCE_BRAINTRUST_COOKIE) and drives the job page with a browser.
 */
export async function applyToBraintrustGig(
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
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (authenticated session) — cannot apply`,
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
    error: `${PLATFORM}: real submit requires the authenticated web flow (Braintrust exposes no public apply API); browser automation for the apply form is not wired up yet — apply manually at ${API_BASE}/jobs/${ctx.gigId}/`,
  };
}
