import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";
import type { Browser, BrowserContext } from "playwright";

const PLATFORM = "wellfound" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_WELLFOUND";
const BASE_URL = "https://wellfound.com";
const GRAPHQL_URL = `${BASE_URL}/graphql`;
const MAX_TERMS = 5;
const MAX_PER_TERM = 50;
const NAV_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Wellfound (AngelList) — REAL credentialed adapter.
 *
 * Wellfound sits behind Cloudflare: every anonymous request (curl or browser)
 * to https://wellfound.com/graphql and the listing pages returns a 403
 * challenge page (verified live). There is NO credential-free public feed.
 *
 * Discovery therefore requires an authenticated session cookie in
 * JOBOPS_FREELANCE_WELLFOUND_COOKIE (a JOBOPS_FREELANCE_WELLFOUND_API_KEY
 * bearer token is also accepted and sent as Authorization). The adapter
 * drives the site's real GraphQL endpoint — https://wellfound.com/graphql —
 * through a Playwright browser context seeded with that session, querying
 * `jobSearchResults` the same way the site's own frontend does.
 *
 * With no credential the finder returns a structured "not configured" result
 * (success:false, actionable message naming the exact env var) and never
 * throws.
 *
 * Applying requires the same session and is gated: ctx.dryRun is forced true
 * unless JOBOPS_FREELANCE_WELLFOUND_APPLY_ENABLED=true.
 */

type WellfoundJob = {
  id?: string | number;
  slug?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  compensation?: string;
  jobType?: string;
  locationNames?: string[] | string;
  skills?: Array<{ name?: string } | string>;
};

type WellfoundStartup = {
  id?: string | number;
  slug?: string;
  name?: string;
  jobs?: WellfoundJob[];
};

type WellfoundSearchResponse = {
  data?: {
    jobSearchResults?: {
      count?: number;
      startups?: WellfoundStartup[];
    };
  };
  errors?: Array<{ message?: string }>;
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

function parseCookieHeader(
  header: string,
  domain: string,
): Array<{ name: string; value: string; domain: string; path: string }> {
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      return {
        name: pair.slice(0, eq).trim().replace(/[^\x20-\x7e]/g, (c) => encodeURIComponent(c)),
        value: pair.slice(eq + 1).trim().replace(/[^\x20-\x7e]/g, (c) => encodeURIComponent(c)),
        domain,
        path: "/",
      };
    })
    .filter(
      (
        cookie,
      ): cookie is {
        name: string;
        value: string;
        domain: string;
        path: string;
      } => cookie !== null && cookie.name.length > 0,
    );
}

/**
 * The site frontend has shipped several input-type names for the same search
 * query over time; try each shape until one is accepted by the schema.
 */
const SEARCH_ATTEMPTS: Array<{
  query: string;
  variables: (term: string) => Record<string, unknown>;
}> = [
  {
    query: `query JobSearchResults($filterConfigurationInput: FilterConfigurationInput) {
      jobSearchResults(filterConfigurationInput: $filterConfigurationInput) {
        count
        startups { id slug name jobs { id slug title description remote compensation jobType locationNames skills { name } } }
      }
    }`,
    variables: (term) => ({
      filterConfigurationInput: { keywords: term },
    }),
  },
  {
    query: `query JobSearchResults($filterConfigurationInput: JobSearchResultsFilterConfigurationInput!) {
      jobSearchResults(filterConfigurationInput: $filterConfigurationInput) {
        count
        startups { id slug name jobs { id slug title description remote compensation jobType } }
      }
    }`,
    variables: (term) => ({
      filterConfigurationInput: { keywords: term },
    }),
  },
];

