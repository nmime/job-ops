import { logger } from "@infra/logger";
import { asyncPool } from "@server/utils/async-pool";
import { progressHelpers, updateProgress } from "../progress";
import type { ScoredJob } from "./types";

type ProcessJobFn = (
  jobId: string,
  options?: { force?: boolean; analyticsOrigin?: "pipeline" },
) => Promise<{ success: boolean; error?: string }>;
const PROCESSING_CONCURRENCY = 3;

export interface PipelineProcessError {
  jobId: string;
  title: string;
  error: string;
}

export async function processJobsStep(args: {
  jobsToProcess: ScoredJob[];
  processJob: ProcessJobFn;
  shouldCancel?: () => boolean;
}): Promise<{
  processedCount: number;
  failedCount: number;
  processErrors: PipelineProcessError[];
}> {
  let processedCount = 0;
  const processErrors: PipelineProcessError[] = [];

  if (args.jobsToProcess.length > 0) {
    const total = args.jobsToProcess.length;
    let startedCount = 0;
    let completedCount = 0;

    updateProgress({
      step: "processing",
      jobsProcessed: 0,
      totalToProcess: total,
    });

    await asyncPool({
      items: args.jobsToProcess,
      concurrency: PROCESSING_CONCURRENCY,
      shouldStop: args.shouldCancel,
      onTaskStarted: (job) => {
        startedCount += 1;
        progressHelpers.processingJob(startedCount, total, job);
      },
      onTaskSettled: (_job, _index) => {
        completedCount += 1;
        progressHelpers.jobComplete(completedCount, total);
      },
      task: async (job) => {
        try {
          const result = await args.processJob(job.id, {
            force: false,
            analyticsOrigin: "pipeline",
          });
          if (result.success) {
            processedCount += 1;
          } else {
            const error = result.error ?? "Processing failed";
            processErrors.push({ jobId: job.id, title: job.title, error });
            logger.warn("Failed to process job", {
              jobId: job.id,
              error,
            });
          }
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          processErrors.push({
            jobId: job.id,
            title: job.title,
            error: message,
          });
          logger.error("Failed to process job", { jobId: job.id, error });
          return { success: false, error: message };
        }
      },
    });
  }

  return {
    processedCount,
    failedCount: processErrors.length,
    processErrors,
  };
}
