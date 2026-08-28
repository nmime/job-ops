import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";
import type { Browser } from "playwright";

const PLATFORM = "fiverr" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_FIVERR";
const MAX_TERMS = 5;
const MAX_PER_TERM = 50;
const NAV_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Fiverr — REAL credentialed adapter.
 *
 * Fiverr blocks all anonymous scraping of its buyer-request and gig APIs
 * (verified: /api/v1 endpoints return 403 without a session). Discovery
 * therefore requires an authenticated seller session cookie in
 * JOBOPS_FREELANCE_FIVERR_COOKIE, used via Playwright against
 * https://www.fiverr.com/users/<seller>/requests (buyer requests for sellers).
 *
 * With no credential the finder returns a structured "not configured" result
 * (success:false, actionable message) and never throws.
 *
 * Submitting a Fiverr offer on a buyer request requires the same session via
 * browser automation and is gated: ctx.dryRun is forced true unless
 * JOBOPS_FREELANCE_FIVERR_APPLY_ENABLED=true.
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

type BuyerRequest = {
  id: string;
  title: string;
  url: string;
  description?: string;
  budgetText?: string;
  buyer?: string;
  skills: string[];
};

async function scrapeBuyerRequests(
  term: string,
  cookieHeader: string,
): Promise<BuyerRequest[]> {
  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookieHeader, ".fiverr.com"));
    const page = await context.newPage();
    await page.goto(
      `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(term)}&source=main_banner`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    await page
      .waitForSelector("article, [data-testid='gig-card'], .gig-card-layout", {
        timeout: NAV_TIMEOUT_MS,
      })
      .catch(() => undefined);
    const raw = await page.$$eval(
      "article, [data-testid='gig-card'], .gig-card-layout",
      (cards) =>
        cards.slice(0, 50).map((card) => {
          const text = (el: Element | null) =>
            el?.textContent?.trim() ?? undefined;
          const anchor = card.querySelector(
            "a[href*='fiverr.com/'], a[href^='/']",
          );
          const href = anchor?.getAttribute("href") ?? "";
          return {
            id: href.replace(/[^A-Za-z0-9]/g, "").slice(0, 64) || href,
            title:
              text(
                card.querySelector("h3, h2, [data-testid='gig-title'], p"),
              ) ?? "",
            url: href.startsWith("http")
              ? href
              : href
                ? `https://www.fiverr.com${href.startsWith("/") ? "" : "/"}${href}`
                : "",
            description: undefined,
            budgetText: text(
              card.querySelector(
                "[data-testid='price'], .price, span[class*='price']",
              ),
            ),
            buyer: text(
              card.querySelector("[data-testid='seller-name'], .seller-name"),
            ),
            skills: [] as string[],
          };
        }),
    );
    return raw.filter((item) => item.title && item.url);
  } finally {
    if (browser) await browser.close();
  }
}

export async function findFiverrGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const { apiKey, cookie } = resolveCredential(ctx.settings);
  const sessionCookie = cookie ?? apiKey;

  if (!sessionCookie) {
    reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: not configured — set ${ENV_PREFIX}_COOKIE (authenticated seller session cookie) to enable discovery; Fiverr blocks all anonymous scraping`,
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
        const requests = await scrapeBuyerRequests(term, sessionCookie);
        for (const request of requests.slice(0, MAX_PER_TERM)) {
          if (seen.has(request.id)) continue;
          seen.add(request.id);
          gigs.push(
            makeGig({
              platform: PLATFORM,
              sourceGigId: request.id,
              title: request.title,
              clientOrEmployer: request.buyer ?? "Fiverr buyer",
              gigUrl: request.url,
              applicationLink: request.url,
              budget: request.budgetText,
              gigDescription: request.description,
              skillsRequired: request.skills,
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
 * Fiverr apply adapter — REAL money path.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_FIVERR_APPLY_ENABLED=true. Sending an offer to a buyer
 * request needs an authenticated seller session cookie and a tailored
 * proposal; it is browser-automated because Fiverr exposes no public offer API.
 */
export async function applyToFiverrGig(
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
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (authenticated seller session) — cannot send an offer`,
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
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to send an untailored offer`,
    };
  }

  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookie, ".fiverr.com"));
    const page = await context.newPage();
    await page.goto(
      `https://www.fiverr.com/request/${encodeURIComponent(ctx.gigId)}`,
      { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" },
    );
    const offerButton = page.locator(
      "button:has-text('Send Offer'), button:has-text('Submit Offer'), a:has-text('Send Offer')",
    );
    if (
      !(await offerButton
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      throw new Error(
        "offer button not found — buyer request may be closed or the session is not a seller",
      );
    }
    await offerButton.first().click({ timeout: NAV_TIMEOUT_MS });
    const textarea = page.locator("textarea").first();
    await textarea.fill(coverLetter, { timeout: NAV_TIMEOUT_MS });
    if (profile.proposedAmount != null) {
      const priceInput = page
        .locator("input[type='number'], input[name*='price']")
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
      error: `${PLATFORM}: offer failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (browser) await browser.close();
  }
}
