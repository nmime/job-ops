import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "@/client/test/renderWithQueryClient";
import * as api from "../api";
import { AutomationProofPage } from "./AutomationProofPage";

vi.mock("../api", () => ({
  getLatestAutomationProof: vi.fn(),
  runAutomationProof: vi.fn(),
  postApplicationProviderStatus: vi.fn(),
  getPostApplicationRuns: vi.fn(),
}));

vi.mock("../hooks/useVersionCheck", () => ({
  useVersionCheck: () => ({
    version: "v0.0.0-test",
    updateAvailable: false,
    latestVersion: null,
  }),
}));

const latestProof = {
  latest: {
    id: "proof-1",
    tenantId: "tenant-test",
    dryRun: true as const,
    startedAt: "2026-06-06T10:00:00.000Z",
    completedAt: "2026-06-06T10:00:01.000Z",
    status: "passed" as const,
    invariants: {
      realEmailSent: false as const,
      externalSubmitClicked: false as const,
      paidCaptchaAttempted: false as const,
    },
    steps: [
      {
        id: "discovery_status" as const,
        status: "pass" as const,
        evidence: {
          latestRun: { status: "completed" },
          readyJobCount: 3,
          triggeredDiscovery: false,
          triggeredAutoApply: false,
        },
      },
      {
        id: "email_imap_config" as const,
        status: "pass" as const,
        evidence: {
          mode: "config_check_only",
          imapConfigured: true,
          inboxReadAttempted: false,
          emailContentsRendered: false,
        },
      },
      {
        id: "llm_scoring_config" as const,
        status: "pass" as const,
        evidence: {
          provider: "openrouter",
          model: "test-model",
          apiKeyPresent: true,
          llmCalled: false,
        },
      },
      {
        id: "resume_pdf_readiness" as const,
        status: "pass" as const,
        evidence: {
          pdfSource: "uploaded",
          exists: true,
          sizeBytes: 128,
          pdfRegenerating: false,
        },
      },
      {
        id: "email_apply_dry_run" as const,
        status: "pass" as const,
        evidence: {
          action: "would_send",
          sent: false,
          smtpConfigured: false,
          recipientRedacted: "p***@example.invalid",
        },
      },
      {
        id: "portal_apply_dry_run" as const,
        status: "pass" as const,
        evidence: {
          preSubmitOk: true,
          externalUrlOpened: false,
          submitClicked: false,
          resumeUploaded: true,
        },
      },
      {
        id: "captcha_session_blockers" as const,
        status: "pass" as const,
        evidence: {
          mode: "classifier_only",
          paidCaptchaAttempted: false,
          captchaProviderCalled: false,
          sessionBrowserOpened: false,
        },
      },
      {
        id: "safety_invariants" as const,
        status: "pass" as const,
        evidence: {
          dryRunForced: true,
          realEmailSent: false,
          externalBrowserSubmitClicked: false,
          paidCaptchaAttempted: false,
        },
      },
    ],
  },
};

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={["/automation-proof"]}>
      <AutomationProofPage />
    </MemoryRouter>,
  );
}

describe("AutomationProofPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getLatestAutomationProof).mockResolvedValue(latestProof);
    vi.mocked(api.postApplicationProviderStatus).mockResolvedValue({
      provider: "gmail",
      action: "status",
      accountKey: "default",
      status: {
        provider: "gmail",
        accountKey: "default",
        connected: true,
        integration: null,
      },
    });
    vi.mocked(api.getPostApplicationRuns).mockResolvedValue({
      total: 1,
      runs: [
        {
          id: "run-imap-1",
          provider: "imap",
          accountKey: "default",
          integrationId: null,
          status: "completed",
          startedAt: 1_780_000_000_000,
          completedAt: 1_780_000_000_500,
          messagesDiscovered: 2,
          messagesRelevant: 1,
          messagesClassified: 1,
          messagesMatched: 1,
          messagesApproved: 0,
          messagesDenied: 1,
          messagesErrored: 0,
          errorCode: null,
          errorMessage: null,
          createdAt: "2026-06-06T10:00:00.000Z",
          updatedAt: "2026-06-06T10:00:01.000Z",
        },
      ],
    });
    vi.mocked(api.runAutomationProof).mockResolvedValue(latestProof.latest);
  });

  it("renders every required automation proof status without exposing secret material", async () => {
    renderPage();

    expect(await screen.findByText("Automation proof")).toBeInTheDocument();
    for (const label of [
      "Discovery",
      "Email / IMAP config",
      "Email connected / IMAP sync",
      "LLM config",
      "PDF ready",
      "Email apply dry-run",
      "Portal pre-submit dry-run",
      "CAPTCHA/session blockers",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    expect(
      screen.getByText(
        /Real external submits and paid CAPTCHA solving are disabled/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Email / IMAP config")).toBeInTheDocument();
    expect(screen.queryByText(/sk-/i)).toBeNull();
  });

  it("calls the proof run endpoint with dryRun true", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /run proof dry-run/i }),
    );

    await waitFor(() => {
      expect(api.runAutomationProof).toHaveBeenCalledWith({ dryRun: true });
    });
  });
});
