import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { getExtractorRegistry } from "@server/extractors/registry";
import { getAllJobUrls } from "@server/repositories/jobs";
import * as settingsRepo from "@server/repositories/settings";
import { buildFallbackSearchTerms } from "@server/services/onboarding-search-terms";
import { getProfile } from "@server/services/profile";
import { asyncPool } from "@server/utils/async-pool";
import type { ExtractorSourceId } from "@shared/extractors";
import { matchJobLocationIntent } from "@shared/job-matching.js";
import {
  buildLocationEvidence as buildSharedLocationEvidence,
  createLocationIntentFromLegacyInputs,
  getPrimaryLocationLabel,
  planLocationSource,
} from "@shared/location-domain.js";
import { formatCountryLabel } from "@shared/location-support.js";
import { normalizeStringArray } from "@shared/normalize-string-array.js";
import type { CreateJobInput, PipelineConfig } from "@shared/types";
import { normalizeSearchTerms } from "@shared/utils/search-terms";
import {
  type CrawlSource,
  type PendingChallenge,
  progressHelpers,
  updateProgress,
} from "../progress";

const DISCOVERY_CONCURRENCY = 3;

type DiscoveryTaskResult = {
  source: CrawlSource;
  selectedSources: ExtractorSourceId[];
  discoveredJobs: CreateJobInput[];
  sourceErrors: string[];
  challenge?: PendingChallenge;
};

type DiscoverySourceTask = {
  source: CrawlSource;
  selectedSources: ExtractorSourceId[];
  termsTotal?: number;
  detail: string;
  run: () => Promise<DiscoveryTaskResult>;
};

function parseBlockedCompanyKeywords(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeStringArray(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  } catch {
    return [];
  }
}

function parseWorkplaceTypes(
  raw: string | undefined,
): Array<"remote" | "hybrid" | "onsite"> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is "remote" | "hybrid" | "onsite" =>
        value === "remote" || value === "hybrid" || value === "onsite",
    );
  } catch {
    return [];
  }
}

function parseConfiguredSearchTerms(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeSearchTerms(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  } catch {
    return [];
  }
}

function parseEnvSearchTerms(): string[] {
  return normalizeSearchTerms(
    (process.env.JOBSPY_SEARCH_TERMS || "web developer")
      .split("|")
      .map((term) => term.trim())
      .filter(Boolean),
  );
}

async function getResumeSearchTerms(): Promise<string[]> {
  try {
    const profile = await getProfile();
    return buildFallbackSearchTerms(profile).terms;
  } catch (error) {
    logger.warn("Could not extract search terms from resume profile", {
      step: "discover-jobs",
      error,
    });
    return [];
  }
}

async function resolveSearchTerms(
  settings: Record<string, string | undefined>,
) {
  const configuredTerms = parseConfiguredSearchTerms(settings.searchTerms);
  const resumeTerms = await getResumeSearchTerms();
  const mergedTerms = normalizeSearchTerms([
    ...configuredTerms,
    ...resumeTerms,
  ]);
  if (mergedTerms.length > 0) return mergedTerms;
  return parseEnvSearchTerms();
}

function isBlockedEmployer(
  employer: string | null | undefined,
  blockedKeywordsLowerCase: string[],
): boolean {
  if (!employer) return false;
  if (blockedKeywordsLowerCase.length === 0) return false;
  const normalizedEmployer = employer.toLowerCase();
  return blockedKeywordsLowerCase.some((keyword) =>
    normalizedEmployer.includes(keyword),
  );
}

function getLegacyLocationSelection(
  intent: NonNullable<PipelineConfig["locationIntent"]>,
): string {
  return intent.selectedCountry ?? "";
}

function getSourceLocationPlan(
  source: CrawlSource,
  intent: NonNullable<PipelineConfig["locationIntent"]>,
): ReturnType<typeof planLocationSource> & {
  canRun: boolean;
  warnings: string[];
} {
  const plan = planLocationSource({ source, intent });
  return {
    ...plan,
    canRun: plan.isCompatible,
    warnings: plan.reasons,
  };
}

