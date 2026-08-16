import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceExportContext,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "wantapply" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_WANTAPPLY";
const BASE_URL = "https://wantapply.com";
const JOBS_API = `${BASE_URL}/api/jobs`;
const MAX_TERMS = 5;
const MAX_PAGES_PER_TERM = 5; // the API serves 20 jobs per page
const MAX_GIGS = 250;
const NAV_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Wantapply — REAL discovery adapter for a Cloudflare-gated public JSON feed.
 *
 * Verified live: wantapply.com is a remote/relocation job board whose frontend
 * is backed by a public JSON API:
 *
 *   GET https://wantapply.com/api/jobs?page=N&filters={"domain":"tech","search":"<term>"}
 *   -> { data: Job[20], hasNextPage: boolean, total: number }   (~2300 tech jobs)
 *
 * The API is anonymous (no credential required) but sits behind a Cloudflare
 * JS challenge that blocks plain HTTP clients (curl/requests/vanilla fetch all
 * get a 403 interstitial). Discovery therefore runs in two tiers:
 *
 *   1. direct fetch with browser-like headers (fast path — works when the
 *      egress IP already has a cf_clearance or CF does not challenge it);
 *   2. on any challenge/non-JSON answer, a headless Chromium context is
 *      launched, primed on the homepage so the JS challenge clears, and the
 *      same API is then read through the browser's request pipeline which
 *      carries the clearance cookie.
 *
 * Applying is NOT an in-platform action: every listing's Apply button
 * redirects to the employer's own external ATS form (verified live across
 * listings). `applyToWantapplyGig` is therefore guarded and never submits or
 * fakes a submission. `exportBatchToWantapply` remains available to push
 * scored gigs to an external auto-applier webhook.
 */

// --- Wire types (observed live payload shapes) ---

type WantapplyEntity = { name_en?: string | null; name?: string | null };

export type WantapplyJob = {
  id?: string | number;
  title?: string | null;
  description?: string | null;
  companyName?: string | null;
  url?: string | null;
  levels?: string[] | null;
  workplaceTypes?: string[] | null;
  jobLocations?: WantapplyEntity[] | null;
  jobRegions?: WantapplyEntity[] | null;
  employmentTypes?: string[] | null;
  remote?: boolean;
  salary?: string | null;
  salaryCurrency?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  publishedAt?: string | null;
  status?: string | null;
  isPlus?: boolean;
};

export type WantapplyJobsPage = {
  data?: WantapplyJob[] | null;
  hasNextPage?: boolean;
  total?: number;
};

// --- Transport seam (testability + two-tier fetching) ---

export type RawResponse = { status: number; body: string };

export type BrowserHandle = {
  get: (url: string) => Promise<RawResponse>;
  close: () => Promise<void>;
};

export type FetchSeam = {
  /** Tier 1: plain HTTP fetch (no browser). */
  direct: (url: string) => Promise<RawResponse>;
  /** Tier 2: launch a stealth browser, return a context-bound fetcher. */
  browser: () => Promise<BrowserHandle>;
};

let fetchSeamOverride: FetchSeam | null = null;

/** Test seam: replace the transport (avoids real network/browser in unit tests). */
export function __setWantapplyFetchSeamForTests(seam: FetchSeam | null): void {
  fetchSeamOverride = seam;
}

