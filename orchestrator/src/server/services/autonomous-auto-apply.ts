import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import type { AutonomousAutoApplyJobPayload } from "@server/infra/job-queue";
import { getJobQueue } from "@server/infra/job-queue-registry";
import * as jobsRepo from "@server/repositories/jobs";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { getActiveTenantId } from "@server/tenancy/context";
import type { Job } from "@shared/types";
import {
  classifyPortalUrlForSession,
  evaluatePortalSubmitPolicy,
  isFullAutoBrowserSubmitEnabled,
  isFullAutoCaptchaEnabled,
  isFullAutoEnabled,
  submitPortalApplication,
} from "./application-browser";
import { transitionStage } from "./applicationTracking";
import {
  resolveAutoApplyRecipient,
  resolveHttpApplicationUrl,
  sendAutoApplication,
} from "./auto-apply";
import {
  getJobPdfFreshness,
  resolvePdfFingerprintContext,
} from "./pdf-fingerprint";

const DEFAULT_QUEUE_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const MIN_QUEUE_INTERVAL_MS = 10_000;
const PORTAL_SESSION_REVIEW_NOTE_TITLE = "Autonomous portal session required";
const terminalPortalReviewKeys = new Set<string>();

export type AutonomousAutoApplyDecision =
  | { action: "email_ready"; recipient: string }
  | { action: "portal_ready"; url: string }
  | { action: "captcha_ready"; url: string; reason: string }
  | { action: "review_only_portal"; reason: string; reasonCode?: string }
  | {
      action: "portal_session_required";
      reason: string;
      provider: "linkedin" | "indeed" | "generic";
    }
  | { action: "review_only_captcha"; reason: string; reasonCode?: string }
  | { action: "not_ready"; reason: string };

export type AutonomousAutoApplyConfig = {
  queueEnabled: boolean;
  emailApplyEnabled: boolean;
  fullAutoEnabled: boolean;
  browserSubmitEnabled: boolean;
  captchaApplyEnabled: boolean;
  portalAllowedDomains: string;
  portalBlockedDomains: string;
  portalSessionRequiredDomains: string;
  portalSessionValidatedDomains: string;
  portalStorageStatePath: string;
  portalValidatedSources: string;
  portalAllowSourceUrlFallback: boolean;
  intervalMs: number;
  batchLimit: number;
  retryDelayMs: number;
  runOnStart: boolean;
};

type AutonomousAutoApplyDependencies = {
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export type AutonomousAutoApplyService = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  requestScan(reason?: string): Promise<"started" | "disabled" | "in_flight">;
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
    fullAutoEnabled: isFullAutoEnabled(env),
    browserSubmitEnabled: isFullAutoBrowserSubmitEnabled(env),
    captchaApplyEnabled: isFullAutoCaptchaEnabled(env),
    portalAllowedDomains:
      env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS ??
      env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS ??
      "ashbyhq.com,jobs.ashbyhq.com",
    portalBlockedDomains:
      env.JOBOPS_AUTONOMOUS_PORTAL_BLOCKED_DOMAINS ??
      env.JOBOPS_FULL_AUTO_BLOCKED_DOMAINS ??
      "",
    portalSessionRequiredDomains:
      env.JOBOPS_AUTONOMOUS_PORTAL_SESSION_REQUIRED_DOMAINS ??
      env.JOBOPS_FULL_AUTO_SESSION_REQUIRED_DOMAINS ??
      "",
    portalSessionValidatedDomains:
      env.JOBOPS_AUTONOMOUS_PORTAL_SESSION_VALIDATED_DOMAINS ??
      env.JOBOPS_FULL_AUTO_SESSION_VALIDATED_DOMAINS ??
      "",
    portalStorageStatePath:
      env.JOBOPS_FULL_AUTO_BROWSER_STORAGE_STATE_PATH ??
      env.JOBOPS_AUTONOMOUS_PORTAL_STORAGE_STATE_PATH ??
      "",
    portalValidatedSources:
      env.JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES ??
      env.JOBOPS_FULL_AUTO_VALIDATED_SOURCES ??
      "",
    portalAllowSourceUrlFallback: parseBoolean(
      env.JOBOPS_AUTONOMOUS_PORTAL_ALLOW_SOURCE_URL_FALLBACK ??
        env.JOBOPS_FULL_AUTO_ALLOW_SOURCE_URL_FALLBACK,
    ),
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
    runOnStart: parseBoolean(env.JOBOPS_AUTONOMOUS_AUTO_APPLY_RUN_ON_START),
  };
}

function containsCaptchaSignal(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return ["captcha", "recaptcha", "hcaptcha", "cloudflare challenge"].some(
    (signal) => normalized.includes(signal),
  );
}

