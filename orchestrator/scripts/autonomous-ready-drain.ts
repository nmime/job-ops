import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDataDir } from "@server/config/dataDir";
import { getAllJobs, getJobById, updateJob } from "@server/repositories/jobs";
import {
  classifyPortalUrlForSession,
  evaluatePortalSubmitPolicy,
  isFullAutoBrowserDryRunEnabled,
  isFullAutoBrowserSubmitEnabled,
  isFullAutoCaptchaEnabled,
  submitPortalApplication,
} from "@server/services/application-browser";
import { transitionStage } from "@server/services/applicationTracking";
import {
  resolveAutoApplyRecipient,
  sendAutoApplication,
} from "@server/services/auto-apply";
import {
  type BlockerBucket,
  classifyReadyDrainCandidate,
  isExplicitReviewOnlyMutationEnabled,
  selectReadyDrainBatch,
} from "@server/services/autonomous-ready-drain-selection";
import {
  getJobPdfFreshness,
  resolvePdfFingerprintContext,
} from "@server/services/pdf-fingerprint";
import type { Job } from "@shared/types";

// Safety: do not force-enable real browser submissions from this drain script.
// The caller must explicitly configure JOBOPS_FULL_AUTO_APPLY_ENABLED plus portal gates.
process.env.JOBOPS_FULL_AUTO_BROWSER_TIMEOUT_MS ??= "90000";

type DestinationResolution = {
  email: string | null;
  portal: string | null;
  emailsFound: number;
  portalsFound: number;
  pages: string[];
};

type BlockerTelemetry = {
  blockerBucket: BlockerBucket;
  blockerReason: string;
  reasonCode?: string;
};

type PortalBlockerDetails = BlockerTelemetry & {
  message: string;
};

type JobResult = {
  id: string;
  employer: string;
  title: string;
  action: string;
  blocker?: string;
  blockerBucket?: BlockerBucket;
  blockerReason?: string;
  reasonCode?: string;
  emailError?: string;
  portalError?: string;
  resolved?: Pick<
    DestinationResolution,
    "email" | "portal" | "emailsFound" | "portalsFound" | "pages"
  >;
};

const startedAt = new Date().toISOString();
const outDir =
  process.env.DO_ALL_DIR ??
  join(getDataDir(), "autonomous-ready-drain", startedAt.replace(/[:.]/g, "-"));
const resultPath = join(outDir, "autonomous-ready-drain-result.json");
const progressPath = join(outDir, "autonomous-ready-drain-progress.json");
const logPath = join(outDir, "autonomous-ready-drain.ndjson");

const maxPages = Math.max(
  1,
  Number.parseInt(process.env.JOBOPS_AUTONOMOUS_RESOLVER_MAX_PAGES ?? "12", 10),
);
const fetchTimeoutMs = Math.max(
  1_000,
  Number.parseInt(
    process.env.JOBOPS_AUTONOMOUS_RESOLVER_FETCH_TIMEOUT_MS ?? "12000",
    10,
  ),
);
const delayMs = Math.max(
  0,
  Number.parseInt(process.env.JOBOPS_AUTONOMOUS_DRAIN_DELAY_MS ?? "1200", 10),
);
const batchLimit = Math.max(
  1,
  Math.min(
    3,
    Number.parseInt(
      process.env.JOBOPS_AUTONOMOUS_AUTO_APPLY_BATCH_LIMIT ?? "1",
      10,
    ) || 1,
  ),
);

const stats = {
  totalReadyAtStart: 0,
  processed: 0,
  emailSent: 0,
  emailIdempotent: 0,
  portalSubmitted: 0,
  resolvedEmail: 0,
  resolvedPortal: 0,
  skippedNoRoute: 0,
  skippedPdf: 0,
  portalNeedsReview: 0,
  errors: 0,
  batchLimit,
  queuedAtStart: 0,
  reviewOnlyBlocked: 0,
};
const results: JobResult[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value: unknown, maxLength = 800): string {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi, "***@$1")
    .slice(0, maxLength);
}