async function defaultDirectFetch(url: string): Promise<RawResponse> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE_URL}/`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Launch headless Chromium, prime the homepage so the Cloudflare JS
 * challenge clears (when present), then expose the context's request
 * pipeline which inherits the cf_clearance cookie.
 */
async function defaultBrowserHandle(): Promise<BrowserHandle> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: BROWSER_UA });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  } catch {
    // Navigation timeout on the challenge page is acceptable — the
    // challenge script may still set cf_clearance before we request.
  }
  try {
    await page.waitForFunction(
      () =>
        !/just a moment|attention required|cloudflare/i.test(
          `${document.title} ${(document.body?.innerText || "").slice(0, 500)}`,
        ),
      undefined,
      { timeout: 15_000 },
    );
  } catch {
    // Challenge markers still present — try anyway; some CF configs only
    // challenge non-browser TLS fingerprints, which this is not.
  }
  return {
    async get(url: string): Promise<RawResponse> {
      const res = await context.request.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await res.text();
      return { status: res.status(), body };
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}

function resolveSeam(): FetchSeam {
  if (fetchSeamOverride) return fetchSeamOverride;
  return { direct: defaultDirectFetch, browser: defaultBrowserHandle };
}

// --- Mapping helpers ---

function entityName(entity: WantapplyEntity): string {
  return (entity.name_en ?? entity.name ?? "").trim();
}

function capitalize(value: string): string {
  const spaced = value.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Convert listing HTML to readable plain text (no DOM dependency). */
export function stripHtml(html: string): string {
  return html
    .replace(/<\s*(\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol)\s*>/gi, "\n\n")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build the paginated jobs-API URL for one search term. */
export function wantapplyJobsUrl(term: string, page: number): string {
  const filters = encodeURIComponent(
    JSON.stringify({ domain: "tech", search: term }),
  );
  return `${JOBS_API}?page=${page}&filters=${filters}`;
}

function looksLikeJson(body: string): boolean {
  return body.trimStart().startsWith("{");
}

/** Map one API job to the normalized gig shape. Pure and exported for tests. */
export function mapJobToGig(job: WantapplyJob): CreateGigInput {
  const slug = (job.url ?? "").trim();
  const gigUrl = slug ? `${BASE_URL}/${slug}` : BASE_URL;
  const regions = (job.jobRegions ?? []).map(entityName).filter(Boolean);
  const countries = (job.jobLocations ?? []).map(entityName).filter(Boolean);
  const locationParts = [...new Set([...regions, ...countries])];
  const employment = (job.employmentTypes ?? []).filter(Boolean);
  const levels = (job.levels ?? []).filter(Boolean);
  const jobType =
    [...employment.map(capitalize), ...levels.map(capitalize)].join(" · ") ||
    undefined;
  const isRemote =
    job.remote === true || (job.workplaceTypes ?? []).includes("remote");
  const text = stripHtml(job.description ?? "");
  return makeGig({
    platform: PLATFORM,
    sourceGigId: job.id != null ? String(job.id) : slug,
    title: (job.title ?? "").trim() || "Untitled role",
    clientOrEmployer: (job.companyName ?? "").trim() || "Unknown company",
    gigUrl,
    applicationLink: gigUrl,
    budget: (job.salary ?? "").trim() || undefined,
    budgetMin: typeof job.salaryMin === "number" ? job.salaryMin : undefined,
    budgetMax: typeof job.salaryMax === "number" ? job.salaryMax : undefined,
    budgetCurrency: (job.salaryCurrency ?? "").trim() || undefined,
    datePosted: job.publishedAt ?? undefined,
    gigDescription: text.slice(0, 4000) || undefined,
    jobType,
    isRemote,
    location: locationParts.join(", ") || undefined,
  });
}

// --- Finder ---

export async function findWantapplyGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, MAX_TERMS);
    if (!terms.length) terms.push("");

    const seam = resolveSeam();
    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    let browserHandle: BrowserHandle | null = null;
    let useBrowser = false;

    const getPage = async (url: string): Promise<WantapplyJobsPage> => {
      if (!useBrowser) {
        let raw: RawResponse;
        try {
          raw = await seam.direct(url);
        } catch {
          raw = { status: 0, body: "direct fetch failed" };
        }
        if (raw.status === 200 && looksLikeJson(raw.body)) {
          return JSON.parse(raw.body) as WantapplyJobsPage;
        }
        // Challenge interstitial / non-JSON / network failure: switch tier.
        useBrowser = true;
      }
      if (!browserHandle) browserHandle = await seam.browser();
      const raw = await browserHandle.get(url);
      if (raw.status !== 200 || !looksLikeJson(raw.body)) {
        throw new Error(
          `jobs API unavailable via stealth browser (HTTP ${raw.status}) — Cloudflare challenge not cleared`,
        );
      }
      return JSON.parse(raw.body) as WantapplyJobsPage;
    };

    try {
      outer: for (const term of terms) {
        reportProgress(
          ctx,
          `${PLATFORM}: searching "${term || "(all tech jobs)"}" via ${JOBS_API}`,
        );
        for (let page = 1; page <= MAX_PAGES_PER_TERM; page++) {
          if (ctx.shouldCancel?.()) break outer;
          const data = await getPage(wantapplyJobsUrl(term, page));
          const jobs = data.data ?? [];
          let added = 0;
          for (const job of jobs) {
            if (gigs.length >= MAX_GIGS) break outer;
            const gig = mapJobToGig(job);
            const key = gig.sourceGigId ?? gig.gigUrl;
            if (seen.has(key)) continue;
            seen.add(key);
            gigs.push(gig);
            added++;
          }
          reportProgress(ctx, `${PLATFORM}: page ${page} (+${added})`);
          if (!data.hasNextPage) break;
        }
      }
    } finally {
      if (browserHandle) await browserHandle.close().catch(() => {});
    }

    if (!gigs.length) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: jobs API returned no listings — Cloudflare may be challenging this egress IP; retry later or run from a different network`,
      });
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: discovery failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

