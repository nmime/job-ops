import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FreelanceApplyContext,
  FreelanceFinderContext,
} from "@shared/types/freelance";

describe.sequential("Freelance worker persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-freelance-worker-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    delete process.env.JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED;

    // Run migrations against the temp db
    await import("../../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeFakeRegistry() {
    const applyToGig = vi.fn(
      async (ctx: FreelanceApplyContext) => ({
        platform: "upwork" as const,
        mode: ctx.dryRun ? ("dry_run" as const) : ("submit" as const),
        status: ctx.dryRun ? ("skipped" as const) : ("submitted" as const),
        externalRef: ctx.dryRun ? undefined : `ref-${ctx.gigId}`,
      }),
    );
    return {
      applyToGig,
      manifests: new Map([
        [
          "upwork" as const,
          {
            id: "upwork" as const,
            displayName: "Upwork",
            kind: "freelance-marketplace",
            findGigs: async (_ctx: FreelanceFinderContext) => ({
              success: true,
              gigs: [
                {
                  platform: "upwork" as const,
                  sourceGigId: "u1",
                  title: "Build a TypeScript API",
                  clientOrEmployer: "Client A",
                  gigUrl: "https://www.upwork.com/jobs/u1",
                  gigDescription:
                    "We need a TypeScript Node.js backend engineer.",
                  skillsRequired: ["TypeScript", "Node.js"],
                },
                {
                  platform: "upwork" as const,
                  sourceGigId: "u2",
                  title: "React dashboard fix",
                  clientOrEmployer: "Client B",
                  gigUrl: "https://www.upwork.com/jobs/u2",
                  gigDescription: "Fix React dashboard bugs.",
                  skillsRequired: ["React"],
                },
              ],
            }),
            applyToGig,
          },
        ],
      ]),
      availablePlatforms: ["upwork" as const],
      failed: [],
    };
  }

  it("persists discovered gigs and proposals, advancing gig status on submit", async () => {
    const fake = makeFakeRegistry();
    const { __setFreelanceRegistryForTests } = await import("./registry");
    __setFreelanceRegistryForTests(fake);
    // Open the per-platform submit gate so the cycle runs in submit mode.
    process.env.JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED = "true";

    const { runWorkerCycle } = await import("./worker");
    const report = await runWorkerCycle(1, {
      platforms: ["upwork"],
      searchTerms: ["typescript"],
      profileSkills: ["TypeScript", "Node.js"],
      minScore: 0,
      bidsPerCycle: 2,
    });

    // Both gigs persisted, two proposals drafted/submitted.
    expect(report.aggregate.discovered).toBe(2);
    expect(report.persisted).toEqual({ created: 2, updated: 0 });
    expect(report.applies).toHaveLength(2);
    expect(report.errors).toEqual([]);

    // The apply context must carry the platform's real gig id
    // (sourceGigId), never the 32-char dedup hash, and a non-null profile.
    expect(
      fake.applyToGig.mock.calls.map(([ctx]) => ctx.gigId).sort(),
    ).toEqual(["u1", "u2"]);
    expect(
      fake.applyToGig.mock.calls.every(([ctx]) => ctx.profile !== null),
    ).toBe(true);

    const { listGigs, listProposals } = await import(
      "../../repositories/freelance"
    );
    const gigs = await listGigs({ limit: 10 });
    expect(gigs).toHaveLength(2);
    expect(gigs.every((g) => g.status === "submitted")).toBe(true);

    const proposals = await listProposals(10);
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.status === "submitted")).toBe(true);
    expect(proposals.every((p) => p.coverLetter.length > 0)).toBe(true);
    delete process.env.JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED;
  });

  it("dry-run cycle persists gigs + proposals but never marks them submitted", async () => {
    const fake = makeFakeRegistry();
    const { __setFreelanceRegistryForTests } = await import("./registry");
    __setFreelanceRegistryForTests(fake);

    const { runWorkerCycle } = await import("./worker");
    const report = await runWorkerCycle(1, {
      platforms: ["upwork"],
      searchTerms: ["typescript"],
      profileSkills: ["TypeScript"],
      minScore: 0,
      bidsPerCycle: 2,
    });

    expect(report.autobidEnabled).toBe(false);
    expect(report.applies.every((a) => a.mode === "dry_run")).toBe(true);
    expect(fake.applyToGig.mock.calls.every(([ctx]) => ctx.dryRun)).toBe(true);

    const { listGigs, listProposals } = await import(
      "../../repositories/freelance"
    );
    const gigs = await listGigs({ limit: 10 });
    expect(gigs.every((g) => g.status === "proposed")).toBe(true);
    const proposals = await listProposals(10);
    expect(proposals.every((p) => p.status === "skipped")).toBe(true);
  });

  it("re-running a cycle updates existing gigs instead of duplicating them", async () => {
    const fake = makeFakeRegistry();
    const { __setFreelanceRegistryForTests } = await import("./registry");
    __setFreelanceRegistryForTests(fake);

    const { runWorkerCycle } = await import("./worker");
    await runWorkerCycle(1, {
      platforms: ["upwork"],
      searchTerms: ["typescript"],
      minScore: 0,
      bidsPerCycle: 2,
    });
    const second = await runWorkerCycle(2, {
      platforms: ["upwork"],
      searchTerms: ["typescript"],
      minScore: 0,
      bidsPerCycle: 2,
    });

    expect(second.persisted).toEqual({ created: 0, updated: 2 });
    const { listGigs } = await import("../../repositories/freelance");
    expect(await listGigs({ limit: 10 })).toHaveLength(2);
  });
});
