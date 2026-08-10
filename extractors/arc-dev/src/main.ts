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

const PLATFORM = "arc-dev" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_ARC_DEV";
const LIST_URL = "https://arc.dev/remote-jobs";
const BASE_URL = "https://arc.dev";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PER_TERM_CAP = 50;

/**
 * Arc.dev — REAL adapter.
 *
 * Arc.dev exposes no public JSON API (arc.dev/api/* is dead), but the
 * server-rendered listing pages at https://arc.dev/remote-jobs and
 * https://arc.dev/remote-jobs/<term> contain fully populated job cards
 * (data-testid="job-card") in plain HTML. Discovery fetches one page per
 * search term with a browser User-Agent and parses the cards with regexes.
 * If the fetch or parse yields nothing, it falls back to a Playwright pass,
 * and finally to a structured not-configured result naming
 * JOBOPS_FREELANCE_ARC_DEV_COOKIE.
 *
 * Applying requires an authenticated Arc session, so the submit path is
 * credential-gated behind JOBOPS_FREELANCE_ARC_DEV_COOKIE.
 */

type ArcCard = {
  id: string;
  title: string;
  url: string;
  company?: string;
  jobType?: string;
  experienceLevel?: string;
  rateType?: string;
  skills: string[];
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

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function tagText(card: string, cls: string): string | undefined {
  const match = card.match(
    new RegExp(
      `class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:div|span|a)>`,
    ),
  );
  return match ? stripTags(match[1]) || undefined : undefined;
}

/** Parse the server-rendered job cards out of an arc.dev listing page. */
export function parseArcJobCards(html: string): ArcCard[] {
  const cards: ArcCard[] = [];
  // Each card opens with data-testid="job-card"; the next card (or the
  // pagination block) terminates it.
  const segments = html.split('data-testid="job-card"').slice(1);
  for (const raw of segments) {
    const segment = raw.split('data-testid="job-card"')[0];
    const link = segment.match(
      /<a[^>]*class="[^"]*\bjob-title\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!link) continue;
    const [, href, titleHtml] = link;
    const title = stripTags(titleHtml);
    if (!title) continue;
    const idMatch = href.match(/-([a-z0-9]{10})(?:[/?#]|$)/i);
    const skills = [
      ...segment.matchAll(
        /data-testid="category"[^>]*>([\s\S]*?)<\/(?:a|div)>/g,
      ),
    ]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    cards.push({
      id: idMatch?.[1] ?? href,
      title,
      url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
      company: tagText(segment, "company-name"),
      jobType: tagText(segment, "job-type"),
      experienceLevel: tagText(segment, "experience-level"),
      rateType: tagText(segment, "contract-rate"),
      skills,
    });
  }
  return cards;
}

function matchesTerms(card: ArcCard, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [card.title, card.company ?? "", ...card.skills]
    .join(" ")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

function toGig(card: ArcCard): CreateGigInput {
  return {
    platform: PLATFORM,
    sourceGigId: card.id,
    title: card.title,
    clientOrEmployer: card.company ?? "Arc.dev client",
    gigUrl: card.url,
    applicationLink: card.url,
    budget: card.rateType,
    budgetInterval: /hour/i.test(card.rateType ?? "") ? "hourly" : undefined,
    gigDescription:
      [card.jobType, card.experienceLevel, card.rateType]
        .filter(Boolean)
        .join(" · ") || undefined,
    skillsRequired: card.skills,
    jobType: card.jobType,
    isRemote: true,
  };
}

async function fetchListingHtml(term?: string): Promise<string> {
  const url = term
    ? `${LIST_URL}/${encodeURIComponent(term.trim().toLowerCase().replace(/\s+/g, "-"))}`
    : LIST_URL;
  const res = await fetchWithTimeout(url, 15_000, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`Arc.dev listing HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/** Playwright fallback — only used when the plain HTML fetch yields no cards. */
async function scrapeWithBrowser(
  ctx: FreelanceFinderContext,
  cookie?: string,
): Promise<ArcCard[]> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    if (cookie) {
      const cookies = cookie.split(";").flatMap((pair) => {
        const [name, ...rest] = pair.trim().split("=");
        return name
          ? [{ name, value: rest.join("="), domain: ".arc.dev", path: "/" }]
          : [];
      });
      if (cookies.length) await context.addCookies(cookies);
    }
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="job-card"]', { timeout: 15_000 });
    const html = await page.content();
    return parseArcJobCards(html);
  } catch (error) {
    reportProgress(
      ctx,
      `${PLATFORM}: browser fallback failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

export async function findArcDevGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    const { cookie } = resolveCredential(ctx.settings);
    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 5);

    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();

    if (terms.length) {
      for (const term of terms) {
        try {
          const html = await fetchListingHtml(term);
          let cards = parseArcJobCards(html);
          if (!cards.length) {
            reportProgress(
              ctx,
              `${PLATFORM}: no cards for "${term}", retrying base listing`,
            );
            cards = parseArcJobCards(await fetchListingHtml());
          }
          let added = 0;
          for (const card of cards) {
            if (added >= PER_TERM_CAP) break;
            if (seen.has(card.id)) continue;
            if (!matchesTerms(card, term)) continue;
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
    }

    if (!gigs.length) {
      reportProgress(ctx, `${PLATFORM}: HTML fetch empty, trying browser`);
      for (const card of await scrapeWithBrowser(ctx, cookie)) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        gigs.push(toGig(card));
      }
    }

    if (!gigs.length) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: no job cards parsed from ${LIST_URL} (layout may have changed or the page is bot-gated) — set ${ENV_PREFIX}_COOKIE with an authenticated session to scrape reliably`,
      });
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
 * Arc.dev apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_ARC_DEV_APPLY_ENABLED=true. Arc.dev has no public apply
 * API — a real submit needs an authenticated session cookie and drives the
 * job page apply flow in a browser.
 */
export async function applyToArcDevGig(
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

  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    const cookies = cookie.split(";").flatMap((pair) => {
      const [name, ...rest] = pair.trim().split("=");
      return name
        ? [{ name, value: rest.join("="), domain: ".arc.dev", path: "/" }]
        : [];
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    await page.goto(`${BASE_URL}/remote-jobs/details/${ctx.gigId}`, {
      waitUntil: "domcontentloaded",
    });
    const applyButton = page
      .getByRole("button", { name: /apply/i })
      .or(page.getByRole("link", { name: /apply/i }))
      .first();
    if (!(await applyButton.count())) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: no apply control found on the job page (session may be invalid)`,
      };
    }
    await applyButton.click({ timeout: 10_000 });
    const letterField = page
      .getByRole("textbox", { name: /cover|message|note/i })
      .or(page.locator("textarea").first());
    if (await letterField.count()) {
      await letterField.fill(coverLetter);
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
