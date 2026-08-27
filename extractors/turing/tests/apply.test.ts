import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToTuringGig, normalizeGreenhouseUrl } from "../src/main";
import type { FreelanceApplyContext } from "job-ops-shared/types/freelance";

const API_KEY_ENV = "JOBOPS_FREELANCE_TURING_API_KEY";
const COOKIE_ENV = "JOBOPS_FREELANCE_TURING_COOKIE";

const VETTED_NETWORK_MESSAGE =
  "Vetted network: apply requires the one-time network application (no per-gig bidding)";

/** 32-char hex — the shape the worker passes as ctx.gigId (dedupe hash). */
const DEDUP_HASH_GIG_ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

function makeCtx(
  overrides: Partial<FreelanceApplyContext> = {},
): FreelanceApplyContext {
  return {
    platform: "turing",
    gigId: DEDUP_HASH_GIG_ID,
    dryRun: true,
    allowCaptcha: false,
    rateBudget: { maxPerHour: 5, windowMs: 3_600_000 },
    profile: null,
    ...overrides,
  };
}

describe("turing apply adapter — guards and honest semantics", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [API_KEY_ENV, COOKIE_ENV]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [API_KEY_ENV, COOKIE_ENV]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("dry-run gate: skips with the dry-run message even for a Greenhouse posting", async () => {
    process.env[API_KEY_ENV] = "dummy";
    const result = await applyToTuringGig(
      makeCtx({
        dryRun: true,
        profile: {
          coverLetter: "Hello",
          email: "ada@example.com",
          fullName: "Ada Lovelace",
          gigUrl: "https://job-boards.greenhouse.io/turing/jobs/4043678#app",
        },
      }),
    );
    expect(result.mode).toBe("dry_run");
    expect(result.status).toBe("skipped");
    expect(result.error).toContain("dry-run");
    expect(result.status).not.toBe("submitted");
  });

  it("credential guard: errors when neither key nor cookie is configured", async () => {
    const result = await applyToTuringGig(
      makeCtx({ dryRun: false, profile: { coverLetter: "Hello" } }),
    );
    expect(result.mode).toBe("submit");
    expect(result.status).toBe("error");
    expect(result.error).toContain(API_KEY_ENV);
    expect(result.error).toContain(COOKIE_ENV);
  });

  it("gig without a per-gig posting (dedupe-hash id, no gig record) -> honest vetted-network skip", async () => {
    process.env[API_KEY_ENV] = "dummy";
    const result = await applyToTuringGig(makeCtx({ dryRun: false, profile: null }));
    expect(result.mode).toBe("submit");
    expect(result.status).toBe("skipped");
    expect(result.error).toContain(VETTED_NETWORK_MESSAGE);
    expect(result.status).not.toBe("submitted");
  });

  it("gig with a Greenhouse posting but no cover letter -> refuses untailored application", async () => {
    process.env[COOKIE_ENV] = "turing_session=dummy";
    const result = await applyToTuringGig(
      makeCtx({
        dryRun: false,
        profile: {
          gigUrl: "https://job-boards.greenhouse.io/turing/jobs/4043678#app",
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("no tailored cover letter");
  });

  it("Greenhouse posting + profile missing email -> precise error before any submit", async () => {
    process.env[API_KEY_ENV] = "dummy";
    const result = await applyToTuringGig(
      makeCtx({
        dryRun: false,
        profile: {
          coverLetter: "Hello — strong fit for this role.",
          fullName: "Ada Lovelace",
          gigUrl: "https://job-boards.greenhouse.io/turing/jobs/4043678#app",
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("email");
  });

  it("Greenhouse posting + profile missing name -> precise error before any submit", async () => {
    process.env[API_KEY_ENV] = "dummy";
    const result = await applyToTuringGig(
      makeCtx({
        dryRun: false,
        profile: {
          coverLetter: "Hello — strong fit for this role.",
          email: "ada@example.com",
          gigUrl: "https://job-boards.greenhouse.io/turing/jobs/4043678#app",
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("name");
  });
});

describe("normalizeGreenhouseUrl", () => {
  it("normalizes the hosted-board apply URL with #app anchor", () => {
    expect(
      normalizeGreenhouseUrl(
        "https://job-boards.greenhouse.io/turing/jobs/4043678#app",
      ),
    ).toEqual({
      url: "https://job-boards.greenhouse.io/turing/jobs/4043678",
      jobId: "4043678",
    });
  });

  it("normalizes tracking params", () => {
    expect(
      normalizeGreenhouseUrl(
        "https://job-boards.greenhouse.io/turing/jobs/4043678?utm_source=referral",
      ),
    ).toEqual({
      url: "https://job-boards.greenhouse.io/turing/jobs/4043678",
      jobId: "4043678",
    });
  });

  it("returns undefined for non-Greenhouse and non-posting URLs", () => {
    expect(normalizeGreenhouseUrl("https://www.turing.com/jobs/123")).toBeUndefined();
    expect(
      normalizeGreenhouseUrl("https://job-boards.greenhouse.io/turing"),
    ).toBeUndefined();
  });
});
