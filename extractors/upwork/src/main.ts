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
import type { Browser, BrowserContext } from "playwright";

const PLATFORM = "upwork" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_UPWORK";
const GRAPHQL_URL = "https://api.upwork.com/graphql";
const MAX_TERMS = 5;
const MAX_PER_TERM = 50;
const NAV_TIMEOUT_MS = 20_000;

/**
 * Upwork — REAL credentialed adapter.
 *
 * Upwork blocks all credential-free scraping (RSS + GraphQL return 403/401 to
 * anonymous clients, verified). Discovery therefore requires one of:
 *   - JOBOPS_FREELANCE_UPWORK_API_KEY  OAuth2 bearer token for the official
 *     GraphQL API (https://api.upwork.com/graphql). Preferred path.
 *   - JOBOPS_FREELANCE_UPWORK_COOKIE   Authenticated session cookie, used via
 *     Playwright against the logged-in job search page. Fallback path.
 *
 * With no credential the finder returns a structured "not configured" result
 * (success:false, actionable message) and never throws.
 *
 * The submit path posts a real proposal via the GraphQL API and is gated by
 * the orchestrator's safety model: ctx.dryRun is forced true unless
 * JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED=true.
 */

// --- credential resolution (mandatory convention) ---

function resolveApiKey(
  settings: Record<string, string | undefined>,
): string | undefined {
  return (
    settings[`${ENV_PREFIX}_API_KEY`] ?? process.env[`${ENV_PREFIX}_API_KEY`]
  );
}

function resolveCookie(
  settings: Record<string, string | undefined>,
): string | undefined {
  return (
    settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`]
  );
}

// --- tolerant unknown-shape helpers (GraphQL payloads evolve) ---

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// --- GraphQL discovery (official API, bearer token) ---

const SEARCH_QUERY = `
query MarketplaceJobPostingsSearch($query: String!, $first: Int) {
  marketplaceJobPostingsSearch(query: $query, first: $first) {
    edges {
      node {
        id
        ciphertext
        title
        description
        createdDateTime
        publishedDateTime
        fixedPriceAmount
        hourlyBudgetMin
        hourlyBudgetMax
        duration
        proposalsTier
        client {
          displayName
          totalHires
          paymentVerificationStatus
          location { country }
        }
        skills { name }
      }
    }
  }
}`;

type ScrapedJob = {
  id: string;
  title: string;
  url: string;
  description?: string;
  budgetText?: string;
  postedText?: string;
  skills: string[];
};

async function searchGraphql(
  term: string,
  apiKey: string,
): Promise<ScrapedJob[]> {
  const res = await fetchWithTimeout(GRAPHQL_URL, 15_000, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": FREELANCE_USER_AGENT,
    },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { query: term, first: MAX_PER_TERM },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upwork GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as unknown;
  const root = asRecord(json);
  const errors = Array.isArray(root?.errors) ? root.errors : [];
  if (errors.length > 0) {
    const first = asRecord(errors[0]);
    throw new Error(
      `Upwork GraphQL error: ${asString(first?.message) ?? "unknown"}`,
    );
  }
  const data = asRecord(root?.data);
  const search = asRecord(data?.marketplaceJobPostingsSearch);
  const edges = Array.isArray(search?.edges) ? search.edges : [];

  const jobs: ScrapedJob[] = [];
  for (const edge of edges.slice(0, MAX_PER_TERM)) {
    const node = asRecord(asRecord(edge)?.node);
    if (!node) continue;
    const id =
      asString(node.ciphertext) ??
      asString(node.id) ??
      JSON.stringify(node).slice(0, 32);
    const title = asString(node.title);
    if (!title) continue;
    jobs.push({
      id,
      title,
      url: `https://www.upwork.com/jobs/${encodeURIComponent(id)}`,
      description: asString(node.description),
      postedText:
        asString(node.publishedDateTime) ?? asString(node.createdDateTime),
      skills: (Array.isArray(node.skills) ? node.skills : [])
        .map((s) => asString(asRecord(s)?.name))
        .filter((s): s is string => Boolean(s)),
    });
  }
  return jobs;
}

// --- Playwright discovery fallback (session cookie) ---

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
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
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

async function launchWithCookies(
  cookieHeader: string,
  domain: string,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  await context.addCookies(parseCookieHeader(cookieHeader, domain));
  return { browser, context };
}

