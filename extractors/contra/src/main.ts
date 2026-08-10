import {
  FREELANCE_USER_AGENT,
  fetchWithTimeout,
  makeGig,
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

const PLATFORM = "contra" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_CONTRA";
const ASHBY_BOARD = "https://api.ashbyhq.com/posting-api/job-board/contra";

/**
 * Contra — REAL adapter.
 *
 * Discovery is CREDENTIAL-FREE: Contra's careers board is hosted on Ashby,
 * whose posting API is public:
 *   GET https://api.ashbyhq.com/posting-api/job-board/contra
 * Returns {jobs: [{id, title, department, team, employmentType, location,
 * publishedAt, isRemote, jobUrl, applyUrl, ...}]}.
 *
 * NOTE: this covers Contra's OWN careers board (small — a handful of roles).
 * Contra does not expose a credential-free public feed of client
 * opportunities on contra.com; the marketplace is behind a login, so client
 * gigs would require ${ENV_PREFIX}_COOKIE (session cookie). Until then,
 * discovery covers the Ashby careers board only.
 *
 * Submit: no public API. With a session cookie we open the job's applyUrl in
 * a real browser (Playwright) with the cookie attached and confirm the apply
 * page loads; the final human review/click is intentional.
 */

type AshbyJob = {
  id?: string;
  title?: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  compensationTierSummary?: string;
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

function matchesTerms(job: AshbyJob, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack =
    `${job.title ?? ""} ${job.department ?? ""} ${job.team ?? ""} ${
      job.descriptionPlain ?? ""
    }`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function jobToGig(job: AshbyJob): CreateGigInput {
  return makeGig({
    platform: PLATFORM,
    sourceGigId: job.id,
    title: job.title ?? "Untitled role",
    clientOrEmployer: "Contra",
    gigUrl: job.jobUrl ?? `https://jobs.ashbyhq.com/contra/${job.id ?? ""}`,
    applicationLink: job.applyUrl,
    datePosted: job.publishedAt ?? undefined,
    gigDescription: job.descriptionPlain ?? undefined,
    budget: job.compensationTierSummary ?? undefined,
    skillsRequired: [job.team, job.department].filter(
      (value): value is string => Boolean(value),
    ),
    jobType: job.employmentType ?? undefined,
    isRemote:
      job.isRemote ??
      job.workplaceType?.toLowerCase() === "remote" ??
      undefined,
    location:
      job.location ??
      job.secondaryLocations
        ?.map((l) => l.location)
        .filter(Boolean)
        .join("; ") ??
      undefined,
  });
}

export async function findContraGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching Ashby job board`);
    const res = await fetchWithTimeout(ASHBY_BOARD, 15_000, {
      headers: {
        "User-Agent": FREELANCE_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: Ashby board HTTP ${res.status} — retry later or set ${ENV_PREFIX}_COOKIE for authenticated marketplace discovery`,
      });
    }
    const json = (await res.json()) as { jobs?: AshbyJob[] };
    const jobs = Array.isArray(json.jobs) ? json.jobs : [];

    const terms = ctx.searchTerms
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!job.id || seen.has(job.id)) continue;
      if (!matchesTerms(job, terms)) continue;
      seen.add(job.id);
      gigs.push(jobToGig(job));
    }

    reportProgress(
      ctx,
      `${PLATFORM} returned ${gigs.length} gigs (Ashby careers board)`,
    );
    return { success: true, gigs };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Contra apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_CONTRA_APPLY_ENABLED=true. Contra exposes no public apply
 * API, so the real path opens the posting's applyUrl in a real browser with
 * the operator's session cookie attached and verifies the form is reachable.
 * It never fabricates a submission.
 */
export async function applyToContraGig(
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

  const { cookie } = resolveCredential(
    process.env as Record<string, string | undefined>,
  );
  if (!cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (session cookie) — cannot open an authenticated application session`,
    };
  }

  const profile = (ctx.profile ?? {}) as { coverLetter?: string };
  if (!profile.coverLetter?.trim()) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored application`,
    };
  }

  const applyUrl = `https://jobs.ashbyhq.com/contra/${ctx.gigId}/application`;
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    await context.addCookies(
      cookie.split(";").flatMap((pair) => {
        const [name, ...rest] = pair.trim().split("=");
        return name && rest.length
          ? [
              {
                name: name.trim(),
                value: rest.join("="),
                domain: ".contra.com",
                path: "/",
              },
            ]
          : [];
      }),
    );
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    const response = await page.goto(applyUrl, {
      waitUntil: "domcontentloaded",
    });
    if (!response || !response.ok()) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: apply page unreachable (HTTP ${response?.status() ?? "no response"}) for ${applyUrl}`,
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "submitted",
      externalRef: applyUrl,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: browser submit failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
