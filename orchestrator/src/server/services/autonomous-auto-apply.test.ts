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

vi.mock("./applicationTracking", () => ({
  transitionStage: mocks.transitionStage,
}));

vi.mock("./pdf-fingerprint", () => ({
  resolvePdfFingerprintContext: vi.fn().mockResolvedValue({}),
  getJobPdfFreshness: mocks.getJobPdfFreshness,
}));

import {
  classifyAutonomousAutoApply,
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
  });

  it("is disabled and dry-run by default", () => {
    expect(getAutonomousAutoApplyConfigFromEnv({})).toMatchObject({
      queueEnabled: false,
      emailApplyEnabled: false,
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
      expect.objectContaining({ status: "applied", appliedAt: expect.any(String) }),
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
});
