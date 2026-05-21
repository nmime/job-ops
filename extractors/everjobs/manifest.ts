import {
  type EverJobsProgressEvent,
  runEverJobs,
} from "@server/services/everjobs";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";

function toProgress(event: EverJobsProgressEvent): ExtractorProgressEvent {
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `Ever Jobs: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: event.jobsFoundTerm,
    jobPagesProcessed: event.jobsFoundTerm,
    detail: `Ever Jobs: completed term ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm} jobs`,
  };
}

export const manifest: ExtractorManifest = {
  id: "everjobs",
  displayName: "Ever Jobs",
  providesSources: ["everjobs"],
  capabilities: { locationEvidence: true },
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const existingJobUrls = await context.getExistingJobUrls?.();
    const result = await runEverJobs({
      searchTerms: context.searchTerms,
      selectedCountry: context.selectedCountry,
      locationIntent: context.locationIntent,
      existingJobUrls,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;
        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return { success: false, jobs: [], error: result.error };
    }

    return { success: true, jobs: result.jobs };
  },
};

export default manifest;
