import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { getJobQueue } from "@server/infra/job-queue-registry";
import type { AutonomousAutoApplyJobPayload } from "@server/infra/job-queue";
import * as jobsRepo from "@server/repositories/jobs";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { getActiveTenantId } from "@server/tenancy/context";
import type { Job } from "@shared/types";
import { transitionStage } from "./applicationTracking";
import { resolveAutoApplyRecipient, sendAutoApplication } from "./auto-apply";
import {
  getJobPdfFreshness,
  resolvePdfFingerprintContext,
} from "./pdf-fingerprint";

const DEFAULT_QUEUE_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const MIN_QUEUE_INTERVAL_MS = 10_000;

export type AutonomousAutoApplyDecision =
  | { action: "email_ready"; recipient: string }
  | { action: "review_only_portal"; reason: string }
  | { action: "review_only_captcha"; reason: string }
  | { action: "not_ready"; reason: string };

export type AutonomousAutoApplyConfig = {
  queueEnabled: boolean;
  emailApplyEnabled: boolean;
  intervalMs: number;
  batchLimit: number;
  retryDelayMs: number;
};

type AutonomousAutoApplyDependencies = {
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export type AutonomousAutoApplyService = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function getAutonomousAutoApplyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AutonomousAutoApplyConfig {
  return {
    queueEnabled: parseBoolean(env.JOBOPS_AUTONOMOUS_AUTO_APPLY_QUEUE_ENABLED),
    emailApplyEnabled: parseBoolean(env.JOBOPS_AUTONOMOUS_EMAIL_APPLY_ENABLED),
    intervalMs: Math.max(
      MIN_QUEUE_INTERVAL_MS,
      parsePositiveInteger(env.JOBOPS_AUTONOMOUS_AUTO_APPLY_INTERVAL_MS) ??
        DEFAULT_QUEUE_INTERVAL_MS,
    ),
    batchLimit: Math.max(
      1,
      parsePositiveInteger(env.JOBOPS_AUTONOMOUS_AUTO_APPLY_BATCH_LIMIT) ??
        DEFAULT_BATCH_LIMIT,
    ),
    retryDelayMs: Math.max(
      0,
      parsePositiveInteger(env.JOBOPS_AUTONOMOUS_AUTO_APPLY_RETRY_DELAY_MS) ??
        DEFAULT_RETRY_DELAY_MS,
    ),
  };
}

function containsCaptchaSignal(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return ["captcha", "recaptcha", "hcaptcha", "cloudflare challenge"].some(
    (signal) => normalized.includes(signal),
  );
}

export function classifyAutonomousAutoApply(job: Job): AutonomousAutoApplyDecision {
  if (job.status !== "ready") {
    return { action: "not_ready", reason: "Job is not READY." };
  }

  // Safety boundary: autonomous auto-apply never attempts portal/CAPTCHA
  // submission or solver bypass. Extractor challenge solving is handled only by
  // the pipeline CAPTCHA service for server-known discovery challenges.
  if (
    containsCaptchaSignal(job.applicationLink) ||
    containsCaptchaSignal(job.jobUrl) ||
    containsCaptchaSignal(job.jobDescription) ||
    containsCaptchaSignal(job.jobBrief)
  ) {
    return {
      action: "review_only_captcha",
      reason: "CAPTCHA/challenge signal detected; human review is required.",
    };
  }

  const recipient = resolveAutoApplyRecipient(job);
  if (!recipient) {
    return {
      action: "review_only_portal",
      reason: "No application email found; portal applications stay human-in-loop.",
    };
  }

  return { action: "email_ready", recipient };
}

function getAutonomousMode(): AutonomousAutoApplyJobPayload["mode"] {
  return getAutonomousAutoApplyConfigFromEnv().emailApplyEnabled
    ? "send_email"
    : "dry_run";
}

async function hydratePdfFreshness(job: Job): Promise<Job> {
  const fingerprintContext = await resolvePdfFingerprintContext();
  return {
    ...job,
    pdfFreshness: getJobPdfFreshness(job, fingerprintContext),
  };
}

async function enqueuePayload(
  payload: AutonomousAutoApplyJobPayload,
  options?: { delayMs?: number },
): Promise<void> {
  await getJobQueue().enqueue("autonomous_auto_apply", payload, {
    dedupeKey: `${payload.tenantId}:${payload.jobId}`,
    delayMs: options?.delayMs,
  });
  scheduleWorker(options?.delayMs);
}

export async function enqueueAutonomousAutoApplyForJob(input: {
  jobId: string;
  requestedBy: "system" | "user";
}): Promise<void> {
  const tenantId = getActiveTenantId();
  await enqueuePayload({
    tenantId,
    jobId: input.jobId,
    requestedAt: new Date().toISOString(),
    requestedBy: input.requestedBy,
    mode: getAutonomousMode(),
  });
}

export async function enqueueAutonomousAutoApplyForReadyJobs(input: {
  requestedBy: "system" | "user";
  limit?: number;
}): Promise<{ enqueued: number; reviewOnly: number; skipped: number }> {
  const limit = Math.max(1, input.limit ?? DEFAULT_BATCH_LIMIT);
  const jobs = await jobsRepo.getAllJobs(["ready"]);
  let enqueued = 0;
  let reviewOnly = 0;
  let skipped = 0;

  for (const job of jobs.slice(0, limit)) {
    const hydratedJob = await hydratePdfFreshness(job);
    const decision = classifyAutonomousAutoApply(hydratedJob);
    if (decision.action === "email_ready") {
      await enqueueAutonomousAutoApplyForJob({
        jobId: job.id,
        requestedBy: input.requestedBy,
      });
      enqueued += 1;
      continue;
    }

    if (
      decision.action === "review_only_portal" ||
      decision.action === "review_only_captcha"
    ) {
      reviewOnly += 1;
      logger.info("Autonomous auto-apply left job for human review", {
        jobId: job.id,
        decision: decision.action,
        reason: decision.reason,
      });
      continue;
    }

    skipped += 1;
  }

  return { enqueued, reviewOnly, skipped };
}

let workerPromise: Promise<void> | null = null;
let workerRequested = false;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerTimerDueAt = 0;

function scheduleWorker(delayMs = 0): void {
  workerRequested = true;
  const normalizedDelayMs = Math.max(0, delayMs);

  if (normalizedDelayMs > 0) {
    const dueAt = Date.now() + normalizedDelayMs;
    if (!workerTimer || dueAt < workerTimerDueAt) {
      if (workerTimer) clearTimeout(workerTimer);
      workerTimerDueAt = dueAt;
      workerTimer = setTimeout(() => {
        workerTimer = null;
        workerTimerDueAt = 0;
        scheduleWorker();
      }, normalizedDelayMs);
    }
    return;
  }

  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
    workerTimerDueAt = 0;
  }

  if (workerPromise) return;
  workerPromise = runWorker().finally(() => {
    workerPromise = null;
    if (workerRequested) scheduleWorker();
  });
}