async function appendLog(entry: Record<string, unknown>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(logPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

async function writeProgress(done = false): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    progressPath,
    JSON.stringify(
      {
        startedAt,
        updatedAt: new Date().toISOString(),
        done,
        stats,
        resultCount: results.length,
      },
      null,
      2,
    ),
  );
}

function isHttpUrl(value: string | null | undefined): value is string {
  return /^https?:\/\//i.test(value?.trim() ?? "");
}

function hostname(value: string | null | undefined): string {
  try {
    return new URL(value ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sameRegistrableDomain(left: string, right: string): boolean {
  if (!left || !right) return false;
  const l = left.split(".").slice(-2).join(".");
  const r = right.split(".").slice(-2).join(".");
  return l === r;
}

function isAggregatorHost(host: string): boolean {
  return /(^|\.)(linkedin|indeed|remoteok|jobicy|remotive|arbeitnow|weworkremotely|themuse|hiring\.cafe|workingnomads|startupjobs|wellfound|otta|cord|glassdoor|monster|ziprecruiter)\./i.test(
    host,
  );
}

function parseList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeAllowedDomain(value: string): string {
  const withoutProtocol =
    value.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
  return withoutProtocol
    .toLowerCase()
    .replace(/^www\./, "")
    .trim();
}

function portalAllowedDomains(): string[] {
  const configured =
    process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS ??
    process.env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS;
  return parseList(configured ?? "ashbyhq.com,jobs.ashbyhq.com")
    .map(normalizeAllowedDomain)
    .filter(Boolean);
}

function domainMatches(host: string, domains: string[]): boolean {
  const normalizedHost = normalizeAllowedDomain(host);
  return domains.some(
    (domain) =>
      normalizedHost === domain || normalizedHost.endsWith(`.${domain}`),
  );
}

function isAtsHost(host: string): boolean {
  return domainMatches(host, portalAllowedDomains());
}

function blockerBucketFromReasonCode(
  reasonCode: string | null | undefined,
  fallback: BlockerBucket = "unknown",
): BlockerBucket {
  switch (reasonCode) {
    case "portal_blocked_domain_not_validated":
      return "allowlist_policy";
    case "portal_blocked_unsupported_source":
      return "unsupported_source";
    case "portal_needs_review_login_required":
    case "portal_needs_review_session_missing":
      return "session_login";
    case "portal_needs_review_captcha":
      return "captcha";
    case "portal_needs_review_required_fields":
    case "portal_needs_review_resume_upload_missing":
      return "required_fields";
    case "portal_needs_review_no_submit_control":
      return "no_submit_control";
    case "portal_needs_review_no_success_signal":
      return "no_success_confirmation";
    default:
      return fallback;
  }
}

function applyBlockerTelemetry(
  result: JobResult,
  details: PortalBlockerDetails,
): void {
  result.portalError = details.message;
  result.blocker = details.message;
  result.blockerBucket = details.blockerBucket;
  result.blockerReason = details.blockerReason;
  result.reasonCode = details.reasonCode;
}

function makeBlockerDetails(input: {
  message: string;
  blockerBucket: BlockerBucket;
  blockerReason?: string;
  reasonCode?: string;
}): PortalBlockerDetails {
  return {
    message: input.message,
    blockerBucket: input.blockerBucket,
    blockerReason: input.blockerReason ?? input.message,
    reasonCode: input.reasonCode,
  };
}

function portalAutoSubmitPolicyBlocker(
  job: Job,
  url: string | null | undefined,
): PortalBlockerDetails | null {
  if (!isHttpUrl(url)) {
    return makeBlockerDetails({
      message: "portal_url_missing_or_invalid",
      blockerBucket: "invalid_url/no_domain",
      blockerReason: "Portal URL is missing, invalid, or has no domain.",
      reasonCode: "portal_blocked_domain_not_validated",
    });
  }
  const host = hostname(url);
  if (!host) {
    return makeBlockerDetails({
      message: "portal_url_missing_or_invalid",
      blockerBucket: "invalid_url/no_domain",
      blockerReason: "Portal URL is missing, invalid, or has no domain.",
      reasonCode: "portal_blocked_domain_not_validated",
    });
  }
  if (isAggregatorHost(host)) {
    return makeBlockerDetails({
      message:
        "portal route is an aggregator/listing URL, not a direct supported ATS/company apply page; needs human review before submission.",
      blockerBucket: "unsupported_source",
      blockerReason: "Portal route is an aggregator/listing URL.",
      reasonCode: "portal_blocked_unsupported_source",
    });
  }

  const policy = evaluatePortalSubmitPolicy(job, url);
  if (!policy.allowed) {
    const reasonCode = policy.reasonCode;
    return makeBlockerDetails({
      message:
        policy.reason ??
        "portal route is blocked by autonomous portal submit policy.",
      blockerBucket:
        policy.blockerCode === "unsupported_source"
          ? "unsupported_source"
          : policy.blockerCode === "session_required" ||
              policy.blockerCode === "login_wall"
            ? "session_login"
            : policy.blockerCode === "domain_not_allowlisted" ||
                policy.blockerCode === "domain_blocked"
              ? "allowlist_policy"
              : blockerBucketFromReasonCode(reasonCode),
      blockerReason: policy.blockerCode,
      reasonCode,
    });
  }
  return null;
}

function addCandidateUrl(
  urls: Set<string>,
  value: string | null | undefined,
): void {
  if (!isHttpUrl(value)) return;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    urls.add(parsed.toString());
  } catch {
    // Ignore invalid candidate URLs.
  }
}

function addDerivedCompanyUrls(
  urls: Set<string>,
  value: string | null | undefined,
): void {
  if (!isHttpUrl(value)) return;
  try {
    const origin = new URL(value).origin;
    for (const path of [
      "/careers",
      "/career",
      "/jobs",
      "/open-positions",
      "/vacancies",
      "/join-us",
      "/work-with-us",
      "/about/careers",
    ]) {
      urls.add(`${origin}${path}`);
    }
  } catch {
    // Ignore invalid candidate URLs.
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: {
        "user-agent":
          process.env.JOBOPS_FULL_AUTO_BROWSER_USER_AGENT ??
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 JobOpsAutonomous/1.0",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !/text|html|json|xml/i.test(contentType)) return null;
    return (await response.text()).slice(0, 450_000);
  } catch {
    return null;
  }
}

function extractEmails(text: string): string[] {
  const blockedLocal =
    /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|privacy|security|support)$/i;
  const emails = new Set<string>();
  for (const match of text.matchAll(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  )) {
    const address = match[0].toLowerCase().replace(/[),.;:'"\]]+$/, "");
    const local = address.split("@")[0] ?? "";
    if (blockedLocal.test(local)) continue;
    emails.add(address);
  }
  return [...emails];
}

function scoreEmail(address: string, job: Job, pageHosts: string[]): number {
  const [local = "", domain = ""] = address.split("@");
  let score = 0;
  if (
    /(career|job|recruit|talent|people|hr|human|apply|application)/i.test(local)
  ) {
    score += 14;
  }
  if (/(info|contact|hello|office|admin)/i.test(local)) score += 5;
  if (/(support|sales|billing|press|media|newsletter|marketing)/i.test(local)) {
    score -= 6;
  }
  const companyHosts = [
    hostname(job.employerUrl),
    hostname(job.companyUrlDirect),
    ...pageHosts,
  ].filter(Boolean);
  if (companyHosts.some((host) => sameRegistrableDomain(host, domain))) {
    score += 8;
  }
  if (/(gmail\.com|outlook\.com|hotmail\.com|yahoo\.com)$/i.test(domain)) {
    score -= 3;
  }
  return score;
}

function extractHrefCandidates(html: string, baseUrl: string): string[] {
  const candidates = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    const href = match[1]?.trim();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      const value = url.toString();
      if (
        /(apply|career|job|position|vacanc|opening|greenhouse|lever|ashby|workday|smartrecruiters|workable|recruitee|personio|teamtailor|join\.com)/i.test(
          value,
        )
      ) {
        candidates.add(value);
      }
    } catch {
      // Ignore invalid href.
    }
  }
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    addCandidateUrl(candidates, match[0]);
  }
  return [...candidates];
}

