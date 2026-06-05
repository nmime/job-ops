import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoSolvePendingExtractorChallengesOnce,
  createBackgroundDiscoveryService,
  getBackgroundDiscoveryConfigFromEnv,
} from "./background-discovery";

describe("background discovery service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is disabled by default", () => {
    const config = getBackgroundDiscoveryConfigFromEnv({});
    const runPipeline = vi.fn().mockResolvedValue({ success: true });
    const service = createBackgroundDiscoveryService(config, {
      runPipeline,
      autoSolvePendingChallengesWhile: vi.fn(),
    });

    service.start();

    expect(service.isRunning()).toBe(false);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("triggers the pipeline on the configured interval with safe overrides", async () => {
    vi.useFakeTimers();
    const runPipeline = vi.fn().mockResolvedValue({ success: true });
    const service = createBackgroundDiscoveryService(
      getBackgroundDiscoveryConfigFromEnv({
        JOBOPS_BACKGROUND_DISCOVERY_ENABLED: "true",
        JOBOPS_BACKGROUND_DISCOVERY_INTERVAL_MS: "10000",
        JOBOPS_BACKGROUND_DISCOVERY_MIN_INTERVAL_MS: "0",
        JOBOPS_BACKGROUND_DISCOVERY_TOP_N: "3",
        JOBOPS_BACKGROUND_DISCOVERY_MIN_SCORE: "70",
        JOBOPS_BACKGROUND_DISCOVERY_SOURCE_OVERRIDES: "remotive, jobicy",
      }),
      { runPipeline, autoSolvePendingChallengesWhile: vi.fn() },
    );

    service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith({
      topN: 3,
      minSuitabilityScore: 70,
      sources: ["remotive", "jobicy"],
      pauseOnChallenges: false,
    });

    service.stop();
  });

  it("omits unset optional overrides from the background pipeline config", async () => {
    const runPipeline = vi.fn().mockResolvedValue({ success: true });
    const service = createBackgroundDiscoveryService(
      getBackgroundDiscoveryConfigFromEnv({
        JOBOPS_BACKGROUND_DISCOVERY_ENABLED: "true",
        JOBOPS_BACKGROUND_DISCOVERY_MIN_INTERVAL_MS: "0",
      }),
      { runPipeline, autoSolvePendingChallengesWhile: vi.fn() },
    );

    await expect(service.triggerOnce("manual")).resolves.toBe("started");

    expect(runPipeline).toHaveBeenCalledWith({
      pauseOnChallenges: false,
    });
  });

  it("does not overlap runs or bypass cooldown", async () => {
    let resolveRun: (() => void) | undefined;
    const runPipeline = vi.fn(
      () =>
        new Promise<{
          success: boolean;
          jobsDiscovered: number;
          jobsProcessed: number;
        }>((resolve) => {
          resolveRun = () =>
            resolve({ success: true, jobsDiscovered: 0, jobsProcessed: 0 });
        }),
    );
    const service = createBackgroundDiscoveryService(
      getBackgroundDiscoveryConfigFromEnv({
        JOBOPS_BACKGROUND_DISCOVERY_ENABLED: "true",
        JOBOPS_BACKGROUND_DISCOVERY_INTERVAL_MS: "10000",
        JOBOPS_BACKGROUND_DISCOVERY_MIN_INTERVAL_MS: "1000",
      }),
      {
        runPipeline,
        now: () => 1_000,
        autoSolvePendingChallengesWhile: vi.fn(),
      },
    );

    const first = service.triggerOnce("manual");
    await Promise.resolve();

    await expect(service.triggerOnce("manual")).resolves.toBe("in_flight");
    resolveRun?.();
    await first;
    await expect(service.triggerOnce("manual")).resolves.toBe("cooldown");
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("requests an immediate autonomous auto-apply scan after successful discovery", async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      success: true,
      jobsDiscovered: 2,
      jobsProcessed: 2,
    });
    const requestAutoApplyScan = vi.fn().mockResolvedValue("started");
    const service = createBackgroundDiscoveryService(
      getBackgroundDiscoveryConfigFromEnv({
        JOBOPS_BACKGROUND_DISCOVERY_ENABLED: "true",
        JOBOPS_BACKGROUND_DISCOVERY_MIN_INTERVAL_MS: "0",
      }),
      {
        runPipeline,
        requestAutoApplyScan,
        autoSolvePendingChallengesWhile: vi.fn(),
      },
    );

    await expect(service.triggerOnce("manual")).resolves.toBe("started");

    expect(requestAutoApplyScan).toHaveBeenCalledWith("background-discovery");
  });

  it("does not request auto-apply scan after failed discovery", async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      success: false,
      jobsDiscovered: 0,
      jobsProcessed: 0,
      error: "pipeline failed",
    });
    const requestAutoApplyScan = vi.fn();
    const service = createBackgroundDiscoveryService(
      getBackgroundDiscoveryConfigFromEnv({
        JOBOPS_BACKGROUND_DISCOVERY_ENABLED: "true",
        JOBOPS_BACKGROUND_DISCOVERY_MIN_INTERVAL_MS: "0",
      }),
      {
        runPipeline,
        requestAutoApplyScan,
        autoSolvePendingChallengesWhile: vi.fn(),
      },
    );

    await expect(service.triggerOnce("manual")).resolves.toBe("started");

    expect(requestAutoApplyScan).not.toHaveBeenCalled();
  });

  it("auto-solves only when enabled and pending extractor challenges exist", async () => {
    const solveChallenge = vi.fn().mockResolvedValue({
      attempted: true,
      provider: "2captcha",
      result: { status: "solved" },
    });
    const resolvePipelineChallenge = vi.fn(() => ({
      resolved: true,
      remaining: 0,
    }));

    await expect(
      autoSolvePendingExtractorChallengesOnce({
        isAutomaticCaptchaSolvingEnabled: async () => false,
        getPendingChallenges: () => [
          {
            extractorId: "naukri",
            extractorName: "Naukri",
            url: "https://example.test/challenge",
            sources: ["naukri"],
          },
        ],
        solveChallenge,
        resolvePipelineChallenge,
      }),
    ).resolves.toEqual({ enabled: false, attempted: 0, solved: 0 });
    expect(solveChallenge).not.toHaveBeenCalled();

    await expect(
      autoSolvePendingExtractorChallengesOnce({
        isAutomaticCaptchaSolvingEnabled: async () => true,
        getPendingChallenges: () => [],
        solveChallenge,
        resolvePipelineChallenge,
      }),
    ).resolves.toEqual({ enabled: true, attempted: 0, solved: 0 });
    expect(solveChallenge).not.toHaveBeenCalled();

    await expect(
      autoSolvePendingExtractorChallengesOnce({
        isAutomaticCaptchaSolvingEnabled: async () => true,
        getPendingChallenges: () => [
          {
            extractorId: "naukri",
            extractorName: "Naukri",
            url: "https://example.test/challenge",
            sources: ["naukri"],
          },
        ],
        solveChallenge,
        resolvePipelineChallenge,
      }),
    ).resolves.toEqual({ enabled: true, attempted: 1, solved: 1 });
    expect(solveChallenge).toHaveBeenCalledWith({
      extractorId: "naukri",
      url: "https://example.test/challenge",
      logContext: { service: "background-discovery" },
    });
    expect(resolvePipelineChallenge).toHaveBeenCalledWith("naukri");
  });
});
