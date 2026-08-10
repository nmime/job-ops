import type {
  CreateGigInput,
  FreelanceFinderContext,
  FreelanceFinderResult,
  FreelancePlatformId,
} from "job-ops-shared/types/freelance";

/** Build a normalized gig, dropping empty optional fields. */
export function makeGig(input: CreateGigInput): CreateGigInput {
  const out: CreateGigInput = {
    platform: input.platform,
    title: input.title.trim(),
    clientOrEmployer: input.clientOrEmployer.trim() || "Unknown client",
    gigUrl: input.gigUrl,
  };
  const optionalKeys = [
    "sourceGigId",
    "applicationLink",
    "budget",
    "budgetMin",
    "budgetMax",
    "budgetCurrency",
    "budgetInterval",
    "deadline",
    "datePosted",
    "gigDescription",
    "skillsRequired",
    "jobType",
    "isRemote",
    "location",
    "duration",
    "proposalCount",
    "verifiedClient",
  ] as const;
  for (const key of optionalKeys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic optional copy
      (out as any)[key] = value;
    }
  }
  return out;
}

/** Report an unimplemented finder without throwing (keeps the cycle alive). */
export function stubNotFound(input: {
  platform: FreelancePlatformId;
  message?: string;
}): FreelanceFinderResult {
  return {
    success: false,
    gigs: [],
    error: input.message ?? `stub: TODO implement ${input.platform} finder`,
  };
}

/** Progress callback helper. */
export function reportProgress(
  ctx: FreelanceFinderContext,
  detail: string,
  currentUrl?: string,
): void {
  ctx.onProgress?.({ phase: "list", detail, currentUrl });
}

/** Normalize a search term for platform query strings. */
export function normalizeTerm(term: string): string {
  return term.trim().replace(/\s+/g, "+");
}

/** Abort-aware fetch wrapper with timeout. */
export async function fetchWithTimeout(
  url: string,
  timeoutMs = 15_000,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const FREELANCE_USER_AGENT = "job-ops-freelance-aggregator/0.11";