function scorePortal(url: string, job: Job): number {
  const host = hostname(url);
  const lower = url.toLowerCase();
  let score = 0;
  if (isAtsHost(host)) score += 14;
  if (/apply|application/.test(lower)) score += 8;
  if (/career|job|position|vacanc|opening/.test(lower)) score += 5;
  if (!isAggregatorHost(host)) score += 3;
  const tokens =
    `${job.employer} ${job.title}`
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g)
      ?.slice(0, 10) ?? [];
  for (const token of tokens) {
    if (lower.includes(token)) score += 1;
  }
  return score;
}

async function resolveDestination(job: Job): Promise<DestinationResolution> {
  const queue: string[] = [];
  const seen = new Set<string>();
  const pageHosts: string[] = [];
  const foundEmails = new Set<string>();
  const foundPortals = new Set<string>();

  const seeds = new Set<string>();
  addCandidateUrl(seeds, job.applicationLink);
  addCandidateUrl(seeds, job.jobUrlDirect);
  addCandidateUrl(seeds, job.jobUrl);
  addCandidateUrl(seeds, job.employerUrl);
  addCandidateUrl(seeds, job.companyUrlDirect);
  addDerivedCompanyUrls(seeds, job.employerUrl ?? job.companyUrlDirect);
  for (const url of seeds) queue.push(url);

  while (queue.length > 0 && seen.size < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const host = hostname(url);
    if (host) pageHosts.push(host);

    const html = await fetchText(url);
    if (!html) continue;
    const text = htmlToText(html);
    for (const email of extractEmails(`${html}\n${text}`))
      foundEmails.add(email);

    for (const candidate of extractHrefCandidates(html, url)) {
      const candidateHost = hostname(candidate);
      if (!candidateHost) continue;
      if (isAtsHost(candidateHost) || scorePortal(candidate, job) >= 8) {
        foundPortals.add(candidate);
      }
      if (
        queue.length + seen.size < maxPages &&
        !seen.has(candidate) &&
        (sameRegistrableDomain(host, candidateHost) || isAtsHost(candidateHost))
      ) {
        queue.push(candidate);
      }
    }
  }

  const email = [...foundEmails]
    .map((address) => ({ address, score: scoreEmail(address, job, pageHosts) }))
    .filter((candidate) => candidate.score >= 5)
    .sort((a, b) => b.score - a.score)[0]?.address;

  const portal = [...foundPortals]
    .map((url) => ({ url, score: scorePortal(url, job) }))
    .filter((candidate) => candidate.score >= 8)
    .sort((a, b) => b.score - a.score)[0]?.url;

  return {
    email: email ?? null,
    portal: portal ?? null,
    emailsFound: foundEmails.size,
    portalsFound: foundPortals.size,
    pages: [...seen],
  };
}

