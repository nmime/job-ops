import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFreelanceRateLimits,
  applyToFreelanceGig,
  buildDeterministicProposal,
  consumeRateLimit,
  getFreelanceRateLimit,
  isFreelanceApplyEnabled,
} from "./apply-adapter";
import { __setFreelanceRegistryForTests } from "./registry";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  __resetFreelanceRateLimits();
  __setFreelanceRegistryForTests(null);
});

describe("isFreelanceApplyEnabled", () => {
  it("is false by default (dry-run is the safe default)", () => {
    expect(isFreelanceApplyEnabled({}, "upwork")).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    expect(
      isFreelanceApplyEnabled(
        { JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED: "true" },
        "upwork",
      ),
    ).toBe(true);
    expect(
      isFreelanceApplyEnabled(
        { JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED: "1" },
        "upwork",
      ),
    ).toBe(false);
  });

  it("normalizes hyphenated platform ids", () => {
    expect(
      isFreelanceApplyEnabled(
        { JOBOPS_FREELANCE_ARC_DEV_APPLY_ENABLED: "true" },
        "arc-dev",
      ),
    ).toBe(true);
  });

  it("does not leak enablement across platforms", () => {
    const env = { JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED: "true" };
    expect(isFreelanceApplyEnabled(env, "fiverr")).toBe(false);
  });
});

describe("getFreelanceRateLimit", () => {
  it("defaults to 5/hour", () => {
    expect(getFreelanceRateLimit("upwork", {})).toEqual({
      maxPerHour: 5,
      windowMs: 3_600_000,
    });
  });

  it("honors a per-platform override", () => {
    expect(
      getFreelanceRateLimit("upwork", {
        JOBOPS_FREELANCE_UPWORK_MAX_PER_HOUR: "12",
      }).maxPerHour,
    ).toBe(12);
  });

  it("ignores garbage overrides", () => {
    expect(
      getFreelanceRateLimit("upwork", {
        JOBOPS_FREELANCE_UPWORK_MAX_PER_HOUR: "not-a-number",
      }).maxPerHour,
    ).toBe(5);
  });
});

describe("consumeRateLimit", () => {
  it("allows up to the budget then blocks", () => {
    const budget = { maxPerHour: 2, windowMs: 3_600_000 };
    expect(consumeRateLimit("upwork", budget)).toBe(true);
    expect(consumeRateLimit("upwork", budget)).toBe(true);
    expect(consumeRateLimit("upwork", budget)).toBe(false);
  });

  it("frees the budget once the window rolls over", () => {
    const budget = { maxPerHour: 1, windowMs: 1000 };
    const t0 = 1_000_000;
    expect(consumeRateLimit("guru", budget, t0)).toBe(true);
    expect(consumeRateLimit("guru", budget, t0 + 100)).toBe(false);
    expect(consumeRateLimit("guru", budget, t0 + 2000)).toBe(true);
  });

  it("tracks platforms independently", () => {
    const budget = { maxPerHour: 1, windowMs: 3_600_000 };
    expect(consumeRateLimit("upwork", budget)).toBe(true);
    expect(consumeRateLimit("fiverr", budget)).toBe(true);
  });
});

describe("buildDeterministicProposal", () => {
  it("always returns a tailored draft with a non-empty cover letter", () => {
    const draft = buildDeterministicProposal({
      gigId: "g1",
      platform: "upwork",
      gigTitle: "Build an API",
      gigDescription: "We need a Node API. It must be fast.",
    });
    expect(draft.tailored).toBe(true);
    expect(draft.coverLetter.length).toBeGreaterThan(50);
    expect(draft.coverLetter).toContain("Build an API");
  });

  it("surfaces matched skills when they appear in the description", () => {
    const draft = buildDeterministicProposal({
      gigId: "g1",
      platform: "upwork",
      gigDescription: "Looking for TypeScript and Postgres expertise.",
      profileSkills: ["TypeScript", "Postgres", "Kubernetes"],
    });
    expect(draft.coverLetter).toContain("TypeScript");
    expect(draft.coverLetter).toContain("Postgres");
  });

  it("handles an empty description without throwing", () => {
    const draft = buildDeterministicProposal({
      gigId: "g1",
      platform: "guru",
      gigDescription: "",
    });
    expect(draft.tailored).toBe(true);
  });
});