async function searchViaGraphql(
  context: BrowserContext,
  term: string,
  apiKey?: string,
): Promise<WellfoundStartup[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/jobs`,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastError: string | undefined;
  for (const attempt of SEARCH_ATTEMPTS) {
    const res = await context.request.post(GRAPHQL_URL, {
      headers,
      data: {
        operationName: "JobSearchResults",
        query: attempt.query,
        variables: attempt.variables(term),
      },
    });
    const body = await res.text();
    if (!res.ok()) {
      lastError = `GraphQL HTTP ${res.status()}${res.status() === 403 ? " (Cloudflare challenge — session cookie missing/expired?)" : ""}: ${body.slice(0, 120)}`;
      if (res.status() === 400) continue; // schema rejected this query shape
      throw new Error(lastError);
    }
    let json: WellfoundSearchResponse;
    try {
      json = JSON.parse(body) as WellfoundSearchResponse;
    } catch {
      throw new Error(
        `GraphQL returned non-JSON (${body.slice(0, 80)}) — likely a Cloudflare interstitial`,
      );
    }
    if (json.errors?.length) {
      lastError = `GraphQL errors: ${json.errors
        .map((err) => err.message ?? "?")
        .join("; ")
        .slice(0, 200)}`;
      continue; // try the next query shape
    }
    return json.data?.jobSearchResults?.startups ?? [];
  }
  throw new Error(lastError ?? "GraphQL search failed");
}

function jobUrl(startup: WellfoundStartup, job: WellfoundJob): string {
  const startupSlug = startup.slug ?? String(startup.id ?? "");
  const jobSlug = job.slug ?? String(job.id ?? "");
  if (startupSlug && jobSlug) {
    return `${BASE_URL}/company/${startupSlug}/jobs/${jobSlug}`;
  }
  return jobSlug ? `${BASE_URL}/jobs/${jobSlug}` : `${BASE_URL}/jobs`;
}

function toGig(startup: WellfoundStartup, job: WellfoundJob): CreateGigInput {
  const skills = (job.skills ?? [])
    .map((skill) => (typeof skill === "string" ? skill : skill.name))
    .filter((name): name is string => Boolean(name));
  const locations = Array.isArray(job.locationNames)
    ? job.locationNames.join(", ")
    : job.locationNames;
  return makeGig({
    platform: PLATFORM,
    sourceGigId: String(job.id ?? job.slug ?? jobUrl(startup, job)),
    title: job.title ?? "Untitled role",
    clientOrEmployer: startup.name ?? "Wellfound startup",
    gigUrl: jobUrl(startup, job),
    applicationLink: jobUrl(startup, job),
    budget: job.compensation ?? undefined,
    datePosted: undefined,
    gigDescription: job.description?.slice(0, 2000) || undefined,
    skillsRequired: skills,
    jobType: job.jobType ?? undefined,
    isRemote: job.remote ?? undefined,
    location: locations || undefined,
  });
}

export async function findWellfoundGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    const { apiKey, cookie } = resolveCredential(ctx.settings);

    if (!apiKey && !cookie) {
      reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: not configured — no credential-free feed exists (Cloudflare blocks anonymous access to ${GRAPHQL_URL}). Set ${ENV_PREFIX}_COOKIE (authenticated session cookie) or ${ENV_PREFIX}_API_KEY to enable discovery`,
      });
    }

    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, MAX_TERMS);
    if (!terms.length) terms.push("react");

    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    let browser: Browser | undefined;

    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent: BROWSER_UA });
      if (cookie) {
        await context.addCookies(parseCookieHeader(cookie, ".wellfound.com"));
      }

      for (const term of terms) {
        if (ctx.shouldCancel?.()) break;
        try {
          reportProgress(ctx, `${PLATFORM}: searching "${term}" via GraphQL`);
          const startups = await searchViaGraphql(context, term, apiKey);
          let added = 0;
          for (const startup of startups) {
            for (const job of startup.jobs ?? []) {
              if (added >= MAX_PER_TERM) break;
              const gig = toGig(startup, job);
              const id = gig.sourceGigId ?? gig.gigUrl;
              if (seen.has(id)) continue;
              seen.add(id);
              gigs.push(gig);
              added++;
            }
            if (added >= MAX_PER_TERM) break;
          }
          reportProgress(
            ctx,
            `${PLATFORM}: term "${term}" matched ${added} gigs`,
          );
        } catch (error) {
          reportProgress(
            ctx,
            `${PLATFORM}: term "${term}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: browser unavailable for GraphQL discovery — ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      if (browser) await browser.close();
    }

    if (!gigs.length) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: GraphQL search returned no jobs — the ${ENV_PREFIX}_COOKIE session is Cloudflare-clearance (cf_clearance) bound to the residential IP it was issued from, so datacenter/egress IPs get HTTP 400. Refresh the cookie AND run discovery from the same egress network it was captured on, or set ${ENV_PREFIX}_API_KEY for a network-agnostic bearer path`,
      });
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs: gigs.slice(0, MAX_TERMS * MAX_PER_TERM) };
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
 * Wellfound apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_WELLFOUND_APPLY_ENABLED=true. Wellfound has no public
 * apply API — a real submit drives the job page apply flow with an
 * authenticated session cookie and a tailored note.
 */
export async function applyToWellfoundGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and configure ${ENV_PREFIX}_COOKIE to submit for real)`,
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

  const targetUrl = ctx.gigId.startsWith("http")
    ? ctx.gigId
    : `${BASE_URL}/jobs/${ctx.gigId}`;

  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookie, ".wellfound.com"));
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    const applyButton = page
      .getByRole("button", { name: /apply/i })
      .or(page.getByRole("link", { name: /apply/i }))
      .first();
    if (!(await applyButton.count())) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: no apply control found on ${targetUrl} (session may be invalid or the role closed)`,
      };
    }
    await applyButton.click({ timeout: 10_000 });

    const noteField = page
      .getByRole("textbox", { name: /note|message|cover/i })
      .or(page.locator("textarea").first());
    if (await noteField.count()) {
      await noteField.fill(coverLetter, { timeout: 10_000 });
    }

    const submitButton = page
      .getByRole("button", { name: /submit|send application|apply now/i })
      .first();
    if (!(await submitButton.count())) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: apply dialog opened but no submit control found — manual review needed`,
      };
    }
    await submitButton.click({ timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    return {
      platform: PLATFORM,
      mode: "submit",
      status: "submitted",
      externalRef: ctx.gigId,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: submit failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (browser) await browser.close();
  }
}
