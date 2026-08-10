import {
  FREELANCE_USER_AGENT,
  fetchWithTimeout,
  makeGig,
  reportProgress,
} from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const WWR_BASE = "https://weworkremotely.com";

/** Categories aggregated; each maps to a public RSS feed. */
const WWR_CATEGORY_FEEDS = [
  "remote-programming-jobs",
  "remote-full-stack-programming-jobs",
  "remote-design-jobs",
  "remote-devops-sysadmin-jobs",
] as const;

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  region?: string;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Minimal dependency-free RSS parser (handles the WWR feed shape). */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null = itemRe.exec(xml);
  while (match !== null) {
    const body = match[1];
    const grab = (tag: string): string | undefined => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeXmlEntities(m[1].trim()) : undefined;
    };
    items.push({
      title: grab("title"),
      link: grab("link"),
      description: grab("description"),
      pubDate: grab("pubDate"),
      region: grab("region"),
    });
    match = itemRe.exec(xml);
  }
  return items;
}

export function toGig(item: RssItem, category: string): CreateGigInput | null {
  if (!item.title || !item.link) return null;
  // WWR titles look like "Company: Position"
  const colonIndex = item.title.indexOf(":");
  const company =
    colonIndex > 0
      ? item.title.slice(0, colonIndex).trim()
      : "We Work Remotely client";
  const title =
    colonIndex > 0 ? item.title.slice(colonIndex + 1).trim() : item.title;

  return makeGig({
    platform: "weworkremotely",
    sourceGigId: item.link,
    title,
    clientOrEmployer: company,
    gigUrl: item.link,
    applicationLink: item.link,
    gigDescription: item.description,
    datePosted: item.pubDate,
    isRemote: true,
    jobType: category,
    location: item.region || "Remote",
  });
}

/**
 * REAL We Work Remotely finder — public RSS feeds per category,
 * no credentials required.
 */
export async function findWwrGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const terms = ctx.searchTerms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const allGigs: CreateGigInput[] = [];
  let lastError: string | null = null;

  for (const category of WWR_CATEGORY_FEEDS) {
    if (ctx.shouldCancel?.()) break;
    const url = `${WWR_BASE}/categories/${category}.rss`;
    reportProgress(ctx, `Fetching WWR feed ${category}`, url);
    try {
      const res = await fetchWithTimeout(url, 20_000, {
        headers: {
          "User-Agent": FREELANCE_USER_AGENT,
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      });
      if (!res.ok) {
        lastError = `WWR feed ${category} returned HTTP ${res.status}`;
        continue;
      }
      const xml = await res.text();
      for (const item of parseRss(xml)) {
        if (terms.length > 0) {
          const haystack =
            `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
          if (!terms.some((term) => haystack.includes(term))) continue;
        }
        const gig = toGig(item, category);
        if (gig) allGigs.push(gig);
      }
    } catch (error) {
      lastError = `WWR feed ${category} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  reportProgress(ctx, `WWR returned ${allGigs.length} gigs`);
  if (allGigs.length === 0 && lastError) {
    return { success: false, gigs: [], error: lastError };
  }
  return { success: true, gigs: allGigs };
}