describe("applyToFreelanceGig", () => {
  const fakeProvider = (applyImpl?: ReturnType<typeof vi.fn>) => ({
    manifests: new Map([
      [
        "upwork" as const,
        {
          id: "upwork" as const,
          displayName: "Upwork",
          kind: "freelance-marketplace",
          findGigs: vi.fn(),
          applyToGig:
            applyImpl ??
            vi.fn(async (ctx: { dryRun: boolean }) => ({
              platform: "upwork" as const,
              mode: ctx.dryRun ? ("dry_run" as const) : ("submit" as const),
              status: ctx.dryRun ? ("skipped" as const) : ("submitted" as const),
            })),
        },
      ],
    ]),
    availablePlatforms: ["upwork" as const],
    failed: [],
  });

  it("defaults to dry-run and still produces a proposal", async () => {
    __setFreelanceRegistryForTests(fakeProvider());
    const result = await applyToFreelanceGig({
      gigId: "g1",
      platform: "upwork",
      gigDescription: "Build a scraper",
      env: {},
    });
    expect(result.mode).toBe("dry_run");
    expect(result.proposalDraft?.tailored).toBe(true);
  });

  it("propagates dryRun=false when the platform flag is enabled", async () => {
    const applyImpl = vi.fn(async (ctx: { dryRun: boolean }) => ({
      platform: "upwork" as const,
      mode: "submit" as const,
      status: "submitted" as const,
      externalRef: `ref-${ctx.dryRun}`,
    }));
    __setFreelanceRegistryForTests(fakeProvider(applyImpl));
    const result = await applyToFreelanceGig({
      gigId: "g1",
      platform: "upwork",
      gigDescription: "Build a scraper",
      env: { JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED: "true" },
    });
    expect(applyImpl).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
    expect(result.status).toBe("submitted");
  });

  it("blocks a real submission once the rate limit is exhausted", async () => {
    __setFreelanceRegistryForTests(fakeProvider());
    const env = {
      JOBOPS_FREELANCE_UPWORK_APPLY_ENABLED: "true",
      JOBOPS_FREELANCE_UPWORK_MAX_PER_HOUR: "1",
    };
    const first = await applyToFreelanceGig({
      gigId: "g1",
      platform: "upwork",
      gigDescription: "x",
      env,
    });
    const second = await applyToFreelanceGig({
      gigId: "g2",
      platform: "upwork",
      gigDescription: "x",
      env,
    });
    expect(first.status).toBe("submitted");
    expect(second.status).toBe("skipped");
    expect(second.error).toContain("rate-limited");
  });

  it("does NOT consume rate limit in dry-run", async () => {
    __setFreelanceRegistryForTests(fakeProvider());
    const env = { JOBOPS_FREELANCE_UPWORK_MAX_PER_HOUR: "1" };
    for (let i = 0; i < 5; i += 1) {
      const result = await applyToFreelanceGig({
        gigId: `g${i}`,
        platform: "upwork",
        gigDescription: "x",
        env,
      });
      expect(result.error ?? "").not.toContain("rate-limited");
    }
  });

  it("returns an error result for an unregistered platform", async () => {
    __setFreelanceRegistryForTests({
      manifests: new Map(),
      availablePlatforms: [],
      failed: [],
    });
    const result = await applyToFreelanceGig({
      gigId: "g1",
      platform: "fiverr",
      gigDescription: "x",
      env: {},
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("not registered");
  });

  it("drafts only when the provider has no apply adapter", async () => {
    __setFreelanceRegistryForTests({
      manifests: new Map([
        [
          "remoteok" as const,
          {
            id: "remoteok" as const,
            displayName: "RemoteOK",
            kind: "remote-job-board",
            findGigs: vi.fn(),
          },
        ],
      ]),
      availablePlatforms: ["remoteok" as const],
      failed: [],
    });
    const result = await applyToFreelanceGig({
      gigId: "g1",
      platform: "remoteok",
      gigDescription: "x",
      env: {},
    });
    expect(result.status).toBe("drafted");
    expect(result.proposalDraft).toBeDefined();
  });

  it("converts a throwing adapter into an error result, not a crash", async () => {
    const boom = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    __setFreelanceRegistryForTests(fakeProvider(boom));
    const result = await applyToFreelanceGig({
      gigId: "g1",
      platform: "upwork",
      gigDescription: "x",
      env: {},
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("provider exploded");
  });
});
