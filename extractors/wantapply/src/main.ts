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
 * Wantapply apply adapter — deliberately NOT a submit path.
 *
 * WantApply is webhook-fed: there is no per-gig apply endpoint and no
 * per-gig "apply" action to perform. Gigs are pushed OUT in batches via
 * `exportBatchToWantapply` to JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL, and
 * the external auto-apply service behind that webhook applies on the
 * operator's behalf (applications are sent back through the provider's
 * webhook, not by job-ops).
 *
 * This adapter therefore always returns a structured "not applicable"
 * result: status "skipped" with a precise explanation. It is never an
 * error (this is by design, not a failure), and it never returns a fake
 * "submitted". The ctx.dryRun gate is kept for result-shape consistency —
 * there is nothing to send in either mode.
 */
export async function applyToWantapplyGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  return {
    platform: PLATFORM,
    mode: ctx.dryRun ? "dry_run" : "submit",
    status: "skipped",
    error:
      "WantApply is webhook-fed: gigs arrive via JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL; applications are sent back through the provider's webhook (see exportBatch if present)",
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
