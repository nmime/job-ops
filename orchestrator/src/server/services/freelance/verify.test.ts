import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderResult,
  FreelancePlatformId,
  FreelanceProviderManifest,
} from "@shared/types/freelance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile } from "../profile";
import { __setFreelanceRegistryForTests } from "./registry";
import { verifyFreelanceAdapter } from "./verify";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../profile", () => ({
  getProfile: vi.fn(),
}));

let tempDir: string;
const FIVERR_COOKIE = "JOBOPS_FREELANCE_FIVERR_COOKIE";

function setRegistry(manifests: FreelanceProviderManifest[]): void {
  __setFreelanceRegistryForTests({
    manifests: new Map(manifests.map((m) => [m.id, m])),
    availablePlatforms: manifests.map((m) => m.id),
    failed: [],
  });
}

function fakeManifest(input: {
  id: FreelancePlatformId;
  findGigs?: (ctx: never) => Promise<FreelanceFinderResult>;
  applyToGig?: (ctx: FreelanceApplyContext) => Promise<FreelanceApplyResult>;
}): FreelanceProviderManifest {
  const manifest: Record<string, unknown> = {
    id: input.id,
    displayName: `Fake ${input.id}`,
    kind: "test",
    findGigs: input.findGigs ?? (async () => ({ success: true, gigs: [] })),
  };
  if (input.applyToGig) manifest.applyToGig = input.applyToGig;
  return manifest as unknown as FreelanceProviderManifest;
}

const sampleGigs = [
  {
    platform: "fiverr" as const,
    title: "Senior React Developer",
    clientOrEmployer: "Acme",
    gigUrl: "https://fiverr.com/request/123",
    sourceGigId: "123",
  },
  {
    platform: "fiverr" as const,
    title: "Node.js API Help",
    clientOrEmployer: "Globex",
    gigUrl: "https://fiverr.com/request/456",
    sourceGigId: "456",
  },
];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "job-ops-verify-"));
  process.env.DATA_DIR = tempDir;
  delete process.env[FIVERR_COOKIE];
  vi.mocked(getProfile).mockReset();
});

