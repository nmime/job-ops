import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("jobs repository scored discovered backlog", () => {
  let tempDir: string;
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-job-backlog-repo-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns already-scored discovered jobs with email, application, direct, or source URLs", async () => {
    const emailRoute = await jobsRepo.createJob({
      source: "manual",
      title: "Email Route",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/email-route",
      emails: "jobs@example.com",
    });
    const applicationRoute = await jobsRepo.createJob({
      source: "manual",
      title: "Application Route",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/application-route",
      applicationLink: "https://ats.example.com/apply/application-route",
    });
    const directRoute = await jobsRepo.createJob({
      source: "manual",
      title: "Direct Route",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/direct-route",
      jobUrlDirect: "https://ats.example.com/apply/direct-route",
    });
    const sourceRoute = await jobsRepo.createJob({
      source: "manual",
      title: "Source Route",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/source-route",
    });
    const unscored = await jobsRepo.createJob({
      source: "manual",
      title: "Unscored Route",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/unscored-route",
      applicationLink: "https://ats.example.com/apply/unscored-route",
    });

    for (const [job, score] of [
      [emailRoute, 81],
      [applicationRoute, 82],
      [directRoute, 83],
      [sourceRoute, 84],
    ] as const) {
      await jobsRepo.updateJob(job.id, {
        suitabilityScore: score,
        suitabilityReason: "cached",
      });
    }

    const backlog = await jobsRepo.getScoredDiscoveredBacklogJobs();

    expect(backlog.map((job) => job.id)).toEqual([
      sourceRoute.id,
      directRoute.id,
      applicationRoute.id,
      emailRoute.id,
    ]);
    expect(backlog.map((job) => job.suitabilityScore)).toEqual([84, 83, 82, 81]);
    expect(backlog.some((job) => job.id === unscored.id)).toBe(false);
  });
});
