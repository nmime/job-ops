import * as api from "@client/api";
import type {
  AutomationProofResult,
  AutomationProofStep,
  AutomationProofStepId,
  AutomationProofStepStatus,
} from "@client/api/automation-proof";
import { PageHeader, PageMain } from "@client/components/layout";
import { queryKeys } from "@client/lib/queryKeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  MailCheck,
  Play,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import type React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const REQUIRED_STEP_IDS: AutomationProofStepId[] = [
  "discovery_status",
  "email_imap_config",
  "llm_scoring_config",
  "resume_pdf_readiness",
  "email_apply_dry_run",
  "portal_apply_dry_run",
  "captcha_session_blockers",
  "safety_invariants",
];

const STEP_COPY: Record<
  AutomationProofStepId,
  { label: string; description: string }
> = {
  discovery_status: {
    label: "Discovery",
    description: "Latest pipeline/run evidence and READY-job availability.",
  },
  email_imap_config: {
    label: "Email / IMAP config",
    description: "Mailbox/provider readiness without rendering inbox contents.",
  },
  llm_scoring_config: {
    label: "LLM config",
    description: "Provider/model readiness without making a paid LLM call.",
  },
  resume_pdf_readiness: {
    label: "PDF ready",
    description: "Resume PDF exists and can be attached to an application.",
  },
  email_apply_dry_run: {
    label: "Email apply dry-run",
    description: "Email payload is assembled without sending mail.",
  },
  portal_apply_dry_run: {
    label: "Portal pre-submit dry-run",
    description: "Mock ATS fields are prepared and stopped before submit.",
  },
  captcha_session_blockers: {
    label: "CAPTCHA/session blockers",
    description:
      "Login wall and CAPTCHA classifier evidence without solver spend.",
  },
  safety_invariants: {
    label: "Safety invariants",
    description:
      "Guards proving no email send, external submit, or paid CAPTCHA attempt ran.",
  },
};

function statusBadgeVariant(status: AutomationProofStepStatus | "missing") {
  if (status === "pass") return "default" as const;
  if (status === "fail") return "destructive" as const;
  return "outline" as const;
}

function statusLabel(status: AutomationProofStepStatus | "missing"): string {
  if (status === "pass") return "Pass";
  if (status === "warn") return "Warning";
  if (status === "fail") return "Fail";
  return "Missing";
}

function statusIcon(status: AutomationProofStepStatus | "missing") {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "fail") return <XCircle className="h-4 w-4" />;
  return <AlertTriangle className="h-4 w-4" />;
}

function formatDate(value: string | number | null | undefined): string {
  if (value == null) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function safeText(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.trim()) return value;
  return "not reported";
}

function findStep(
  result: AutomationProofResult | null | undefined,
  id: AutomationProofStepId,
): AutomationProofStep | null {
  return result?.steps.find((step) => step.id === id) ?? null;
}

