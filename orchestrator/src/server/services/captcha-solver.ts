import { join } from "node:path";
import { logger } from "@infra/logger";
import { getDataDir } from "@server/config/dataDir";
import * as settingsRepo from "@server/repositories/settings";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { settingsRegistry } from "@shared/settings-registry";
import type { SolverResult } from "browser-utils";

type PaidChallengeSolverOptions = { provider: "2captcha"; apiKey: string };

type SolveExtractorChallengeInput = {
  extractorId: string;
  url: string;
  storageDir?: string;
  timeoutMs?: number;
  logContext?: Record<string, unknown>;
};

type SolveExtractorChallengeResult =
  | {
      attempted: true;
      provider: PaidChallengeSolverOptions["provider"];
      result: SolverResult;
    }
  | { attempted: false; provider: null; result: null };

/**
 * Central resolver for the paid CAPTCHA settings used by server-known extractor
 * challenge handling. This is intentionally not a generic CAPTCHA bypass layer:
 * portal/application CAPTCHA jobs remain human-review only.
 */
export async function getPaidChallengeSolverOptions(): Promise<PaidChallengeSolverOptions | null> {
  const settings = await settingsRepo.getAllSettings();
  const provider =
    settingsRegistry.captchaSolverProvider.parse(
      settings.captchaSolverProvider ??
        getOriginalEnvValue("CAPTCHA_SOLVER_PROVIDER"),
    ) ?? settingsRegistry.captchaSolverProvider.default();
  const enabled =
    settingsRegistry.captchaSolverAutoSolveEnabled.parse(
      settings.captchaSolverAutoSolveEnabled ??
        getOriginalEnvValue("CAPTCHA_SOLVER_AUTO_SOLVE_ENABLED"),
    ) ?? settingsRegistry.captchaSolverAutoSolveEnabled.default();
  const apiKey =
    settings.captchaSolverApiKey ??
    getOriginalEnvValue("CAPTCHA_SOLVER_API_KEY");

  return enabled && provider === "2captcha" && apiKey
    ? { provider, apiKey }
    : null;
}

export async function isAutomaticCaptchaSolvingEnabled(): Promise<boolean> {
  return (await getPaidChallengeSolverOptions()) !== null;
}

export async function solveExtractorChallenge(
  input: SolveExtractorChallengeInput,
): Promise<SolveExtractorChallengeResult> {
  const paidSolver = await getPaidChallengeSolverOptions();
  if (!paidSolver) {
    return { attempted: false, provider: null, result: null };
  }

  logger.info("Using paid CAPTCHA solver for extractor challenge", {
    ...input.logContext,
    extractorId: input.extractorId,
    provider: paidSolver.provider,
  });

  const { solveChallenge } = await import("browser-utils");
  const result = await solveChallenge(
    input.url,
    input.extractorId,
    input.storageDir ?? join(getDataDir(), "cloudflare-cookies"),
    input.timeoutMs,
    {
      paidCaptcha: paidSolver,
      headless: true,
      manualFallback: false,
    },
  );

  return { attempted: true, provider: paidSolver.provider, result };
}