async function runWorker(): Promise<void> {
  while (workerRequested) {
    workerRequested = false;
    await drainAutonomousAutoApplyQueue();
  }
}

export async function drainAutonomousAutoApplyQueue(): Promise<void> {
  const queue = getJobQueue();

  while (true) {
    const queuedJob = await queue.reserveNext("autonomous_auto_apply");
    if (!queuedJob) return;

    try {
      const result = await processQueuedAutonomousAutoApply(queuedJob.payload);
      await queue.acknowledge(queuedJob.id);
      if (result === "retry_later") {
        await enqueuePayload(queuedJob.payload, {
          delayMs: getAutonomousAutoApplyConfigFromEnv().retryDelayMs,
        });
      }
    } catch (error) {
      logger.warn("Autonomous auto-apply queue job failed", {
        queue: "autonomous_auto_apply",
        tenantId: queuedJob.payload.tenantId,
        jobId: queuedJob.payload.jobId,
        error: sanitizeUnknown(error),
      });
      await queue.reject(queuedJob.id);
    }
  }
}

async function processQueuedAutonomousAutoApply(
  input: AutonomousAutoApplyJobPayload,
): Promise<"processed" | "retry_later"> {
  return runWithRequestContext(
    {
      tenantId: input.tenantId,
      jobId: input.jobId,
      requestId: "autonomous-auto-apply",
    },
    async () => {
      const job = await jobsRepo.getJobById(input.jobId);
      if (!job) return "processed";

      const hydratedJob = await hydratePdfFreshness(job);
      const decision = classifyAutonomousAutoApply(hydratedJob);
      if (decision.action !== "email_ready") {
        logger.info("Autonomous auto-apply skipped review-only job", {
          tenantId: input.tenantId,
          jobId: input.jobId,
          decision: decision.action,
          reason: decision.reason,
        });
        return "processed";
      }

      if (!getAutonomousAutoApplyConfigFromEnv().emailApplyEnabled) {
        logger.info("Autonomous auto-apply dry run candidate", {
          tenantId: input.tenantId,
          jobId: input.jobId,
          recipient: decision.recipient,
        });
        return "processed";
      }

      if (hydratedJob.pdfRegenerating || hydratedJob.pdfFreshness === "regenerating") {
        return "retry_later";
      }

      const autoApply = await sendAutoApplication(hydratedJob);
      const appliedAtDate = new Date();
      const appliedAt = appliedAtDate.toISOString();

      transitionStage(
        hydratedJob.id,
        "applied",
        Math.floor(appliedAtDate.getTime() / 1000),
        {
          eventLabel: "Autonomous email auto-apply",
          actor: "system",
          note: `Sent ${autoApply.mode} application to ${autoApply.recipient}`,
        },
        null,
      );

      await jobsRepo.updateJob(hydratedJob.id, {
        status: "applied",
        appliedAt,
      });

      return "processed";
    },
  );
}

