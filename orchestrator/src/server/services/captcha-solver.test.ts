import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/repositories/settings", () => ({
  getAllSettings: vi.fn(),
}));

vi.mock("@server/services/envSettings", () => ({
  getOriginalEnvValue: vi.fn(),
}));

vi.mock("@infra/logger", () => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock("browser-utils", () => ({
  solveChallenge: vi.fn().mockResolvedValue({ status: "solved" }),
}));

import { logger } from "@infra/logger";
import { getAllSettings } from "@server/repositories/settings";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { solveChallenge } from "browser-utils";
import {
  getPaidChallengeSolverOptions,
  isAutomaticCaptchaSolvingEnabled,
  solveExtractorChallenge,
} from "./captcha-solver";

function mockEnv(values: Record<string, string | undefined>) {
  vi.mocked(getOriginalEnvValue).mockImplementation((key) => values[key]);
}

describe("captcha solver service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue({});
    mockEnv({});
  });

  it("is disabled by default", async () => {
    await expect(getPaidChallengeSolverOptions()).resolves.toBeNull();
    await expect(isAutomaticCaptchaSolvingEnabled()).resolves.toBe(false);
  });

  it("enables paid solving only with 2captcha, auto flag, and api key", async () => {
    mockEnv({
      CAPTCHA_SOLVER_PROVIDER: "2captcha",
      CAPTCHA_SOLVER_AUTO_SOLVE_ENABLED: "1",
      CAPTCHA_SOLVER_API_KEY: "secret-key",
    });

    await expect(getPaidChallengeSolverOptions()).resolves.toEqual({
      provider: "2captcha",
      apiKey: "secret-key",
    });
    await expect(isAutomaticCaptchaSolvingEnabled()).resolves.toBe(true);
  });

  it("stays disabled on missing key, manual provider, or missing auto flag", async () => {
    vi.mocked(getAllSettings)
      .mockResolvedValueOnce({
        captchaSolverProvider: "2captcha",
        captchaSolverAutoSolveEnabled: "true",
      })
      .mockResolvedValueOnce({
        captchaSolverProvider: "manual",
        captchaSolverAutoSolveEnabled: "true",
        captchaSolverApiKey: "secret-key",
      })
      .mockResolvedValueOnce({
        captchaSolverProvider: "2captcha",
        captchaSolverApiKey: "secret-key",
      });

    await expect(getPaidChallengeSolverOptions()).resolves.toBeNull();
    await expect(getPaidChallengeSolverOptions()).resolves.toBeNull();
    await expect(getPaidChallengeSolverOptions()).resolves.toBeNull();
  });

  it("does not leak secrets in logs or public solve result", async () => {
    vi.mocked(getAllSettings).mockResolvedValue({
      captchaSolverProvider: "2captcha",
      captchaSolverAutoSolveEnabled: "true",
      captchaSolverApiKey: "secret-key",
    });

    const result = await solveExtractorChallenge({
      extractorId: "naukri",
      url: "https://example.test/challenge",
      storageDir: "/tmp/cookies",
    });

    expect(result).toEqual({
      attempted: true,
      provider: "2captcha",
      result: { status: "solved" },
    });
    expect(solveChallenge).toHaveBeenCalledWith(
      "https://example.test/challenge",
      "naukri",
      "/tmp/cookies",
      undefined,
      {
        paidCaptcha: { provider: "2captcha", apiKey: "secret-key" },
        headless: true,
        manualFallback: false,
      },
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      "secret-key",
    );
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});
