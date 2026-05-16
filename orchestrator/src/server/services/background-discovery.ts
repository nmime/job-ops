import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import type { PipelineConfig, PipelinePendingChallenge } from "@shared/types";
import { requestAutonomousAutoApplyScan } from "./autonomous-auto-apply";
import {
  isAutomaticCaptchaSolvingEnabled,
  solveExtractorChallenge,
} from "./captcha-solver";

const DEFAULT_DISCOVERY_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_DISCOVERY_MIN_INTERVAL_MS = 5 * 60 * 1000;
const MIN_TIMER_INTERVAL_MS = 10_000;
const CAPTCHA_AUTO_SOLVE_POLL_INTERVAL_MS = 1_000;

export type BackgroundDiscoveryConfig = {
  enabled: boolean;
  intervalMs: number;
  minIntervalMs: number;
  runOnStart: boolean;
  topN?: number;
  minSuitabilityScore?: number;
  sources?: NonNullable<PipelineConfig["sources"]>;
};

type BackgroundDiscoveryRunReason = "startup" | "interval" | "manual";

type RunPipeline = (config?: Partial<PipelineConfig>) => Promise<{
  success: boolean;
  jobsDiscovered: number;
  jobsProcessed: number;
  error?: string;
}>;

type BackgroundDiscoveryDependencies = {
  runPipeline?: RunPipeline;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  autoSolvePendingChallengesWhile?: (
    runPromise: Promise<unknown>,
  ) => Promise<void>;
  requestAutoApplyScan?: (reason: string) => Promise<unknown>;
};

export type BackgroundDiscoveryService = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  triggerOnce(
    reason?: BackgroundDiscoveryRunReason,
  ): Promise<"started" | "disabled" | "in_flight" | "cooldown">;
};

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseSources(
  value: string | undefined,
): NonNullable<PipelineConfig["sources"]> | undefined {
  const sources = value
    ?.split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  return sources && sources.length > 0
    ? (sources as NonNullable<PipelineConfig["sources"]>)
    : undefined;
}

export function getBackgroundDiscoveryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BackgroundDiscoveryConfig {
  const configuredIntervalMs = parsePositiveInteger(
    env.JOBOPS_BACKGROUND_DISCOVERY_INTERVAL_MS,
  );
  const configuredMinIntervalMs = parsePositiveInteger(
    env.JOBOPS_BACKGROUND_DISCOVERY_MIN_INTERVAL_MS,
  );
  const intervalMs = Math.max(
    MIN_TIMER_INTERVAL_MS,
    configuredIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS,
  );
  const minIntervalMs = Math.max(
    0,
    configuredMinIntervalMs ?? DEFAULT_DISCOVERY_MIN_INTERVAL_MS,
  );

  return {
    enabled: parseBoolean(env.JOBOPS_BACKGROUND_DISCOVERY_ENABLED),
    intervalMs,
    minIntervalMs,
    runOnStart: parseBoolean(env.JOBOPS_BACKGROUND_DISCOVERY_RUN_ON_START),
    topN: parsePositiveInteger(env.JOBOPS_BACKGROUND_DISCOVERY_TOP_N),
    minSuitabilityScore: parsePositiveInteger(
      env.JOBOPS_BACKGROUND_DISCOVERY_MIN_SCORE,
    ),
    sources: parseSources(env.JOBOPS_BACKGROUND_DISCOVERY_SOURCE_OVERRIDES),
  };
}