export function clearAutonomousPortalReviewBlocksForTests(): void {
  terminalPortalReviewKeys.clear();
}

function portalAttemptKey(job: Job, url: string): string {
  let domain = "unknown";
  try {
    domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    domain = "unknown";
  }
  return `${job.id}:${domain}`;
}

function portalPolicyEnvFromConfig(
  config: AutonomousAutoApplyConfig,
): NodeJS.ProcessEnv {
  return {
    JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: config.portalAllowedDomains,
    JOBOPS_AUTONOMOUS_PORTAL_BLOCKED_DOMAINS: config.portalBlockedDomains,
    JOBOPS_AUTONOMOUS_PORTAL_SESSION_REQUIRED_DOMAINS:
      config.portalSessionRequiredDomains,
    JOBOPS_AUTONOMOUS_PORTAL_SESSION_VALIDATED_DOMAINS:
      config.portalSessionValidatedDomains,
    JOBOPS_AUTONOMOUS_PORTAL_STORAGE_STATE_PATH: config.portalStorageStatePath,
    JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES: config.portalValidatedSources,
    JOBOPS_AUTONOMOUS_PORTAL_ALLOW_SOURCE_URL_FALLBACK:
      config.portalAllowSourceUrlFallback ? "true" : "false",
  };
}

export function classifyAutonomousAutoApply(
  job: Job,
  config: AutonomousAutoApplyConfig = getAutonomousAutoApplyConfigFromEnv(),
): AutonomousAutoApplyDecision {
  if (job.status !== "ready") {
    return { action: "not_ready", reason: "Job is not READY." };
  }

  const applicationUrl = resolveHttpApplicationUrl(job);
  const hasCaptchaSignal =
    containsCaptchaSignal(job.applicationLink) ||
    containsCaptchaSignal(job.jobUrl) ||
    containsCaptchaSignal(job.jobDescription) ||
    containsCaptchaSignal(job.jobBrief);
  const sessionGate =
    (applicationUrl && classifyPortalUrlForSession(applicationUrl)) || null;

  if (sessionGate) {
    return {
      action: "portal_session_required",
      provider: sessionGate.provider,
      reason: sessionGate.reason,
    };
  }

  const portalSubmitDecision =
    applicationUrl && config.browserSubmitEnabled
      ? evaluatePortalSubmitPolicy(
          job,
          applicationUrl,
          portalPolicyEnvFromConfig(config),
        )
      : null;
  if (applicationUrl && config.browserSubmitEnabled) {
    if (terminalPortalReviewKeys.has(portalAttemptKey(job, applicationUrl))) {
      return {
        action: "review_only_portal",
        reasonCode: "terminal_portal_blocker",
        reason:
          "Portal application has a terminal full-auto blocker recorded; human action is required before retry.",
      };
    }
    if (!portalSubmitDecision?.allowed) {
      return {
        action: "review_only_portal",
        reasonCode: portalSubmitDecision?.reasonCode,
        reason:
          portalSubmitDecision?.reason ??
          "Portal domain/source is not authorized for full-auto submission.",
      };
    }
  }

  if (hasCaptchaSignal) {
    if (
      config.browserSubmitEnabled &&
      config.captchaApplyEnabled &&
      applicationUrl
    ) {
      return {
        action: "captcha_ready",
        url: applicationUrl,
        reason:
          "CAPTCHA/challenge signal detected and explicit full-auto CAPTCHA submission is enabled.",
      };
    }
    return {
      action: "review_only_captcha",
      reasonCode: "portal_needs_review_captcha",
      reason:
        "CAPTCHA/challenge signal detected; paid portal CAPTCHA solving stays disabled unless explicitly enabled and budgeted.",
    };
  }

  const recipient = resolveAutoApplyRecipient(job);
  if (recipient) return { action: "email_ready", recipient };

  if (applicationUrl && config.browserSubmitEnabled) {
    return { action: "portal_ready", url: applicationUrl };
  }

  return {
    action: "review_only_portal",
    reason: applicationUrl
      ? "Browser/portal application is available but full-auto browser submission is disabled."
      : "No application route was found for this job.",
    reasonCode: applicationUrl
      ? "browser_apply_disabled"
      : "no_application_route",
  };
}

function getAutonomousMode(): AutonomousAutoApplyJobPayload["mode"] {
  const config = getAutonomousAutoApplyConfigFromEnv();
  if (config.browserSubmitEnabled) return "full_auto";
  return config.emailApplyEnabled ? "send_email" : "dry_run";
}

async function hydratePdfFreshness(job: Job): Promise<Job> {
  const fingerprintContext = await resolvePdfFingerprintContext();
  return {
    ...job,
    pdfFreshness: getJobPdfFreshness(job, fingerprintContext),
  };
}

