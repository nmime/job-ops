import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const mocks = vi.hoisted(() => ({
  runAutomationProof: vi.fn(),
  getLatestAutomationProofResult: vi.fn(),
}));

vi.mock("@server/services/automation-proof", () => ({
  runAutomationProof: mocks.runAutomationProof,
  getLatestAutomationProofResult: mocks.getLatestAutomationProofResult,
}));

describe("automation proof API", () => {
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAutomationProof.mockResolvedValue({
      id: "proof-1",
      tenantId: "tenant_default",
      dryRun: true,
      startedAt: "2026-06-05T00:00:00.000Z",
      completedAt: "2026-06-05T00:00:01.000Z",
      status: "passed",
      steps: [],
      invariants: {
        realEmailSent: false,
        externalSubmitClicked: false,
        paidCaptchaAttempted: false,
      },
    });
    mocks.getLatestAutomationProofResult.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
  });

  it("runs proof mode only when dryRun true is explicit", async () => {
    server = await startServer();

    const rejectResponse = await fetch(
      `${server.baseUrl}/api/automation/proof/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(rejectResponse.status).toBe(400);
    expect(mocks.runAutomationProof).not.toHaveBeenCalled();

    const response = await fetch(`${server.baseUrl}/api/automation/proof/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({
      dryRun: true,
      invariants: {
        realEmailSent: false,
        externalSubmitClicked: false,
        paidCaptchaAttempted: false,
      },
    });
    expect(mocks.runAutomationProof).toHaveBeenCalledTimes(1);
  });

  it("exposes latest proof result through both automation and autonomous aliases", async () => {
    mocks.getLatestAutomationProofResult.mockResolvedValue({
      id: "proof-latest",
      tenantId: "tenant_default",
      dryRun: true,
      status: "warning",
      startedAt: "2026-06-05T00:00:00.000Z",
      completedAt: "2026-06-05T00:00:01.000Z",
      steps: [],
      invariants: {
        realEmailSent: false,
        externalSubmitClicked: false,
        paidCaptchaAttempted: false,
      },
    });
    server = await startServer();

    const [automationResponse, autonomousResponse] = await Promise.all([
      fetch(`${server.baseUrl}/api/automation/proof/latest`),
      fetch(`${server.baseUrl}/api/autonomous/proof/latest`),
    ]);

    expect(automationResponse.status).toBe(200);
    expect(autonomousResponse.status).toBe(200);
    expect((await automationResponse.json()).data.latest.id).toBe(
      "proof-latest",
    );
    expect((await autonomousResponse.json()).data.latest.id).toBe(
      "proof-latest",
    );
  });
});