// --- Apply (guarded: no in-platform submission exists) ---

/**
 * Wantapply apply adapter.
 *
 * GUARDED BY DESIGN: verified live, wantapply has no application API — every
 * listing's Apply control redirects to the employer's own external ATS form.
 * The adapter therefore never submits anything itself: dry-run reports
 * skipped, and a non-dry-run call returns an honest error pointing at the
 * external form instead of faking a submission. Batch export to an external
 * auto-applier webhook is available via exportBatchToWantapply.
 */
export async function applyToWantapplyGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} has no in-platform apply API — applications are submitted on the employer's external ATS form linked from the listing page`,
    };
  }

  const listingUrl = ctx.gigId.startsWith("http")
    ? ctx.gigId
    : `${BASE_URL}/${ctx.gigId}`;

  return {
    platform: PLATFORM,
    mode: "submit",
    status: "error",
    error: `${PLATFORM}: no native application endpoint exists — the listing's Apply button redirects to the employer's own ATS form (verified live). Open ${listingUrl} and submit there manually; this adapter will never fake a submission`,
  };
}

// --- Batch export (external auto-applier webhook) ---

/**
 * Wantapply-style batch export.
 *
 * Produces a portable JSON payload of scored gigs that an external
 * auto-applier (Wantapply or equivalent) can consume. Dry-run by default;
 * a real POST happens only when a webhook URL is configured AND
 * JOBOPS_FREELANCE_WANTAPPLY_APPLY_ENABLED=true.
 */
export async function exportBatchToWantapply(
  ctx: FreelanceExportContext,
): Promise<FreelanceApplyResult> {
  const payload = {
    provider: "wantapply",
    exportedAt: new Date().toISOString(),
    dryRun: ctx.dryRun,
    gigCount: ctx.gigs.length,
    gigs: ctx.gigs,
  };

  const webhookUrl = ctx.webhookUrl ?? process.env[`${ENV_PREFIX}_WEBHOOK_URL`];

  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "exported",
      exportPayload: payload,
      error: webhookUrl
        ? undefined
        : `dry-run: no ${ENV_PREFIX}_WEBHOOK_URL configured`,
    };
  }

  if (!webhookUrl) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      exportPayload: payload,
      error: `${PLATFORM}: missing ${ENV_PREFIX}_WEBHOOK_URL — configure the external auto-applier webhook to export batches for real`,
    };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        exportPayload: payload,
        error: `wantapply webhook returned HTTP ${res.status}`,
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "exported",
      exportPayload: payload,
      externalRef: `wantapply-batch-${Date.now()}`,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      exportPayload: payload,
      error: `wantapply webhook failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
