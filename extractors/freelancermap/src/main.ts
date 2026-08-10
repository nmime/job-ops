import {
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

const PLATFORM = "freelancermap" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_FREELANCERMAP";
const SEARCH_URL = "https://www.freelancermap.com/projects";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * freelancermap — REAL adapter.
 *
 * freelancermap.com serves its public project search to plain HTTP clients
 * as long as a browser User-Agent is sent. Discovery tries two real paths,
 * in order:
 *
 *  1. CREDENTIAL-FREE fetch of the public project search
 *     (freelancermap.com/projects?query=<term>). The server-rendered page
 *     embeds a structured JSON state blob (react-on-rails) with the full
 *     project list; we parse that instead of scraping DOM cards. If plain
 *     HTTP is blocked we fall back to loading the same page in a real
 *     browser via Playwright.
 *  2. The official freelancermap API for paying members when
 *     ${ENV_PREFIX}_API_KEY is configured (Bearer token against
 *     https://www.freelancermap.de/api — the documented member API).
 *
 * If neither yields listings we return a clean not-configured result naming
 * ${ENV_PREFIX}_API_KEY. No data is ever fabricated.
 */

type ParsedProject = {
  sourceGigId?: string;
  title?: string;
  clientOrEmployer?: string;
  gigUrl?: string;
  location?: string;
  datePosted?: string;
  gigDescription?: string;
  skillsRequired?: string[];
  isRemote?: boolean;
  budget?: string;
  jobType?: string;
};

/** Raw project shape inside the react-on-rails embedded state. */
type FmEmbeddedProject = {
  id?: number | string;
  slug?: string;
  title?: string;
  description?: string;
  company?: string;
  city?: string;
  country?: string | { nameEn?: string; nameDe?: string };
  locations?: Array<{ city?: string; country?: string }>;
  created?: string;
  updated?: string;
  url?: string;
  plink?: string;
  budget?: string | number;
  durationText?: string;
  beginningText?: string;
  contractType?: string | { nameEn?: string; nameDe?: string };
  remoteInPercent?: number;
  skills?: Array<string | { name?: string; nameEn?: string }>;
  subCategories?: Array<string | { nameEn?: string; nameDe?: string }>;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const namedText = (value: unknown): string | undefined => {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return text(rec.nameEn) ?? text(rec.nameDe) ?? text(rec.name);
  }
  return undefined;
};

function embeddedToParsed(project: FmEmbeddedProject): ParsedProject {
  const id = project.id != null ? String(project.id) : undefined;
  const slug = text(project.slug);
  const gigUrl =
    text(project.url) ??
    text(project.plink) ??
    (slug ? `https://www.freelancermap.com/project/${slug}` : undefined);
  const location =
    project.locations
      ?.map((l) => [l.city, l.country].filter(Boolean).join(", "))
      .filter(Boolean)
      .join("; ") ??
    [text(project.city), namedText(project.country)].filter(Boolean).join(", ");
  return {
    sourceGigId: id ?? gigUrl,
    title: text(project.title),
    clientOrEmployer: text(project.company),
    gigUrl,
    location: location || undefined,
    datePosted: text(project.created) ?? text(project.updated),
    gigDescription: text(project.description),
    skillsRequired: (project.skills ?? project.subCategories ?? [])
      .map(namedText)
      .filter((s): s is string => Boolean(s)),
    isRemote:
      project.remoteInPercent != null
        ? project.remoteInPercent >= 100
        : undefined,
    budget:
      project.budget != null && project.budget !== ""
        ? String(project.budget)
        : undefined,
    jobType: namedText(project.contractType),
  };
}

/**
 * Extract the embedded react-on-rails state from the server-rendered search
 * page HTML. The largest application/json script holds initialState with the
 * full project list.
 */
function parseEmbeddedProjects(html: string): ParsedProject[] {
  const out: ParsedProject[] = [];
  const scriptRe =
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(scriptRe)) {
    const body = match[1];
    if (!body.includes('"projects"')) continue;
    try {
      const data = JSON.parse(body) as {
        initialState?: { result?: { projects?: FmEmbeddedProject[] } };
      };
      for (const project of data.initialState?.result?.projects ?? []) {
        out.push(embeddedToParsed(project));
      }
    } catch {
      // a JSON script that is not the search state — ignore it
    }
  }
  return out;
}

/** Fast path: plain HTTP fetch of the public search page (browser UA). */
async function fetchProjectsHtml(term: string): Promise<string> {
  const url = `${SEARCH_URL}?query=${encodeURIComponent(term)}`;
  const res = await fetchWithTimeout(url, 20_000, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`freelancermap search HTTP ${res.status}`);
  }
  return res.text();
}