async function hydratePdfFreshness(job: Job): Promise<Job> {
  const fingerprintContext = await resolvePdfFingerprintContext();
  return {
    ...job,
    pdfFreshness: getJobPdfFreshness(job, fingerprintContext),
  };
}

function hasUsablePdf(job: Job): boolean {
  return (
    Boolean(job.pdfPath) && !job.pdfRegenerating && job.pdfFreshness !== "stale"
  );
}

async function markApplied(
  job: Job,
  note: string,
  reasonCode = "autonomous_service_application",
): Promise<void> {
  const appliedAtDate = new Date();
  transitionStage(
    job.id,
    "applied",
    Math.floor(appliedAtDate.getTime() / 1000),
    {
      eventLabel: "Autonomous service application",
      actor: "system",
      eventType: "status_update",
      reasonCode,
      note,
    },
    null,
  );
  await updateJob(job.id, {
    status: "applied",
    appliedAt: appliedAtDate.toISOString(),
  });
}

function portalSessionBlocker(
  url: string | null | undefined,
): PortalBlockerDetails | null {
  if (!url) return null;
  const gate = classifyPortalUrlForSession(url);
  return gate
    ? makeBlockerDetails({
        message: gate.reason,
        blockerBucket: "session_login",
        blockerReason: gate.provider,
        reasonCode:
          gate.provider === "generic"
            ? "portal_needs_review_session_missing"
            : "portal_needs_review_login_required",
      })
    : null;
}

