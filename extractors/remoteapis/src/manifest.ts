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

function parseListSetting(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }
  } catch {
    // Fall through to comma/newline parsing.
  }

  return trimmed
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseBooleanSetting(value: string | undefined): boolean {
  return /^(1|true|yes|y|on)$/i.test(value?.trim() ?? "");
}

function parsePositiveIntegerSetting(
  value: string | undefined,
): number | undefined {
  const parsed = value?.trim() ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function firstSetting(
  settings: Record<string, string | undefined>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = settings[key];
    if (value?.trim()) return value;
  }
  return undefined;
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
      // Source-specific public board settings accept JSON arrays, comma-separated,
      // or newline-separated values. Supported keys:
      // greenhouseBoardTokens/greenhouseBoards, leverSites, leverEuSites,
      // leverUseEu, ashbyJobBoardNames/ashbyBoards,
      // smartrecruitersCompanies, telegramChannels, himalayasPages,
      // usajobsApiKey/USAJOBS_API_KEY, usajobsUserAgent/USAJOBS_USER_AGENT.
      greenhouseBoardTokens: parseListSetting(
        firstSetting(context.settings, [
          "greenhouseBoardTokens",
          "greenhouseBoards",
        ]),
      ),
      leverSites: parseListSetting(context.settings.leverSites),
      leverEuSites: parseListSetting(context.settings.leverEuSites),
      leverUseEu: parseBooleanSetting(context.settings.leverUseEu),
      ashbyJobBoardNames: parseListSetting(
        firstSetting(context.settings, ["ashbyJobBoardNames", "ashbyBoards"]),
      ),
      smartrecruitersCompanies: parseListSetting(
        context.settings.smartrecruitersCompanies,
      ),
      telegramChannels: parseListSetting(context.settings.telegramChannels),
      himalayasPages: parsePositiveIntegerSetting(
        firstSetting(context.settings, ["himalayasPages", "HIMALAYAS_PAGES"]),
      ),
      usajobsApiKey:
        firstSetting(context.settings, ["usajobsApiKey", "USAJOBS_API_KEY"]) ??
        process.env.USAJOBS_API_KEY,
      usajobsUserAgent:
        firstSetting(context.settings, [
          "usajobsUserAgent",
          "usajobsUserEmail",
          "USAJOBS_USER_AGENT",
          "USAJOBS_USER_EMAIL",
        ]) ??
        process.env.USAJOBS_USER_AGENT ??
        process.env.USAJOBS_USER_EMAIL,
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