function buildPipelineConfig(
  config: BackgroundDiscoveryConfig,
): Partial<PipelineConfig> {
  return {
    topN: config.topN,
    minSuitabilityScore: config.minSuitabilityScore,
    sources: config.sources,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function autoSolvePendingExtractorChallengesOnce(
  dependencies: {
    isAutomaticCaptchaSolvingEnabled?: () => Promise<boolean>;
    getPendingChallenges?: () => PipelinePendingChallenge[];
    resolvePipelineChallenge?: (extractorId: string) => {
      resolved: boolean;
      remaining: number;
    };
    solveChallenge?: typeof solveExtractorChallenge;
  } = {},
): Promise<{ enabled: boolean; attempted: number; solved: number }> {
  const enabled = await (
    dependencies.isAutomaticCaptchaSolvingEnabled ??
    isAutomaticCaptchaSolvingEnabled
  )();
  if (!enabled) return { enabled: false, attempted: 0, solved: 0 };

  const pipeline =
    dependencies.getPendingChallenges && dependencies.resolvePipelineChallenge
      ? null
      : await import("@server/pipeline");
  const getPendingChallenges =
    dependencies.getPendingChallenges ?? pipeline?.getPendingChallenges;
  const resolvePipelineChallenge =
    dependencies.resolvePipelineChallenge ?? pipeline?.resolvePipelineChallenge;
  if (!getPendingChallenges || !resolvePipelineChallenge) {
    return { enabled: true, attempted: 0, solved: 0 };
  }
  const solveChallenge = dependencies.solveChallenge ?? solveExtractorChallenge;
  const pending = getPendingChallenges();
  let attempted = 0;
  let solved = 0;

  for (const challenge of pending) {
    attempted += 1;
    const result = await solveChallenge({
      extractorId: challenge.extractorId,
      url: challenge.url,
      logContext: { service: "background-discovery" },
    });
    if (result.result?.status !== "solved") continue;
    const resolution = resolvePipelineChallenge(challenge.extractorId);
    if (resolution.resolved) solved += 1;
  }

  if (attempted > 0) {
    logger.info("Background discovery CAPTCHA auto-solve pass completed", {
      attempted,
      solved,
    });
  }

  return { enabled: true, attempted, solved };
}

async function autoSolvePendingChallengesWhile(
  runPromise: Promise<unknown>,
): Promise<void> {
  if (!(await isAutomaticCaptchaSolvingEnabled())) return;

  const done = Symbol("done");
  while (true) {
    const state = await Promise.race([
      runPromise.then(
        () => done,
        () => done,
      ),
      wait(CAPTCHA_AUTO_SOLVE_POLL_INTERVAL_MS).then(() => null),
    ]);
    if (state === done) return;
    await autoSolvePendingExtractorChallengesOnce({
      isAutomaticCaptchaSolvingEnabled: async () => true,
    });
  }
}

export function createBackgroundDiscoveryService(
  config: BackgroundDiscoveryConfig = getBackgroundDiscoveryConfigFromEnv(),
  dependencies: BackgroundDiscoveryDependencies = {},
): BackgroundDiscoveryService {
  const run =
    dependencies.runPipeline ??
    (async (pipelineConfig) => {
      const { runPipeline } = await import("@server/pipeline");
      return runPipeline(pipelineConfig);
    });
  const now = dependencies.now ?? Date.now;
  const setIntervalFn = dependencies.setInterval ?? setInterval;
  const clearIntervalFn = dependencies.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lastStartedAt = 0;

  async function triggerOnce(
    reason: BackgroundDiscoveryRunReason = "manual",
  ): Promise<"started" | "disabled" | "in_flight" | "cooldown"> {
    if (!config.enabled) return "disabled";
    if (inFlight) return "in_flight";

    const startedAt = now();
    if (lastStartedAt > 0 && startedAt - lastStartedAt < config.minIntervalMs) {
      logger.debug("Background discovery skipped during cooldown", {
        reason,
        cooldownRemainingMs: config.minIntervalMs - (startedAt - lastStartedAt),
      });
      return "cooldown";
    }

    inFlight = true;
    lastStartedAt = startedAt;
    try {
      const result = await runWithRequestContext(
        { tenantId: DEFAULT_TENANT_ID, requestId: "background-discovery" },
        async () => {
          const runPromise = run(buildPipelineConfig(config));
          await (
            dependencies.autoSolvePendingChallengesWhile ??
            autoSolvePendingChallengesWhile
          )(runPromise);
          return runPromise;
        },
      );
      if (result.success) {
        await (
          dependencies.requestAutoApplyScan ?? requestAutonomousAutoApplyScan
        )("background-discovery");
      }
      logger.info("Background discovery pipeline completed", {
        reason,
        success: result.success,
        jobsDiscovered: result.jobsDiscovered,
        jobsProcessed: result.jobsProcessed,
      });
    } catch (error) {
      logger.warn("Background discovery pipeline failed", {
        reason,
        error: sanitizeUnknown(error),
      });
    } finally {
      inFlight = false;
    }

    return "started";
  }

  return {
    start(): void {
      if (!config.enabled || timer) return;
      timer = setIntervalFn(() => {
        void triggerOnce("interval");
      }, config.intervalMs);
      if (config.runOnStart) {
        void triggerOnce("startup");
      }
      logger.info("Background discovery listener started", {
        intervalMs: config.intervalMs,
        minIntervalMs: config.minIntervalMs,
        runOnStart: config.runOnStart,
        sources: config.sources,
      });
    },
    stop(): void {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
      logger.info("Background discovery listener stopped");
    },
    isRunning(): boolean {
      return timer !== null;
    },
    triggerOnce,
  };
}

let activeService: BackgroundDiscoveryService | null = null;

export function startBackgroundDiscoveryService(): BackgroundDiscoveryService | null {
  const config = getBackgroundDiscoveryConfigFromEnv();
  if (!config.enabled) return null;
  activeService = createBackgroundDiscoveryService(config);
  activeService.start();
  return activeService;
}

export function stopBackgroundDiscoveryService(): void {
  activeService?.stop();
  activeService = null;
}