export function createAutonomousAutoApplyService(
  config: AutonomousAutoApplyConfig = getAutonomousAutoApplyConfigFromEnv(),
  dependencies: AutonomousAutoApplyDependencies = {},
): AutonomousAutoApplyService {
  const setIntervalFn = dependencies.setInterval ?? setInterval;
  const clearIntervalFn = dependencies.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function scanAndQueue(): Promise<void> {
    try {
      await runWithRequestContext(
        { tenantId: DEFAULT_TENANT_ID, requestId: "autonomous-auto-apply-scan" },
        () =>
          enqueueAutonomousAutoApplyForReadyJobs({
            requestedBy: "system",
            limit: config.batchLimit,
          }),
      );
    } catch (error) {
      logger.warn("Autonomous auto-apply scan failed", {
        error: sanitizeUnknown(error),
      });
    }
  }

  return {
    start(): void {
      if (!config.queueEnabled || timer) return;
      timer = setIntervalFn(() => {
        void scanAndQueue();
      }, config.intervalMs);
      logger.info("Autonomous auto-apply queue scanner started", {
        intervalMs: config.intervalMs,
        batchLimit: config.batchLimit,
        emailApplyEnabled: config.emailApplyEnabled,
      });
    },
    stop(): void {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
      logger.info("Autonomous auto-apply queue scanner stopped");
    },
    isRunning(): boolean {
      return timer !== null;
    },
  };
}

let activeService: AutonomousAutoApplyService | null = null;

export function startAutonomousAutoApplyService(): AutonomousAutoApplyService | null {
  const config = getAutonomousAutoApplyConfigFromEnv();
  if (!config.queueEnabled) return null;
  activeService = createAutonomousAutoApplyService(config);
  activeService.start();
  return activeService;
}

export function stopAutonomousAutoApplyService(): void {
  activeService?.stop();
  activeService = null;
}
