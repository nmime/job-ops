export type AutomationProofStepStatus = "pass" | "warn" | "fail";

export type AutomationProofStepId =
  | "discovery_status"
  | "email_imap_config"
  | "llm_scoring_config"
  | "resume_pdf_readiness"
  | "email_apply_dry_run"
  | "portal_apply_dry_run"
  | "captcha_session_blockers"
  | "safety_invariants";

export interface AutomationProofStep {
  id: AutomationProofStepId;
  status: AutomationProofStepStatus;
  evidence: Record<string, unknown>;
  message?: string;
}

export interface AutomationProofResult {
  id: string;
  tenantId: string;
  dryRun: true;
  startedAt: string;
  completedAt: string;
  status: "passed" | "warning" | "failed";
  steps: AutomationProofStep[];
  invariants: {
    realEmailSent: false;
    externalSubmitClicked: false;
    paidCaptchaAttempted: false;
  };
}

import { fetchApi } from "./core";

export async function getLatestAutomationProof(): Promise<{
  latest: AutomationProofResult | null;
}> {
  return fetchApi<{ latest: AutomationProofResult | null }>(
    "/automation/proof/latest",
  );
}

export async function runAutomationProof(input?: {
  dryRun?: true;
}): Promise<AutomationProofResult> {
  return fetchApi<AutomationProofResult>("/automation/proof/run", {
    method: "POST",
    body: JSON.stringify({ dryRun: input?.dryRun ?? true }),
  });
}
