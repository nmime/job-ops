import { reportProgress, stubNotFound } from "freelance-shared";
import type {
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "wantapply" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_WANTAPPLY";

/**
 * Wantapply finder.
 *
 * Wantapply exposes no credential-free public listing API. A real finder needs
 * one of:
 *   - WANTAPPLY_API_KEY   (official API / OAuth token)
 *   - WANTAPPLY_COOKIE    (authenticated session cookie)
 *
 * Until a credential is present this returns a structured "not configured"
 * result so the aggregator cycle stays alive and observable instead of
 * throwing. See docs/freelance-aggregator.md for the exact setup per platform.
 */
export async function findWantapplyGigs(
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
 * Wantapply apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_WANTAPPLY_APPLY_ENABLED=true. Never submits real money-bearing
 * proposals without that explicit opt-in plus a tailored draft.
 */
export async function applyToWantapplyGig(
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

/**
 * Wantapply-style batch export.
 *
 * Produces a portable JSON payload of scored gigs that an external
 * auto-applier (Wantapply or equivalent) can consume. Dry-run by default;
 * a real POST happens only when a webhook URL is configured AND
 * JOBOPS_FREELANCE_WANTAPPLY_APPLY_ENABLED=true.
 */
export async function exportBatchToWantapply(
  ctx: import("job-ops-shared/types/freelance").FreelanceExportContext,
): Promise<FreelanceApplyResult> {
  const payload = {
    provider: "wantapply",
    exportedAt: new Date().toISOString(),
    dryRun: ctx.dryRun,
    gigCount: ctx.gigs.length,
    gigs: ctx.gigs,
  };

  const webhookUrl =
    ctx.webhookUrl ?? process.env.JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL;

  if (ctx.dryRun || !webhookUrl) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "exported",
      exportPayload: payload,
      error: webhookUrl
        ? undefined
        : "dry-run: no JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL configured",
    };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        exportPayload: payload,
        error: `wantapply webhook returned HTTP ${res.status}`,
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "exported",
      exportPayload: payload,
      externalRef: `wantapply-batch-${Date.now()}`,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      exportPayload: payload,
      error: `wantapply webhook failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
