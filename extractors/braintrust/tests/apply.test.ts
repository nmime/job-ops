import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToBraintrustGig } from "../src/main";
import type { FreelanceApplyContext } from "job-ops-shared/types/freelance";

const API_KEY_ENV = "JOBOPS_FREELANCE_BRAINTRUST_API_KEY";
const COOKIE_ENV = "JOBOPS_FREELANCE_BRAINTRUST_COOKIE";

const VETTED_NETWORK_MESSAGE =
  "Vetted network: apply requires the one-time network application (no per-gig bidding)";

function makeCtx(
  overrides: Partial<FreelanceApplyContext> = {},
): FreelanceApplyContext {
  return {
    platform: "braintrust",
    gigId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    dryRun: true,
    allowCaptcha: false,
    rateBudget: { maxPerHour: 5, windowMs: 3_600_000 },
    profile: null,
    ...overrides,
  };
}

describe("braintrust apply adapter — honest vetted-network semantics", () => {
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

  it("dry-run gate: skips with the dry-run message", async () => {
    process.env[COOKIE_ENV] = "braintrust_session=dummy";
    const result = await applyToBraintrustGig(makeCtx({ dryRun: true }));
    expect(result.mode).toBe("dry_run");
    expect(result.status).toBe("skipped");
    expect(result.error).toContain("dry-run");
  });

  it("credential guard: errors when neither key nor cookie is configured", async () => {
    const result = await applyToBraintrustGig(makeCtx({ dryRun: false }));
    expect(result.mode).toBe("submit");
    expect(result.status).toBe("error");
    expect(result.error).toContain(COOKIE_ENV);
  });

  it("guarded real path: honest vetted-network skip (no public apply endpoint)", async () => {
    process.env[COOKIE_ENV] = "braintrust_session=dummy";
    const result = await applyToBraintrustGig(makeCtx({ dryRun: false }));
    expect(result.mode).toBe("submit");
    expect(result.status).toBe("skipped");
    expect(result.error).toContain(VETTED_NETWORK_MESSAGE);
    // never a fake submission, never a fake "not wired up" error
    expect(result.status).not.toBe("submitted");
    expect(result.status).not.toBe("error");
  });

  it("api-key-only credential passes the guard and reaches the vetted-network skip", async () => {
    process.env[API_KEY_ENV] = "dummy";
    const result = await applyToBraintrustGig(makeCtx({ dryRun: false }));
    expect(result.status).toBe("skipped");
    expect(result.error).toContain(VETTED_NETWORK_MESSAGE);
  });
});
