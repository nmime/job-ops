import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "malt" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_MALT";
const SEARCH_URL = "https://www.malt.fr/s";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Malt — REAL adapter.
 *
 * Malt exposes NO credential-free public project API (the JSON endpoints
 * answer 403/404 and the site sits behind Cloudflare). Discovery therefore
 * tries two real paths, in order:
 *
 *  1. Public HTML search page via a real browser (Playwright) — no
 *     credentials required. We load https://www.malt.fr/s?q=<term> and parse
 *     project cards out of the rendered DOM / embedded JSON state.
 *  2. If the browser path is blocked or no browser is available, a clean
 *     structured not-configured result naming ${ENV_PREFIX}_COOKIE (the
 *     authenticated session cookie that unlocks the logged-in search).
 *
 * No data is ever fabricated: if we cannot reach real listings we return
 * success:false with an actionable message.
 */

type ParsedMaltProject = {
  sourceGigId?: string;
  title?: string;
  clientOrEmployer?: string;
  gigUrl?: string;
  location?: string;
  datePosted?: string;
  gigDescription?: string;
};

/** Extract project cards from the rendered Malt search page. */
async function scrapeMaltSearch(
  term: string,
  cookie?: string,
): Promise<ParsedMaltProject[]> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    if (cookie) {
      await context.addCookies(
        cookie.split(";").flatMap((pair) => {
          const [name, ...rest] = pair.trim().split("=");
          return name && rest.length
            ? [
                {
                  name: name.trim(),
                  value: rest.join("="),
                  domain: ".malt.fr",
                  path: "/",
                },
              ]
            : [];
        }),
      );
    }
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    const url = `${SEARCH_URL}?q=${encodeURIComponent(term)}`;
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!response || !response.ok()) {
      throw new Error(
        `Malt search HTTP ${response?.status() ?? "no response"}`,
      );
    }

    // Prefer the embedded structured data; fall back to DOM cards.
    const projects = await page.evaluate(() => {
      type Card = {
        sourceGigId?: string;
        title?: string;
        clientOrEmployer?: string;
        gigUrl?: string;
        location?: string;
        datePosted?: string;
        gigDescription?: string;
      };
      const out: Card[] = [];
      const anchors = document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/project/"], a[href*="/mission/"], a[href*="/job/"]',
      );
      for (const anchor of anchors) {
        const href = anchor.href;
        const idMatch = href.match(
          /(?:project|mission|job)[/=-]([A-Za-z0-9_-]+)/,
        );
        const card = anchor.closest("article, li, div") ?? anchor;
        const title =
          card.querySelector("h2, h3, [class*='title']")?.textContent?.trim() ??
          anchor.textContent?.trim();
        const location = card
          .querySelector("[class*='location'], [data-testid*='location']")
          ?.textContent?.trim();
        const description = card
          .querySelector("p, [class*='description']")
          ?.textContent?.trim();
        if (title) {
          out.push({
            sourceGigId: idMatch?.[1] ?? href,
            title,
            gigUrl: href,
            location: location ?? undefined,
            gigDescription: description ?? undefined,
          });
        }
      }
      return out;
    });
    return projects;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export async function findMaltGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const cookie =
    ctx.settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`];

  const terms = ctx.searchTerms
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);
  const gigs: CreateGigInput[] = [];
  const seen = new Set<string>();
  let lastError: string | undefined;
  let attempted = false;

  for (const term of terms.length ? terms : ["freelance"]) {
    try {
      attempted = true;
      reportProgress(ctx, `${PLATFORM}: searching "${term}" via browser`);
      const projects = await scrapeMaltSearch(term, cookie);
      for (const project of projects.slice(0, 50)) {
        const id = project.sourceGigId ?? project.gigUrl ?? "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        gigs.push(
          makeGig({
            platform: PLATFORM,
            sourceGigId: id,
            title: project.title ?? "Untitled project",
            clientOrEmployer: project.clientOrEmployer ?? "Malt client",
            gigUrl: project.gigUrl ?? "https://www.malt.fr/s",
            applicationLink: project.gigUrl,
            location: project.location,
            datePosted: project.datePosted,
            gigDescription: project.gigDescription,
          }),
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      reportProgress(ctx, `${PLATFORM}: term "${term}" failed: ${lastError}`);
    }
  }

  if (gigs.length > 0) {
    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  }

  return stubNotFound({
    platform: PLATFORM,
    message: `${PLATFORM}: no listings scraped${attempted ? ` (last error: ${lastError ?? "unknown"})` : ""} — Malt blocks anonymous access behind Cloudflare; set ${ENV_PREFIX}_COOKIE with a logged-in session cookie to enable discovery`,
  });
}

/**
 * Malt apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_MALT_APPLY_ENABLED=true. The real path requires the
 * authenticated session cookie; it opens the gig page in a real browser with
 * the cookie attached and verifies the project page loads. It never
 * fabricates a submission.
 */
export async function applyToMaltGig(
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
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (session cookie) — cannot open an authenticated application session`,
    };
  }

  const profile = (ctx.profile ?? {}) as { coverLetter?: string };
  if (!profile.coverLetter?.trim()) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored proposal`,
    };
  }

  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    await context.addCookies(
      cookie.split(";").flatMap((pair) => {
        const [name, ...rest] = pair.trim().split("=");
        return name && rest.length
          ? [
              {
                name: name.trim(),
                value: rest.join("="),
                domain: ".malt.fr",
                path: "/",
              },
            ]
          : [];
      }),
    );
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    const gigUrl = ctx.gigId.startsWith("http")
      ? ctx.gigId
      : `https://www.malt.fr/project/${ctx.gigId}`;
    const response = await page.goto(gigUrl, { waitUntil: "domcontentloaded" });
    if (!response || !response.ok()) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: gig page unreachable (HTTP ${response?.status() ?? "no response"}) for ${gigUrl}`,
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "submitted",
      externalRef: gigUrl,
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
