import { logger } from "@infra/logger";
import {
  FREELANCE_PLATFORM_IDS,
  type CreateGigInput,
  type FreelanceAggregatorCycleResult,
  type FreelanceFinderContext,
  type FreelancePlatformId,
  type FreelanceProviderManifest,
} from "@shared/types/freelance";
import { dedupeGigs, heuristicGigScore, rankGigs } from "./dedupe";
import { getFreelanceProviderRegistry } from "./registry";

export interface AggregatorRunOptions {
  platforms?: FreelancePlatformId[];
  searchTerms?: string[];
  selectedCountry?: string;
  profileSkills?: string[];
  minScore?: number;
  maxGigsPerPlatform?: number;
  shouldCancel?: () => boolean;
  onProgress?: (event: {
    platform: FreelancePlatformId;
    phase: "start" | "done" | "error";
    found?: number;
    detail?: string;
  }) => void;
}

export interface AggregatedGig extends CreateGigInput {
  dedupHash: string;
  suitabilityScore: number | null;
}

export interface AggregatorRunResult extends FreelanceAggregatorCycleResult {
  gigs: AggregatedGig[];
}

/** True when the aggregator is allowed to auto-bid (default: false). */
export function isFreelanceAutobidEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.FREELANCE_AUTOBID_ENABLED === "true";
}

/** Platforms the aggregator will poll, honoring an explicit allowlist env. */
export function resolveEnabledPlatforms(
  env: NodeJS.ProcessEnv = process.env,
): FreelancePlatformId[] {
  const raw = env.JOBOPS_FREELANCE_PLATFORMS?.trim();
  const all = FREELANCE_PLATFORM_IDS.filter((id) => id !== "aggregator-core");
  if (!raw) return [...all];
  const requested = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return all.filter((id) => requested.includes(id));
}

async function runFinder(
  manifest: FreelanceProviderManifest,
  options: AggregatorRunOptions,
): Promise<{ platform: FreelancePlatformId; success: boolean; gigs: CreateGigInput[]; error?: string }> {
  const platform = manifest.id;
  options.onProgress?.({ platform, phase: "start" });

  const ctx: FreelanceFinderContext = {
    platform,
    searchTerms: options.searchTerms ?? [],
    selectedCountry: options.selectedCountry ?? "",
    settings: process.env as Record<string, string | undefined>,
    shouldCancel: options.shouldCancel,
    onProgress: (event) => {
      options.onProgress?.({ platform, phase: "start", detail: event.detail });
    },
  };

  try {
    const result = await manifest.findGigs(ctx);
    const limit = options.maxGigsPerPlatform ?? 200;
    const gigs = result.gigs.slice(0, limit);
    options.onProgress?.({
      platform,
      phase: result.success ? "done" : "error",
      found: gigs.length,
      detail: result.error,
    });
    return {
      platform,
      success: result.success,
      gigs,
      error: result.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Freelance finder threw", { platform, error: message });
    options.onProgress?.({ platform, phase: "error", detail: message });
    return { platform, success: false, gigs: [], error: message };
  }
}

/**
 * One full aggregator cycle: discover across every enabled platform in
 * parallel -> dedupe (exact + fuzzy) -> score -> rank -> filter by minScore.
 *
 * A failing platform never aborts the cycle; it is reported in perPlatform.
 */
export async function runAggregatorCycle(
  options: AggregatorRunOptions = {},
): Promise<AggregatorRunResult> {
  const startedAt = new Date().toISOString();
  const registry = await getFreelanceProviderRegistry();

  const requested = options.platforms ?? resolveEnabledPlatforms();
  const manifests = requested
    .map((id) => registry.manifests.get(id))
    .filter((m): m is FreelanceProviderManifest => m !== undefined);

  logger.info("Freelance aggregator cycle starting", {
    platforms: manifests.map((m) => m.id),
  });

  const results = await Promise.all(
    manifests.map((manifest) => runFinder(manifest, options)),
  );

  const allGigs = results.flatMap((result) => result.gigs);
  const { unique, duplicatesRemoved, fuzzyMerges } = dedupeGigs(allGigs);

  const scored: AggregatedGig[] = unique.map((gig) => ({
    ...gig,
    suitabilityScore: heuristicGigScore(gig, options.profileSkills ?? []),
  }));

  const minScore = options.minScore ?? 0;
  const ranked = rankGigs(scored).filter(
    (gig) => (gig.suitabilityScore ?? 0) >= minScore,
  );

  const finishedAt = new Date().toISOString();
  const cycle: AggregatorRunResult = {
    startedAt,
    finishedAt,
    discovered: allGigs.length,
    deduped: duplicatesRemoved + fuzzyMerges,
    scored: scored.length,
    enqueued: ranked.length,
    perPlatform: results.map((result) => ({
      platform: result.platform,
      success: result.success,
      found: result.gigs.length,
      error: result.error,
    })),
    gigs: ranked,
  };

  logger.info("Freelance aggregator cycle complete", {
    discovered: cycle.discovered,
    deduped: cycle.deduped,
    enqueued: cycle.enqueued,
    autobid: isFreelanceAutobidEnabled(),
  });

  return cycle;
}