function ProofStepCard({
  result,
  stepId,
}: {
  result: AutomationProofResult | null | undefined;
  stepId: AutomationProofStepId;
}) {
  const step = findStep(result, stepId);
  const status = step?.status ?? "missing";
  const copy = STEP_COPY[stepId];

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{copy.label}</CardTitle>
            <CardDescription>{copy.description}</CardDescription>
          </div>
          <Badge variant={statusBadgeVariant(status)}>
            {statusLabel(status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          {statusIcon(status)}
          <span>{step?.message ?? "Status evidence is summarized below."}</span>
        </div>
        {step ? <StepEvidence step={step} /> : null}
      </CardContent>
    </Card>
  );
}

function StepEvidence({ step }: { step: AutomationProofStep }) {
  if (step.id === "discovery_status") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm
          label="Latest run"
          value={safeText(step.evidence.latestRun ? "present" : "none")}
        />
        <EvidenceTerm
          label="READY jobs"
          value={safeText(step.evidence.readyJobCount)}
        />
        <EvidenceTerm
          label="Triggered discovery"
          value={safeText(step.evidence.triggeredDiscovery)}
        />
        <EvidenceTerm
          label="Triggered auto-apply"
          value={safeText(step.evidence.triggeredAutoApply)}
        />
      </dl>
    );
  }

  if (step.id === "email_imap_config") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm
          label="Gmail OAuth configured"
          value={safeText(step.evidence.gmailOAuthConfigured)}
        />
        <EvidenceTerm
          label="IMAP configured"
          value={safeText(step.evidence.imapConfigured)}
        />
        <EvidenceTerm
          label="SMTP configured"
          value={safeText(step.evidence.smtpConfigured)}
        />
        <EvidenceTerm
          label="Inbox read attempted"
          value={safeText(step.evidence.inboxReadAttempted)}
        />
      </dl>
    );
  }

  if (step.id === "llm_scoring_config") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm
          label="Provider"
          value={safeText(step.evidence.provider)}
        />
        <EvidenceTerm
          label="Model"
          value={safeText(step.evidence.modelName ?? step.evidence.model)}
        />
        <EvidenceTerm
          label="API key present"
          value={safeText(step.evidence.apiKeyPresent)}
        />
        <EvidenceTerm
          label="LLM called"
          value={safeText(
            step.evidence.scoringRequestSent ?? step.evidence.llmCalled,
          )}
        />
      </dl>
    );
  }

  if (step.id === "resume_pdf_readiness") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm
          label="PDF source"
          value={safeText(step.evidence.pdfSource)}
        />
        <EvidenceTerm label="Exists" value={safeText(step.evidence.exists)} />
        <EvidenceTerm label="SHA-256" value={safeText(step.evidence.sha256)} />
        <EvidenceTerm
          label="Freshness"
          value={safeText(step.evidence.pdfFreshness)}
        />
      </dl>
    );
  }

  if (step.id === "email_apply_dry_run") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm label="Action" value={safeText(step.evidence.action)} />
        <EvidenceTerm label="Sent" value={safeText(step.evidence.sent)} />
        <EvidenceTerm
          label="Network opened"
          value={safeText(step.evidence.networkOpened)}
        />
        <EvidenceTerm
          label="Recipient"
          value={safeText(step.evidence.recipientRedacted)}
        />
      </dl>
    );
  }

  if (step.id === "portal_apply_dry_run") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm
          label="Local only"
          value={safeText(step.evidence.localOnly)}
        />
        <EvidenceTerm
          label="External URL opened"
          value={safeText(step.evidence.externalUrlOpened)}
        />
        <EvidenceTerm
          label="External submit clicked"
          value={safeText(step.evidence.externalSubmitClicked)}
        />
        <EvidenceTerm
          label="Browser launched"
          value={safeText(step.evidence.browserAutomationLaunched)}
        />
      </dl>
    );
  }

  if (step.id === "captcha_session_blockers") {
    return (
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <EvidenceTerm label="Mode" value={safeText(step.evidence.mode)} />
        <EvidenceTerm
          label="Solver called"
          value={safeText(step.evidence.captchaProviderCalled)}
        />
        <EvidenceTerm
          label="CAPTCHA attempted"
          value={safeText(step.evidence.paidCaptchaAttempted)}
        />
        <EvidenceTerm
          label="Session browser opened"
          value={safeText(step.evidence.sessionBrowserOpened)}
        />
      </dl>
    );
  }

  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <EvidenceTerm
        label="Dry-run forced"
        value={safeText(step.evidence.dryRunForced)}
      />
      <EvidenceTerm
        label="Real email sent"
        value={safeText(step.evidence.realEmailSent)}
      />
      <EvidenceTerm
        label="External submit clicked"
        value={safeText(step.evidence.externalBrowserSubmitClicked)}
      />
      <EvidenceTerm
        label="Paid CAPTCHA attempted"
        value={safeText(step.evidence.paidCaptchaAttempted)}
      />
    </dl>
  );
}

function EvidenceTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-foreground">
        {value}
      </dd>
    </div>
  );
}

