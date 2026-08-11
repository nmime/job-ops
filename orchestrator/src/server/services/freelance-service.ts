import { logger } from "@infra/logger";
import {
  isFreelanceAutobidEnabled,
  resolveEnabledPlatforms,
} from "@server/services/freelance/aggregator";
import { runFreelanceWorker } from "@server/services/freelance/worker";

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Autonomous freelance worker background service.
 *
 * OFF by default. Set JOBOPS_FREELANCE_WORKER_ENABLED=true to run continuous
 * discover -> dedupe -> score -> propose -> (guarded) apply cycles. Respects the
 * same 3-gate safety model as the API, so submissions still require per-platform
 * opt-in + FREELANCE_AUTOBID_ENABLED=true.
 */
export function startFreelanceWorkerService(): void {
  if (process.env.JOBOPS_FREELANCE_WORKER_ENABLED !== "true") {
    logger.info(
      "Freelance worker disabled (set JOBOPS_FREELANCE_WORKER_ENABLED=true to enable)",
    );
    return;
  }
  if (timer) return;

  const intervalMinutes = Number.parseInt(
    process.env.JOBOPS_FREELANCE_WORKER_INTERVAL_MINUTES ?? "60",
    10,
  );
  const intervalMs =
    (Number.isNaN(intervalMinutes) ? 60 : Math.max(5, intervalMinutes)) *
    60 *
    1000;

  logger.info("Freelance worker service starting", {
    intervalMinutes,
    autobid: isFreelanceAutobidEnabled(),
    platforms: resolveEnabledPlatforms(),
  });

  const tick = async (): Promise<void> => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      await runFreelanceWorker({
        cycles: 1,
        intervalMs: 0,
        searchTerms: (
          process.env.JOBOPS_FREELANCE_SEARCH_TERMS ??
          "typescript,react,node,python"
        )
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        profileSkills: (
          process.env.JOBOPS_FREELANCE_PROFILE_SKILLS ??
          "TypeScript,React,Node.js,PostgreSQL,Python,AWS"
        )
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        minScore: Number.parseInt(
          process.env.JOBOPS_FREELANCE_MIN_SCORE ?? "40",
          10,
        ),
        bidsPerCycle: Number.parseInt(
          process.env.JOBOPS_FREELANCE_BIDS_PER_CYCLE ?? "3",
          10,
        ),
      });
    } catch (error) {
      logger.warn("Freelance worker cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
}

export function stopFreelanceWorkerService(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
