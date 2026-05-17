import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  reserveNext: vi.fn(),
  acknowledge: vi.fn(),
  reject: vi.fn(),
  getAllJobs: vi.fn(),
  getJobById: vi.fn(),
  updateJob: vi.fn(),
  sendAutoApplication: vi.fn(),
  submitPortalApplication: vi.fn(),
  resolveAutoApplyRecipient: vi.fn(),
  transitionStage: vi.fn(),
  getJobPdfFreshness: vi.fn(),
}));

vi.mock("@server/infra/job-queue-registry", () => ({
  getJobQueue: vi.fn(() => ({
    enqueue: mocks.enqueue,
    reserveNext: mocks.reserveNext,
    acknowledge: mocks.acknowledge,
    reject: mocks.reject,
  })),
}));

vi.mock("@server/repositories/jobs", () => ({
  getAllJobs: mocks.getAllJobs,
  getJobById: mocks.getJobById,
  updateJob: mocks.updateJob,
}));

vi.mock("@server/tenancy/context", () => ({
  getActiveTenantId: vi.fn(() => "tenant-test"),
}));

vi.mock("./auto-apply", () => ({
  resolveAutoApplyRecipient: mocks.resolveAutoApplyRecipient,
  sendAutoApplication: mocks.sendAutoApplication,
}));

vi.mock("./application-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./application-browser")>();
  return {
    ...actual,
    submitPortalApplication: mocks.submitPortalApplication,
  };
});

vi.mock("./applicationTracking", () => ({
  transitionStage: mocks.transitionStage,
}));

vi.mock("./pdf-fingerprint", () => ({
  resolvePdfFingerprintContext: vi.fn().mockResolvedValue({}),
  getJobPdfFreshness: mocks.getJobPdfFreshness,
}));

import {
  classifyAutonomousAutoApply,
  createAutonomousAutoApplyService,
  drainAutonomousAutoApplyQueue,
  enqueueAutonomousAutoApplyForJob,
  enqueueAutonomousAutoApplyForReadyJobs,
  getAutonomousAutoApplyConfigFromEnv,
} from "./autonomous-auto-apply";

