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
  listJobNotes: vi.fn(),
  createJobNote: vi.fn(),
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
  listJobNotes: mocks.listJobNotes,
  createJobNote: mocks.createJobNote,
}));

vi.mock("@server/tenancy/context", () => ({
  getActiveTenantId: vi.fn(() => "tenant-test"),
}));

vi.mock("./auto-apply", () => ({
  resolveAutoApplyRecipient: mocks.resolveAutoApplyRecipient,
  resolveHttpApplicationUrl: (job: {
    applicationLink?: string | null;
    jobUrlDirect?: string | null;
    jobUrl?: string | null;
  }) =>
    [job.applicationLink, job.jobUrlDirect, job.jobUrl]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => /^https?:\/\//i.test(value)) ?? null,
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
  clearAutonomousPortalReviewBlocksForTests,
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
    mocks.listJobNotes.mockResolvedValue([]);
    mocks.createJobNote.mockResolvedValue({
      id: "note-1",
      jobId: "job-portal",
      title: "Autonomous portal session required",
      content: "needs_portal_session",
      createdAt: "2026-05-04T10:00:00.000Z",
      updatedAt: "2026-05-04T10:00:00.000Z",
    });
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
      reasonCode: "portal_submitted",
      outcomeMetadata: {
        reasonCode: "portal_submitted",
        status: "submitted",
        domain: "example.com",
        source: "gradcracker",
        urlKind: "application_link",
        liveSubmitAttempted: true,
        submitClicked: true,
        captchaType: null,
        captchaAttempted: false,
        captchaSolved: false,
      },
    });
    mocks.resolveAutoApplyRecipient.mockImplementation((job) =>
      String(job.applicationLink ?? "").startsWith("mailto:") ||
      String(job.emails ?? "").includes("@") ||
      String(job.jobDescription ?? "").includes("@")
        ? "jobs@example.com"
        : null,
    );
    mocks.getJobPdfFreshness.mockReturnValue("current");
    clearAutonomousPortalReviewBlocksForTests();
  });

  afterEach(() => {
    delete process.env.JOBOPS_AUTONOMOUS_EMAIL_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_AUTO_APPLY_QUEUE_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_AUTO_APPLY_RUN_ON_START;
    delete process.env.JOBOPS_FULL_AUTO_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_BLOCKED_DOMAINS;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_SESSION_REQUIRED_DOMAINS;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_SESSION_VALIDATED_DOMAINS;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES;
    delete process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOW_SOURCE_URL_FALLBACK;
    delete process.env.JOBOPS_FULL_AUTO_ENABLED;
    delete process.env.JOBOPS_FULL_AUTO_BROWSER_SUBMIT_ENABLED;
    delete process.env.JOBOPS_FULL_AUTO_CAPTCHA_ENABLED;
    clearAutonomousPortalReviewBlocksForTests();
    vi.useRealTimers();
  });

  it("routes explicit mailto/email-only jobs through email even when browser automation is enabled", () => {
    const job = createJob({
      status: "ready",
      applicationLink: "mailto:jobs@example.com",
      jobUrlDirect: "https://ats.example.com/apply/also-present",
    });

    expect(
      classifyAutonomousAutoApply(
        job,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "ats.example.com",
        }),
      ),
    ).toMatchObject({ action: "email_ready", recipient: "jobs@example.com" });
  });

  it("routes supported HTTP application, direct, or source URLs to portal only when full-auto gates and allowlist are enabled", () => {
    const config = getAutonomousAutoApplyConfigFromEnv({
      JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS:
        "ats.example.com,source.example.com",
      JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES: "gradcracker",
    });

    expect(
      classifyAutonomousAutoApply(
        createJob({
          source: "gradcracker",
          status: "ready",
          applicationLink: "https://ats.example.com/apply/application",
          jobUrlDirect: null,
          jobUrl: "https://source.example.com/jobs/application",
        }),
        config,
      ),
    ).toMatchObject({ action: "portal_ready" });
    expect(
      classifyAutonomousAutoApply(
        createJob({
          source: "gradcracker",
          status: "ready",
          applicationLink: null,
          jobUrlDirect: "https://ats.example.com/apply/direct",
          jobUrl: "https://source.example.com/jobs/direct",
        }),
        config,
      ),
    ).toMatchObject({ action: "portal_ready" });
    expect(
      classifyAutonomousAutoApply(
        createJob({
          source: "gradcracker",
          status: "ready",
          applicationLink: null,
          jobUrlDirect: null,
          jobUrl: "https://source.example.com/jobs/source",
        }),
        config,
      ),
    ).toMatchObject({ action: "portal_ready" });

    expect(
      classifyAutonomousAutoApply(
        createJob({
          status: "ready",
          applicationLink: null,
          jobUrlDirect: "https://ats.example.com/apply/disabled",
        }),
        getAutonomousAutoApplyConfigFromEnv({}),
      ),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "browser_apply_disabled",
    });
  });

  it("marks no route as needs review without claiming an application route", () => {
    expect(
      classifyAutonomousAutoApply(
        createJob({
          status: "ready",
          applicationLink: null,
          jobUrlDirect: null,
          jobUrl: "",
          emails: null,
          jobDescription: null,
          jobBrief: null,
        }),
        getAutonomousAutoApplyConfigFromEnv({}),
      ),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "no_application_route",
    });
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
    process.env.JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED = "true";
    process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS = "example.com";
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

  it("classifies LinkedIn sign-up redirects as portal-session-required and never submits", async () => {
    process.env.JOBOPS_FULL_AUTO_APPLY_ENABLED = "true";
    process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS = "linkedin.com";
    const portalJob = createJob({
      id: "job-linkedin-gated",
      status: "ready",
      applicationLink:
        "https://www.linkedin.com/signup/cold-join?session_redirect=https%3A%2F%2Fnl.linkedin.com%2Fjobs%2Fview%2F123",
      pdfPath: "data/pdfs/job-linkedin-gated.pdf",
      pdfSource: "uploaded",
    });

    const decision = classifyAutonomousAutoApply(
      portalJob,
      getAutonomousAutoApplyConfigFromEnv(process.env),
    );
    expect(decision).toMatchObject({
      action: "portal_session_required",
      provider: "linkedin",
    });

    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-linkedin-gated",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-linkedin-gated",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "full_auto",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(portalJob);

    await drainAutonomousAutoApplyQueue();

    expect(mocks.submitPortalApplication).not.toHaveBeenCalled();
    expect(mocks.createJobNote).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-linkedin-gated",
        title: "Autonomous portal session required",
        content: expect.stringContaining("needs_portal_session"),
      }),
    );
    expect(mocks.updateJob).not.toHaveBeenCalledWith(
      "job-linkedin-gated",
      expect.objectContaining({ status: "applied" }),
    );
  });

  it("does not retry browser submit when a prior gated-portal review note exists", async () => {
    process.env.JOBOPS_FULL_AUTO_APPLY_ENABLED = "true";
    process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS = "greenhouse.io";
    const portalJob = createJob({
      id: "job-prior-review",
      status: "ready",
      applicationLink: "https://boards.greenhouse.io/example/jobs/1",
      pdfPath: "data/pdfs/job-prior-review.pdf",
      pdfSource: "uploaded",
    });
    mocks.listJobNotes.mockResolvedValue([
      {
        id: "note-prior",
        jobId: "job-prior-review",
        title: "Autonomous portal session required",
        content: "needs_portal_session (generic)",
        createdAt: "2026-05-04T10:00:00.000Z",
        updatedAt: "2026-05-04T10:00:00.000Z",
      },
    ]);
    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-prior-review",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-prior-review",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "full_auto",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(portalJob);

    await drainAutonomousAutoApplyQueue();

    expect(mocks.submitPortalApplication).not.toHaveBeenCalled();
    expect(mocks.updateJob).not.toHaveBeenCalledWith(
      "job-prior-review",
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
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "example.com",
        }),
      ).action,
    ).toBe("review_only_captcha");
    expect(
      classifyAutonomousAutoApply(
        captchaJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "example.com",
        }),
      ),
    ).toMatchObject({
      action: "review_only_captcha",
      reasonCode: "portal_needs_review_captcha",
    });
    expect(
      classifyAutonomousAutoApply(
        captchaJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED: "true",
        }),
      ),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "portal_blocked_domain_not_validated",
    });
    expect(
      classifyAutonomousAutoApply(
        captchaJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "example.com",
          JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED: "true",
        }),
      ).action,
    ).toBe("captcha_ready");
    expect(
      classifyAutonomousAutoApply(
        captchaJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "example.com",
          JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED: "false",
        }),
      ).action,
    ).toBe("review_only_captcha");
  });

  it("requires explicit portal enablement and an allowed domain before browser submit", () => {
    const portalJob = createJob({
      id: "job-portal-policy",
      status: "ready",
      applicationLink: "https://jobs.example.com/apply",
    });

    expect(
      classifyAutonomousAutoApply(
        portalJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
        }),
      ),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "browser_apply_disabled",
    });

    expect(
      classifyAutonomousAutoApply(
        portalJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
        }),
      ),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "portal_blocked_domain_not_validated",
    });

    expect(
      classifyAutonomousAutoApply(
        portalJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "example.com",
        }),
      ).action,
    ).toBe("portal_ready");
  });

  it("blocks source-listing fallback URLs unless the source is validated or deliberately allowed", () => {
    const sourceFallbackJob = createJob({
      id: "job-source-fallback",
      source: "unsupported-board",
      status: "ready",
      applicationLink: null,
      jobUrlDirect: null,
      jobUrl: "https://source.example.com/jobs/source-only",
    });

    const baseConfig = getAutonomousAutoApplyConfigFromEnv({
      JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "source.example.com",
    });

    expect(
      classifyAutonomousAutoApply(sourceFallbackJob, baseConfig),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "portal_blocked_unsupported_source",
    });

    expect(
      classifyAutonomousAutoApply(
        sourceFallbackJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "source.example.com",
          JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES: "unsupported-board",
        }),
      ),
    ).toMatchObject({ action: "portal_ready" });

    expect(
      classifyAutonomousAutoApply(
        sourceFallbackJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "source.example.com",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOW_SOURCE_URL_FALLBACK: "true",
        }),
      ),
    ).toMatchObject({ action: "portal_ready" });
  });

  it("blocks LinkedIn and Indeed unless an allowed domain has a validated session", () => {
    const linkedInJob = createJob({
      id: "job-linkedin",
      status: "ready",
      applicationLink: "https://www.linkedin.com/jobs/view/123",
    });
    const config = getAutonomousAutoApplyConfigFromEnv({
      JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "linkedin.com,indeed.com",
    });

    expect(classifyAutonomousAutoApply(linkedInJob, config)).toMatchObject({
      action: "review_only_portal",
      reasonCode: "portal_needs_review_session_missing",
    });

    expect(
      classifyAutonomousAutoApply(
        linkedInJob,
        getAutonomousAutoApplyConfigFromEnv({
          JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
          JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "linkedin.com",
          JOBOPS_AUTONOMOUS_PORTAL_SESSION_VALIDATED_DOMAINS: "linkedin.com",
        }),
      ).action,
    ).toBe("portal_ready");
  });

  it("records a terminal blocker after portal needs-review so the same job/domain is not retried", async () => {
    process.env.JOBOPS_FULL_AUTO_APPLY_ENABLED = "true";
    process.env.JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED = "true";
    process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS = "example.com";
    const portalJob = createJob({
      id: "job-terminal",
      status: "ready",
      applicationLink: "https://example.com/apply",
      pdfPath: "data/pdfs/job-terminal.pdf",
      pdfSource: "uploaded",
    });
    mocks.submitPortalApplication.mockResolvedValueOnce({
      mode: "browser",
      status: "needs_review",
      url: "https://example.com/apply",
      finalUrl: "https://example.com/apply",
      submittedAt: null,
      fieldsFilled: 4,
      resumeUploaded: true,
      submitClicked: false,
      captcha: { attempted: false, solved: false, type: null, provider: null },
      reason: "Portal requires login/sign-up before application submission.",
      reasonCode: "portal_needs_review_login_required",
      reviewReason: "needs_portal_session",
      outcomeMetadata: {
        reasonCode: "portal_needs_review_login_required",
        status: "needs_review",
        domain: "example.com",
        source: "gradcracker",
        urlKind: "application_link",
        liveSubmitAttempted: false,
        submitClicked: false,
        captchaType: null,
        captchaAttempted: false,
        captchaSolved: false,
      },
    });
    mocks.reserveNext
      .mockResolvedValueOnce({
        id: "queue-job-terminal",
        queue: "autonomous_auto_apply",
        payload: {
          tenantId: "tenant-test",
          jobId: "job-terminal",
          requestedAt: "2026-05-04T10:00:00.000Z",
          requestedBy: "system",
          mode: "full_auto",
        },
        acceptedAt: "2026-05-04T10:00:00.000Z",
      })
      .mockResolvedValueOnce(null);
    mocks.getJobById.mockResolvedValue(portalJob);

    await drainAutonomousAutoApplyQueue();

    expect(mocks.submitPortalApplication).toHaveBeenCalledTimes(1);
    expect(mocks.transitionStage).toHaveBeenCalledWith(
      "job-terminal",
      "no_change",
      expect.any(Number),
      expect.objectContaining({
        reasonCode: "portal_needs_review_login_required",
        eventType: "note",
        portalOutcome: expect.objectContaining({
          reasonCode: "portal_needs_review_login_required",
          status: "needs_review",
        }),
      }),
      null,
    );
    expect(
      classifyAutonomousAutoApply(
        portalJob,
        getAutonomousAutoApplyConfigFromEnv(process.env),
      ),
    ).toMatchObject({
      action: "review_only_portal",
      reasonCode: "terminal_portal_blocker",
    });
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