function fullAutoSubmitAllowed(): boolean {
  return isFullAutoBrowserSubmitEnabled() && !isFullAutoBrowserDryRunEnabled();
}

async function markSkipped(job: Job, blocker: string): Promise<void> {
  await updateJob(job.id, { status: "skipped" });
  await appendLog({
    ts: new Date().toISOString(),
    event: "job_skipped",
    jobId: job.id,
    blocker,
  });
}

async function markNeedsReview(
  job: Job,
  blocker: string,
  telemetry?: BlockerTelemetry,
): Promise<void> {
  const reviewedAt = new Date();
  const occurredAt = Math.floor(reviewedAt.getTime() / 1000);
  transitionStage(
    job.id,
    "no_change",
    occurredAt,
    {
      eventLabel: "Autonomous service needs review",
      actor: "system",
      eventType: "status_update",
      reasonCode: telemetry?.reasonCode ?? "portal_needs_review",
      note: blocker,
    },
    "needs_human" as never,
  );
  await updateJob(job.id, {
    status: "skipped",
    outcome: "needs_human" as never,
    closedAt: occurredAt,
  });
  await appendLog({
    ts: reviewedAt.toISOString(),
    event: "job_needs_review",
    jobId: job.id,
    blocker,
    blockerBucket: telemetry?.blockerBucket,
    blockerReason: telemetry?.blockerReason,
    reasonCode: telemetry?.reasonCode,
  });
}

async function tryEmail(job: Job, result: JobResult): Promise<boolean> {
  try {
    if (!resolveAutoApplyRecipient(job)) return false;
    const sent = await sendAutoApplication(job);
    await markApplied(
      job,
      `Sent${sent.idempotent ? " idempotent" : ""} email application to ${sent.recipient}`,
    );
    if (sent.idempotent) stats.emailIdempotent += 1;
    else stats.emailSent += 1;
    result.action = sent.idempotent ? "email_idempotent" : "email_sent";
    return true;
  } catch (error) {
    result.emailError = redact(error instanceof Error ? error.message : error);
    return false;
  }
}

async function tryPortal(job: Job, result: JobResult): Promise<boolean> {
  const targetUrl = job.applicationLink ?? job.jobUrlDirect ?? job.jobUrl;
  const sessionBlocker = portalSessionBlocker(targetUrl);
  if (sessionBlocker) {
    stats.portalNeedsReview += 1;
    stats.reviewOnlyBlocked += 1;
    applyBlockerTelemetry(result, sessionBlocker);
    result.action = "needs_portal_session";
    return false;
  }
  const policyBlocker = portalAutoSubmitPolicyBlocker(job, targetUrl);
  if (policyBlocker) {
    stats.portalNeedsReview += 1;
    stats.reviewOnlyBlocked += 1;
    applyBlockerTelemetry(result, policyBlocker);
    result.action = "needs_review";
    return false;
  }
  if (!fullAutoSubmitAllowed()) {
    stats.portalNeedsReview += 1;
    result.portalError =
      "Full-auto portal submit is disabled or dry-run; skipped before any real submit click.";
    result.blocker = result.portalError;
    result.blockerBucket = "unknown";
    result.blockerReason = "pre_submit_dry_run";
    result.reasonCode = "portal_needs_review_pre_submit_dry_run";
    result.action = "portal_pre_submit_dry_run";
    return false;
  }
  try {
    const portal = await submitPortalApplication(job, {
      allowCaptcha: isFullAutoCaptchaEnabled(),
    });
    if (portal.status === "submitted") {
      await markApplied(
        job,
        `Submitted portal application: fields=${portal.fieldsFilled}; resumeUploaded=${portal.resumeUploaded}; finalUrl=${portal.finalUrl}`,
        "portal_submitted",
      );
      stats.portalSubmitted += 1;
      result.reasonCode = "portal_submitted";
      result.action = "portal_submitted";
      return true;
    }
    stats.portalNeedsReview += 1;
    result.portalError = redact(
      portal.reason ??
        portal.captcha.message ??
        "portal application needs review",
    );
    result.blocker = result.portalError;
    result.blockerBucket = blockerBucketFromReasonCode(portal.reasonCode);
    result.blockerReason =
      portal.reviewReason ?? portal.reasonCode ?? "unknown";
    result.reasonCode = portal.reasonCode;
    result.action = "needs_review";
    return false;
  } catch (error) {
    result.portalError = redact(error instanceof Error ? error.message : error);
    result.blocker = result.portalError;
    result.blockerBucket = "unknown";
    result.blockerReason = "browser_error";
    result.reasonCode = "portal_needs_review_browser_error";
    result.action = "needs_review";
    return false;
  }
}

