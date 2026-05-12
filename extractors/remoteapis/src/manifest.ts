import { resolveSearchCities } from "job-ops-shared/search-cities";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "job-ops-shared/types/extractors";
import {
  REMOTE_API_SOURCES,
  type RemoteApiSource,
  runRemoteApiJobs,
} from "./run";

function toProgress(event: {
  type: string;
  source: RemoteApiSource;
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}): ExtractorProgressEvent {
  const label = event.source;
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: `${label}:${event.searchTerm}`,
      detail: `${label}: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: `${label}:${event.searchTerm}`,
    jobPagesEnqueued: event.jobsFoundTerm ?? 0,
    jobPagesProcessed: event.jobsFoundTerm ?? 0,
    detail: `${label}: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm ?? 0} jobs`,
  };
}

function parseSelectedSources(values: readonly string[]): RemoteApiSource[] {
  return values.filter((value): value is RemoteApiSource =>
    REMOTE_API_SOURCES.includes(value as RemoteApiSource),
  );
}

export const manifest: ExtractorManifest = {
  id: "remoteapis",
  displayName: "Remote API Boards",
  providesSources: REMOTE_API_SOURCES,
  capabilities: { locationEvidence: true },
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const parsedMaxJobsPerTerm = context.settings.jobspyResultsWanted
      ? Number.parseInt(context.settings.jobspyResultsWanted, 10)
      : Number.NaN;
    const maxJobsPerTerm = Number.isFinite(parsedMaxJobsPerTerm)
      ? Math.max(1, parsedMaxJobsPerTerm)
      : 50;

    const result = await runRemoteApiJobs({
      selectedSources: parseSelectedSources(context.selectedSources),
      selectedCountry: context.selectedCountry,
      searchTerms: context.searchTerms,
      locations: resolveSearchCities({
        single:
          context.settings.searchCities ?? context.settings.jobspyLocation,
      }),
      workplaceTypes: context.settings.workplaceTypes
        ? JSON.parse(context.settings.workplaceTypes)
        : undefined,
      maxJobsPerTerm,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;
        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return {
        success: false,
        jobs: [],
        error: result.error,
      };
    }

    return {
      success: true,
      jobs: result.jobs,
    };
  },
};

export default manifest;
