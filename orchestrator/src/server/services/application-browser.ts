import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { badRequest, serviceUnavailable, upstreamError } from "@infra/errors";
import { logger } from "@infra/logger";
import { getDataDir } from "@server/config/dataDir";
import { getPaidChallengeSolverOptions } from "@server/services/captcha-solver";
import { getPdfPath } from "@server/services/pdf";
import { getProfile } from "@server/services/profile";
import type { Job, ResumeProfile } from "@shared/types";
import type { Browser, Locator, Page } from "playwright";
import { resolveHttpApplicationUrl } from "./auto-apply";

export type BrowserAutoApplyReviewReason =
  | "needs_portal_session"
  | "needs_captcha"
  | "required_fields_missing"
  | "resume_upload_missing"
  | "pre_submit_dry_run"
  | "no_submit_button"
  | "no_success_signal"
  | "post_submit_blocking_error"
  | "browser_error";

export type PortalOutcomeReasonCode =
  | "portal_submitted"
  | "portal_needs_review_login_required"
  | "portal_needs_review_session_missing"
  | "portal_needs_review_captcha"
  | "portal_needs_review_required_fields"
  | "portal_needs_review_resume_upload_missing"
  | "portal_needs_review_pre_submit_dry_run"
  | "portal_needs_review_no_submit_control"
  | "portal_needs_review_no_success_signal"
  | "portal_needs_review_post_submit_blocking_error"
  | "portal_needs_review_browser_error"
  | "portal_blocked_domain_not_validated"
  | "portal_blocked_unsupported_source";

export type PortalOutcomeMetadata = {
  reasonCode: PortalOutcomeReasonCode;
  status: "submitted" | "needs_review" | "blocked";
  domain: string | null;
  source?: string | null;
  urlKind?: "application_link" | "direct_url" | "source_url" | "unknown";
  liveSubmitAttempted: boolean;
  submitClicked: boolean;
  captchaType?: CaptchaDetection["type"] | null;
  captchaAttempted?: boolean;
  captchaSolved?: boolean;
};

export type PortalSessionGate = {
  type: "needs_portal_session";
  provider: "linkedin" | "indeed" | "generic";
  reason: string;
};

export type BrowserAutoApplyResult = {
  mode: "browser";
  status: "submitted" | "needs_review";
  url: string;
  finalUrl: string;
  submittedAt: string | null;
  fieldsFilled: number;
  resumeUploaded: boolean;
  submitClicked: boolean;
  captcha: {
    attempted: boolean;
    solved: boolean;
    type: CaptchaDetection["type"] | null;
    provider: "2captcha" | null;
    message?: string;
  };
  screenshotPath?: string;
  reason?: string;
  reasonCode?: PortalOutcomeReasonCode;
  reviewReason?: BrowserAutoApplyReviewReason;
  outcomeMetadata: PortalOutcomeMetadata;
};

type BrowserAutoApplyOptions = {
  allowCaptcha?: boolean;
  /** Fill and validate only; never click the final submit/apply button. */
  dryRun?: boolean;
};

export type PortalBlockerReasonCode =
  | "domain_not_allowlisted"
  | "domain_blocked"
  | "unsupported_source"
  | "session_required"
  | "login_wall"
  | "captcha_challenge"
  | "required_or_invalid_fields"
  | "resume_upload_missing"
  | "pre_submit_dry_run"
  | "missing_success_signal"
  | "post_submit_blocking_error"
  | "browser_error"
  | "no_submit_control";

type PortalBlocker = {
  code: PortalBlockerReasonCode;
  reason: string;
};

type PortalReadinessSnapshot = {
  title?: string;
  text?: string;
  fields?: Array<{
    required?: boolean;
    value?: string;
    type?: string;
    name?: string;
    visible?: boolean;
    ariaInvalid?: string;
    validationMessage?: string;
  }>;
};

export type PortalDomainPolicyDecision = {
  allowed: boolean;
  domain: string | null;
  allowedDomains: string[];
  blockedDomains: string[];
  sessionRequiredDomains: string[];
  sessionRequired: boolean;
  hasValidatedSession: boolean;
  reasonCode?: PortalOutcomeReasonCode;
  blockerCode?: PortalBlockerReasonCode;
  reason?: string;
};

export type PortalSourcePolicyDecision = {
  allowed: boolean;
  source: string | null;
  urlKind: "application_link" | "direct_url" | "source_url" | "unknown";
  validatedSources: string[];
  allowSourceUrlFallback: boolean;
  reasonCode?: PortalOutcomeReasonCode;
  blockerCode?: PortalBlockerReasonCode;
  reason?: string;
};

export type PortalSubmitPolicyDecision = PortalDomainPolicyDecision & {
  sourcePolicy: PortalSourcePolicyDecision;
  source: string | null;
  urlKind: PortalSourcePolicyDecision["urlKind"];
};

type CaptchaDetection =
  | {
      type: "recaptcha-v2";
      sitekey: string;
      pageUrl: string;
      invisible?: boolean;
    }
  | { type: "hcaptcha"; sitekey: string; pageUrl: string }
  | {
      type: "turnstile";
      sitekey: string;
      pageUrl: string;
      action?: string;
      cData?: string;
    }
  | { type: "image"; pageUrl: string }
  | { type: "cloudflare"; pageUrl: string }
  | { type: null; pageUrl: string };

type CaptchaSolveOutcome = BrowserAutoApplyResult["captcha"];

type TwoCaptchaCreateTaskResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
};

type TwoCaptchaTaskResultResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: "processing" | "ready";
  solution?: { token?: string; text?: string };
};

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function getBrowserTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.JOBOPS_FULL_AUTO_BROWSER_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function getCaptchaTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.JOBOPS_FULL_AUTO_CAPTCHA_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizePageText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeDomainEntry(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  try {
    return new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname
      .replace(/^\.+/, "")
      .replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^\.+/, "").replace(/^www\./, "") || null;
  }
}

