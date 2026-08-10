import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";
import type { Browser } from "playwright";

const PLATFORM = "flexjobs" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_FLEXJOBS";
const BASE_URL = "https://www.flexjobs.com";
const SEARCH_URL = `${BASE_URL}/search`;
const MAX_TERMS = 5;
const MAX_PER_TERM = 50;
const NAV_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * FlexJobs — REAL credentialed adapter.
 *
 * FlexJobs is a subscription job board with no public API; anonymous
 * requests to https://www.flexjobs.com/search are blocked before a single
 * listing is served (verified live: the connection is dropped / reset for
 * anonymous clients). There is NO credential-free public feed.
 *
 * Discovery therefore requires an authenticated member session cookie in
 * JOBOPS_FREELANCE_FLEXJOBS_COOKIE, used via Playwright against
 * https://www.flexjobs.com/search?search=<term>. Job cards are extracted
 * from the rendered DOM (a[href*="/publicJobs/"] anchors) inside the page.
 *
 * With no credential the finder returns a structured "not configured" result
 * (success:false, actionable message naming the exact env var) and never
 * throws.
 *
 * Applying requires the same session and is gated: ctx.dryRun is forced true
 * unless JOBOPS_FREELANCE_FLEXJOBS_APPLY_ENABLED=true.
 */

type FlexjobsCard = {
  id: string;
  title: string;
  url: string;
  company?: string;
  location?: string;
  summary?: string;
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

function toGig(card: FlexjobsCard): CreateGigInput {
  return makeGig({
    platform: PLATFORM,
    sourceGigId: card.id,
    title: card.title,
    clientOrEmployer: card.company ?? "FlexJobs employer",
    gigUrl: card.url,
    applicationLink: card.url,
    gigDescription: card.summary || undefined,
    location: card.location || undefined,
    isRemote: /remote/i.test(card.location ?? "") || undefined,
  });
}

export async function findFlexjobsGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    const { cookie } = resolveCredential(ctx.settings);

    if (!cookie) {
      reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: not configured — no credential-free feed exists (FlexJobs is a subscription board; ${SEARCH_URL} blocks anonymous clients). Set ${ENV_PREFIX}_COOKIE (authenticated member session cookie) to enable discovery`,
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
      await context.addCookies(parseCookieHeader(cookie, ".flexjobs.com"));
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

      for (const term of terms) {
        if (ctx.shouldCancel?.()) break;
        const url = `${SEARCH_URL}?search=${encodeURIComponent(term)}`;
        try {
          reportProgress(ctx, `${PLATFORM}: searching "${term}"`, url);
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page
            .waitForSelector("a[href*='/publicJobs/']", {
              timeout: NAV_TIMEOUT_MS,
            })
            .catch(() => undefined);

          const cards = await page.$$eval(
            "a[href*='/publicJobs/']",
            (anchors) => {
              const out: Array<{
                id: string;
                title: string;
                url: string;
                company?: string;
                location?: string;
                summary?: string;
              }> = [];
              const seenHrefs = new Set<string>();
              for (const anchor of anchors) {
                const href = anchor.getAttribute("href") ?? "";
                const idMatch = href.match(/(\d{4,})/);
                if (!idMatch || seenHrefs.has(href)) continue;
                seenHrefs.add(href);
                const title = anchor.textContent?.trim() ?? "";
                if (!title || title.length < 4) continue;
                const card = anchor.closest(
                  "li, article, div.card, div.job, div.sc-job",
                );
                const pick = (selector: string) =>
                  card?.querySelector(selector)?.textContent?.trim() ||
                  undefined;
                out.push({
                  id: idMatch[1],
                  title,
                  url: href.startsWith("http")
                    ? href
                    : `https://www.flexjobs.com${href}`,
                  company: pick(".job-company, .company, [class*='company']"),
                  location: pick(
                    ".job-location, .location, [class*='location']",
                  ),
                  summary: pick(".job-description, .description, p")?.slice(
                    0,
                    500,
                  ),
                });
                if (out.length >= 50) break;
              }
              return out;
            },
          );

          let added = 0;
          for (const card of cards) {
            if (added >= MAX_PER_TERM) break;
            if (seen.has(card.id)) continue;
            seen.add(card.id);
            gigs.push(toGig(card));
            added++;
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
        message: `${PLATFORM}: browser unavailable for discovery — ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      if (browser) await browser.close();
    }

    if (!gigs.length) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: search returned no job cards — the ${ENV_PREFIX}_COOKIE session may be expired or the listing markup changed; refresh the cookie from a logged-in flexjobs.com browser session`,
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
 * FlexJobs apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_FLEXJOBS_APPLY_ENABLED=true. FlexJobs has no public apply
 * API — a real submit drives the job detail page apply flow with an
 * authenticated member session and a tailored cover letter.
 */
export async function applyToFlexjobsGig(
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
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (authenticated member session) — cannot apply`,
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
    : `${BASE_URL}/publicJobs/-${ctx.gigId}.aspx`;

  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(parseCookieHeader(cookie, ".flexjobs.com"));
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    const applyButton = page
      .getByRole("button", { name: /apply/i })
      .or(page.getByRole("link", { name: /apply for this job|apply now/i }))
      .first();
    if (!(await applyButton.count())) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: no apply control found on ${targetUrl} (session may be invalid or the job closed)`,
      };
    }
    await applyButton.click({ timeout: 10_000 });

    const letterField = page
      .getByRole("textbox", { name: /cover|message|note/i })
      .or(page.locator("textarea").first());
    if (await letterField.count()) {
      await letterField.fill(coverLetter, { timeout: 10_000 });
    }

    const submitButton = page
      .getByRole("button", { name: /submit|send application/i })
      .first();
    if (!(await submitButton.count())) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: apply form opened but no submit control found — manual review needed`,
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