function IntegrationCard() {
  const emailStatusQuery = useQuery({
    queryKey: queryKeys.postApplication.providerStatus("gmail", "default"),
    queryFn: () =>
      api.postApplicationProviderStatus({
        provider: "gmail",
        accountKey: "default",
      }),
  });
  const imapRunsQuery = useQuery({
    queryKey: queryKeys.postApplication.runs("imap", "default", 1),
    queryFn: () =>
      api.getPostApplicationRuns({
        provider: "imap",
        accountKey: "default",
        limit: 1,
      }),
  });

  const emailConnected = emailStatusQuery.data?.status.connected ?? false;
  const lastImapRun = imapRunsQuery.data?.runs[0] ?? null;
  const imapStatus = lastImapRun
    ? lastImapRun.status === "completed"
      ? "pass"
      : "warn"
    : "warn";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MailCheck className="h-4 w-4" /> Email connected / IMAP sync
        </CardTitle>
        <CardDescription>
          Connection state is reduced to safe booleans and run metadata; message
          contents, passwords, OAuth tokens, and email addresses are never
          shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm md:grid-cols-2">
        <div className="rounded-lg border border-border/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">Email connected</h3>
            <Badge variant={emailConnected ? "default" : "outline"}>
              {emailConnected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {emailStatusQuery.isError
              ? "Provider status endpoint returned an error; connect Gmail/IMAP or verify backend provider support."
              : "Uses the post-application provider status endpoint and displays no account secrets."}
          </p>
        </div>
        <div className="rounded-lg border border-border/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">IMAP sync</h3>
            <Badge variant={imapStatus === "pass" ? "default" : "outline"}>
              {lastImapRun ? lastImapRun.status : "No run"}
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {imapRunsQuery.isError
              ? "IMAP sync history endpoint is unavailable; backend/provider wiring is required."
              : lastImapRun
                ? `Last run ${formatDate(lastImapRun.startedAt)}; ${lastImapRun.messagesDiscovered} messages discovered.`
                : "No IMAP sync run has been recorded yet."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export const AutomationProofPage: React.FC = () => {
  const queryClient = useQueryClient();
  const latestQuery = useQuery({
    queryKey: queryKeys.automationProof.latest(),
    queryFn: api.getLatestAutomationProof,
    refetchInterval: 30_000,
  });
  const runMutation = useMutation({
    mutationFn: () => api.runAutomationProof({ dryRun: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automationProof.all,
      });
    },
  });

  const latest = latestQuery.data?.latest ?? null;
  const resultStatus = latest?.status ?? "not run";
  const missingSteps = latest
    ? REQUIRED_STEP_IDS.filter((id) => !findStep(latest, id))
    : REQUIRED_STEP_IDS;

  return (
    <>
      <PageHeader
        icon={Bot}
        title="Automation proof"
        subtitle="Admin dry-run status surface for the guarded JobOps automation chain"
        badge="Dry-run only"
        actions={
          <Button
            type="button"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
          >
            {runMutation.isPending ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Run proof dry-run
          </Button>
        }
      />
      <PageMain className="space-y-6">
        <Alert variant="warning">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Automation safety guardrails are enforced</AlertTitle>
          <AlertDescription>
            Real external submits and paid CAPTCHA solving are disabled until
            explicit confirmation. This page never displays secrets, passwords,
            OAuth tokens, or email contents.
          </AlertDescription>
        </Alert>

        {latestQuery.isError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              Automation proof backend endpoint unavailable
            </AlertTitle>
            <AlertDescription>
              Expected GET /api/automation/proof/latest and POST
              /api/automation/proof/run with body {"{ dryRun: true }"}. Once the
              backend is wired, this page will render the returned proof result.
            </AlertDescription>
          </Alert>
        ) : null}

        {runMutation.isError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Proof run failed</AlertTitle>
            <AlertDescription>
              {runMutation.error instanceof Error
                ? runMutation.error.message
                : "The dry-run endpoint returned an unknown error."}
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-5 w-5" /> Latest proof result
            </CardTitle>
            <CardDescription>
              Endpoint contract: GET /api/automation/proof/latest returns
              {" { latest: AutomationProofResult | null }"}; POST
              /api/automation/proof/run starts a dry-run and returns the result.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-4">
            <EvidenceTerm label="Result" value={resultStatus} />
            <EvidenceTerm
              label="Started"
              value={formatDate(latest?.startedAt)}
            />
            <EvidenceTerm
              label="Completed"
              value={formatDate(latest?.completedAt)}
            />
            <EvidenceTerm
              label="Missing required steps"
              value={String(missingSteps.length)}
            />
          </CardContent>
        </Card>

        <IntegrationCard />

        <div className="grid gap-4 lg:grid-cols-2">
          {REQUIRED_STEP_IDS.map((stepId) => (
            <ProofStepCard key={stepId} result={latest} stepId={stepId} />
          ))}
        </div>
      </PageMain>
    </>
  );
};