async function handleReadyJob(jobSnapshot: Job): Promise<JobResult> {
  const current = await getJobById(jobSnapshot.id);
  const job = current ? await hydratePdfFreshness(current) : null;
  const result: JobResult = {
    id: jobSnapshot.id,
    employer: jobSnapshot.employer,
    title: jobSnapshot.title,
    action: "not_ready",
  };

  if (!job || job.status !== "ready") return result;
  if (!hasUsablePdf(job)) {
    result.action = "skipped_pdf";
    result.blocker = "missing_or_stale_resume_pdf";
    stats.skippedPdf += 1;
    await markSkipped(job, result.blocker);
    return result;
  }

  if (await tryEmail(job, result)) return result;

  const resolved = await resolveDestination(job);
  result.resolved = {
    email: resolved.email ? "redacted" : null,
    portal: resolved.portal,
    emailsFound: resolved.emailsFound,
    portalsFound: resolved.portalsFound,
    pages: resolved.pages.slice(0, 12),
  };

  if (resolved.email) {
    stats.resolvedEmail += 1;
    const updated = await updateJob(job.id, {
      applicationLink: `mailto:${resolved.email}`,
    });
    if (
      updated &&
      (await tryEmail(await hydratePdfFreshness(updated), result))
    ) {
      return result;
    }
  }

  if (resolved.portal) {
    stats.resolvedPortal += 1;
    const sessionBlocker = portalSessionBlocker(resolved.portal);
    if (sessionBlocker) {
      applyBlockerTelemetry(result, sessionBlocker);
      result.action = "needs_portal_session";
      stats.portalNeedsReview += 1;
      stats.reviewOnlyBlocked += 1;
      if (isExplicitReviewOnlyMutationEnabled()) {
        stats.skippedNoRoute += 1;
        await markNeedsReview(job, sessionBlocker.message, sessionBlocker);
      }
      return result;
    }
    const policyBlocker = portalAutoSubmitPolicyBlocker(job, resolved.portal);
    if (policyBlocker) {
      applyBlockerTelemetry(result, policyBlocker);
      result.action = "needs_review";
      stats.portalNeedsReview += 1;
      stats.reviewOnlyBlocked += 1;
      if (isExplicitReviewOnlyMutationEnabled()) {
        stats.skippedNoRoute += 1;
        await markNeedsReview(job, policyBlocker.message, policyBlocker);
      }
      return result;
    }
    const updated = await updateJob(job.id, {
      applicationLink: resolved.portal,
    });
    if (
      updated &&
      (await tryPortal(await hydratePdfFreshness(updated), result))
    ) {
      return result;
    }
  }

  const directUrl = job.applicationLink ?? job.jobUrlDirect ?? job.jobUrl;
  if (isHttpUrl(directUrl) && !isAggregatorHost(hostname(directUrl))) {
    const sessionBlocker = portalSessionBlocker(directUrl);
    if (sessionBlocker) {
      applyBlockerTelemetry(result, sessionBlocker);
      result.action = "needs_portal_session";
      stats.portalNeedsReview += 1;
      stats.reviewOnlyBlocked += 1;
      if (isExplicitReviewOnlyMutationEnabled()) {
        stats.skippedNoRoute += 1;
        await markNeedsReview(job, sessionBlocker.message, sessionBlocker);
      }
      return result;
    }
    const policyBlocker = portalAutoSubmitPolicyBlocker(job, directUrl);
    if (policyBlocker) {
      applyBlockerTelemetry(result, policyBlocker);
      result.action = "needs_review";
      stats.portalNeedsReview += 1;
      stats.reviewOnlyBlocked += 1;
      if (isExplicitReviewOnlyMutationEnabled()) {
        stats.skippedNoRoute += 1;
        await markNeedsReview(job, policyBlocker.message, policyBlocker);
      }
      return result;
    }
    if (await tryPortal(job, result)) return result;
  }

  result.action = "skipped_no_route";
  result.blocker =
    result.portalError ??
    (resolved.emailsFound > 0 || resolved.portalsFound > 0
      ? "alternate_routes_exhausted_no_confirmed_submit"
      : "no_contact_or_direct_ats_found_after_search");
  if (result.portalError || resolved.portal) {
    stats.reviewOnlyBlocked += 1;
    if (!result.blockerBucket) {
      result.blockerBucket = "unknown";
      result.blockerReason = result.blocker;
    }
    if (isExplicitReviewOnlyMutationEnabled()) {
      stats.skippedNoRoute += 1;
      await markNeedsReview(job, result.blocker, {
        blockerBucket: result.blockerBucket,
        blockerReason: result.blockerReason ?? result.blocker,
        reasonCode: result.reasonCode,
      });
    }
  } else if (isExplicitReviewOnlyMutationEnabled()) {
    stats.skippedNoRoute += 1;
    await markSkipped(job, result.blocker);
  } else {
    stats.reviewOnlyBlocked += 1;
    result.blockerBucket = "unknown";
    result.blockerReason = result.blocker;
  }
  return result;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const ready = await getAllJobs(["ready"]);
  stats.totalReadyAtStart = ready.length;
  stats.queuedAtStart = ready.length;
  const readyBatch = selectReadyDrainBatch(ready, batchLimit, {
    hasEmailReady: (job) => Boolean(resolveAutoApplyRecipient(job)),
  });
  await appendLog({
    ts: startedAt,
    event: "start",
    ready: ready.length,
    batchLimit,
    selected: readyBatch.length,
    selectedRoutes: readyBatch.map((job) => ({
      jobId: job.id,
      ...classifyReadyDrainCandidate(job, {
        hasEmailReady: Boolean(resolveAutoApplyRecipient(job)),
      }),
    })),
    maxPages,
    allowCaptcha: isFullAutoCaptchaEnabled(),
    mutateReviewOnlyRoutes: isExplicitReviewOnlyMutationEnabled(),
  });
  await writeProgress(false);

  for (const job of readyBatch) {
    try {
      const result = await handleReadyJob(job);
      results.push(result);
      stats.processed += 1;
      await appendLog({
        ts: new Date().toISOString(),
        event: "job_done",
        ...result,
      });
    } catch (error) {
      stats.errors += 1;
      const result: JobResult = {
        id: job.id,
        employer: job.employer,
        title: job.title,
        action: "error",
        blocker: redact(error instanceof Error ? error.message : error),
      };
      results.push(result);
      await appendLog({
        ts: new Date().toISOString(),
        event: "job_error",
        ...result,
      });
    }
    await writeProgress(false);
    if (delayMs > 0) await sleep(delayMs);
  }

  const final = {
    startedAt,
    finishedAt: new Date().toISOString(),
    stats,
    results,
    paths: { outDir, resultPath, progressPath, logPath },
  };
  await writeFile(resultPath, JSON.stringify(final, null, 2));
  await writeProgress(true);
  console.log(JSON.stringify(final, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(async (error) => {
    stats.errors += 1;
    const failure = {
      startedAt,
      finishedAt: new Date().toISOString(),
      stats,
      error: redact(
        error instanceof Error ? (error.stack ?? error.message) : error,
      ),
      paths: { outDir, resultPath, progressPath, logPath },
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(resultPath, JSON.stringify(failure, null, 2));
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  });
}