function normalizeDomainList(entries: string[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => normalizeDomainEntry(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

function hostnameForUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function domainMatches(
  hostname: string | null,
  policyDomains: string[],
): boolean {
  if (!hostname) return false;
  return policyDomains.some(
    (domain) =>
      domain === "*" || hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function normalizeSourceEntry(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeSourceList(entries: string[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => normalizeSourceEntry(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

function getPortalValidatedSources(env: NodeJS.ProcessEnv): string[] {
  return normalizeSourceList(
    parseList(
      env.JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES ??
        env.JOBOPS_FULL_AUTO_VALIDATED_SOURCES,
    ),
  );
}

function isPortalSourceUrlFallbackAllowed(env: NodeJS.ProcessEnv): boolean {
  return parseBoolean(
    env.JOBOPS_AUTONOMOUS_PORTAL_ALLOW_SOURCE_URL_FALLBACK ??
      env.JOBOPS_FULL_AUTO_ALLOW_SOURCE_URL_FALLBACK,
  );
}

export function classifyPortalUrlKind(
  job: Pick<Job, "applicationLink" | "jobUrlDirect" | "jobUrl">,
  url: string,
): PortalSourcePolicyDecision["urlKind"] {
  const matches = (value: string | null | undefined): boolean =>
    Boolean(value?.trim()) && value?.trim() === url;
  if (matches(job.applicationLink)) return "application_link";
  if (matches(job.jobUrlDirect)) return "direct_url";
  if (matches(job.jobUrl)) return "source_url";
  return "unknown";
}

export function evaluatePortalSourcePolicy(
  job: Pick<Job, "source" | "applicationLink" | "jobUrlDirect" | "jobUrl">,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): PortalSourcePolicyDecision {
  const source = normalizeSourceEntry(String(job.source ?? ""));
  const validatedSources = getPortalValidatedSources(env);
  const urlKind = classifyPortalUrlKind(job, url);
  const allowSourceUrlFallback = isPortalSourceUrlFallbackAllowed(env);
  const sourceIsValidated = Boolean(
    source &&
      (validatedSources.includes("*") || validatedSources.includes(source)),
  );

  const base = {
    source,
    urlKind,
    validatedSources,
    allowSourceUrlFallback,
  };

  if (
    urlKind === "source_url" &&
    !sourceIsValidated &&
    !allowSourceUrlFallback
  ) {
    return {
      ...base,
      allowed: false,
      reasonCode: "portal_blocked_unsupported_source",
      blockerCode: "unsupported_source",
      reason:
        "Portal submit URL falls back to the source listing URL, but this source is not validated for live browser submission.",
    };
  }

  return { ...base, allowed: true };
}

export function evaluatePortalSubmitPolicy(
  job: Pick<Job, "source" | "applicationLink" | "jobUrlDirect" | "jobUrl">,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): PortalSubmitPolicyDecision {
  const domainDecision = evaluatePortalDomainPolicy(url, env);
  const sourcePolicy = evaluatePortalSourcePolicy(job, url, env);
  if (!domainDecision.allowed) {
    return {
      ...domainDecision,
      sourcePolicy,
      source: sourcePolicy.source,
      urlKind: sourcePolicy.urlKind,
    };
  }

  if (!sourcePolicy.allowed) {
    return {
      ...domainDecision,
      allowed: false,
      reasonCode: sourcePolicy.reasonCode,
      blockerCode: sourcePolicy.blockerCode,
      reason: sourcePolicy.reason,
      sourcePolicy,
      source: sourcePolicy.source,
      urlKind: sourcePolicy.urlKind,
    };
  }

  return {
    ...domainDecision,
    sourcePolicy,
    source: sourcePolicy.source,
    urlKind: sourcePolicy.urlKind,
  };
}

function getPortalAllowedDomains(env: NodeJS.ProcessEnv): string[] {
  const configured =
    env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS ??
    env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS;
  return normalizeDomainList(
    parseList(configured ?? "ashbyhq.com,jobs.ashbyhq.com"),
  );
}

function getPortalBlockedDomains(env: NodeJS.ProcessEnv): string[] {
  return normalizeDomainList([
    "linkedin.com",
    "indeed.com",
    ...parseList(
      env.JOBOPS_AUTONOMOUS_PORTAL_BLOCKED_DOMAINS ??
        env.JOBOPS_FULL_AUTO_BLOCKED_DOMAINS,
    ),
  ]);
}

function getPortalSessionRequiredDomains(env: NodeJS.ProcessEnv): string[] {
  return normalizeDomainList([
    "linkedin.com",
    "indeed.com",
    ...parseList(
      env.JOBOPS_AUTONOMOUS_PORTAL_SESSION_REQUIRED_DOMAINS ??
        env.JOBOPS_FULL_AUTO_SESSION_REQUIRED_DOMAINS,
    ),
  ]);
}

function getPortalValidatedSessionDomains(env: NodeJS.ProcessEnv): string[] {
  return normalizeDomainList(
    parseList(
      env.JOBOPS_AUTONOMOUS_PORTAL_SESSION_VALIDATED_DOMAINS ??
        env.JOBOPS_FULL_AUTO_SESSION_VALIDATED_DOMAINS,
    ),
  );
}

function getBrowserStorageStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path =
    env.JOBOPS_FULL_AUTO_BROWSER_STORAGE_STATE_PATH ??
    env.JOBOPS_AUTONOMOUS_PORTAL_STORAGE_STATE_PATH;
  return path?.trim() ? path.trim() : undefined;
}

function portalOutcomeReasonCodeForBlocker(
  code: PortalBlockerReasonCode | undefined,
): PortalOutcomeReasonCode {
  switch (code) {
    case "login_wall":
      return "portal_needs_review_login_required";
    case "session_required":
      return "portal_needs_review_session_missing";
    case "captcha_challenge":
      return "portal_needs_review_captcha";
    case "required_or_invalid_fields":
      return "portal_needs_review_required_fields";
    case "resume_upload_missing":
      return "portal_needs_review_resume_upload_missing";
    case "pre_submit_dry_run":
      return "portal_needs_review_pre_submit_dry_run";
    case "no_submit_control":
      return "portal_needs_review_no_submit_control";
    case "missing_success_signal":
      return "portal_needs_review_no_success_signal";
    case "post_submit_blocking_error":
      return "portal_needs_review_post_submit_blocking_error";
    case "domain_not_allowlisted":
    case "domain_blocked":
      return "portal_blocked_domain_not_validated";
    case "unsupported_source":
      return "portal_blocked_unsupported_source";
    default:
      return "portal_needs_review_browser_error";
  }
}

function createPortalOutcomeMetadata(input: {
  reasonCode: PortalOutcomeReasonCode;
  domain: string | null;
  source?: string | null;
  urlKind?: PortalSourcePolicyDecision["urlKind"];
  liveSubmitAttempted?: boolean;
  submitClicked?: boolean;
  captcha?: BrowserAutoApplyResult["captcha"];
}): PortalOutcomeMetadata {
  return {
    reasonCode: input.reasonCode,
    status:
      input.reasonCode === "portal_submitted"
        ? "submitted"
        : input.reasonCode.startsWith("portal_blocked_")
          ? "blocked"
          : "needs_review",
    domain: input.domain,
    source: input.source,
    urlKind: input.urlKind,
    liveSubmitAttempted: Boolean(input.liveSubmitAttempted),
    submitClicked: Boolean(input.submitClicked),
    captchaType: input.captcha?.type ?? null,
    captchaAttempted: input.captcha?.attempted ?? false,
    captchaSolved: input.captcha?.solved ?? false,
  };
}

function storageStateHasSessionForDomain(
  hostname: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const storageStatePath = getBrowserStorageStatePath(env);
  if (!storageStatePath || !existsSync(storageStatePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(storageStatePath, "utf8")) as {
      cookies?: Array<{ domain?: string; expires?: number }>;
    };
    const nowSeconds = Date.now() / 1000;
    return (parsed.cookies ?? []).some((cookie) => {
      const cookieDomain = normalizeDomainEntry(cookie.domain ?? "");
      if (!cookieDomain) return false;
      const notExpired =
        cookie.expires === undefined ||
        cookie.expires === -1 ||
        cookie.expires > nowSeconds;
      return notExpired && domainMatches(hostname, [cookieDomain]);
    });
  } catch {
    return false;
  }
}

export function evaluatePortalDomainPolicy(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): PortalDomainPolicyDecision {
  const domain = hostnameForUrl(url);
  const allowedDomains = getPortalAllowedDomains(env);
  const blockedDomains = getPortalBlockedDomains(env);
  const sessionRequiredDomains = getPortalSessionRequiredDomains(env);
  const sessionRequired = domainMatches(domain, sessionRequiredDomains);
  const hasValidatedSession = Boolean(
    domain &&
      (domainMatches(domain, getPortalValidatedSessionDomains(env)) ||
        storageStateHasSessionForDomain(domain, env)),
  );

  const base = {
    domain,
    allowedDomains,
    blockedDomains,
    sessionRequiredDomains,
    sessionRequired,
    hasValidatedSession,
  };

  if (!domain || !domainMatches(domain, allowedDomains)) {
    return {
      ...base,
      allowed: false,
      reasonCode: "portal_blocked_domain_not_validated",
      blockerCode: "domain_not_allowlisted",
      reason:
        "Portal domain is not in JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS/JOBOPS_FULL_AUTO_ALLOWED_DOMAINS.",
    };
  }

  if (sessionRequired && !hasValidatedSession) {
    return {
      ...base,
      allowed: false,
      reasonCode: "portal_needs_review_session_missing",
      blockerCode: "session_required",
      reason:
        "Portal domain requires a validated browser session/storage state before automation.",
    };
  }

  if (domainMatches(domain, blockedDomains) && !hasValidatedSession) {
    return {
      ...base,
      allowed: false,
      reasonCode: "portal_blocked_domain_not_validated",
      blockerCode: "domain_blocked",
      reason:
        "Portal domain is blocked for full-auto submissions unless a validated session is configured.",
    };
  }

  return { ...base, allowed: true };
}

export function classifyPortalUrlForSession(
  rawUrl: string,
): PortalSessionGate | null {
  const normalized = rawUrl.trim();
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const query = parsed.search.toLowerCase();

  if (
    host.endsWith("linkedin.com") &&
    (/(signup|login|uas\/login|checkpoint)\b/.test(path) ||
      path.includes("/signup/") ||
      path.includes("/login") ||
      query.includes("session_redirect="))
  ) {
    return {
      type: "needs_portal_session",
      provider: "linkedin",
      reason:
        "LinkedIn application URL is a login/sign-up wall; capture a portal session before autonomous submission.",
    };
  }

  if (
    /(^|\.)indeed\./.test(host) &&
    (/(account|auth|login|signin|signup|viewjob)\b/.test(path) ||
      query.includes("from=signin"))
  ) {
    return {
      type: "needs_portal_session",
      provider: "indeed",
      reason:
        "Indeed application flow appears to require an authenticated portal session.",
    };
  }

  if (/(login|signin|sign-in|signup|sign-up|register|account)\b/.test(path)) {
    return {
      type: "needs_portal_session",
      provider: "generic",
      reason:
        "Portal URL is an authentication or account wall; human portal session is required before autonomous submission.",
    };
  }

  return null;
}

export function classifyPortalPageTextForSession(input: {
  url: string;
  text: string;
  hasPasswordField?: boolean;
  hasApplicationFormSignal?: boolean;
}): PortalSessionGate | null {
  const urlGate = classifyPortalUrlForSession(input.url);
  if (urlGate) return urlGate;

  const text = normalizePageText(input.text);
  const hasAuthLanguage =
    /\b(sign in|log in|login|create account|join now|register|sign up|continue with google|continue with linkedin)\b/.test(
      text,
    );
  const hasApplicationLanguage =
    /\b(resume|cv|cover letter|work authorization|application questions|submit application)\b/.test(
      text,
    );

  if (
    (input.hasPasswordField &&
      hasAuthLanguage &&
      !input.hasApplicationFormSignal) ||
    (hasAuthLanguage &&
      !hasApplicationLanguage &&
      /\b(apply|application)\b/.test(text))
  ) {
    return {
      type: "needs_portal_session",
      provider: hostnameOf(input.url).includes("linkedin")
        ? "linkedin"
        : hostnameOf(input.url).includes("indeed")
          ? "indeed"
          : "generic",
      reason:
        "Portal page is showing sign-in/sign-up controls instead of an application form.",
    };
  }

  return null;
}

export type PortalHtmlInspection = {
  gate: PortalSessionGate | null;
  captchaRequired: boolean;
  hasApplicationFormSignal: boolean;
  hasSuccessSignal: boolean;
  hasBlockingErrorSignal: boolean;
  requiredIssueCount: number;
};

export function inspectPortalHtmlForAutoApply(
  html: string,
  url = "https://example.test/apply",
): PortalHtmlInspection {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = stripped.replace(/<[^>]+>/g, " ");
  const lowered = normalizePageText(text);
  const hasPasswordField = /<input\b[^>]*type=["']?password/i.test(html);
  const hasApplicationFormSignal =
    /<input\b[^>]*type=["']?file/i.test(html) ||
    /\b(resume|cv|cover letter|phone|email|submit application)\b/i.test(text);
  const requiredIssueCount = (
    html.match(/\brequired\b|aria-required=["']?true/gi) ?? []
  ).length;

  return {
    gate: classifyPortalPageTextForSession({
      url,
      text,
      hasPasswordField,
      hasApplicationFormSignal,
    }),
    captchaRequired:
      /\b(captcha|recaptcha|hcaptcha|turnstile|cloudflare challenge)\b/i.test(
        `${html}\n${text}`,
      ),
    hasApplicationFormSignal,
    hasSuccessSignal:
      /\b(application submitted|application received|thank you for applying|we received your application|your application has been sent)\b/i.test(
        lowered,
      ),
    hasBlockingErrorSignal:
      /\b(required|invalid|please complete|please fill|missing|captcha|verification required)\b/i.test(
        lowered,
      ),
    requiredIssueCount,
  };
}

function normalizeSnapshotText(snapshot: PortalReadinessSnapshot): string {
  return `${snapshot.title ?? ""}\n${snapshot.text ?? ""}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function snapshotHasRequiredOrInvalidFields(
  snapshot: PortalReadinessSnapshot,
): boolean {
  return (snapshot.fields ?? []).some((field) => {
    if (field.visible === false) return false;
    const type = field.type?.toLowerCase() ?? "text";
    if (["hidden", "button", "submit", "reset", "file"].includes(type)) {
      return false;
    }
    const value = field.value?.trim() ?? "";
    return (
      field.ariaInvalid?.toLowerCase() === "true" ||
      Boolean(field.validationMessage?.trim()) ||
      (Boolean(field.required) && !value)
    );
  });
}

export function detectPortalBlockerFromSnapshot(
  snapshot: PortalReadinessSnapshot,
  options: { includeRequiredFields?: boolean } = {},
): PortalBlocker | null {
  const text = normalizeSnapshotText(snapshot);
  if (
    /(sign in|log in|login|create an account|sign up|join now|authentication required|session expired)/.test(
      text,
    ) &&
    /(apply|application|continue|submit|job)/.test(text)
  ) {
    return {
      code: "login_wall",
      reason: "Portal requires login/sign-up before application submission.",
    };
  }

  if (
    /(cloudflare|checking if the site connection is secure|verify you are human|security check|challenge page|captcha|recaptcha|hcaptcha|turnstile)/.test(
      text,
    )
  ) {
    return {
      code: "captcha_challenge",
      reason: "Portal shows a CAPTCHA/challenge that requires manual review.",
    };
  }

  if (
    options.includeRequiredFields &&
    (snapshotHasRequiredOrInvalidFields(snapshot) ||
      /(required field|required fields|please complete|required|invalid|missing required)/.test(
        text,
      ))
  ) {
    return {
      code: "required_or_invalid_fields",
      reason:
        "Portal has required/invalid fields that full-auto could not safely complete.",
    };
  }

  return null;
}

async function detectPortalBlocker(
  page: Page,
  options: { includeRequiredFields?: boolean } = {},
): Promise<PortalBlocker | null> {
  return detectPortalBlockerFromSnapshot(
    await page.evaluate<PortalReadinessSnapshot>(`(() => ({
      title: document.title || "",
      text: document.body && document.body.innerText || "",
      fields: Array.from(document.querySelectorAll('input, textarea, select'))
        .slice(0, 250)
        .map((el) => {
          const input = el;
          const style = window.getComputedStyle(input);
          return {
            required: Boolean(input.required || input.getAttribute('aria-required') === 'true'),
            value: input.value || "",
            type: input.getAttribute('type') || input.tagName.toLowerCase(),
            name: input.getAttribute('name') || input.getAttribute('id') || "",
            visible: Boolean(input.offsetParent || input.getClientRects().length) && style.visibility !== 'hidden' && style.display !== 'none',
            ariaInvalid: input.getAttribute('aria-invalid') || "",
            validationMessage: input.validationMessage || "",
          };
        }),
    }))()`),
    options,
  );
}

type RequiredFieldIssue = {
  kind: "missing_required" | "invalid" | "required_file" | "required_choice";
};

async function inspectRequiredFieldIssues(
  page: Page,
): Promise<RequiredFieldIssue[]> {
  return await page
    .evaluate<RequiredFieldIssue[]>(
      `(() => {
        function isVisible(el) {
          const style = window.getComputedStyle(el);
          if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        function isRequired(el) {
          return el.required || el.getAttribute('aria-required') === 'true' || el.dataset.required === 'true';
        }
        const issues = [];
        const fields = Array.from(document.querySelectorAll('input, textarea, select'));
        const checkedRadioNames = new Set(
          Array.from(document.querySelectorAll('input[type="radio"]:checked')).map((el) => el.name).filter(Boolean)
        );
        for (const el of fields) {
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (el.disabled || type === 'hidden' || type === 'button' || type === 'submit' || type === 'reset') continue;
          if (!isVisible(el)) continue;
          if (isRequired(el)) {
            if (type === 'file') {
              if (!el.files || el.files.length === 0) issues.push({ kind: 'required_file' });
              continue;
            }
            if (type === 'checkbox') {
              if (!el.checked) issues.push({ kind: 'required_choice' });
              continue;
            }
            if (type === 'radio') {
              if (!el.name || !checkedRadioNames.has(el.name)) issues.push({ kind: 'required_choice' });
              continue;
            }
            if (tag === 'select') {
              if (!String(el.value || '').trim()) issues.push({ kind: 'missing_required' });
              continue;
            }
            if (!String(el.value || '').trim()) issues.push({ kind: 'missing_required' });
          }
          if (typeof el.checkValidity === 'function' && !el.checkValidity()) {
            issues.push({ kind: 'invalid' });
          }
        }
        return issues;
      })()`,
    )
    .catch(() => []);
}

function summarizeRequiredIssues(issues: RequiredFieldIssue[]): string {
  const requiredFiles = issues.filter(
    (issue) => issue.kind === "required_file",
  ).length;
  const invalid = issues.filter((issue) => issue.kind === "invalid").length;
  const choices = issues.filter(
    (issue) => issue.kind === "required_choice",
  ).length;
  const missing = issues.length - requiredFiles - invalid - choices;
  const parts = [];
  if (missing > 0) parts.push(`${missing} missing required field(s)`);
  if (requiredFiles > 0)
    parts.push(`${requiredFiles} missing required file upload(s)`);
  if (choices > 0) parts.push(`${choices} missing required choice(s)`);
  if (invalid > 0) parts.push(`${invalid} invalid field(s)`);
  return `Portal pre-submit validation failed: ${parts.join(", ")}.`;
}

function getApplicationUrl(job: Job): string {
  const url = resolveHttpApplicationUrl(job);
  if (!url) {
    throw badRequest(
      "Full-auto browser apply requires an http(s) application URL.",
    );
  }
  return url;
}

function splitName(profile: ResumeProfile | null): {
  first: string;
  last: string;
  full: string;
} {
  const full = cleanString(profile?.basics?.name) ?? "";
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    first: parts[0] ?? "",
    last: parts.length > 1 ? parts.slice(1).join(" ") : "",
    full,
  };
}

function profileString(
  profile: ResumeProfile | null,
  key: keyof NonNullable<ResumeProfile["basics"]>,
): string {
  const value = profile?.basics?.[key];
  return typeof value === "string" ? (cleanString(value) ?? "") : "";
}

function profileLocation(profile: ResumeProfile | null): string {
  const location = profile?.basics?.location;
  if (!location) return "";
  return [
    location.address,
    location.city,
    location.region,
    location.countryCode,
  ]
    .map((value) => cleanString(value))
    .filter(Boolean)
    .join(", ");
}

function buildCoverLetter(job: Job, profile: ResumeProfile | null): string {
  const name = splitName(profile).full || "Candidate";
  const headline =
    cleanString(job.tailoredHeadline) ??
    cleanString(profile?.basics?.headline) ??
    cleanString(profile?.basics?.label);
  const summary =
    cleanString(job.tailoredSummary) ?? cleanString(profile?.basics?.summary);
  return [
    `Hello ${job.employer} team,`,
    "",
    `I am applying for the ${job.title} role.`,
    headline ? `\n${headline}` : null,
    summary
      ? `\n${summary
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()}`
      : null,
    "",
    "I have attached my tailored resume for your review.",
    "",
    "Best regards,",
    name,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function installStealth(page: Page): Promise<void> {
  await page.addInitScript({
    content: `(() => {
      Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } });
      Object.defineProperty(navigator, "plugins", { get: function () { return [1, 2, 3, 4, 5]; } });
      Object.defineProperty(navigator, "languages", {
        get: function () { return ["en-US", "en"]; },
      });
      var originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = function (parameters) {
          return parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery.call(window.navigator.permissions, parameters);
        };
      }
    })();`,
  });
}

async function fillVisibleLocator(
  locator: Locator,
  value: string,
): Promise<boolean> {
  if (!value) return false;
  try {
    if ((await locator.count()) === 0) return false;
    const target = locator.first();
    if (!(await target.isVisible({ timeout: 500 }).catch(() => false)))
      return false;
    const existing = await target.inputValue({ timeout: 500 }).catch(() => "");
    if (existing.trim()) return false;
    await target.fill(value, { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function fillBySelectors(
  page: Page,
  selectors: string[],
  value: string,
): Promise<boolean> {
  for (const selector of selectors) {
    if (await fillVisibleLocator(page.locator(selector), value)) return true;
  }
  return false;
}

async function fillApplicationForm(
  page: Page,
  job: Job,
  profile: ResumeProfile | null,
): Promise<number> {
  const name = splitName(profile);
  const email = profileString(profile, "email");
  const phone = profileString(profile, "phone");
  const website = profileString(profile, "url");
  const location = profileLocation(profile);
  const coverLetter = buildCoverLetter(job, profile);

  let fieldsFilled = 0;
  const fill = async (selectors: string[], value: string) => {
    if (await fillBySelectors(page, selectors, value)) fieldsFilled += 1;
  };

  await fill(
    [
      'input[name*="first" i]',
      'input[id*="first" i]',
      'input[placeholder*="first" i]',
      'input[aria-label*="first" i]',
    ],
    name.first,
  );
  await fill(
    [
      'input[name*="last" i]',
      'input[id*="last" i]',
      'input[placeholder*="last" i]',
      'input[aria-label*="last" i]',
    ],
    name.last,
  );
  await fill(
    [
      'input[name*="full" i][name*="name" i]',
      'input[id*="full" i][id*="name" i]',
      'input[name="name" i]',
      'input[id="name" i]',
      'input[placeholder*="full name" i]',
      'input[aria-label*="full name" i]',
    ],
    name.full,
  );
  await fill(
    [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
    ],
    email,
  );
  await fill(
    [
      'input[type="tel"]',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[name*="mobile" i]',
      'input[placeholder*="phone" i]',
    ],
    phone,
  );
  await fill(
    [
      'input[name*="linkedin" i]',
      'input[id*="linkedin" i]',
      'input[placeholder*="linkedin" i]',
      'input[name*="website" i]',
      'input[id*="website" i]',
      'input[type="url"]',
    ],
    website,
  );
  await fill(
    [
      'input[name*="location" i]',
      'input[id*="location" i]',
      'input[placeholder*="location" i]',
      'input[name*="city" i]',
      'input[id*="city" i]',
    ],
    location,
  );
  await fill(
    [
      'textarea[name*="cover" i]',
      'textarea[id*="cover" i]',
      'textarea[placeholder*="cover" i]',
      'textarea[name*="message" i]',
      'textarea[id*="message" i]',
    ],
    coverLetter,
  );

  // Consent checkboxes are only touched in explicit full-auto mode.
  const consentBoxes = page.locator(
    'label:has-text("agree") input[type="checkbox"], label:has-text("consent") input[type="checkbox"], label:has-text("privacy") input[type="checkbox"], label:has-text("terms") input[type="checkbox"], input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][name*="consent" i], input[type="checkbox"][id*="consent" i]',
  );
  const consentCount = Math.min(await consentBoxes.count().catch(() => 0), 5);
  for (let index = 0; index < consentCount; index += 1) {
    const checkbox = consentBoxes.nth(index);
    if (await checkbox.isVisible().catch(() => false)) {
      await checkbox.check({ timeout: 1_000 }).catch(() => undefined);
    }
  }

  return fieldsFilled;
}

async function uploadResume(page: Page, job: Job): Promise<boolean> {
  const pdfPath = getPdfPath(job.id);
  if (!job.pdfPath || !existsSync(pdfPath)) return false;
  const inputs = page.locator('input[type="file"]');
  const count = Math.min(await inputs.count().catch(() => 0), 5);
  let uploaded = false;
  for (let index = 0; index < count; index += 1) {
    try {
      await inputs.nth(index).setInputFiles(pdfPath, { timeout: 5_000 });
      uploaded = true;
    } catch {
      // Keep trying other file inputs.
    }
  }
  return uploaded;
}

async function detectCaptcha(page: Page): Promise<CaptchaDetection> {
  return await page.evaluate<CaptchaDetection>(`(() => {
    function getSitekey(selector) {
      var element = document.querySelector(selector);
      return (element && element.dataset && element.dataset.sitekey && element.dataset.sitekey.trim()) || "";
    }
    var pageUrl = window.location.href;
    var turnstile = document.querySelector(
      ".cf-turnstile,[name='cf-turnstile-response'],[data-sitekey][data-action]"
    );
    if (turnstile && turnstile.dataset && turnstile.dataset.sitekey && turnstile.dataset.sitekey.trim()) {
      var turnstileKey = turnstile.dataset.sitekey.trim();
      return {
        type: "turnstile",
        sitekey: turnstileKey,
        pageUrl: pageUrl,
        action: (turnstile.dataset.action && turnstile.dataset.action.trim()) || undefined,
        cData:
          (turnstile.dataset.cdata && turnstile.dataset.cdata.trim()) ||
          (turnstile.getAttribute("data-cData") && turnstile.getAttribute("data-cData").trim()) ||
          undefined,
      };
    }
    var hcaptchaElement = document.querySelector("[data-hcaptcha-sitekey]");
    var hcaptchaKey =
      getSitekey(".h-captcha,[data-hcaptcha-sitekey]") ||
      (hcaptchaElement && hcaptchaElement.dataset && hcaptchaElement.dataset.hcaptchaSitekey && hcaptchaElement.dataset.hcaptchaSitekey.trim());
    if (hcaptchaKey) return { type: "hcaptcha", sitekey: hcaptchaKey, pageUrl: pageUrl };
    var recaptcha = document.querySelector(
      ".g-recaptcha,[name='g-recaptcha-response'],[data-sitekey]"
    );
    if (recaptcha && recaptcha.dataset && recaptcha.dataset.sitekey && recaptcha.dataset.sitekey.trim()) {
      var recaptchaKey = recaptcha.dataset.sitekey.trim();
      return {
        type: "recaptcha-v2",
        sitekey: recaptchaKey,
        pageUrl: pageUrl,
        invisible: recaptcha.dataset.size === "invisible",
      };
    }
    var bodyText = (document.body && document.body.innerText || "").toLowerCase();
    var titleText = (document.title || "").toLowerCase();
    if (
      document.querySelector(
        'img[src*="captcha" i], img[alt*="captcha" i], input[name*="captcha" i]'
      )
    ) {
      return { type: "image", pageUrl: pageUrl };
    }
    if (
      titleText.includes("just a moment") ||
      bodyText.includes("performing security verification") ||
      bodyText.includes("verify you are not a bot") ||
      bodyText.includes("cloudflare") && bodyText.includes("ray id")
    ) {
      return { type: "cloudflare", pageUrl: pageUrl };
    }
    return { type: null, pageUrl: pageUrl };
  })()`);
}

function captchaTaskFor(
  detection: Exclude<CaptchaDetection, { type: null }>,
  imageBody?: string,
): Record<string, unknown> {
  switch (detection.type) {
    case "recaptcha-v2":
      return {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: detection.pageUrl,
        websiteKey: detection.sitekey,
        isInvisible: Boolean(detection.invisible),
      };
    case "hcaptcha":
      return {
        type: "HCaptchaTaskProxyless",
        websiteURL: detection.pageUrl,
        websiteKey: detection.sitekey,
      };
    case "turnstile":
      return {
        type: "TurnstileTaskProxyless",
        websiteURL: detection.pageUrl,
        websiteKey: detection.sitekey,
        ...(detection.action ? { action: detection.action } : {}),
        ...(detection.cData ? { data: detection.cData } : {}),
      };
    case "image":
      return { type: "ImageToTextTask", body: imageBody ?? "" };
    case "cloudflare":
      throw new Error(
        "Cloudflare managed challenge cannot be solved without a Turnstile sitekey.",
      );
  }
}

async function create2CaptchaTask(
  apiKey: string,
  task: Record<string, unknown>,
): Promise<number> {
  const response = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });
  const body = (await response.json()) as TwoCaptchaCreateTaskResponse;
  if (!response.ok || body.errorId !== 0 || !body.taskId) {
    throw new Error(
      body.errorDescription ||
        body.errorCode ||
        "2Captcha task creation failed",
    );
  }
  return body.taskId;
}

async function poll2Captcha(
  apiKey: string,
  taskId: number,
  timeoutMs: number,
  page: Page,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(5_000);
    const response = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const body = (await response.json()) as TwoCaptchaTaskResultResponse;
    if (!response.ok || body.errorId !== 0) {
      throw new Error(
        body.errorDescription || body.errorCode || "2Captcha task failed",
      );
    }
    const token = body.solution?.token ?? body.solution?.text;
    if (body.status === "ready" && token) return token;
  }
  throw new Error("2Captcha solve timed out");
}

async function screenshotImageCaptcha(page: Page): Promise<string | null> {
  const image = page
    .locator('img[src*="captcha" i], img[alt*="captcha" i]')
    .first();
  if (!(await image.isVisible({ timeout: 1_000 }).catch(() => false)))
    return null;
  const buffer = await image.screenshot({ timeout: 5_000 }).catch(() => null);
  return buffer ? buffer.toString("base64") : null;
}

async function injectCaptchaSolution(
  page: Page,
  detection: CaptchaDetection,
  solution: string,
): Promise<void> {
  const payload = JSON.stringify({ type: detection.type, token: solution });
  await page.evaluate(`(() => {
    var payload = ${payload};
    var type = payload.type;
    var token = payload.token;
    if (type === "image") {
      var input = document.querySelector('input[name*="captcha" i], input[id*="captcha" i]');
      if (input) {
        input.value = token;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    var names = [
      "g-recaptcha-response",
      "h-captcha-response",
      "cf-turnstile-response",
    ];
    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      var textarea = document.querySelector('textarea[name="' + name + '"]');
      if (!textarea) {
        textarea = document.createElement("textarea");
        textarea.name = name;
        textarea.style.display = "none";
        document.body.appendChild(textarea);
      }
      textarea.value = token;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }

    var callbackElement = document.querySelector("[data-callback]");
    var callbackName = callbackElement && callbackElement.dataset && callbackElement.dataset.callback && callbackElement.dataset.callback.trim();
    var callback = undefined;
    if (callbackName) {
      var target = window;
      var parts = callbackName.split(".");
      for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
        if (!target || typeof target !== "object") {
          target = undefined;
          break;
        }
        target = target[parts[partIndex]];
      }
      callback = target;
    }
    if (typeof callback === "function") callback(token);

    var cfg = window.___grecaptcha_cfg;
    var grecaptchaClients = cfg && cfg.clients;
    if (grecaptchaClients) {
      var clients = Object.values(grecaptchaClients);
      for (var clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {
        var values = Object.values(clients[clientIndex] || {});
        for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
          var maybe = values[valueIndex];
          if (maybe && typeof maybe.callback === "function") maybe.callback(token);
        }
      }
    }
  })()`);
}

async function solveCaptchaIfPresent(
  page: Page,
  allowCaptcha: boolean,
): Promise<CaptchaSolveOutcome> {
  const detection = await detectCaptcha(page);
  if (!detection.type) {
    return { attempted: false, solved: false, type: null, provider: null };
  }
  if (!allowCaptcha) {
    return {
      attempted: false,
      solved: false,
      type: detection.type,
      provider: null,
      message: "CAPTCHA detected but full-auto CAPTCHA solving is disabled.",
    };
  }

  if (detection.type === "cloudflare") {
    return {
      attempted: false,
      solved: false,
      type: detection.type,
      provider: null,
      message:
        "Cloudflare managed challenge/security verification detected; no usable ATS form is reachable yet.",
    };
  }

  const paidSolver = await getPaidChallengeSolverOptions();
  if (!paidSolver) {
    return {
      attempted: false,
      solved: false,
      type: detection.type,
      provider: null,
      message:
        "CAPTCHA detected but CAPTCHA_SOLVER_PROVIDER=2captcha, CAPTCHA_SOLVER_AUTO_SOLVE_ENABLED=1, and CAPTCHA_SOLVER_API_KEY are required.",
    };
  }

  try {
    const imageBody =
      detection.type === "image"
        ? await screenshotImageCaptcha(page)
        : undefined;
    if (detection.type === "image" && !imageBody) {
      return {
        attempted: true,
        solved: false,
        type: detection.type,
        provider: paidSolver.provider,
        message: "Image CAPTCHA was detected but could not be screenshot.",
      };
    }
    const taskId = await create2CaptchaTask(
      paidSolver.apiKey,
      captchaTaskFor(detection, imageBody ?? undefined),
    );
    const token = await poll2Captcha(
      paidSolver.apiKey,
      taskId,
      getCaptchaTimeoutMs(),
      page,
    );
    await injectCaptchaSolution(page, detection, token);
    return {
      attempted: true,
      solved: true,
      type: detection.type,
      provider: paidSolver.provider,
    };
  } catch (error) {
    return {
      attempted: true,
      solved: false,
      type: detection.type,
      provider: paidSolver.provider,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function humanClick(locator: Locator): Promise<boolean> {
  try {
    const target = locator.first();
    if ((await target.count().catch(() => 0)) === 0) return false;
    if (!(await target.isVisible({ timeout: 1_000 }).catch(() => false)))
      return false;
    const box = await target.boundingBox({ timeout: 1_000 }).catch(() => null);
    if (!box) {
      await target.click({ timeout: 2_000 });
      return true;
    }
    const page = target.page();
    const x = box.x + Math.max(4, box.width * (0.35 + Math.random() * 0.3));
    const y = box.y + Math.max(4, box.height * (0.35 + Math.random() * 0.3));
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.click(x, y, {
      delay: 80 + Math.floor(Math.random() * 120),
    });
    return true;
  } catch {
    return false;
  }
}

type ClickOutcome = { clicked: boolean; page: Page };

async function dismissCookieOverlays(page: Page): Promise<void> {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Allow all")',
    '[role="button"]:has-text("Accept")',
    '[aria-label*="accept" i]',
    "#onetrust-accept-btn-handler",
    ".cc-allow",
    ".cookie-accept",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible({ timeout: 500 }).catch(() => false)))
      continue;
    await locator.click({ timeout: 1_500 }).catch(() => undefined);
    await page.waitForTimeout(250).catch(() => undefined);
    return;
  }
}

async function clickAndFollow(locator: Locator): Promise<ClickOutcome | null> {
  const target = locator.first();
  if ((await target.count().catch(() => 0)) === 0) return null;
  if (await target.isDisabled().catch(() => false)) return null;
  const ariaDisabled = await target
    .getAttribute("aria-disabled")
    .catch(() => null);
  if (ariaDisabled?.toLowerCase() === "true") return null;
  const currentPage = target.page();
  const popupPromise = currentPage
    .waitForEvent("popup", { timeout: 7_500 })
    .catch(() => null);
  const clicked = await humanClick(target);
  if (!clicked) return null;
  const popup = await popupPromise;
  const nextPage = popup ?? currentPage;
  await nextPage
    .waitForLoadState("domcontentloaded", { timeout: 20_000 })
    .catch(() => undefined);
  await nextPage
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await dismissCookieOverlays(nextPage).catch(() => undefined);
  return { clicked: true, page: nextPage };
}

async function clickFirstMatching(
  page: Page,
  selectors: string[],
): Promise<ClickOutcome | null> {
  await dismissCookieOverlays(page).catch(() => undefined);
  for (const selector of selectors) {
    const count = Math.min(
      await page
        .locator(selector)
        .count()
        .catch(() => 0),
      8,
    );
    for (let index = 0; index < count; index += 1) {
      const outcome = await clickAndFollow(page.locator(selector).nth(index));
      if (outcome) return outcome;
    }
  }
  return null;
}

async function hasApplicationFormSignal(page: Page): Promise<boolean> {
  return await page
    .evaluate<boolean>(
      `(() => {
      var fields = document.querySelectorAll(
        'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select'
      ).length;
      var upload = document.querySelectorAll('input[type=file]').length;
      var text = (document.body && document.body.innerText || '').toLowerCase();
      return upload > 0 || fields >= 3 ||
        (fields > 0 && /resume|cv|cover letter|phone|email/.test(text));
    })()`,
    )
    .catch(() => false);
}

const initialApplySelectors = [
  'a[target="_blank"]:has-text("Apply")',
  'a:has-text("Easy Apply")',
  'button:has-text("Easy Apply")',
  '[role="button"]:has-text("Easy Apply")',
  '[role="link"]:has-text("Easy Apply")',
  'a:has-text("Apply now")',
  'button:has-text("Apply now")',
  '[role="button"]:has-text("Apply now")',
  '[role="link"]:has-text("Apply now")',
  'a:has-text("Apply to this job")',
  'button:has-text("Apply to this job")',
  'a:has-text("Apply on website")',
  'button:has-text("Apply on website")',
  'a:has-text("Apply on company site")',
  'button:has-text("Apply on company site")',
  'a:has-text("Apply for this job")',
  'button:has-text("Apply for this job")',
  'a:has-text("Start application")',
  'button:has-text("Start application")',
  'a:has-text("Continue application")',
  'button:has-text("Continue application")',
  'a:has-text("Apply")',
  'button:has-text("Apply")',
  '[role="button"]:has-text("Apply")',
  '[role="link"]:has-text("Apply")',
  '[data-control-name*="jobdetails_topcard" i]',
  '[data-testid*="apply" i]',
  '[data-qa*="apply" i]',
  '[aria-label*="Apply" i]',
  'a[href*="/apply" i]',
];

async function findExternalApplyUrl(page: Page): Promise<string | null> {
  return await page
    .evaluate<string | null>(
      String.raw`(() => {
      var currentHost = window.location.hostname.replace(/^www\./, '');
      var ats = /greenhouse|lever\.co|workday|ashbyhq|bamboohr|jobvite|smartrecruiters|icims|recruitee|personio|teamtailor|pinpointhq|comeet|workable|applytojob|myworkdayjobs/i;
      var applyText = /apply|apply now|apply to this job|apply on website|start application|continue application/i;
      var links = Array.prototype.slice.call(document.querySelectorAll('a[href], [role="link"][href]'));
      for (var i = 0; i < links.length; i += 1) {
        var link = links[i];
        var href = link.href || '';
        if (!/^https?:/i.test(href)) continue;
        var text = ((link.innerText || link.getAttribute('aria-label') || link.getAttribute('title') || '') + ' ' + href).trim();
        var host = '';
        try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (error) {}
        if (!ats.test(href) && !applyText.test(text)) continue;
        if (host === currentHost && !ats.test(href)) continue;
        if (/login|privacy|terms|mailto:|share|linkedin\.com\/company/i.test(href)) continue;
        return href;
      }
      var forms = Array.prototype.slice.call(document.querySelectorAll('form[action]'));
      for (var j = 0; j < forms.length; j += 1) {
        var action = forms[j].action || '';
        if (/^https?:/i.test(action) && ats.test(action)) return action;
      }
      return null;
    })()`,
    )
    .catch(() => null);
}

async function openInitialApplyFlow(page: Page): Promise<Page> {
  let currentPage = page;
  for (let step = 0; step < 3; step += 1) {
    await dismissCookieOverlays(currentPage).catch(() => undefined);
    if (await hasApplicationFormSignal(currentPage)) return currentPage;
    const externalUrl = await findExternalApplyUrl(currentPage);
    if (externalUrl) {
      await currentPage.goto(externalUrl, {
        waitUntil: "domcontentloaded",
        timeout: getBrowserTimeoutMs(),
      });
      await currentPage
        .waitForLoadState("networkidle", { timeout: 10_000 })
        .catch(() => undefined);
      continue;
    }
    const outcome = await clickFirstMatching(
      currentPage,
      initialApplySelectors,
    );
    if (!outcome) return currentPage;
    currentPage = outcome.page;
  }
  return currentPage;
}

async function clickSubmit(page: Page): Promise<ClickOutcome> {
  let currentPage = page;
  let clickedAny = false;
  const finalSelectors = [
    'button[type="submit"]:has-text("Submit")',
    'button[type="submit"]:has-text("Send")',
    'button[type="submit"]:has-text("Apply")',
    'input[type="submit"]',
    'input[value*="Submit" i]',
    'input[value*="Send" i]',
    'input[value*="Apply" i]',
    'button:has-text("Submit application")',
    'button:has-text("Submit Application")',
    'button:has-text("Submit your application")',
    'button:has-text("Send application")',
    'button:has-text("Send Application")',
    'button:has-text("Apply for this job")',
    'button:has-text("Apply now")',
    'button:has-text("Review and submit")',
    '[role="button"]:has-text("Submit application")',
    '[role="button"]:has-text("Submit")',
    '[role="button"]:has-text("Send application")',
    '[role="button"]:has-text("Send")',
    '[data-qa*="submit" i]',
    '[data-testid*="submit" i]',
    '[aria-label*="submit" i]',
    'button[type="submit"]',
  ];
  const progressSelectors = [
    'button:has-text("Review")',
    '[role="button"]:has-text("Review")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Continue")',
    'a:has-text("Continue")',
    'button:has-text("Next")',
    '[role="button"]:has-text("Next")',
    'a:has-text("Next")',
    'button:has-text("Save and continue")',
    'button:has-text("Start application")',
  ];

  for (let step = 0; step < 6; step += 1) {
    await dismissCookieOverlays(currentPage).catch(() => undefined);
    const finalOutcome = await clickFirstMatching(currentPage, finalSelectors);
    if (finalOutcome) return finalOutcome;

    const progressOutcome = await clickFirstMatching(
      currentPage,
      progressSelectors,
    );
    if (!progressOutcome) break;
    clickedAny = true;
    currentPage = progressOutcome.page;
    await currentPage.waitForTimeout(800 + Math.floor(Math.random() * 700));
  }

  return { clicked: clickedAny, page: currentPage };
}

async function hasSuccessSignal(page: Page): Promise<boolean> {
  return await page
    .evaluate<boolean>(
      `(() => {
      var text = document.body.innerText.toLowerCase();
      var signals = [
        "application submitted",
        "application received",
        "thank you for applying",
        "thanks for applying",
        "your application has been submitted",
        "we received your application",
        "successfully submitted",
        "submitted successfully",
        "application sent",
        "application complete",
        "applied successfully",
        "we have received your application",
        "we'll be in touch",
      ];
      return signals.some(function (signal) { return text.includes(signal); });
    })()`,
    )
    .catch(() => false);
}

async function saveDebugScreenshot(
  page: Page,
  jobId: string,
): Promise<string | undefined> {
  try {
    const dir = join(getDataDir(), "browser-auto-apply");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${jobId}-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: true, timeout: 10_000 });
    return path;
  } catch {
    return undefined;
  }
}

export function isFullAutoEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    parseBoolean(env.JOBOPS_FULL_AUTO_APPLY_ENABLED) ||
    parseBoolean(env.JOBOPS_FULL_AUTO_ENABLED) ||
    parseBoolean(env.FULL_AUTO_ENABLED) ||
    parseBoolean(env.FULL_AUTO)
  );
}

export function isFullAutoBrowserSubmitEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isFullAutoEnabled(env)) return false;
  const explicit =
    env.JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED ??
    env.JOBOPS_FULL_AUTO_BROWSER_SUBMIT_ENABLED;
  if (explicit === undefined) return false;
  return parseBoolean(explicit);
}

export function isFullAutoCaptchaEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isFullAutoEnabled(env)) return false;
  const explicit =
    env.JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED ??
    env.JOBOPS_FULL_AUTO_CAPTCHA_ENABLED;
  if (explicit === undefined) return false;
  return parseBoolean(explicit);
}

export function isFullAutoBrowserDryRunEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBoolean(env.JOBOPS_FULL_AUTO_BROWSER_DRY_RUN);
}

function getBundledFirefoxExecutablePath(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
  try {
    const candidates = readdirSync(root)
      .filter((name) => name.startsWith("firefox-"))
      .sort()
      .reverse()
      .map((name) => join(root, name, "firefox", "firefox"));
    return candidates.find((candidate) => existsSync(candidate));
  } catch {
    return undefined;
  }
}

async function launchBrowser(): Promise<{
  browser: Browser;
  browserName: "chromium" | "firefox";
}> {
  const { chromium, firefox } = await import("playwright");
  const requested = (process.env.JOBOPS_FULL_AUTO_BROWSER ?? "chromium")
    .trim()
    .toLowerCase();
  const order: ("chromium" | "firefox")[] =
    requested === "firefox" ? ["firefox", "chromium"] : ["chromium", "firefox"];
  const headless = process.env.JOBOPS_FULL_AUTO_BROWSER_HEADLESS !== "0";
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];
  let lastError: unknown;

  for (const browserName of order) {
    try {
      const browserType = browserName === "chromium" ? chromium : firefox;
      const launchOptions = {
        headless,
        args,
        env:
          browserName === "firefox"
            ? {
                ...process.env,
                MOZ_DISABLE_CONTENT_SANDBOX: "1",
                MOZ_DISABLE_RDD_SANDBOX: "1",
                MOZ_DISABLE_GMP_SANDBOX: "1",
              }
            : process.env,
      };
      const browser = await browserType.launch(
        browserName === "firefox"
          ? {
              ...launchOptions,
              executablePath: getBundledFirefoxExecutablePath(),
            }
          : launchOptions,
      );
      logger.info("Full-auto browser launched", { browserName });
      return { browser, browserName };
    } catch (error) {
      lastError = error;
      logger.warn("Full-auto browser launch failed", {
        browserName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function submitPortalApplication(
  job: Job,
  options: BrowserAutoApplyOptions = {},
): Promise<BrowserAutoApplyResult> {
  if (job.status !== "ready") {
    throw badRequest("Only ready jobs can be full-auto submitted.");
  }
  if (
    job.pdfRegenerating ||
    job.pdfFreshness === "regenerating" ||
    job.pdfFreshness === "stale"
  ) {
    throw badRequest(
      "Full-auto browser apply needs a current generated or uploaded resume PDF.",
    );
  }
  if (!job.pdfPath || !existsSync(getPdfPath(job.id))) {
    throw badRequest(
      "Full-auto browser apply needs a resume PDF before submission.",
    );
  }
  const dryRun = options.dryRun || isFullAutoBrowserDryRunEnabled();
  if (!isFullAutoBrowserSubmitEnabled() && !dryRun) {
    throw serviceUnavailable(
      "Full-auto browser submission is disabled. Set JOBOPS_FULL_AUTO_APPLY_ENABLED=true and JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED=true to enable it.",
    );
  }

  const url = getApplicationUrl(job);
  const submitPolicy = evaluatePortalSubmitPolicy(job, url);
  const outcomeBase = {
    domain: submitPolicy.domain,
    source: submitPolicy.source,
    urlKind: submitPolicy.urlKind,
  };
  if (!submitPolicy.allowed && !dryRun) {
    const reasonCode =
      submitPolicy.reasonCode ??
      portalOutcomeReasonCodeForBlocker(submitPolicy.blockerCode);
    return {
      mode: "browser",
      status: "needs_review",
      url,
      finalUrl: url,
      submittedAt: null,
      fieldsFilled: 0,
      resumeUploaded: false,
      submitClicked: false,
      captcha: { attempted: false, solved: false, type: null, provider: null },
      reason:
        submitPolicy.reason ??
        "Portal domain/source is not authorized for full-auto submission.",
      reasonCode,
      reviewReason:
        submitPolicy.blockerCode === "session_required"
          ? "needs_portal_session"
          : undefined,
      outcomeMetadata: createPortalOutcomeMetadata({
        ...outcomeBase,
        reasonCode,
      }),
    };
  }
  const profile = await getProfile().catch((error) => {
    logger.warn("Full-auto browser apply could not load profile", {
      jobId: job.id,
      error,
    });
    return null;
  });
  const timeoutMs = getBrowserTimeoutMs();
  let browser: Browser | undefined;
  let browserName: "chromium" | "firefox" | undefined;
  let page: Page | undefined;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    browserName = launched.browserName;
    const storageState = getBrowserStorageStatePath();
    const context = await browser.newContext({
      ...(storageState ? { storageState } : {}),
      userAgent:
        process.env.JOBOPS_FULL_AUTO_BROWSER_USER_AGENT ||
        (browserName === "firefox"
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"),
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
      timezoneId:
        process.env.JOBOPS_FULL_AUTO_BROWSER_TIMEZONE || "Europe/London",
    });
    page = await context.newPage();
    await installStealth(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);
    page = await openInitialApplyFlow(page);
    await installStealth(page).catch(() => undefined);

    const preFillBlocker = await detectPortalBlocker(page);
    if (preFillBlocker) {
      const screenshotPath = await saveDebugScreenshot(page, job.id);
      return {
        mode: "browser",
        status: "needs_review",
        url,
        finalUrl: page.url(),
        submittedAt: null,
        fieldsFilled: 0,
        resumeUploaded: false,
        submitClicked: false,
        captcha: {
          attempted: false,
          solved: false,
          type: null,
          provider: null,
        },
        screenshotPath,
        reason: preFillBlocker.reason,
        reasonCode: portalOutcomeReasonCodeForBlocker(preFillBlocker.code),
        reviewReason:
          preFillBlocker.code === "login_wall"
            ? "needs_portal_session"
            : preFillBlocker.code === "captcha_challenge"
              ? "needs_captcha"
              : undefined,
        outcomeMetadata: createPortalOutcomeMetadata({
          ...outcomeBase,
          reasonCode: portalOutcomeReasonCodeForBlocker(preFillBlocker.code),
        }),
      };
    }

    const fieldsFilled = await fillApplicationForm(page, job, profile);
    await dismissCookieOverlays(page).catch(() => undefined);
    const resumeUploaded = await uploadResume(page, job);
    await page.waitForTimeout(500 + Math.floor(Math.random() * 750));

    const postFillBlocker = await detectPortalBlocker(page, {
      includeRequiredFields: true,
    });
    if (postFillBlocker) {
      const screenshotPath = await saveDebugScreenshot(page, job.id);
      return {
        mode: "browser",
        status: "needs_review",
        url,
        finalUrl: page.url(),
        submittedAt: null,
        fieldsFilled,
        resumeUploaded,
        submitClicked: false,
        captcha: {
          attempted: false,
          solved: false,
          type: null,
          provider: null,
        },
        screenshotPath,
        reason: postFillBlocker.reason,
        reasonCode: portalOutcomeReasonCodeForBlocker(postFillBlocker.code),
        reviewReason:
          postFillBlocker.code === "login_wall"
            ? "needs_portal_session"
            : postFillBlocker.code === "captcha_challenge"
              ? "needs_captcha"
              : postFillBlocker.code === "required_or_invalid_fields"
                ? "required_fields_missing"
                : undefined,
        outcomeMetadata: createPortalOutcomeMetadata({
          ...outcomeBase,
          reasonCode: portalOutcomeReasonCodeForBlocker(postFillBlocker.code),
        }),
      };
    }

    const captcha = await solveCaptchaIfPresent(
      page,
      Boolean(options.allowCaptcha),
    );
    if (captcha.type && !captcha.solved) {
      const screenshotPath = await saveDebugScreenshot(page, job.id);
      return {
        mode: "browser",
        status: "needs_review",
        url,
        finalUrl: page.url(),
        submittedAt: null,
        fieldsFilled,
        resumeUploaded,
        submitClicked: false,
        captcha,
        screenshotPath,
        reason: captcha.message ?? "CAPTCHA could not be solved automatically.",
        reasonCode: "portal_needs_review_captcha",
        reviewReason: "needs_captcha",
        outcomeMetadata: createPortalOutcomeMetadata({
          ...outcomeBase,
          reasonCode: "portal_needs_review_captcha",
          captcha,
        }),
      };
    }

    const requiredIssues = await inspectRequiredFieldIssues(page);
    if (requiredIssues.length > 0) {
      const screenshotPath = await saveDebugScreenshot(page, job.id);
      const hasRequiredFile = requiredIssues.some(
        (issue) => issue.kind === "required_file",
      );
      return {
        mode: "browser",
        status: "needs_review",
        url,
        finalUrl: page.url(),
        submittedAt: null,
        fieldsFilled,
        resumeUploaded,
        submitClicked: false,
        captcha,
        screenshotPath,
        reason: summarizeRequiredIssues(requiredIssues),
        reasonCode: hasRequiredFile
          ? "portal_needs_review_resume_upload_missing"
          : "portal_needs_review_required_fields",
        reviewReason: hasRequiredFile
          ? "resume_upload_missing"
          : "required_fields_missing",
        outcomeMetadata: createPortalOutcomeMetadata({
          ...outcomeBase,
          reasonCode: hasRequiredFile
            ? "portal_needs_review_resume_upload_missing"
            : "portal_needs_review_required_fields",
          captcha,
        }),
      };
    }

    if (dryRun) {
      const screenshotPath = await saveDebugScreenshot(page, job.id);
      return {
        mode: "browser",
        status: "needs_review",
        url,
        finalUrl: page.url(),
        submittedAt: null,
        fieldsFilled,
        resumeUploaded,
        submitClicked: false,
        captcha,
        screenshotPath,
        reason:
          "Dry-run pre-submit checks passed; final submit/apply click was intentionally skipped.",
        reasonCode: "portal_needs_review_pre_submit_dry_run",
        reviewReason: "pre_submit_dry_run",
        outcomeMetadata: createPortalOutcomeMetadata({
          ...outcomeBase,
          reasonCode: "portal_needs_review_pre_submit_dry_run",
          captcha,
        }),
      };
    }

    const submitOutcome = await clickSubmit(page);
    page = submitOutcome.page;
    const submitClicked = submitOutcome.clicked;
    await page
      .waitForLoadState("domcontentloaded", { timeout: 20_000 })
      .catch(() => undefined);
    await page.waitForTimeout(3_000);

    const success = await hasSuccessSignal(page);
    const postSubmitBlocker = await detectPortalBlocker(page, {
      includeRequiredFields: true,
    });
    if (submitClicked && success) {
      return {
        mode: "browser",
        status: "submitted",
        url,
        finalUrl: page.url(),
        submittedAt: new Date().toISOString(),
        fieldsFilled,
        resumeUploaded,
        submitClicked,
        captcha,
        reasonCode: "portal_submitted",
        outcomeMetadata: createPortalOutcomeMetadata({
          ...outcomeBase,
          reasonCode: "portal_submitted",
          liveSubmitAttempted: true,
          submitClicked,
          captcha,
        }),
      };
    }

    const screenshotPath = await saveDebugScreenshot(page, job.id);
    const finalReasonCode = submitClicked
      ? postSubmitBlocker
        ? portalOutcomeReasonCodeForBlocker(postSubmitBlocker.code)
        : "portal_needs_review_no_success_signal"
      : "portal_needs_review_no_submit_control";
    return {
      mode: "browser",
      status: "needs_review",
      url,
      finalUrl: page.url(),
      submittedAt: null,
      fieldsFilled,
      resumeUploaded,
      submitClicked,
      captcha,
      screenshotPath,
      reason: submitClicked
        ? postSubmitBlocker
          ? postSubmitBlocker.reason
          : "Portal did not show a success signal after submit."
        : "No usable submit/apply button was found.",
      reasonCode: finalReasonCode,
      reviewReason: submitClicked
        ? postSubmitBlocker
          ? "post_submit_blocking_error"
          : "no_success_signal"
        : "no_submit_button",
      outcomeMetadata: createPortalOutcomeMetadata({
        ...outcomeBase,
        reasonCode: finalReasonCode,
        liveSubmitAttempted: true,
        submitClicked,
        captcha,
      }),
    };
  } catch (error) {
    throw upstreamError("Full-auto browser application failed.", {
      jobId: job.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await browser?.close();
  }
}
