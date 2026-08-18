import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";
import type { Browser } from "playwright";

const PLATFORM = "peopleperhour" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_PEOPLEPERHOUR";
const MAX_TERMS = 5;
const MAX_PER_TERM = 50;
const NAV_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * PeoplePerHour — REAL credentialed adapter.
 *
 * PeoplePerHour serves a bot wall to anonymous clients (verified: the
 * freelance-jobs listing returns a 202 challenge with an empty body).
 * Discovery therefore requires an authenticated session cookie in
 * JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE, used via Playwright against
 * https://www.peopleperhour.com/freelance-jobs .
 *
 * With no credential the finder returns a structured "not configured" result
 * (success:false, actionable message) and never throws.
 *
 * Sending a proposal requires the same session via browser automation and is
 * gated: ctx.dryRun is forced true unless
 * JOBOPS_FREELANCE_PEOPLEPERHOUR_APPLY_ENABLED=true.
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

type PphJob = {
  id: string;
  title: string;
  url: string;
  description?: string;
  budgetText?: string;
  location?: string;
  postedText?: string;
  proposalCount?: number;
  skills: string[];
};

async function scrapeJobs(
  term: string,
  cookieHeader: string,
): Promise<PphJob[]> {
  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(
      parseCookieHeader(cookieHeader, ".peopleperhour.com"),
    );
    const page = await context.newPage();
    await page.goto(
      `https://www.peopleperhour.com/freelance-jobs?keyword=${encodeURIComponent(term)}`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    await page
      .waitForSelector(
        "a[href*='/freelance-jobs/'], li.job-list-item, [class*='job-list'] li, article, .job-card",
        { timeout: NAV_TIMEOUT_MS },
      )
      .catch(() => undefined);
    // IIFE string through page.evaluate: avoids both the tsx/esbuild __name
    // decoration breaking Playwright function serialization and the fact that
    // this Playwright version treats $$eval string args as bare expressions.
    const raw = (await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll("div[class*='item__container'], li.job-list-item, [class*='job-list'] li, article.job-card, .job-card")).slice(0, 50);
      const text = (el) => (el && el.textContent ? el.textContent.trim() : undefined);
      return cards.map((card) => {
        const anchor = card.querySelector("a[href*='freelance-jobs/'], a[class*='item__url'], a[href*='/job/'], a[href*='freelance-job'], h2 a[href], h3 a[href]");
        const href = anchor && anchor.getAttribute("href") ? anchor.getAttribute("href") : "";
        const proposals = text(card.querySelector("[class*='proposal'], [class*='bids'], [class*='sent']"));
        const proposalCount = proposals ? Number(proposals.replace(/[^0-9]/g, "")) : undefined;
        return {
          id: (href.match(/(\\d{4,})/) || [])[1] || href.replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
          title: text(anchor) || text(card.querySelector("h2, h3, h6")) || "",
          url: href.startsWith("http") ? href : href ? "https://www.peopleperhour.com" + (href.startsWith("/") ? "" : "/") + href : "",
          description: text(card.querySelector("[class*='description'], p")),
          budgetText: text(card.querySelector("[class*='budget'], [class*='price']")),
          location: text(card.querySelector("[class*='location'], [class*='country']")),
          postedText: text(card.querySelector("[class*='date'], [class*='posted'], time")),
          proposalCount: proposalCount != null && Number.isFinite(proposalCount) ? proposalCount : undefined,
          skills: Array.from(card.querySelectorAll("[class*='skill'], [class*='tag']")).map((el) => (el.textContent || "").trim()).filter(Boolean),
        };
      });
    })()`)) as PphJob[];
    return raw.filter((job) => job.title && job.url);
  } finally {
    if (browser) await browser.close();
  }
}

export async function findPeopleperhourGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const { apiKey, cookie } = resolveCredential(ctx.settings);
  const sessionCookie = cookie ?? apiKey;

  if (!sessionCookie) {
    reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: not configured — set ${ENV_PREFIX}_COOKIE (authenticated session cookie) to enable discovery; PeoplePerHour serves a bot wall to anonymous clients`,
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
        const jobs = await scrapeJobs(term, sessionCookie);
        for (const job of jobs.slice(0, MAX_PER_TERM)) {
          if (seen.has(job.id)) continue;
          seen.add(job.id);
          gigs.push(
            makeGig({
              platform: PLATFORM,
              sourceGigId: job.id,
              title: job.title,
              clientOrEmployer: "PeoplePerHour client",
              gigUrl: job.url,
              applicationLink: job.url,
              budget: job.budgetText,
              gigDescription: job.description,
              datePosted: job.postedText,
              location: job.location,
              proposalCount: job.proposalCount,
              skillsRequired: job.skills,
              isRemote: true,
            }),
          );
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
        message: `${PLATFORM}: 0 gigs — session cookie may be invalid or expired (check ${ENV_PREFIX}_COOKIE)`,
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
 * PeoplePerHour apply adapter — REAL money path.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_PEOPLEPERHOUR_APPLY_ENABLED=true. Sending a proposal needs
 * an authenticated session cookie and a tailored cover letter; it is
 * browser-automated because PeoplePerHour exposes no public proposal API.
 */
export async function applyToPeopleperhourGig(
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
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (authenticated session) — cannot send a proposal`,
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
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to send an untailored proposal`,
    };
  }

  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookie, ".peopleperhour.com"));
    const page = await context.newPage();
    const jobUrl = ctx.gigId.startsWith("http")
      ? ctx.gigId
      : `https://www.peopleperhour.com/freelance-jobs/${encodeURIComponent(ctx.gigId)}`;
    await page.goto(jobUrl, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    const proposalButton = page.locator(
      "a:has-text('Send Proposal'), button:has-text('Send Proposal'), button:has-text('Submit Proposal')",
    );
    if (
      !(await proposalButton
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      throw new Error(
        "proposal button not found — job may be closed or the session is not logged in",
      );
    }
    await proposalButton.first().click({ timeout: NAV_TIMEOUT_MS });
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
      error: `${PLATFORM}: proposal failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (browser) await browser.close();
  }
}
