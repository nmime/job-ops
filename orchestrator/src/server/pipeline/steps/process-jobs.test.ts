import { createJob } from "@shared/testing/factories";
import { describe, expect, it, vi } from "vitest";
import { processJobsStep } from "./process-jobs";
import type { ScoredJob } from "./types";

vi.mock("@infra/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../progress", () => ({
  updateProgress: vi.fn(),
  progressHelpers: {
    processingJob: vi.fn(),
    jobComplete: vi.fn(),
  },
}));

const createScoredJob = (id: string, title: string): ScoredJob =>
  createJob({
    id,
    title,
    suitabilityScore: 80,
    suitabilityReason: "Strong fit",
  }) as ScoredJob;

describe("processJobsStep", () => {
  it("reports processed and failed jobs without aborting partial failures", async () => {
    const processJob = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "Tailoring failed" })
      .mockRejectedValueOnce(new Error("PDF failed"));

    const result = await processJobsStep({
      jobsToProcess: [
        createScoredJob("job-1", "First Role"),
        createScoredJob("job-2", "Second Role"),
        createScoredJob("job-3", "Third Role"),
      ],
      processJob,
    });

    expect(result).toEqual({
      processedCount: 1,
      failedCount: 2,
      processErrors: [
        { jobId: "job-2", title: "Second Role", error: "Tailoring failed" },
        { jobId: "job-3", title: "Third Role", error: "PDF failed" },
      ],
    });
    expect(processJob).toHaveBeenCalledTimes(3);
  });
});