describe("autonomous auto-apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue({
      id: "queue-job-1",
      queue: "autonomous_auto_apply",
      acceptedAt: "2026-05-04T10:00:00.000Z",
      deduplicated: false,
    });
    mocks.reserveNext.mockResolvedValue(null);
    mocks.acknowledge.mockResolvedValue(undefined);
    mocks.reject.mockResolvedValue(undefined);
    mocks.getAllJobs.mockResolvedValue([]);
    mocks.getJobById.mockResolvedValue(null);
    mocks.updateJob.mockResolvedValue(createJob({ status: "applied" }));
    mocks.sendAutoApplication.mockResolvedValue({
      mode: "email",
      recipient: "jobs@example.com",
      subject: "Application",
      messageId: "msg-1",
      attachedResume: true,
    });
    mocks.submitPortalApplication.mockResolvedValue({
      mode: "browser",
      status: "submitted",
      url: "https://example.com/apply",
      finalUrl: "https://example.com/thanks",
      submittedAt: "2026-05-04T10:00:00.000Z",
      fieldsFilled: 5,
      resumeUploaded: true,
      submitClicked: true,
      captcha: { attempted: false, solved: false, type: null, provider: null },
    });
    mocks.resolveAutoApplyRecipient.mockImplementation((job) =>
      String(job.applicationLink ?? "").startsWith("mailto:") ||
      String(job.emails ?? "").includes("@") ||
      String(job.jobDescription ?? "").includes("@")
        ? "jobs@example.com"
        : null,
    );
    mocks.getJobPdfFreshness.mockReturnValue("current");
  });

  afterEach(() => {
    delete process.env.JOBOPS_AUTONOMOUS_EMAIL_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_AUTO_APPLY_QUEUE_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_AUTO_APPLY_RUN_ON_START;
    delete process.env.JOBOPS_FULL_AUTO_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED;
    delete process.env.JOBOPS_FULL_AUTO_ENABLED;
    delete process.env.JOBOPS_FULL_AUTO_BROWSER_SUBMIT_ENABLED;
    delete process.env.JOBOPS_FULL_AUTO_CAPTCHA_ENABLED;
    vi.useRealTimers();
  });

  it("is disabled and dry-run by default", () => {
    expect(getAutonomousAutoApplyConfigFromEnv({})).toMatchObject({
      queueEnabled: false,
      emailApplyEnabled: false,
      runOnStart: false,
    });
  });

  it("enqueues email-ready jobs with tenant-scoped dedupe", async () => {
    await enqueueAutonomousAutoApplyForJob({
      jobId: "job-1",
      requestedBy: "system",
    });
    await Promise.resolve();

    expect(mocks.enqueue).toHaveBeenCalledWith(
      "autonomous_auto_apply",
      expect.objectContaining({
        tenantId: "tenant-test",
        jobId: "job-1",
        requestedBy: "system",
        mode: "dry_run",
      }),
      { dedupeKey: "tenant-test:job-1", delayMs: undefined },
    );
  });

  it("dry-run queue processing does not send email or mark applied", async () => {
    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-job-1",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-1",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "dry_run",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(
      createJob({
        id: "job-1",
        status: "ready",
        applicationLink: "mailto:jobs@example.com",
        pdfPath: "data/pdfs/job-1.pdf",
        pdfSource: "uploaded",
      }),
    );

    await drainAutonomousAutoApplyQueue();

    expect(mocks.sendAutoApplication).not.toHaveBeenCalled();
    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect(mocks.acknowledge).toHaveBeenCalledWith("queue-job-1");
  });

  it("explicit email opt-in delegates to sendAutoApplication and marks applied", async () => {
    process.env.JOBOPS_AUTONOMOUS_EMAIL_APPLY_ENABLED = "true";
    const job = createJob({
      id: "job-1",
      status: "ready",
      applicationLink: "mailto:jobs@example.com",
      pdfPath: "data/pdfs/job-1.pdf",
      pdfSource: "uploaded",
    });
    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-job-1",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-1",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "send_email",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(job);

    await drainAutonomousAutoApplyQueue();

    expect(mocks.sendAutoApplication).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", pdfFreshness: "current" }),
    );
    expect(mocks.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        status: "applied",
        appliedAt: expect.any(String),
      }),
    );
    expect(mocks.transitionStage).toHaveBeenCalled();
    expect(mocks.acknowledge).toHaveBeenCalledWith("queue-job-1");
  });

  it("send failures do not mark jobs applied", async () => {
    process.env.JOBOPS_AUTONOMOUS_EMAIL_APPLY_ENABLED = "true";
    mocks.sendAutoApplication.mockRejectedValueOnce(new Error("SMTP down"));
    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-job-1",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-1",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "send_email",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(
      createJob({
        id: "job-1",
        status: "ready",
        applicationLink: "mailto:jobs@example.com",
        pdfPath: "data/pdfs/job-1.pdf",
        pdfSource: "uploaded",
      }),
    );

    await drainAutonomousAutoApplyQueue();

    expect(mocks.updateJob).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalledWith("queue-job-1");
    expect(mocks.reject).toHaveBeenCalledWith("queue-job-1");
  });

  it("keeps portal and CAPTCHA jobs review-only", async () => {
    const portalJob = createJob({
      id: "job-portal",
      status: "ready",
      applicationLink: "https://example.com/apply",
      jobDescription: "Apply through our portal.",
    });
    const captchaJob = createJob({
      id: "job-captcha",
      status: "ready",
      applicationLink: "mailto:jobs@example.com",
      jobDescription: "Application may require CAPTCHA verification.",
    });
    mocks.getAllJobs.mockResolvedValue([portalJob, captchaJob]);

    const result = await enqueueAutonomousAutoApplyForReadyJobs({
      requestedBy: "system",
    });

    expect(classifyAutonomousAutoApply(portalJob).action).toBe(
      "review_only_portal",
    );
    expect(classifyAutonomousAutoApply(captchaJob).action).toBe(
      "review_only_captcha",
    );
    expect(result).toEqual({ enqueued: 0, reviewOnly: 2, skipped: 0 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("explicit FULL_AUTO enqueues and submits portal jobs via browser", async () => {
    process.env.JOBOPS_FULL_AUTO_APPLY_ENABLED = "true";
    const portalJob = createJob({
      id: "job-portal",
      status: "ready",
      applicationLink: "https://example.com/apply",
      pdfPath: "data/pdfs/job-portal.pdf",
      pdfSource: "uploaded",
    });

    expect(
      classifyAutonomousAutoApply(
        portalJob,
        getAutonomousAutoApplyConfigFromEnv(process.env),
      ).action,
    ).toBe("portal_ready");

    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-job-portal",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-portal",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "full_auto",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(portalJob);

    await drainAutonomousAutoApplyQueue();

    expect(mocks.submitPortalApplication).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-portal" }),
      { allowCaptcha: false },
    );
    expect(mocks.updateJob).toHaveBeenCalledWith(
      "job-portal",
      expect.objectContaining({ status: "applied" }),
    );
  });

  it("FULL_AUTO CAPTCHA path requires the explicit CAPTCHA gate", async () => {
    const captchaJob = createJob({
      id: "job-captcha",
      status: "ready",
      applicationLink: "https://example.com/apply",
      jobDescription: "Includes reCAPTCHA",
    });

    expect(
      classifyAutonomousAutoApply(
        captchaJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
        }),
      ).action,
    ).toBe("captcha_ready");
    expect(
      classifyAutonomousAutoApply(
        captchaJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED: "false",
        }),
      ).action,
    ).toBe("review_only_captcha");
  });

  it("runs a safe scanner pass on start only when explicitly configured", async () => {
    vi.useFakeTimers();
    mocks.getAllJobs.mockResolvedValue([
      createJob({
        id: "job-start",
        status: "ready",
        applicationLink: "mailto:jobs@example.com",
      }),
    ]);
    const service = createAutonomousAutoApplyService(
      getAutonomousAutoApplyConfigFromEnv({
        JOBOPS_AUTONOMOUS_AUTO_APPLY_QUEUE_ENABLED: "true",
        JOBOPS_AUTONOMOUS_AUTO_APPLY_RUN_ON_START: "true",
        JOBOPS_AUTONOMOUS_AUTO_APPLY_INTERVAL_MS: "10000",
      }),
    );

    service.start();
    expect(service.isRunning()).toBe(true);
    for (let i = 0; i < 10 && mocks.enqueue.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(mocks.getAllJobs).toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "autonomous_auto_apply",
      expect.objectContaining({ jobId: "job-start", mode: "dry_run" }),
      expect.any(Object),
    );
    service.stop();
  });

  it("does not overlap scanner requests", async () => {
    let resolveScan: ((value: unknown[]) => void) | undefined;
    mocks.getAllJobs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );
    const service = createAutonomousAutoApplyService(
      getAutonomousAutoApplyConfigFromEnv({
        JOBOPS_AUTONOMOUS_AUTO_APPLY_QUEUE_ENABLED: "true",
      }),
    );

    const first = service.requestScan("manual");
    await Promise.resolve();

    await expect(service.requestScan("manual")).resolves.toBe("in_flight");
    resolveScan?.([]);
    await expect(first).resolves.toBe("started");
    expect(mocks.getAllJobs).toHaveBeenCalledTimes(1);
  });

  it("prioritizes newest READY jobs by readyAt then discoveredAt", async () => {
    mocks.getAllJobs.mockResolvedValue([
      createJob({
        id: "old-ready",
        status: "ready",
        applicationLink: "mailto:jobs@example.com",
        readyAt: "2026-05-01T00:00:00.000Z",
        discoveredAt: "2026-05-01T00:00:00.000Z",
      }),
      createJob({
        id: "new-ready",
        status: "ready",
        applicationLink: "mailto:jobs@example.com",
        readyAt: "2026-05-03T00:00:00.000Z",
        discoveredAt: "2026-05-03T00:00:00.000Z",
      }),
      createJob({
        id: "new-discovered",
        status: "ready",
        applicationLink: "mailto:jobs@example.com",
        readyAt: null,
        discoveredAt: "2026-05-02T00:00:00.000Z",
      }),
    ]);

    const result = await enqueueAutonomousAutoApplyForReadyJobs({
      requestedBy: "system",
      limit: 1,
    });

    expect(result).toEqual({ enqueued: 1, reviewOnly: 0, skipped: 0 });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "autonomous_auto_apply",
      expect.objectContaining({ jobId: "new-ready" }),
      expect.any(Object),
    );
  });
});
