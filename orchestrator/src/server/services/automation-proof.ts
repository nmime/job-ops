import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsRegistry } from "@shared/settings-registry";
import { createJob } from "@shared/testing/factories";
import type { Job, JobPdfFreshness } from "@shared/types";
import { desc, eq } from "drizzle-orm";
import { getDataDir } from "../config/dataDir";
import { db, schema } from "../db/index";
import * as jobsRepo from "../repositories/jobs";
import { getLatestPipelineRun } from "../repositories/pipeline";
import { getAllSettings } from "../repositories/settings";
import { getActiveTenantId } from "../tenancy/context";
import { resolveAutoApplyRecipient } from "./auto-apply";
import {
  classifyAutonomousAutoApply,
  getAutonomousAutoApplyConfigFromEnv,
} from "./autonomous-auto-apply";
import { resolvePdfFingerprintContext } from "./pdf-fingerprint";
import { getProfile } from "./profile";

export type AutomationProofStepStatus = "pass" | "warn" | "fail";

export type AutomationProofStep = {
  id:
    | "discovery_status"
    | "email_imap_config"
    | "llm_scoring_config"
    | "resume_pdf_readiness"
    | "email_apply_dry_run"
    | "portal_apply_dry_run"
    | "captcha_session_blockers"
    | "safety_invariants";
  status: AutomationProofStepStatus;
  evidence: Record<string, unknown>;
  message?: string;
};

export type AutomationProofResult = {
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
};

const PROOF_DIR = "automation-proof";
const LATEST_FILENAME = "latest.json";
const MOCK_ATS_PATH = "mock-ats-application.html";
const PROOF_EMAIL_RECIPIENT = "proof-recipient@example.invalid";

function step(
  id: AutomationProofStep["id"],
  status: AutomationProofStepStatus,
  evidence: Record<string, unknown>,
  message?: string,
): AutomationProofStep {
  return { id, status, evidence, ...(message ? { message } : {}) };
}

function normalizeEnvInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function redactEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const [local = "", domain = ""] = value.split("@");
  if (!domain) return "redacted";
  return `${local.slice(0, 1)}***@${domain}`;
}

