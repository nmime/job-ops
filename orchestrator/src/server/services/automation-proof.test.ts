import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  getAllJobs: vi.fn(),
  getLatestPipelineRun: vi.fn(),
  getAllSettings: vi.fn(),
  getProfile: vi.fn(),
  getActiveTenantId: vi.fn(),
  resolvePdfFingerprintContext: vi.fn(),
  sendAutoApplication: vi.fn(),
  submitPortalApplication: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@server/db/index", () => ({
  db: {
    insert: vi.fn(() => ({ values: mocks.insertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    })),
  },
  schema: {
    automationProofRuns: {
      tenantId: "tenant_id",
      startedAt: "started_at",
    },
  },
}));

vi.mock("@server/repositories/jobs", () => ({
  getAllJobs: mocks.getAllJobs,
}));

vi.mock("@server/repositories/pipeline", () => ({
  getLatestPipelineRun: mocks.getLatestPipelineRun,
}));

vi.mock("@server/repositories/settings", () => ({
  getAllSettings: mocks.getAllSettings,
}));

vi.mock("@server/services/profile", () => ({
  getProfile: mocks.getProfile,
}));

vi.mock("@server/tenancy/context", () => ({
  getActiveTenantId: mocks.getActiveTenantId,
}));

vi.mock("./pdf-fingerprint", () => ({
  resolvePdfFingerprintContext: mocks.resolvePdfFingerprintContext,
}));

vi.mock("./auto-apply", async () => {
  const actual =
    await vi.importActual<typeof import("./auto-apply")>("./auto-apply");
  return {
    ...actual,
    sendAutoApplication: mocks.sendAutoApplication,
  };
});

vi.mock("./application-browser", async () => {
  const actual = await vi.importActual<typeof import("./application-browser")>(
    "./application-browser",
  );
  return {
    ...actual,
    submitPortalApplication: mocks.submitPortalApplication,
  };
});

describe("automation proof mode", () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "jobops-proof-test-"));
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      LLM_PROVIDER: "openrouter",
      MODEL: "proof-model",
      AUTO_APPLY_SMTP_HOST: "smtp.example.invalid",
      AUTO_APPLY_EMAIL_FROM: "candidate@example.invalid",
      JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
      JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED: "true",
      CAPTCHA_SOLVER_PROVIDER: "2captcha",
      CAPTCHA_SOLVER_AUTO_SOLVE_ENABLED: "1",
      CAPTCHA_SOLVER_API_KEY: "paid-captcha-key-that-must-not-be-used",
    };
    global.fetch = mocks.fetch;
    mocks.insertValues.mockResolvedValue(undefined);
    mocks.getAllJobs.mockResolvedValue([]);
    mocks.getLatestPipelineRun.mockResolvedValue({
      id: "run-1",
      status: "completed",
      startedAt: "2026-06-05T00:00:00.000Z",
      completedAt: "2026-06-05T00:01:00.000Z",
      jobsDiscovered: 3,
      jobsProcessed: 2,
    });
    mocks.getAllSettings.mockResolvedValue({});
    mocks.getProfile.mockResolvedValue({
      basics: {
        name: "Proof Candidate",
        email: "candidate@example.invalid",
        phone: "+49 000 000000",
      },
    });
    mocks.getActiveTenantId.mockReturnValue("tenant-proof");
    mocks.resolvePdfFingerprintContext.mockResolvedValue({ version: "proof" });
  });

  afterEach(async () => {
    process.env = originalEnv;
    global.fetch = fetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("proves the chain without real email, external submit, or paid CAPTCHA", async () => {
    const { runAutomationProof } = await import("./automation-proof");

    const result = await runAutomationProof();

    expect(result.dryRun).toBe(true);
    expect(result.invariants).toEqual({
      realEmailSent: false,
      externalSubmitClicked: false,
      paidCaptchaAttempted: false,
    });
    expect(result.steps.map((step) => step.id)).toEqual([
      "discovery_status",
      "email_imap_config",
      "llm_scoring_config",
      "resume_pdf_readiness",
      "email_apply_dry_run",
      "portal_apply_dry_run",
      "captcha_session_blockers",
      "safety_invariants",
    ]);
    expect(mocks.sendAutoApplication).not.toHaveBeenCalled();
    expect(mocks.submitPortalApplication).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-proof",
        dryRun: true,
        result: expect.objectContaining({ dryRun: true }),
      }),
    );

    const emailStep = result.steps.find(
      (candidate) => candidate.id === "email_apply_dry_run",
    );
    expect(emailStep?.evidence).toMatchObject({
      action: "would_send",
      sent: false,
      networkOpened: false,
      attemptRecordCreated: false,
      bodyRenderedToClient: false,
    });

    const portalStep = result.steps.find(
      (candidate) => candidate.id === "portal_apply_dry_run",
    );
    expect(portalStep?.evidence).toMatchObject({
      action: "would_submit",
      localOnly: true,
      externalUrlOpened: false,
      externalSubmitClicked: false,
      paidCaptchaAttempted: false,
      browserAutomationLaunched: false,
    });

    const imapStep = result.steps.find(
      (candidate) => candidate.id === "email_imap_config",
    );
    expect(imapStep?.evidence).toMatchObject({
      mode: "config_check_only",
      inboxReadAttempted: false,
      emailContentsRendered: false,
    });

    const captchaStep = result.steps.find(
      (candidate) => candidate.id === "captcha_session_blockers",
    );
    expect(captchaStep?.evidence).toMatchObject({
      mode: "classifier_only",
      paidCaptchaAttempted: false,
      captchaProviderCalled: false,
      captchaApiEndpointsCalled: false,
      sessionBrowserOpened: false,
    });

    const safetyStep = result.steps.find(
      (candidate) => candidate.id === "safety_invariants",
    );
    expect(safetyStep?.evidence).toMatchObject({
      paidCaptchaAllowedByEnvironment: true,
      proofIgnoresPaidCaptchaOptIn: true,
      irreversibleActions: [],
    });
  });

  it("uses an existing ready job only as proof input and still does not apply", async () => {
    mocks.getAllJobs.mockImplementation(async (statuses?: string[]) => {
      if (statuses?.includes("ready")) {
        return [
          createJob({
            id: "ready-job-1",
            status: "ready",
            applicationLink: "mailto:jobs@example.com",
            emails: "jobs@example.com",
            pdfPath: null,
            pdfSource: null,
          }),
        ];
      }
      return [];
    });

    const { runAutomationProof } = await import("./automation-proof");
    const result = await runAutomationProof();

    expect(result.status).not.toBe("failed");
    expect(mocks.sendAutoApplication).not.toHaveBeenCalled();
    expect(mocks.submitPortalApplication).not.toHaveBeenCalled();
    const discoveryStep = result.steps.find(
      (candidate) => candidate.id === "discovery_status",
    );
    expect(discoveryStep?.evidence).toMatchObject({
      triggeredDiscovery: false,
      triggeredAutoApply: false,
    });
  });
});
