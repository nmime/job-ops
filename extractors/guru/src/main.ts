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
import type { Browser } from "playwright";

const PLATFORM = "guru" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_GURU";
const MAX_TERMS = 5;
const MAX_PER_TERM = 50;
const NAV_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Guru — REAL credentialed adapter.
 *
 * Guru blocks anonymous job-search scraping (verified: /d/jobs/ redirects
 * anonymous clients). Discovery therefore supports two credentialed paths:
 *   - JOBOPS_FREELANCE_GURU_API_KEY  OAuth token for Guru's official API
 *     (available to paid members; see https://www.guru.com/developers ).
 *     Preferred HTTP path.
 *   - JOBOPS_FREELANCE_GURU_COOKIE   Authenticated session cookie, used via
 *     Playwright against https://www.guru.com/d/jobs/ . Fallback path.
 *
 * With no credential the finder returns a structured "not configured" result
 * (success:false, actionable message) and never throws.
 *
 * Submitting a quote (Guru's term for a proposal) requires the authenticated
 * session via browser automation and is gated: ctx.dryRun is forced true
 * unless JOBOPS_FREELANCE_GURU_APPLY_ENABLED=true.
 */

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

type GuruJob = {
  id: string;
  title: string;
  url: string;
  description?: string;
  budgetText?: string;
  location?: string;
  postedText?: string;
  employer?: string;
  skills: string[];
};

// --- official API path (paid members) ---

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function searchViaApi(term: string, apiKey: string): Promise<GuruJob[]> {
  const url = new URL("https://api.guru.com/v1/jobs/search");
  url.searchParams.set("q", term);
  url.searchParams.set("limit", String(MAX_PER_TERM));
  const res = await fetchWithTimeout(url.toString(), 15_000, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": FREELANCE_USER_AGENT,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Guru API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as unknown;
  const root = asRecord(json);
  const items = Array.isArray(root?.jobs)
    ? root.jobs
    : Array.isArray(root?.results)
      ? root.results
      : Array.isArray(json)
        ? (json as unknown[])
        : [];
  const jobs: GuruJob[] = [];
  for (const item of items.slice(0, MAX_PER_TERM)) {
    const job = asRecord(item);
    if (!job) continue;
    const id = asString(job.id) ?? asString(job.jobId);
    const title = asString(job.title) ?? asString(job.name);
    if (!id || !title) continue;
    jobs.push({
      id,
      title,
      url:
        asString(job.url) ??
        `https://www.guru.com/d/jobs/q/${encodeURIComponent(id)}/`,
      description: asString(job.description),
      budgetText: asString(job.budget),
      location: asString(job.location),
      postedText: asString(job.postedDate) ?? asString(job.createdAt),
      employer: asString(job.employerName) ?? asString(job.employer),
      skills: Array.isArray(job.skills)
        ? job.skills
            .map((s) =>
              typeof s === "string" ? s : asString(asRecord(s)?.name),
            )
            .filter((s): s is string => Boolean(s))
        : [],
    });
  }
  return jobs;
}

// --- Playwright fallback (session cookie) ---

async function searchViaBrowser(
  term: string,
  cookieHeader: string,
): Promise<GuruJob[]> {
  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookieHeader, ".guru.com"));
    const page = await context.newPage();
    await page.goto(
      `https://www.guru.com/d/jobs/q/${encodeURIComponent(term)}/`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    await page
      .waitForSelector(
        ".module_job, [class*='jobRecord'], article, .job-listing",
        { timeout: NAV_TIMEOUT_MS },
      )
      .catch(() => undefined);
    const raw = await page.$$eval(
      ".module_job, [class*='jobRecord'], article.job-listing, .job-listing",
      (cards) =>
        cards.slice(0, 50).map((card) => {
          const text = (el: Element | null) =>
            el?.textContent?.trim() ?? undefined;
          const anchor = card.querySelector(
            "a[href*='/jobs/'], h2 a[href], h3 a[href]",
          );
          const href = anchor?.getAttribute("href") ?? "";
          return {
            id:
              href.match(/\/jobs\/[^/]*\/(\d+)/)?.[1] ??
              href.replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
            title: text(anchor) ?? text(card.querySelector("h2, h3")) ?? "",
            url: href.startsWith("http")
              ? href
              : href
                ? `https://www.guru.com${href.startsWith("/") ? "" : "/"}${href}`
                : "",
            description: text(card.querySelector("[class*='description'], p")),
            budgetText: text(
              card.querySelector("[class*='budget'], [class*='price']"),
            ),
            location: text(card.querySelector("[class*='location']")),
            postedText: text(
              card.querySelector("[class*='date'], [class*='posted'], time"),
            ),
            employer: text(
              card.querySelector("[class*='employer'], [class*='client']"),
            ),
            skills: Array.from(
              card.querySelectorAll("[class*='skill'], [class*='tag']"),
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

function toGig(job: GuruJob): CreateGigInput {
  return makeGig({
    platform: PLATFORM,
    sourceGigId: job.id,
    title: job.title,
    clientOrEmployer: job.employer ?? "Guru employer",
    gigUrl: job.url,
    applicationLink: job.url,
    budget: job.budgetText,
    gigDescription: job.description,
    datePosted: job.postedText,
    location: job.location,
    skillsRequired: job.skills,
    isRemote: true,
  });
}

export async function findGuruGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const { apiKey, cookie } = resolveCredential(ctx.settings);

  if (!apiKey && !cookie) {
    reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: not configured — set ${ENV_PREFIX}_API_KEY (official API token for paid members) or ${ENV_PREFIX}_COOKIE (authenticated session cookie) to enable discovery; Guru blocks anonymous job-search scraping`,
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
          ? await searchViaApi(term, apiKey)
          : await searchViaBrowser(term, cookie ?? "");
        for (const job of jobs.slice(0, MAX_PER_TERM)) {
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

    if (gigs.length === 0) {
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

/**
 * Guru apply adapter — REAL money path.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_GURU_APPLY_ENABLED=true. Submitting a quote needs an
 * authenticated session cookie and a tailored cover letter; it is
 * browser-automated because quote submission is not part of the public API.
 */
export async function applyToGuruGig(
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

  const cookie = process.env[`${ENV_PREFIX}_COOKIE`];
  if (!cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (authenticated session) — cannot submit a quote`,
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
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored quote`,
    };
  }

  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookie, ".guru.com"));
    const page = await context.newPage();
    const jobUrl = ctx.gigId.startsWith("http")
      ? ctx.gigId
      : `https://www.guru.com/d/jobs/q/${encodeURIComponent(ctx.gigId)}/`;
    await page.goto(jobUrl, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    const quoteButton = page.locator(
      "a:has-text('Submit a Quote'), button:has-text('Submit a Quote'), a:has-text('Send Quote')",
    );
    if (
      !(await quoteButton
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      throw new Error(
        "quote button not found — job may be closed or the session is not logged in",
      );
    }
    await quoteButton.first().click({ timeout: NAV_TIMEOUT_MS });
    const textarea = page.locator("textarea").first();
    await textarea.fill(coverLetter, { timeout: NAV_TIMEOUT_MS });
    if (profile.proposedAmount != null) {
      const priceInput = page
        .locator(
          "input[type='number'], input[name*='price'], input[name*='amount']",
        )
        .first();
      await priceInput
        .fill(String(profile.proposedAmount), { timeout: 5_000 })
        .catch(() => undefined);
    }
    await page
      .locator("button:has-text('Submit'), button[type='submit']")
      .first()
      .click({ timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS });
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
      error: `${PLATFORM}: quote failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (browser) await browser.close();
  }
}