async function searchViaBrowser(
  term: string,
  cookieHeader: string,
): Promise<ScrapedJob[]> {
  let browser: Browser | undefined;
  try {
    const launched = await launchWithCookies(cookieHeader, ".upwork.com");
    browser = launched.browser;
    const page = await launched.context.newPage();
    const url = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(term)}`;
    await page.goto(url, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForSelector(
        "section[data-test='JobTile'], [data-test='JobTile'], article, .job-tile",
        { timeout: NAV_TIMEOUT_MS },
      )
      .catch(() => undefined);
    const raw = await page.$$eval(
      "section[data-test='JobTile'], [data-test='JobTile'], article.job-tile, .job-tile",
      (tiles) =>
        tiles.slice(0, 50).map((tile) => {
          const text = (el: Element | null) =>
            el?.textContent?.trim() ?? undefined;
          const anchor = tile.querySelector(
            "h2 a[href], h3 a[href], h4 a[href], a[href*='/jobs/']",
          );
          const href = anchor?.getAttribute("href") ?? "";
          const idMatch =
            href.match(/~([A-Za-z0-9]+)/) ?? href.match(/\/jobs\/([^/?_]+)/);
          return {
            id: idMatch?.[1] ?? href,
            title: text(anchor) ?? "",
            url: href.startsWith("http")
              ? href
              : href
                ? `https://www.upwork.com${href.startsWith("/") ? "" : "/"}${href}`
                : "",
            description: text(
              tile.querySelector(
                "[data-test='JobDescription'], .job-description, p",
              ),
            ),
            budgetText: text(
              tile.querySelector(
                "[data-test='job-type-label'], [data-test='Budget'], .js-budget",
              ),
            ),
            postedText: text(
              tile.querySelector("[data-test='job-pub-date'], .js-posted"),
            ),
            skills: Array.from(
              tile.querySelectorAll(
                "[data-test='TokenClamp'] span, .skills span, .o-tag-skill",
              ),
            )
              .map((el) => el.textContent?.trim() ?? "")
              .filter(Boolean),
          };
        }),
    );
    return raw.filter((job) => job.title && job.url);
  } finally {
    if (browser) await browser.close();
  }
}

function toGig(job: ScrapedJob): CreateGigInput {
  return makeGig({
    platform: PLATFORM,
    sourceGigId: job.id,
    title: job.title,
    clientOrEmployer: "Upwork client",
    gigUrl: job.url,
    applicationLink: job.url,
    budget: job.budgetText,
    gigDescription: job.description,
    datePosted: job.postedText,
    skillsRequired: job.skills,
    isRemote: true,
  });
}

export async function findUpworkGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const apiKey = resolveApiKey(ctx.settings);
  const cookie = resolveCookie(ctx.settings);

  if (!apiKey && !cookie) {
    reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: not configured — set ${ENV_PREFIX}_API_KEY (OAuth2 bearer for the official GraphQL API) or ${ENV_PREFIX}_COOKIE (authenticated session cookie) to enable discovery; Upwork blocks all anonymous scraping`,
    });
  }

  try {
    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    const terms = ctx.searchTerms.length
      ? ctx.searchTerms.slice(0, MAX_TERMS)
      : ["typescript", "react", "node"];

    for (const term of terms) {
      try {
        reportProgress(ctx, `${PLATFORM}: searching "${term}"`);
        const jobs = apiKey
          ? await searchGraphql(term, apiKey)
          : await searchViaBrowser(term, cookie ?? "");
        for (const job of jobs) {
          if (seen.has(job.id)) continue;
          seen.add(job.id);
          gigs.push(toGig(job));
        }
      } catch (error) {
        reportProgress(
          ctx,
          `${PLATFORM}: term "${term}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (gigs.length === 0 && seen.size === 0) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: 0 gigs — credential may be invalid or expired (check ${ENV_PREFIX}_API_KEY / ${ENV_PREFIX}_COOKIE)`,
      });
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

// --- submit (money path, safety gated) ---

const SUBMIT_PROPOSAL_MUTATION = `
mutation CreateProposal($jobPostingId: ID!, $coverLetter: String!, $bidAmount: Float) {
  createProposal(
    jobPostingId: $jobPostingId
    coverLetter: $coverLetter
    bidAmount: $bidAmount
  ) {
    id
    status
  }
}`;

/**
 * Upwork apply adapter — REAL money path.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED=true. Submitting a proposal requires
 * an OAuth token with the proposal scope in JOBOPS_FREELANCE_UPWORK_API_KEY
 * and a tailored cover letter in ctx.profile.
 */
export async function applyToUpworkGig(
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

  const apiKey = resolveApiKey(
    process.env as Record<string, string | undefined>,
  );
  if (!apiKey) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_API_KEY (OAuth token with proposal scope) — cannot submit proposal`,
    };
  }

  const profile = (ctx.profile ?? {}) as {
    coverLetter?: string;
    proposedAmount?: number;
  };
  const coverLetter = profile.coverLetter?.trim();
  if (!coverLetter) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored proposal`,
    };
  }

  try {
    const res = await fetchWithTimeout(GRAPHQL_URL, 15_000, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": FREELANCE_USER_AGENT,
      },
      body: JSON.stringify({
        query: SUBMIT_PROPOSAL_MUTATION,
        variables: {
          jobPostingId: ctx.gigId,
          coverLetter,
          bidAmount: profile.proposedAmount,
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Upwork proposal HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as unknown;
    const root = asRecord(json);
    const errors = Array.isArray(root?.errors) ? root.errors : [];
    if (errors.length > 0) {
      const first = asRecord(errors[0]);
      throw new Error(
        `Upwork proposal rejected: ${asString(first?.message) ?? "unknown GraphQL error"}`,
      );
    }
    const proposal = asRecord(asRecord(asRecord(root?.data))?.createProposal);
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "submitted",
      externalRef: asString(proposal?.id),
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: proposal failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
