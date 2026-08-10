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

const REMOTEOK_API = "https://remoteok.com/api";

interface RemoteOkJob {
  id?: string;
  slug?: string;
  position?: string;
  company?: string;
  tags?: string[];
  location?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string;
  description?: string;
  date?: string;
}

function toGig(job: RemoteOkJob): CreateGigInput | null {
  const title = job.position?.trim();
  const url = job.url;
  if (!title || !url) return null;

  const budgetMin = job.salary_min ?? undefined;
  const budgetMax = job.salary_max ?? undefined;
  const budget =
    budgetMin !== undefined || budgetMax !== undefined
      ? `${budgetMin !== undefined ? `$${budgetMin}` : "?"}-${budgetMax !== undefined ? `$${budgetMax}` : "?"}`
      : undefined;

  return makeGig({
    platform: "remoteok",
    sourceGigId: job.id ?? job.slug,
    title,
    clientOrEmployer: job.company?.trim() || "RemoteOK client",
    gigUrl: url,
    applicationLink: url,
    budget,
    budgetMin,
    budgetMax,
    budgetCurrency: budget ? "USD" : undefined,
    skillsRequired: job.tags?.slice(0, 20),
    location: job.location || "Remote",
    isRemote: true,
    datePosted: job.date,
    gigDescription: job.description,
    jobType: "remote",
  });
}

/**
 * REAL RemoteOK finder — public JSON API (https://remoteok.com/api),
 * no credentials required. Search terms filter client-side across
 * title / company / tags / description.
 */
export async function findRemoteOkGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  reportProgress(ctx, "Fetching RemoteOK API", REMOTEOK_API);
  try {
    const res = await fetchWithTimeout(REMOTEOK_API, 20_000, {
      headers: { "User-Agent": FREELANCE_USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        success: false,
        gigs: [],
        error: `RemoteOK API returned HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      return {
        success: false,
        gigs: [],
        error: "RemoteOK API returned an unexpected payload shape",
      };
    }

    const terms = ctx.searchTerms
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);

    let jobs = (data as RemoteOkJob[]).filter(
      (job) => job && typeof job === "object" && Boolean(job.position),
    );

    if (terms.length > 0) {
      jobs = jobs.filter((job) => {
        const haystack = [
          job.position ?? "",
          job.company ?? "",
          (job.tags ?? []).join(" "),
          job.description ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return terms.some((term) => haystack.includes(term));
      });
    }

    const gigs = jobs
      .map(toGig)
      .filter((gig): gig is CreateGigInput => gig !== null);

    reportProgress(ctx, `RemoteOK returned ${gigs.length} gigs`);
    return { success: true, gigs };
  } catch (error) {
    return {
      success: false,
      gigs: [],
      error: `RemoteOK fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