/** Fallback: load the same page in a real browser when HTTP is blocked. */
async function fetchProjectsHtmlViaBrowser(term: string): Promise<string> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    const response = await page.goto(
      `${SEARCH_URL}?query=${encodeURIComponent(term)}`,
      { waitUntil: "domcontentloaded" },
    );
    if (!response || !response.ok()) {
      throw new Error(
        `freelancermap browser search HTTP ${response?.status() ?? "no response"}`,
      );
    }
    return await page.content();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/** Credential-free public search: HTML state blob, browser fallback. */
async function searchPublicListing(term: string): Promise<ParsedProject[]> {
  let html: string | undefined;
  try {
    html = await fetchProjectsHtml(term);
  } catch {
    html = await fetchProjectsHtmlViaBrowser(term);
  }
  return parseEmbeddedProjects(html);
}

/** Official member API (paying members only). Bearer token auth. */
async function searchMemberApi(
  apiKey: string,
  term: string,
): Promise<ParsedProject[]> {
  const url = `https://www.freelancermap.de/api/projects?query=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": BROWSER_UA,
    },
  });
  if (!res.ok) {
    throw new Error(`freelancermap API HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    projects?: Array<{
      id?: number | string;
      title?: string;
      description?: string;
      company?: string;
      location?: string;
      created?: string;
      url?: string;
      skills?: string[];
    }>;
  };
  return (json.projects ?? []).map((p) => ({
    sourceGigId: p.id != null ? String(p.id) : p.url,
    title: p.title,
    clientOrEmployer: p.company,
    gigUrl: p.url,
    location: p.location,
    datePosted: p.created,
    gigDescription: p.description,
    skillsRequired: p.skills,
  }));
}

export async function findFreelancermapGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const apiKey =
    ctx.settings[`${ENV_PREFIX}_API_KEY`] ??
    process.env[`${ENV_PREFIX}_API_KEY`];

  const terms = ctx.searchTerms
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);
  const gigs: CreateGigInput[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  const pushProject = (project: ParsedProject) => {
    const id = project.sourceGigId ?? project.gigUrl ?? "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    gigs.push(
      makeGig({
        platform: PLATFORM,
        sourceGigId: id,
        title: project.title ?? "Untitled project",
        clientOrEmployer: project.clientOrEmployer ?? "freelancermap client",
        gigUrl: project.gigUrl ?? SEARCH_URL,
        applicationLink: project.gigUrl,
        location: project.location,
        datePosted: project.datePosted,
        gigDescription: project.gigDescription,
        skillsRequired: project.skillsRequired,
        isRemote: project.isRemote,
        budget: project.budget,
        jobType: project.jobType,
      }),
    );
  };

  // Path 1: official member API when a key is configured.
  if (apiKey) {
    for (const term of terms) {
      try {
        reportProgress(ctx, `${PLATFORM}: member API search "${term}"`);
        const projects = await searchMemberApi(apiKey, term);
        for (const project of projects.slice(0, 50)) pushProject(project);
      } catch (error) {
        errors.push(
          `member API "${term}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Path 2: credential-free public listing (embedded state, per term).
  if (gigs.length === 0) {
    for (const term of terms.length ? terms : [""]) {
      try {
        reportProgress(ctx, `${PLATFORM}: public search "${term || "all"}"`);
        const projects = await searchPublicListing(term);
        for (const project of projects.slice(0, 50)) pushProject(project);
      } catch (error) {
        errors.push(
          `public search "${term}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (gigs.length > 0) {
    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  }

  return stubNotFound({
    platform: PLATFORM,
    message: `${PLATFORM}: no listings found (${errors.join("; ") || "no source reachable"}) — set ${ENV_PREFIX}_API_KEY to use the official freelancermap member API (available to paying members)`,
  });
}

/**
 * freelancermap apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_FREELANCERMAP_APPLY_ENABLED=true. The real path requires
 * the member API key; without it the submit returns a clean actionable
 * error. It never fabricates a submission.
 */
export async function applyToFreelancermapGig(
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

  const apiKey = process.env[`${ENV_PREFIX}_API_KEY`];
  if (!apiKey) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_API_KEY (official member API key, paying members only) — cannot apply`,
    };
  }

  const profile = (ctx.profile ?? {}) as { coverLetter?: string };
  if (!profile.coverLetter?.trim()) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored application`,
    };
  }

  try {
    const res = await fetch(
      `https://www.freelancermap.de/api/projects/${encodeURIComponent(ctx.gigId)}/applications`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": BROWSER_UA,
        },
        body: JSON.stringify({ message: profile.coverLetter.trim() }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: apply HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      id?: number | string;
    };
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "submitted",
      externalRef: json.id != null ? String(json.id) : ctx.gigId,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: apply failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
