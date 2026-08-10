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

const PLATFORM = "gun-io" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_GUN_IO";
const LIST_URL = "https://gun.io/jobs/";
const BASE_URL = "https://gun.io";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Gun.io — REAL adapter.
 *
 * Gun.io has no public JSON API (gun.io/api/* 404s), but
 * https://gun.io/jobs/ is a server-rendered WordPress page whose "Latest
 * Jobs" section lists vetted roles as static cards:
 *   <div class="card-default ..."><h2>TITLE</h2><p>DESCRIPTION</p>
 *   <span>SKILL</span>...</div>
 * Discovery parses those cards out of the HTML (no credentials needed) and
 * filters them against ctx.searchTerms on title + description + skills.
 * If the parse yields nothing it returns a structured not-configured result
 * naming JOBOPS_FREELANCE_GUN_IO_API_KEY.
 *
 * Applying is only possible after joining the Gun.io network (screening +
 * intro call), so the submit path is credential-gated.
 */

type GunIoCard = {
  title: string;
  description?: string;
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
    .replace(/&#0?39;|&apos;|&#039;/g, "'")
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

/** Parse the job cards out of the server-rendered gun.io/jobs page. */
export function parseGunIoJobCards(html: string): GunIoCard[] {
  const cards: GunIoCard[] = [];
  const segments = html.split(/<div class="card-default[^"]*"[^>]*>/).slice(1);
  for (const segment of segments) {
    const titleMatch = segment.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!titleMatch) continue;
    const title = stripTags(titleMatch[1]);
    if (!title) continue;
    const descMatch = segment.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const skills = [...segment.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    cards.push({
      title,
      description: descMatch ? stripTags(descMatch[1]) || undefined : undefined,
      skills,
    });
  }
  return cards;
}

function matchesTerms(card: GunIoCard, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = [card.title, card.description ?? "", ...card.skills]
    .join(" ")
    .toLowerCase();
  return terms.some((term) => haystack.includes(term.trim().toLowerCase()));
}

function toGig(card: GunIoCard, index: number): CreateGigInput {
  const sourceGigId = `gunio-${index}-${card.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60)}`;
  return {
    platform: PLATFORM,
    sourceGigId,
    title: card.title,
    clientOrEmployer: "Gun.io client",
    gigUrl: LIST_URL,
    applicationLink: "https://app.gun.io/sign-up/",
    gigDescription: card.description,
    skillsRequired: card.skills,
    jobType: "contract",
    isRemote: true,
    verifiedClient: true,
  };
}

export async function findGunIoGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching public jobs page`);
    const res = await fetchWithTimeout(LIST_URL, 15_000, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    if (!res.ok) {
      throw new Error(`Gun.io jobs page HTTP ${res.status}`);
    }
    const html = await res.text();

    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 5);

    const cards = parseGunIoJobCards(html);
    if (!cards.length) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: no job cards parsed from ${LIST_URL} (layout may have changed) — set ${ENV_PREFIX}_API_KEY or ${ENV_PREFIX}_COOKIE for an authenticated feed if available`,
      });
    }

    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const card of cards) {
      index++;
      if (!matchesTerms(card, terms)) continue;
      const gig = toGig(card, index);
      if (seen.has(gig.sourceGigId ?? "")) continue;
      seen.add(gig.sourceGigId ?? "");
      gigs.push(gig);
    }

    reportProgress(
      ctx,
      `${PLATFORM} returned ${gigs.length} gigs (of ${cards.length} listed)`,
    );
    return { success: true, gigs: gigs.slice(0, 50) };
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
 * Gun.io apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_GUN_IO_APPLY_ENABLED=true. Gun.io matches freelancers to
 * clients manually after a screening + intro call — there is no self-serve
 * apply endpoint, so a real submit is impossible without network membership.
 */
export async function applyToGunIoGig(
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

  const { apiKey, cookie } = resolveCredential(
    process.env as Record<string, string | undefined>,
  );
  if (!apiKey && !cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_API_KEY (Gun.io network membership) — cannot apply`,
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

  return {
    platform: PLATFORM,
    mode: "submit",
    status: "error",
    error: `${PLATFORM}: Gun.io has no self-serve apply API — roles are matched manually after network screening; express interest at ${BASE_URL}/jobs/ or via your Gun.io talent manager`,
  };
}