afterEach(async () => {
  __setFreelanceRegistryForTests(null);
  delete process.env[FIVERR_COOKIE];
  delete process.env.DATA_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("verifyFreelanceAdapter", () => {
  it("verdict not-applicable for a board with no apply adapter", async () => {
    setRegistry([
      fakeManifest({
        id: "remoteok",
        findGigs: async () => ({ success: true, gigs: [sampleGigs[0]] }),
      }),
    ]);
    const report = await verifyFreelanceAdapter("remoteok");
    expect(report.verdict).toBe("not-applicable");
    expect(report.discovery).toMatchObject({ ok: true, count: 1 });
    expect(report.discovery.sample).toBe("Senior React Developer");
    expect(report.apply.supported).toBe(false);
    expect(report.apply.dryRun).toBeNull();
    expect(report.credential.configured).toBe(true); // boards: format none
  });

  it("blocked on missing credentials even when discovery works", async () => {
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: sampleGigs }),
        applyToGig: async (ctx) => ({
          platform: "fiverr",
          mode: "dry_run",
          status: "skipped",
          error: `dry-run: ${ctx.dryRun}`,
        }),
      }),
    ]);
    const report = await verifyFreelanceAdapter("fiverr");
    expect(report.verdict).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("missing credentials");
    expect(report.credential.missing).toEqual([
      FIVERR_COOKIE,
      "JOBOPS_FREELANCE_FIVERR_API_KEY",
    ]);
    // dry-run still ran and is recorded
    expect(report.apply.supported).toBe(true);
    expect(report.apply.dryRun?.status).toBe("skipped");
  });

  it("verified when credentials are set and dry-run apply is skipped", async () => {
    process.env[FIVERR_COOKIE] = "a=1; b=2";
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: sampleGigs }),
        applyToGig: async () => ({
          platform: "fiverr",
          mode: "dry_run",
          status: "skipped",
          error: "dry-run: fiverr submission disabled",
        }),
      }),
    ]);
    const report = await verifyFreelanceAdapter("fiverr");
    expect(report.verdict).toBe("verified");
    expect(report.credential.present).toEqual([FIVERR_COOKIE]);
    expect(report.apply.dryRun?.status).toBe("skipped");
    expect(report.blockers).toEqual([]);
  });

  it("reports discovery errors with the error class and keeps running", async () => {
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ]);
    const report = await verifyFreelanceAdapter("fiverr", {
      discoveryTimeoutMs: 5_000,
    });
    expect(report.discovery.ok).toBe(false);
    expect(report.discovery.error).toContain("TypeError");
    expect(report.discovery.error).toContain("fetch failed");
    expect(report.verdict).toBe("blocked");
  });

  it("times out a hung discovery instead of hanging the run", async () => {
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: () => new Promise<FreelanceFinderResult>(() => {}),
      }),
    ]);
    const report = await verifyFreelanceAdapter("fiverr", {
      discoveryTimeoutMs: 50,
    });
    expect(report.discovery.ok).toBe(false);
    expect(report.discovery.error).toContain("timed out");
    expect(report.verdict).toBe("blocked");
  });

  it("dry-run apply uses the first discovered gigId and dryRun=true", async () => {
    const seen: Array<{ gigId: string; dryRun: boolean }> = [];
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: sampleGigs }),
        applyToGig: async (ctx) => {
          seen.push({ gigId: ctx.gigId, dryRun: ctx.dryRun });
          return {
            platform: "fiverr",
            mode: "dry_run",
            status: "skipped",
          };
        },
      }),
    ]);
    await verifyFreelanceAdapter("fiverr");
    expect(seen).toEqual([{ gigId: "123", dryRun: true }]);
  });

  it("uses a synthetic gigId when discovery finds nothing", async () => {
    const seen: string[] = [];
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: [] }),
        applyToGig: async (ctx) => {
          seen.push(ctx.gigId);
          return { platform: "fiverr", mode: "dry_run", status: "skipped" };
        },
      }),
    ]);
    await verifyFreelanceAdapter("fiverr");
    expect(seen).toEqual(["verify"]);
  });

  it("never attempts a live submission without live:true", async () => {
    const dryRuns: boolean[] = [];
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: sampleGigs }),
        applyToGig: async (ctx) => {
          dryRuns.push(ctx.dryRun);
          return { platform: "fiverr", mode: "dry_run", status: "skipped" };
        },
      }),
    ]);
    const report = await verifyFreelanceAdapter("fiverr");
    expect(dryRuns).toEqual([true]);
    expect(report.apply.live).toBeNull();
  });

  it("live:true submits against the first discovered gig with dryRun=false", async () => {
    const calls: Array<{ gigId: string; dryRun: boolean }> = [];
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: sampleGigs }),
        applyToGig: async (ctx) => {
          calls.push({ gigId: ctx.gigId, dryRun: ctx.dryRun });
          return ctx.dryRun
            ? { platform: "fiverr", mode: "dry_run", status: "skipped" }
            : {
                platform: "fiverr",
                mode: "submit",
                status: "submitted",
                externalRef: ctx.gigId,
              };
        },
      }),
    ]);
    process.env[FIVERR_COOKIE] = "a=1";
    const report = await verifyFreelanceAdapter("fiverr", { live: true });
    expect(calls).toEqual([
      { gigId: "123", dryRun: true },
      { gigId: "123", dryRun: false },
    ]);
    expect(report.apply.live).toEqual({ status: "submitted" });
  });

  it("skips live submission when discovery found no gigs", async () => {
    const calls: number[] = [];
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: [] }),
        applyToGig: async (ctx) => {
          calls.push(ctx.gigId === "verify" ? 1 : 0);
          return { platform: "fiverr", mode: "dry_run", status: "skipped" };
        },
      }),
    ]);
    process.env[FIVERR_COOKIE] = "a=1";
    const report = await verifyFreelanceAdapter("fiverr", { live: true });
    // only the dry-run ran (synthetic gigId)
    expect(calls).toEqual([1]);
    expect(report.apply.live).toBeNull();
  });

  it("blocks when the dry-run apply returns an error status", async () => {
    process.env[FIVERR_COOKIE] = "a=1";
    setRegistry([
      fakeManifest({
        id: "fiverr",
        findGigs: async () => ({ success: true, gigs: sampleGigs }),
        applyToGig: async () => ({
          platform: "fiverr",
          mode: "dry_run",
          status: "error",
          error: "boom",
        }),
      }),
    ]);
    const report = await verifyFreelanceAdapter("fiverr");
    expect(report.verdict).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("boom");
  });

  it("records provider load failures as blocked, not as a crash", async () => {
    setRegistry([]);
    const report = await verifyFreelanceAdapter("fiverr");
    expect(report.verdict).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("provider failed to load");
    expect(report.apply.supported).toBe(false);
  });
});
