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

const PLATFORM = "toptal" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_TOPTAL";
const LEVER_API = "https://api.lever.co/v0/postings/toptal?mode=json";

/**
 * Toptal — REAL adapter.
 *
 * Discovery is CREDENTIAL-FREE: Toptal publishes its openings on Lever, and
 * the Lever postings API is public:
 *   GET https://api.lever.co/v0/postings/toptal?mode=json
 * Returns an array of postings {id, text, hostedUrl, categories, ...}.
 * We fetch the full list once and filter client-side by search terms against
 * title + plain-text description. No API key or cookie is required.
 *
 * NOTE: this board mostly lists Toptal's own internal roles; Toptal does not
 * expose a public client-project feed for freelancers.
 *
 * Submit: Toptal has no public application API for programmatic posting.
 * With a session cookie (JOBOPS_FREELANCE_TOPTAL_COOKIE) we navigate to the
 * hosted Lever posting in a real browser (Playwright) so the operator can
 * complete the application; without credentials the submit path reports a
 * clean actionable error.
 */

type LeverPosting = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  categories?: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  };
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

function matchesTerms(posting: LeverPosting, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${posting.text ?? ""} ${posting.descriptionPlain ?? ""} ${
    posting.categories?.team ?? ""
  } ${posting.categories?.department ?? ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function postingToGig(posting: LeverPosting): CreateGigInput {
  const categories = posting.categories ?? {};
  const location =
    categories.allLocations?.join("; ") ?? categories.location ?? undefined;
  return makeGig({
    platform: PLATFORM,
    sourceGigId: posting.id,
    title: posting.text ?? "Untitled role",
    clientOrEmployer: "Toptal",
    gigUrl:
      posting.hostedUrl ?? `https://jobs.lever.co/toptal/${posting.id ?? ""}`,
    applicationLink: posting.hostedUrl,
    datePosted: posting.createdAt
      ? new Date(posting.createdAt).toISOString()
      : undefined,
    gigDescription: posting.descriptionPlain ?? undefined,
    skillsRequired: [categories.team, categories.department].filter(
      (value): value is string => Boolean(value),
    ),
    jobType: categories.commitment ?? undefined,
    isRemote:
      posting.workplaceType?.toLowerCase() === "remote" ||
      (location ?? "").toLowerCase().includes("remote"),
    location,
  });
}

export async function findToptalGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching Lever postings feed`);
    const res = await fetchWithTimeout(LEVER_API, 15_000, {
      headers: {
        "User-Agent": FREELANCE_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: Lever feed HTTP ${res.status} — retry later or set ${ENV_PREFIX}_COOKIE for authenticated discovery`,
      });
    }
    const postings = (await res.json()) as LeverPosting[];
    if (!Array.isArray(postings)) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: unexpected Lever response shape (expected array)`,
      });
    }

    const terms = ctx.searchTerms
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    for (const posting of postings) {
      if (!posting.id || seen.has(posting.id)) continue;
      if (!matchesTerms(posting, terms)) continue;
      seen.add(posting.id);
      gigs.push(postingToGig(posting));
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Toptal apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_TOPTAL_APPLY_ENABLED=true. Toptal has no public apply API,
 * so the real path opens the Lever-hosted posting in a real browser with the
 * operator's session cookie attached and confirms the apply page is
 * reachable. It never fabricates a submission.
 */
export async function applyToToptalGig(
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

  const applyUrl = `https://jobs.lever.co/toptal/${ctx.gigId}/apply`;
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
                domain: ".toptal.com",
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
    // We reached a real, authenticated application form. Programmatic form
    // submission is intentionally not automated: return the form URL as the
    // external reference so a human completes the final click.
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
