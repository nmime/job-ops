import { reportProgress, stubNotFound } from "freelance-shared";
import type {
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "contra" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_CONTRA";

/**
 * Contra finder.
 *
 * Contra exposes no credential-free public listing API. A real finder needs
 * one of:
 *   - CONTRA_API_KEY   (official API / OAuth token)
 *   - CONTRA_COOKIE    (authenticated session cookie)
 *
 * Until a credential is present this returns a structured "not configured"
 * result so the aggregator cycle stays alive and observable instead of
 * throwing. See docs/freelance-aggregator.md for the exact setup per platform.
 */
export async function findContraGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const apiKey = ctx.settings[`${ENV_PREFIX}_API_KEY`] ?? process.env[`${ENV_PREFIX}_API_KEY`];
  const cookie = ctx.settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`];

  if (!apiKey && !cookie) {
    reportProgress(ctx, `${PLATFORM}: no credentials configured, skipping`);
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: not configured — set ${ENV_PREFIX}_API_KEY or ${ENV_PREFIX}_COOKIE to enable discovery`,
    });
  }

  reportProgress(ctx, `${PLATFORM}: credentials present but adapter not implemented`);
  return stubNotFound({
    platform: PLATFORM,
    message: `${PLATFORM}: credentialed finder adapter not implemented yet`,
  });
}

/**
 * Contra apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_CONTRA_APPLY_ENABLED=true. Never submits real money-bearing
 * proposals without that explicit opt-in plus a tailored draft.
 */
export async function applyToContraGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and configure credentials to submit for real)`,
    };
  }

  return {
    platform: PLATFORM,
    mode: "submit",
    status: "error",
    error: `${PLATFORM}: submit adapter not implemented (requires platform credentials + OAuth flow)`,
  };
}
