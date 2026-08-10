import { reportProgress, stubNotFound } from "freelance-shared";
import type {
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceExportContext,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "wantapply" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_WANTAPPLY";

/**
 * Wantapply — auto-apply EXPORT adapter (not a listing source).
 *
 * Wantapply (https://wantapply.com) is an external auto-apply service, not a
 * job board: it exposes no public listing feed (the site is Cloudflare-gated
 * and serves no anonymous gig data — verified live: 403 challenge). The
 * genuinely useful integration here is `exportBatchToWantapply` below, which
 * hands the aggregator's scored gigs to a Wantapply webhook.
 *
 * The finder therefore only has a structured "not configured" path: it
 * returns success:false with an actionable message naming the exact env var
 * and never throws, so the aggregator cycle stays alive and observable.
 */
export async function findWantapplyGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const apiKey =
    ctx.settings[`${ENV_PREFIX}_API_KEY`] ??
    process.env[`${ENV_PREFIX}_API_KEY`];
  const cookie =
    ctx.settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`];

  reportProgress(ctx, `${PLATFORM}: no public gig feed — exporter only`);
  return stubNotFound({
    platform: PLATFORM,
    message:
      apiKey || cookie
        ? `${PLATFORM}: credentials present, but wantapply.com is an auto-apply service with no public gig listing API (Cloudflare-gated, no search endpoint) — use exportBatchToWantapply to push scored gigs to it instead`
        : `${PLATFORM}: not configured — wantapply.com exposes no credential-free gig feed (auto-apply service, not a job board). Set ${ENV_PREFIX}_API_KEY or ${ENV_PREFIX}_COOKIE if a listing API is provisioned, and ${ENV_PREFIX}_WEBHOOK_URL to export batches`,
  });
}

/**
 * Wantapply apply adapter.
 *
 * Single-gig "apply" is not part of the Wantapply model — submissions go out
 * in batches via `exportBatchToWantapply`. This adapter is GUARDED: ctx.dryRun
 * is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_WANTAPPLY_APPLY_ENABLED=true, and the non-dry-run path
 * points the caller at the batch exporter instead of faking a submit.
 */
export async function applyToWantapplyGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and configure ${ENV_PREFIX}_WEBHOOK_URL to submit for real)`,
    };
  }

  const webhookUrl = process.env[`${ENV_PREFIX}_WEBHOOK_URL`];
  if (!webhookUrl) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_WEBHOOK_URL — wantapply applies in batches; configure the webhook and use exportBatchToWantapply`,
    };
  }

  return {
    platform: PLATFORM,
    mode: "submit",
    status: "error",
    error: `${PLATFORM}: single-gig submit is not supported by wantapply (batch auto-apply service) — queue the gig and use exportBatchToWantapply`,
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
  ctx: FreelanceExportContext,
): Promise<FreelanceApplyResult> {
  const payload = {
    provider: "wantapply",
    exportedAt: new Date().toISOString(),
    dryRun: ctx.dryRun,
    gigCount: ctx.gigs.length,
    gigs: ctx.gigs,
  };

  const webhookUrl = ctx.webhookUrl ?? process.env[`${ENV_PREFIX}_WEBHOOK_URL`];

  if (ctx.dryRun || !webhookUrl) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "exported",
      exportPayload: payload,
      error: webhookUrl
        ? undefined
        : `dry-run: no ${ENV_PREFIX}_WEBHOOK_URL configured`,
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