function isPortalSessionReviewNote(note: {
  title: string;
  content: string;
}): boolean {
  return (
    note.title === PORTAL_SESSION_REVIEW_NOTE_TITLE ||
    /needs_portal_session|LinkedIn application URL is a login\/sign-up wall|authenticated portal session/i.test(
      note.content,
    )
  );
}

async function hasPriorPortalSessionReview(jobId: string): Promise<boolean> {
  const notes = await jobsRepo.listJobNotes(jobId).catch(() => []);
  return notes.some(isPortalSessionReviewNote);
}

async function recordPortalSessionReview(input: {
  jobId: string;
  provider: string;
  reason: string;
  reasonCode?: string | null;
}): Promise<void> {
  if (await hasPriorPortalSessionReview(input.jobId)) return;
  await jobsRepo.createJobNote({
    jobId: input.jobId,
    title: PORTAL_SESSION_REVIEW_NOTE_TITLE,
    content: [
      `needs_portal_session (${input.provider})`,
      input.reason,
      "Autonomous browser submit was skipped before any real submit click. Capture a logged-in portal session or provide explicit manual confirmation before retrying.",
    ].join("\n"),
  });
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

function readyPriorityTimestamp(job: Job): number {
  const value = job.readyAt ?? job.discoveredAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortReadyJobsNewestFirst(jobs: Job[]): Job[] {
  return [...jobs].sort(
    (left, right) =>
      readyPriorityTimestamp(right) - readyPriorityTimestamp(left),
  );
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

  for (const job of sortReadyJobsNewestFirst(jobs).slice(0, limit)) {
    const hydratedJob = await hydratePdfFreshness(job);
    const decision = classifyAutonomousAutoApply(hydratedJob);
    if (
      decision.action === "email_ready" ||
      decision.action === "portal_ready" ||
      decision.action === "captcha_ready"
    ) {
      await enqueueAutonomousAutoApplyForJob({
        jobId: job.id,
        requestedBy: input.requestedBy,
      });
      enqueued += 1;
      continue;
    }

    if (
      decision.action === "review_only_portal" ||
      decision.action === "review_only_captcha" ||
      decision.action === "portal_session_required"
    ) {
      reviewOnly += 1;
      logger.info("Autonomous auto-apply left job for human review", {
        jobId: job.id,
        decision: decision.action,
        reason: decision.reason,
        reasonCode:
          "reasonCode" in decision ? (decision.reasonCode ?? null) : null,
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
      const config = getAutonomousAutoApplyConfigFromEnv();
      const decision = classifyAutonomousAutoApply(hydratedJob, config);
      if (decision.action === "portal_session_required") {
        await recordPortalSessionReview({
          jobId: hydratedJob.id,
          provider: decision.provider,
          reason: decision.reason,
          reasonCode: null,
        });
        logger.info(
          "Autonomous full-auto portal application skipped before submit: portal session required",
          {
            tenantId: input.tenantId,
            jobId: input.jobId,
            provider: decision.provider,
            reason: decision.reason,
            reasonCode: "portal_needs_review_session_missing",
          },
        );
        return "processed";
      }

      if (
        decision.action !== "email_ready" &&
        decision.action !== "portal_ready" &&
        decision.action !== "captcha_ready"
      ) {
        logger.info("Autonomous auto-apply skipped review-only job", {
          tenantId: input.tenantId,
          jobId: input.jobId,
          decision: decision.action,
          reason: decision.reason,
          reasonCode: "reasonCode" in decision ? decision.reasonCode : null,
        });
        return "processed";
      }

      if (
        hydratedJob.pdfRegenerating ||
        hydratedJob.pdfFreshness === "regenerating"
      ) {
        return "retry_later";
      }

      if (decision.action === "email_ready") {
        if (!config.emailApplyEnabled && !config.browserSubmitEnabled) {
          logger.info("Autonomous auto-apply dry run email candidate", {
            tenantId: input.tenantId,
            jobId: input.jobId,
            recipient: decision.recipient,
          });
          return "processed";
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
      }

      if (!config.browserSubmitEnabled) {
        logger.info("Autonomous full-auto browser candidate left as dry run", {
          tenantId: input.tenantId,
          jobId: input.jobId,
          decision: decision.action,
        });
        return "processed";
      }

      if (await hasPriorPortalSessionReview(hydratedJob.id)) {
        logger.info(
          "Autonomous full-auto portal application skipped: prior gated portal review exists",
          {
            tenantId: input.tenantId,
            jobId: input.jobId,
          },
        );
        return "processed";
      }

      const browserApply = await submitPortalApplication(hydratedJob, {
        allowCaptcha:
          decision.action === "captcha_ready" && config.captchaApplyEnabled,
      });
      if (browserApply.status !== "submitted") {
        terminalPortalReviewKeys.add(
          portalAttemptKey(
            hydratedJob,
            browserApply.finalUrl || browserApply.url,
          ),
        );
        if (browserApply.reviewReason === "needs_portal_session") {
          await recordPortalSessionReview({
            jobId: hydratedJob.id,
            provider: "generic",
            reason:
              browserApply.reason ??
              "Portal session is required before autonomous submission.",
          });
        }
        await transitionStage(
          hydratedJob.id,
          "no_change",
          Math.floor(Date.now() / 1000),
          {
            eventLabel: "Autonomous portal apply needs review",
            actor: "system",
            externalUrl: browserApply.finalUrl,
            reasonCode:
              browserApply.outcomeMetadata.reasonCode ??
              browserApply.reasonCode ??
              "portal_needs_review_browser_error",
            eventType: "note",
            portalOutcome: browserApply.outcomeMetadata,
            note:
              browserApply.reason ??
              "Portal application could not be safely submitted automatically.",
          },
          null,
        );
        logger.warn("Autonomous full-auto browser application needs review", {
          tenantId: input.tenantId,
          jobId: input.jobId,
          decision: decision.action,
          reason: browserApply.reason ?? null,
          reasonCode:
            browserApply.outcomeMetadata.reasonCode ??
            browserApply.reasonCode ??
            null,
          portalOutcome: browserApply.outcomeMetadata,
          reviewReason: browserApply.reviewReason ?? null,
          captchaType: browserApply.captcha.type,
          captchaAttempted: browserApply.captcha.attempted,
          captchaSolved: browserApply.captcha.solved,
          screenshotPath: browserApply.screenshotPath ?? null,
        });
        return "processed";
      }

      const appliedAtDate = new Date(browserApply.submittedAt ?? Date.now());
      const appliedAt = appliedAtDate.toISOString();
      transitionStage(
        hydratedJob.id,
        "applied",
        Math.floor(appliedAtDate.getTime() / 1000),
        {
          eventLabel: "Autonomous full-auto browser apply",
          actor: "system",
          externalUrl: browserApply.finalUrl,
          reasonCode:
            browserApply.outcomeMetadata.reasonCode ?? "portal_submitted",
          note: `Submitted portal application via browser automation; fields=${browserApply.fieldsFilled}; resumeUploaded=${browserApply.resumeUploaded}; captcha=${browserApply.captcha.type ?? "none"}/${browserApply.captcha.solved ? "solved" : "not-needed"}`,
          portalOutcome: browserApply.outcomeMetadata,
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
  let scanInFlight = false;

  async function requestScan(
    reason = "manual",
  ): Promise<"started" | "disabled" | "in_flight"> {
    if (!config.queueEnabled) return "disabled";
    if (scanInFlight) return "in_flight";

    scanInFlight = true;
    try {
      await runWithRequestContext(
        {
          tenantId: DEFAULT_TENANT_ID,
          requestId: "autonomous-auto-apply-scan",
        },
        () =>
          enqueueAutonomousAutoApplyForReadyJobs({
            requestedBy: "system",
            limit: config.batchLimit,
          }),
      );
      logger.info("Autonomous auto-apply scan completed", { reason });
    } catch (error) {
      logger.warn("Autonomous auto-apply scan failed", {
        reason,
        error: sanitizeUnknown(error),
      });
    } finally {
      scanInFlight = false;
    }

    return "started";
  }

  return {
    start(): void {
      if (!config.queueEnabled || timer) return;
      timer = setIntervalFn(() => {
        void requestScan("interval");
      }, config.intervalMs);
      if (config.runOnStart) {
        void requestScan("startup");
      }
      logger.info("Autonomous auto-apply queue scanner started", {
        intervalMs: config.intervalMs,
        batchLimit: config.batchLimit,
        emailApplyEnabled: config.emailApplyEnabled,
        fullAutoEnabled: config.fullAutoEnabled,
        browserSubmitEnabled: config.browserSubmitEnabled,
        captchaApplyEnabled: config.captchaApplyEnabled,
        runOnStart: config.runOnStart,
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
    requestScan,
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

export async function requestAutonomousAutoApplyScan(
  reason = "external",
): Promise<"started" | "disabled" | "in_flight"> {
  const config = getAutonomousAutoApplyConfigFromEnv();
  if (!config.queueEnabled) return "disabled";
  if (!activeService) {
    activeService = createAutonomousAutoApplyService(config);
  }
  return activeService.requestScan(reason);
}