function buildLocationEvidence(args: {
  location?: string | null;
  isRemote?: boolean | null;
  sourceNotes?: readonly string[] | null;
}): CreateJobInput["locationEvidence"] {
  if (!args.location && args.isRemote !== true) return undefined;
  return buildSharedLocationEvidence({
    location: args.location ?? (args.isRemote ? "Remote" : null),
    isRemote: args.isRemote ?? null,
    source:
      args.sourceNotes?.find((note) => note.startsWith("source:"))?.slice(7) ??
      null,
  });
}

export async function discoverJobsStep(args: {
  mergedConfig: PipelineConfig;
  shouldCancel?: () => boolean;
}): Promise<{
  discoveredJobs: CreateJobInput[];
  sourceErrors: string[];
  pendingChallenges: PendingChallenge[];
}> {
  logger.info("Running discovery step");

  const discoveredJobs: CreateJobInput[] = [];
  const sourceErrors: string[] = [];

  const settings = await settingsRepo.getAllSettings();
  const registry = await getExtractorRegistry();

  const searchTerms = await resolveSearchTerms(settings);

  const locationIntent =
    args.mergedConfig.locationIntent ??
    createLocationIntentFromLegacyInputs({
      selectedCountry: settings.jobspyCountryIndeed ?? "",
      searchCities: settings.searchCities ?? settings.jobspyLocation ?? "",
      workplaceTypes: parseWorkplaceTypes(settings.workplaceTypes),
      searchScope: settings.locationSearchScope,
      matchStrictness: settings.locationMatchStrictness,
    });
  const configuredSources = Array.isArray(args.mergedConfig.sources)
    ? args.mergedConfig.sources
    : [];
  const sourcePlans = configuredSources.map((source) => ({
    source,
    plan: getSourceLocationPlan(source, locationIntent),
  }));
  const compatibleSources = sourcePlans
    .filter(({ plan }) => plan.canRun)
    .map(({ source }) => source);
  let existingJobUrlsPromise: Promise<string[]> | null = null;
  const getExistingJobUrls = (): Promise<string[]> => {
    if (!existingJobUrlsPromise) {
      existingJobUrlsPromise = getAllJobUrls();
    }
    return existingJobUrlsPromise;
  };
  const skippedSources = sourcePlans.filter(({ plan }) => !plan.canRun);

  if (skippedSources.length > 0) {
    logger.info("Skipping incompatible sources for requested location intent", {
      step: "discover-jobs",
      locationIntent,
      primaryLocation: getPrimaryLocationLabel(locationIntent),
      requestedSources: configuredSources,
      skippedSources: skippedSources.map(({ source }) => source),
      warnings: skippedSources.flatMap(({ plan }) => plan.warnings),
    });
  }

  if (configuredSources.length > 0 && compatibleSources.length === 0) {
    throw new Error(
      locationIntent.selectedCountry
        ? `No compatible sources for selected country: ${formatCountryLabel(locationIntent.selectedCountry)}`
        : `No compatible sources for requested location: ${getPrimaryLocationLabel(locationIntent)}`,
    );
  }

  const groupedByManifest = new Map<
    string,
    { sources: string[]; detail: string; termsTotal?: number }
  >();

  for (const source of compatibleSources) {
    const manifest = registry.manifestBySource.get(source);
    if (!manifest) {
      sourceErrors.push(`${source}: extractor manifest not registered`);
      continue;
    }

    const existing = groupedByManifest.get(manifest.id);
    if (existing) {
      existing.sources.push(source);
      continue;
    }

    groupedByManifest.set(manifest.id, {
      sources: [source],
      termsTotal: searchTerms.length,
      detail: `${manifest.displayName}: fetching jobs...`,
    });
  }

  const sourceTasks: DiscoverySourceTask[] = [];

  for (const [manifestId, grouped] of groupedByManifest) {
    const manifest = registry.manifests.get(manifestId);
    if (!manifest) continue;

    sourceTasks.push({
      source: manifest.id,
      selectedSources: grouped.sources as ExtractorSourceId[],
      termsTotal: grouped.termsTotal,
      detail:
        grouped.sources.length > 1
          ? `${manifest.displayName}: ${grouped.sources.join(", ")}...`
          : grouped.detail,
      run: async () => {
        const filteredSettings = Object.fromEntries(
          Object.entries(settings).filter(
            ([, value]) =>
              typeof value === "string" || typeof value === "undefined",
          ),
        ) as Record<string, string | undefined>;

        const result = await manifest.run({
          source: grouped.sources[0],
          selectedSources: grouped.sources,
          settings: filteredSettings,
          searchTerms,
          selectedCountry: getLegacyLocationSelection(locationIntent),
          locationIntent,
          sourceLocationPlan: getSourceLocationPlan(
            grouped.sources[0] as CrawlSource,
            locationIntent,
          ),
          getExistingJobUrls,
          shouldCancel: args.shouldCancel,
          onProgress: (event) => {
            progressHelpers.crawlingUpdate({
              source: manifest.id,
              termsProcessed: event.termsProcessed,
              termsTotal: event.termsTotal,
              listPagesProcessed: event.listPagesProcessed,
              listPagesTotal: event.listPagesTotal,
              jobCardsFound: event.jobCardsFound,
              jobPagesEnqueued: event.jobPagesEnqueued,
              jobPagesSkipped: event.jobPagesSkipped,
              jobPagesProcessed: event.jobPagesProcessed,
              phase: event.phase,
              currentUrl: event.currentUrl,
            });

            if (event.detail) {
              updateProgress({
                step: "crawling",
                detail: event.detail,
              });
            }
          },
        });

        if (!result.success) {
          return {
            source: manifest.id,
            selectedSources: grouped.sources as ExtractorSourceId[],
            discoveredJobs: [],
            sourceErrors: [
              `${manifest.displayName || manifest.id}: ${result.error ?? "unknown error"} (sources: ${grouped.sources.join(",")})`,
            ],
            challenge: result.challengeRequired
              ? {
                  extractorId: manifest.id,
                  extractorName: manifest.displayName || manifest.id,
                  url: result.challengeRequired,
                  sources: grouped.sources as ExtractorSourceId[],
                }
              : undefined,
          };
        }

        return {
          source: manifest.id,
          selectedSources: grouped.sources as ExtractorSourceId[],
          discoveredJobs: result.jobs,
          sourceErrors: [],
        };
      },
    });
  }

  const totalSources = sourceTasks.length;
  let completedSources = 0;

  progressHelpers.startCrawling(totalSources);

  if (args.shouldCancel?.()) {
    return { discoveredJobs, sourceErrors, pendingChallenges: [] };
  }

  const sourceResults = await asyncPool({
    items: sourceTasks,
    concurrency: DISCOVERY_CONCURRENCY,
    shouldStop: args.shouldCancel,
    onTaskStarted: (sourceTask) => {
      progressHelpers.startSource(
        sourceTask.source,
        completedSources,
        totalSources,
        {
          termsTotal: sourceTask.termsTotal,
          detail: sourceTask.detail,
        },
      );
    },
    onTaskSettled: () => {
      completedSources += 1;
      progressHelpers.completeSource(completedSources, totalSources);
    },
    task: async (sourceTask) => {
      try {
        return await sourceTask.run();
      } catch (error) {
        logger.warn("Discovery source task failed", {
          sourceTask: sourceTask.source,
          error: sanitizeUnknown(error),
        });

        return {
          source: sourceTask.source,
          selectedSources: sourceTask.selectedSources,
          discoveredJobs: [],
          sourceErrors: [
            `${sourceTask.source}: ${error instanceof Error ? error.message : "unknown error"}`,
          ],
        };
      }
    },
  });

  // Collect challenges after ALL extractors finish, not on first failure.
  // This way the user sees every challenged site at once and can solve them
  // in a single batch, rather than solve-one → re-run → hit-next → solve-again.
  const pendingChallenges: PendingChallenge[] = [];
  for (const sourceResult of sourceResults) {
    discoveredJobs.push(...sourceResult.discoveredJobs);
    sourceErrors.push(...sourceResult.sourceErrors);
    if (sourceResult.challenge) {
      pendingChallenges.push(sourceResult.challenge);
    }
  }

  const discoveryMetrics = sourceResults.map((sourceResult) => {
    const jobsBySource = sourceResult.discoveredJobs.reduce<
      Record<string, number>
    >((counts, job) => {
      counts[job.source] = (counts[job.source] ?? 0) + 1;
      return counts;
    }, {});

    return {
      manifest: sourceResult.source,
      sources: sourceResult.selectedSources,
      discovered: sourceResult.discoveredJobs.length,
      jobsBySource,
      failures: sourceResult.sourceErrors.length,
      challengeRequired: Boolean(sourceResult.challenge),
    };
  });

  logger.info("Discovery source metrics", {
    step: "discover-jobs",
    metrics: discoveryMetrics,
    totalDiscoveredBeforeFilters: discoveredJobs.length,
    totalFailures: sourceErrors.length,
    challengeCount: pendingChallenges.length,
  });

  const locationFilterReasonCounts: Record<string, number> = {};
  const locationFilteredJobs = discoveredJobs.filter((job) => {
    const evidence =
      job.locationEvidence ??
      buildLocationEvidence({
        location: job.location,
        isRemote: job.isRemote,
        sourceNotes: [`source:${job.source}`],
      });
    job.locationEvidence = evidence;
    const match = matchJobLocationIntent(job, locationIntent);
    if (match.matched) {
      return true;
    }
    const reasonCode = match.reasonCode;
    locationFilterReasonCounts[reasonCode] =
      (locationFilterReasonCounts[reasonCode] ?? 0) + 1;
    return false;
  });
  const locationFilteredOutCount =
    discoveredJobs.length - locationFilteredJobs.length;

  if (locationFilteredOutCount > 0) {
    logger.info(
      "Dropped discovered jobs that did not satisfy location preferences",
      {
        step: "discover-jobs",
        droppedCount: locationFilteredOutCount,
        locationIntent,
        primaryLocation: getPrimaryLocationLabel(locationIntent),
        reasonCounts: locationFilterReasonCounts,
      },
    );
  }

  const blockedCompanyKeywords = parseBlockedCompanyKeywords(
    settings.blockedCompanyKeywords,
  );
  const blockedKeywordsLowerCase = blockedCompanyKeywords.map((value) =>
    value.toLowerCase(),
  );
  const filteredDiscoveredJobs = locationFilteredJobs.filter(
    (job) => !isBlockedEmployer(job.employer, blockedKeywordsLowerCase),
  );
  const droppedCount =
    locationFilteredJobs.length - filteredDiscoveredJobs.length;

  if (droppedCount > 0) {
    const blockedCompanyKeywordsPreview = blockedCompanyKeywords.slice(0, 10);
    const blockedCompanyKeywordsTruncated =
      blockedCompanyKeywordsPreview.length < blockedCompanyKeywords.length;

    logger.info("Dropped discovered jobs matching blocked company keywords", {
      step: "discover-jobs",
      droppedCount,
      blockedKeywordCount: blockedCompanyKeywords.length,
      blockedCompanyKeywordsPreview,
      blockedCompanyKeywordsTruncated,
    });

    logger.debug("Full blocked company keywords used for filtering", {
      step: "discover-jobs",
      blockedCompanyKeywords,
    });
  }

  if (args.shouldCancel?.()) {
    return {
      discoveredJobs: filteredDiscoveredJobs,
      sourceErrors,
      pendingChallenges,
    };
  }

  // Don't throw "all sources failed" when challenges are pending — the
  // orchestrator will pause, let the user solve them, then re-run those
  // extractors.  Jobs from non-challenged extractors (if any) are kept.
  if (
    filteredDiscoveredJobs.length === 0 &&
    sourceErrors.length > 0 &&
    pendingChallenges.length === 0
  ) {
    throw new Error(`All sources failed: ${sourceErrors.join("; ")}`);
  }

  if (sourceErrors.length > 0) {
    if (pendingChallenges.length > 0) {
      logger.info("Some discovery sources hit challenges and will be retried", {
        sourceErrors,
        pendingChallenges,
      });
    } else {
      logger.warn("Some discovery sources failed", { sourceErrors });
    }
  }

  // Don't transition to "importing" yet if there are challenges to solve —
  // the orchestrator will pause and re-run after challenges are resolved.
  if (pendingChallenges.length === 0) {
    progressHelpers.crawlingComplete(filteredDiscoveredJobs.length);
  }

  return {
    discoveredJobs: filteredDiscoveredJobs,
    sourceErrors,
    pendingChallenges,
  };
}