function getOriginalEnvValue(key: string): string | undefined {
  return process.env[key];
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function buildProofJob(input: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return createJob({
    id: `automation-proof-${randomUUID()}`,
    source: "manual",
    sourceJobId: null,
    jobUrl: "https://proof.local/job",
    jobUrlDirect: null,
    title: "Automation Proof Engineer",
    employer: "Job Ops Proof",
    location: "Remote",
    status: "ready",
    applicationLink: `mailto:${PROOF_EMAIL_RECIPIENT}`,
    emails: JSON.stringify([PROOF_EMAIL_RECIPIENT]),
    jobDescription:
      "Local proof fixture. This content is synthetic and never submitted externally.",
    discoveredAt: now,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
    suitabilityScore: 88,
    suitabilityReason: "Synthetic proof fixture with local-only evidence.",
    isRemote: true,
    ...input,
  });
}

async function latestReadyJob(): Promise<Job | null> {
  const readyJobs = await jobsRepo.getAllJobs(["ready"]);
  return readyJobs[0] ?? null;
}

async function buildDiscoveryStep(): Promise<AutomationProofStep> {
  const [pipelineRun, readyJobs] = await Promise.all([
    getLatestPipelineRun(),
    jobsRepo.getAllJobs(["ready"]),
  ]);
  return step("discovery_status", "pass", {
    mode: "read_only_status",
    triggeredDiscovery: false,
    triggeredAutoApply: false,
    latestRun: pipelineRun
      ? {
          id: pipelineRun.id,
          status: pipelineRun.status,
          startedAt: pipelineRun.startedAt,
          completedAt: pipelineRun.completedAt,
          jobsDiscovered: pipelineRun.jobsDiscovered,
          jobsProcessed: pipelineRun.jobsProcessed,
        }
      : null,
    readyJobCount: readyJobs.length,
  });
}

async function buildEmailImapStep(): Promise<AutomationProofStep> {
  const settings = await getAllSettings();
  const gmailConnected = Boolean(
    normalizeEnvInput(getOriginalEnvValue("GMAIL_CLIENT_ID")) &&
      normalizeEnvInput(getOriginalEnvValue("GMAIL_CLIENT_SECRET")),
  );
  const imapHost = normalizeEnvInput(
    getOriginalEnvValue("POST_APPLICATION_IMAP_HOST"),
  );
  const imapUser = normalizeEnvInput(
    getOriginalEnvValue("POST_APPLICATION_IMAP_USER"),
  );
  const smtpHost = normalizeEnvInput(
    getOriginalEnvValue("AUTO_APPLY_SMTP_HOST"),
  );
  const smtpFrom = normalizeEnvInput(
    getOriginalEnvValue("AUTO_APPLY_EMAIL_FROM"),
  );
  const configured = Boolean(
    gmailConnected || imapHost || smtpHost || smtpFrom,
  );

  return step(
    "email_imap_config",
    configured ? "pass" : "warn",
    {
      mode: "config_check_only",
      providerStatusEndpoint:
        "/api/post-application/providers/:provider/status",
      gmailOAuthConfigured: gmailConnected,
      imapConfigured: Boolean(imapHost),
      imapUserRedacted: redactEmail(imapUser),
      smtpConfigured: Boolean(smtpHost),
      smtpFromRedacted: redactEmail(smtpFrom),
      settingsKeysPresent: Object.keys(settings).filter((key) =>
        key.toLowerCase().includes("email"),
      ).length,
      inboxReadAttempted: false,
      emailContentsRendered: false,
    },
    configured
      ? "Email/IMAP configuration evidence collected without reading inbox content."
      : "No Gmail/IMAP/SMTP proof configuration detected; proof mode still remains dry-run.",
  );
}

async function buildLlmStep(): Promise<AutomationProofStep> {
  const settings = await getAllSettings();
  const provider =
    settingsRegistry.llmProvider.parse(
      settings.llmProvider ?? getOriginalEnvValue("LLM_PROVIDER"),
    ) ?? settingsRegistry.llmProvider.default();
  const model =
    normalizeEnvInput(settings.model) ??
    normalizeEnvInput(getOriginalEnvValue("MODEL")) ??
    normalizeEnvInput(getOriginalEnvValue("LLM_MODEL"));
  const apiKeyPresent = Boolean(
    normalizeEnvInput(getOriginalEnvValue("LLM_API_KEY")),
  );
  const status: AutomationProofStepStatus = provider && model ? "pass" : "warn";

  return step(
    "llm_scoring_config",
    status,
    {
      mode: "config_check_only",
      provider,
      modelConfigured: Boolean(model),
      modelName: model ?? null,
      apiKeyPresent,
      scoringRequestSent: false,
      billableLlmCallMade: false,
    },
    status === "pass"
      ? "LLM scorer is configured; proof mode did not call it."
      : "LLM scorer is not fully configured.",
  );
}

async function ensureProofResumePdf(
  jobId: string,
): Promise<{ pdfPath: string; absolutePath: string }> {
  const relativePath = `pdfs/${jobId}-proof-resume.pdf`;
  const absolutePath = join(getDataDir(), relativePath);
  await mkdir(join(getDataDir(), "pdfs"), { recursive: true });
  if (!existsSync(absolutePath)) {
    await writeFile(
      absolutePath,
      Buffer.from(
        "%PDF-1.4\n% job-ops proof fixture\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
      ),
    );
  }
  return { pdfPath: relativePath, absolutePath };
}

async function buildResumeStep(job: Job): Promise<AutomationProofStep> {
  const pdfAbsolutePath = job.pdfPath
    ? join(getDataDir(), job.pdfPath)
    : join(getDataDir(), "pdfs", `${job.id}-proof-resume.pdf`);
  const exists = existsSync(pdfAbsolutePath);
  const fingerprint = exists ? sha256File(pdfAbsolutePath) : null;
  const fingerprintContext = exists
    ? await resolvePdfFingerprintContext()
    : null;

  return step(
    "resume_pdf_readiness",
    exists ? "pass" : "fail",
    {
      pdfPath: job.pdfPath,
      exists,
      sha256: fingerprint,
      pdfSource: job.pdfSource,
      pdfFreshness: job.pdfFreshness,
      fingerprintContext,
      generatedProofFixture: job.pdfPath?.includes("proof-resume") ?? false,
      contentRenderedToClient: false,
    },
    exists
      ? "Resume PDF evidence is present; only path/hash metadata is exposed."
      : "Resume PDF evidence is missing.",
  );
}

async function buildDryRunEmailPayload(
  job: Job,
): Promise<Record<string, unknown>> {
  const profile = await getProfile();
  const recipient = resolveAutoApplyRecipient(job) ?? PROOF_EMAIL_RECIPIENT;
  const normalizedRecipient = recipient.includes("@")
    ? recipient
    : PROOF_EMAIL_RECIPIENT;
  const attachments = job.pdfPath
    ? [
        {
          filename: `${job.id}.pdf`,
          path: job.pdfPath,
          exists: existsSync(join(getDataDir(), job.pdfPath)),
          sha256: sha256File(join(getDataDir(), job.pdfPath)),
        },
      ]
    : [];

  return {
    action: "would_send",
    recipientRedacted: redactEmail(normalizedRecipient),
    fromRedacted: redactEmail(
      normalizeEnvInput(getOriginalEnvValue("AUTO_APPLY_EMAIL_FROM")) ??
        profile?.basics?.email ??
        null,
    ),
    subjectTemplate: `Application: ${job.title} at ${job.employer}`,
    bodyPreview: "redacted",
    bodyRenderedToClient: false,
    attachments,
    sent: false,
    networkOpened: false,
    smtpTransportCreated: false,
    attemptRecordCreated: false,
  };
}

async function buildEmailStep(job: Job): Promise<AutomationProofStep> {
  const payload = await buildDryRunEmailPayload(job);
  const attachments = payload.attachments as Array<{ exists: boolean }>;
  return step(
    "email_apply_dry_run",
    attachments.every((attachment) => attachment.exists) ? "pass" : "fail",
    payload,
    "Email apply proof built a redacted payload only; sendAutoApplication is never invoked.",
  );
}

async function ensureMockAtsPage(): Promise<{
  htmlPath: string;
  fileUrl: string;
}> {
  const proofDir = join(getDataDir(), PROOF_DIR);
  await mkdir(proofDir, { recursive: true });
  const htmlPath = join(proofDir, MOCK_ATS_PATH);
  await writeFile(
    htmlPath,
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Job Ops Proof ATS</title></head>
  <body>
    <form id="application-form">
      <label>Name <input name="name" required></label>
      <label>Email <input name="email" type="email" required></label>
      <button type="submit">Submit application</button>
    </form>
  </body>
</html>`,
  );
  return { htmlPath, fileUrl: `file://${htmlPath}` };
}

async function buildPortalStep(job: Job): Promise<AutomationProofStep> {
  const mockAts = await ensureMockAtsPage();
  const decision = classifyAutonomousAutoApply(
    buildProofJob({
      ...job,
      emails: null,
      applicationLink: mockAts.fileUrl,
      jobUrl: mockAts.fileUrl,
      jobUrlDirect: mockAts.fileUrl,
    }),
    {
      ...getAutonomousAutoApplyConfigFromEnv(),
      browserSubmitEnabled: true,
      fullAutoEnabled: true,
      captchaApplyEnabled: false,
    },
  );

  return step(
    "portal_apply_dry_run",
    decision.action === "portal_ready" ? "pass" : "warn",
    {
      action: "would_submit",
      dryRunForced: true,
      localOnly: true,
      fixtureUrlScheme: "file",
      fixturePath: mockAts.htmlPath,
      portalDecision: decision,
      externalUrlOpened: false,
      browserAutomationLaunched: false,
      externalSubmitClicked: false,
      paidCaptchaAttempted: false,
      submitFunctionCalled: false,
    },
    "Portal proof uses a local file fixture and never calls submitPortalApplication.",
  );
}

function buildCaptchaSessionStep(): AutomationProofStep {
  const config = getAutonomousAutoApplyConfigFromEnv();
  const sessionDecision = classifyAutonomousAutoApply(
    buildProofJob({
      emails: null,
      applicationLink: "https://www.linkedin.com/jobs/view/proof",
      jobUrl: "https://www.linkedin.com/jobs/view/proof",
    }),
    { ...config, browserSubmitEnabled: true, fullAutoEnabled: true },
  );
  const captchaDecision = classifyAutonomousAutoApply(
    buildProofJob({
      emails: null,
      applicationLink: "https://jobs.example.invalid/apply?captcha=true",
      jobUrl: "https://jobs.example.invalid/apply?captcha=true",
      jobDescription: "Application form contains CAPTCHA challenge.",
    }),
    config,
  );

  return step(
    "captcha_session_blockers",
    "pass",
    {
      mode: "classifier_only",
      sessionGate: sessionDecision,
      captchaGate: captchaDecision,
      paidCaptchaAllowedByEnvironment: config.captchaApplyEnabled,
      paidCaptchaAttempted: false,
      captchaProviderCalled: false,
      captchaApiEndpointsCalled: false,
      sessionBrowserOpened: false,
      externalSubmitClicked: false,
      blockers: [
        sessionDecision.action === "portal_session_required"
          ? sessionDecision.reason
          : null,
        "Paid CAPTCHA solving is disabled in proof mode even if environment opt-in is present.",
      ].filter(Boolean),
    },
    "CAPTCHA/session evidence is classifier-only; no solver or browser session is started.",
  );
}

function buildSafetyStep(): AutomationProofStep {
  const config = getAutonomousAutoApplyConfigFromEnv();
  return step("safety_invariants", "pass", {
    dryRunForced: true,
    emailSendFunctionCalled: false,
    portalSubmitFunctionCalled: false,
    realEmailSent: false,
    externalBrowserSubmitClicked: false,
    paidCaptchaAttempted: false,
    paidCaptchaAllowedByEnvironment: config.captchaApplyEnabled,
    proofIgnoresPaidCaptchaOptIn: true,
    irreversibleActions: [],
  });
}

async function persistResult(result: AutomationProofResult): Promise<void> {
  await db.insert(schema.automationProofRuns).values({
    id: result.id,
    tenantId: result.tenantId,
    dryRun: true,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    result,
  });

  const proofDir = join(getDataDir(), PROOF_DIR);
  await mkdir(proofDir, { recursive: true });
  await writeFile(
    join(proofDir, LATEST_FILENAME),
    JSON.stringify(result, null, 2),
  );
}

export async function getLatestAutomationProofResult(): Promise<AutomationProofResult | null> {
  const tenantId = getActiveTenantId();
  const [row] = await db
    .select({ result: schema.automationProofRuns.result })
    .from(schema.automationProofRuns)
    .where(eq(schema.automationProofRuns.tenantId, tenantId))
    .orderBy(desc(schema.automationProofRuns.startedAt))
    .limit(1);
  if (!row?.result) return null;
  return row.result as AutomationProofResult;
}

export async function runAutomationProof(): Promise<AutomationProofResult> {
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  const tenantId = getActiveTenantId();
  const baseJob = (await latestReadyJob()) ?? buildProofJob();
  const existingProofPdfPath = baseJob.pdfPath
    ? join(getDataDir(), baseJob.pdfPath)
    : null;
  const { pdfPath } =
    baseJob.pdfPath && existingProofPdfPath && existsSync(existingProofPdfPath)
      ? { pdfPath: baseJob.pdfPath }
      : await ensureProofResumePdf(baseJob.id);
  const proofJob = buildProofJob({
    ...baseJob,
    id: baseJob.id,
    status: "ready",
    applicationLink:
      baseJob.applicationLink ?? `mailto:${PROOF_EMAIL_RECIPIENT}`,
    emails: baseJob.emails ?? JSON.stringify([PROOF_EMAIL_RECIPIENT]),
    pdfPath,
    pdfSource: baseJob.pdfSource ?? "uploaded",
    pdfFreshness: "current" as JobPdfFreshness,
  });

  const steps: AutomationProofStep[] = [];
  steps.push(await buildDiscoveryStep());
  steps.push(await buildEmailImapStep());
  steps.push(await buildLlmStep());
  steps.push(await buildResumeStep(proofJob));
  steps.push(await buildEmailStep(proofJob));
  steps.push(await buildPortalStep(proofJob));
  steps.push(buildCaptchaSessionStep());
  steps.push(buildSafetyStep());

  const completedAt = new Date().toISOString();
  const hasFail = steps.some((candidate) => candidate.status === "fail");
  const hasWarn = steps.some((candidate) => candidate.status === "warn");
  const result: AutomationProofResult = {
    id,
    tenantId,
    dryRun: true,
    startedAt,
    completedAt,
    status: hasFail ? "failed" : hasWarn ? "warning" : "passed",
    steps,
    invariants: {
      realEmailSent: false,
      externalSubmitClicked: false,
      paidCaptchaAttempted: false,
    },
  };
  await persistResult(result);
  return result;
}
