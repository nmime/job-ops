import { reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "freelancer" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_FREELANCER";
const API_BASE = "https://www.freelancer.com/api";

/**
 * Freelancer.com — REAL credentialed adapter.
 *
 * Discovery uses the official public project-search API (no key required for
 * search). Bidding (the money path) requires an OAuth access token in
 * JOBOPS_FREELANCE_FREELANCER_API_KEY and is gated by the orchestrator's
 * three-gate safety model; ctx.dryRun is forced true unless that gate is open.
 */

type FreelancerProject = {
  id: number;
  title?: string;
  description?: string;
  preview_description?: string;
  budget?: { minimum?: number; maximum?: number; currency?: string };
  type?: string;
  currency?: { code?: string };
  jobs?: Array<{ name?: string }>;
  submitdate?: number;
  bids?: number;
  owner_id?: number;
};

function resolveApiKey(ctx: FreelanceFinderContext): string | undefined {
  return (
    ctx.settings[`${ENV_PREFIX}_API_KEY`] ??
    process.env[`${ENV_PREFIX}_API_KEY`] ??
    process.env.FREELANCER_API_KEY
  );
}

async function searchProjects(
  query: string,
  limit: number,
): Promise<FreelancerProject[]> {
  const url = new URL(`${API_BASE}/projects/0.1/projects/active`);
  url.searchParams.set("query", query);
  url.searchParams.set("compact", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("full_description", "false");
  for (const field of ["project_details", "jobs", "budget", "bid_stats"]) {
    url.searchParams.append("projects[]", field);
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": "JobOps-FreelanceAggregator/1.0",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Freelancer search HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: { projects?: FreelancerProject[] };
  };
  return json.result?.projects ?? [];
}

export async function findFreelancerGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: searching active projects`);

    const gigs: CreateGigInput[] = [];
    const seen = new Set<number>();
    const terms = ctx.searchTerms.length
      ? ctx.searchTerms
      : ["typescript", "react", "node"];

    for (const term of terms.slice(0, 5)) {
      try {
        const projects = await searchProjects(term, 50);
        for (const project of projects) {
          if (seen.has(project.id)) continue;
          seen.add(project.id);
          gigs.push({
            platform: PLATFORM,
            sourceGigId: String(project.id),
            title: project.title ?? "Untitled project",
            clientOrEmployer: `Freelancer client #${project.owner_id ?? "?"}`,
            gigUrl: `https://www.freelancer.com/projects/${project.id}`,
            applicationLink: `https://www.freelancer.com/projects/${project.id}/proposals`,
            budget:
              project.budget?.minimum != null
                ? `${project.budget.minimum}-${project.budget.maximum ?? ""} ${
                    project.currency?.code ?? project.budget?.currency ?? "USD"
                  }`
                : undefined,
            budgetMin: project.budget?.minimum,
            budgetMax: project.budget?.maximum,
            budgetCurrency:
              project.currency?.code ?? project.budget?.currency ?? undefined,
            budgetInterval: project.type === "hourly" ? "hourly" : "fixed",
            datePosted: project.submitdate
              ? new Date(project.submitdate * 1000).toISOString()
              : undefined,
            gigDescription:
              project.preview_description ?? project.description ?? undefined,
            skillsRequired: (project.jobs ?? [])
              .map((job) => job.name)
              .filter((name): name is string => Boolean(name)),
            proposalCount: project.bids,
            isRemote: true,
          });
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
 * Post a real bid via the Freelancer API. Only runs when dryRun is false,
 * which the orchestrator guarantees only after all three safety gates open.
 */
async function postBid(
  apiKey: string,
  projectId: string,
  bid: {
    amount: number;
    period: number;
    description: string;
  },
): Promise<{ bidId?: string }> {
  const res = await fetch(`${API_BASE}/projects/0.1/bids/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Freelancer-OAuth-V1": apiKey,
      "User-Agent": "JobOps-FreelanceAggregator/1.0",
    },
    body: JSON.stringify({
      project_id: Number(projectId),
      bidder_id: undefined,
      amount: bid.amount,
      period: bid.period,
      milestone_percentage: 0.2,
      description: bid.description,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Freelancer bid HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result?: { id?: number } };
  return {
    bidId: json.result?.id != null ? String(json.result.id) : undefined,
  };
}

/**
 * Freelancer.com apply adapter — REAL money path.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_FREELANCER_APPLY_ENABLED=true. A tailored proposal must be
 * present in ctx.profile before any real bid is attempted.
 */
export async function applyToFreelancerGig(
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

  const apiKey = resolveApiKey({
    settings: process.env as Record<string, string | undefined>,
  } as FreelanceFinderContext);
  if (!apiKey) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_API_KEY (OAuth token) — cannot bid`,
    };
  }

  const profile = (ctx.profile ?? {}) as {
    coverLetter?: string;
    proposedAmount?: number;
    proposedPeriod?: number;
  };
  const coverLetter = profile.coverLetter?.trim();
  if (!coverLetter) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored bid`,
    };
  }

  try {
    const result = await postBid(apiKey, ctx.gigId, {
      amount: profile.proposedAmount ?? 100,
      period: profile.proposedPeriod ?? 3,
      description: coverLetter,
    });
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "submitted",
      externalRef: result.bidId,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: bid failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
