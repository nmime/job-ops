import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { badRequest, serviceUnavailable, upstreamError } from "@infra/errors";
import { logger } from "@infra/logger";
import { getDataDir } from "@server/config/dataDir";
import { getPaidChallengeSolverOptions } from "@server/services/captcha-solver";
import { getPdfPath } from "@server/services/pdf";
import { getProfile } from "@server/services/profile";
import type { Job, ResumeProfile } from "@shared/types";
import type { Locator, Page } from "playwright";

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
};

type BrowserAutoApplyOptions = {
  allowCaptcha?: boolean;
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

function getApplicationUrl(job: Job): string {
  const raw =
    cleanString(job.applicationLink) ??
    cleanString(job.jobUrlDirect) ??
    cleanString(job.jobUrl);
  if (!raw || !/^https?:\/\//i.test(raw)) {
    throw badRequest(
      "Full-auto browser apply requires an http(s) application URL.",
    );
  }
  return raw;
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
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({
              state: Notification.permission,
            } as PermissionStatus)
          : originalQuery.call(window.navigator.permissions, parameters);
    }
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
  return await page.evaluate(() => {
    const getSitekey = (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.dataset.sitekey?.trim() ||
      "";
    const pageUrl = window.location.href;
    const turnstile = document.querySelector<HTMLElement>(
      ".cf-turnstile,[name='cf-turnstile-response'],[data-sitekey][data-action]",
    );
    if (turnstile?.dataset.sitekey?.trim()) {
      const turnstileKey = turnstile.dataset.sitekey.trim();
      return {
        type: "turnstile" as const,
        sitekey: turnstileKey,
        pageUrl,
        action: turnstile.dataset.action?.trim() || undefined,
        cData:
          turnstile.dataset.cdata?.trim() ||
          turnstile.getAttribute("data-cData")?.trim() ||
          undefined,
      };
    }
    const hcaptchaKey =
      getSitekey(".h-captcha,[data-hcaptcha-sitekey]") ||
      document
        .querySelector<HTMLElement>("[data-hcaptcha-sitekey]")
        ?.dataset.hcaptchaSitekey?.trim();
    if (hcaptchaKey)
      return { type: "hcaptcha" as const, sitekey: hcaptchaKey, pageUrl };
    const recaptcha = document.querySelector<HTMLElement>(
      ".g-recaptcha,[name='g-recaptcha-response'],[data-sitekey]",
    );
    if (recaptcha?.dataset.sitekey?.trim()) {
      const recaptchaKey = recaptcha.dataset.sitekey.trim();
      return {
        type: "recaptcha-v2" as const,
        sitekey: recaptchaKey,
        pageUrl,
        invisible: recaptcha.dataset.size === "invisible",
      };
    }
    if (
      document.querySelector(
        'img[src*="captcha" i], img[alt*="captcha" i], input[name*="captcha" i]',
      )
    ) {
      return { type: "image" as const, pageUrl };
    }
    return { type: null, pageUrl };
  });
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
  await page.evaluate(
    ({ type, token }) => {
      if (type === "image") {
        const input = document.querySelector<HTMLInputElement>(
          'input[name*="captcha" i], input[id*="captcha" i]',
        );
        if (input) {
          input.value = token;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }

      const names = [
        "g-recaptcha-response",
        "h-captcha-response",
        "cf-turnstile-response",
      ];
      for (const name of names) {
        let textarea = document.querySelector<HTMLTextAreaElement>(
          `textarea[name="${name}"]`,
        );
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

      const callbackName = document
        .querySelector<HTMLElement>("[data-callback]")
        ?.dataset.callback?.trim();
      const callback = callbackName
        ?.split(".")
        .reduce<unknown>((target, key) => {
          return target && typeof target === "object"
            ? (target as Record<string, unknown>)[key]
            : undefined;
        }, window);
      if (typeof callback === "function") callback(token);

      const grecaptchaClients = (
        window as unknown as {
          ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
        }
      ).___grecaptcha_cfg?.clients;
      if (grecaptchaClients) {
        for (const client of Object.values(grecaptchaClients)) {
          for (const value of Object.values(
            client as Record<string, unknown>,
          )) {
            const maybe = value as { callback?: unknown };
            if (typeof maybe.callback === "function") maybe.callback(token);
          }
        }
      }
    },
    { type: detection.type, token: solution },
  );
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

async function clickSubmit(page: Page): Promise<boolean> {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'button:has-text("Send")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Submit")',
    '[role="button"]:has-text("Apply")',
  ];
  for (const selector of selectors) {
    if (await humanClick(page.locator(selector))) return true;
  }
  return false;
}

async function hasSuccessSignal(page: Page): Promise<boolean> {
  return await page
    .evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return [
        "application submitted",
        "application received",
        "thank you for applying",
        "thanks for applying",
        "your application has been submitted",
        "we received your application",
        "successfully submitted",
      ].some((signal) => text.includes(signal));
    })
    .catch(() => false);
}

async function hasBlockingErrorSignal(page: Page): Promise<boolean> {
  return await page
    .evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return [
        "required",
        "invalid",
        "captcha",
        "verification failed",
        "please complete",
      ].some((signal) => text.includes(signal));
    })
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
  if (explicit === undefined) return true;
  return parseBoolean(explicit);
}

export function isFullAutoCaptchaEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isFullAutoEnabled(env)) return false;
  const explicit =
    env.JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED ??
    env.JOBOPS_FULL_AUTO_CAPTCHA_ENABLED;
  if (explicit === undefined) return true;
  return parseBoolean(explicit);
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
  if (!isFullAutoBrowserSubmitEnabled()) {
    throw serviceUnavailable(
      "Full-auto browser submission is disabled. Set JOBOPS_FULL_AUTO_APPLY_ENABLED=true to enable it.",
    );
  }

  const url = getApplicationUrl(job);
  const profile = await getProfile().catch((error) => {
    logger.warn("Full-auto browser apply could not load profile", {
      jobId: job.id,
      error,
    });
    return null;
  });
  const timeoutMs = getBrowserTimeoutMs();
  let browser:
    | Awaited<ReturnType<typeof import("playwright")["firefox"]["launch"]>>
    | undefined;
  let page: Page | undefined;

  try {
    const { firefox } = await import("playwright");
    browser = await firefox.launch({
      headless: process.env.JOBOPS_FULL_AUTO_BROWSER_HEADLESS !== "0",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });
    const context = await browser.newContext({
      userAgent:
        process.env.JOBOPS_FULL_AUTO_BROWSER_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
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

    const fieldsFilled = await fillApplicationForm(page, job, profile);
    const resumeUploaded = await uploadResume(page, job);
    await page.waitForTimeout(500 + Math.floor(Math.random() * 750));
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
      };
    }

    const submitClicked = await clickSubmit(page);
    await page
      .waitForLoadState("domcontentloaded", { timeout: 20_000 })
      .catch(() => undefined);
    await page.waitForTimeout(3_000);

    const success = await hasSuccessSignal(page);
    const blockingError = await hasBlockingErrorSignal(page);
    if (submitClicked && (success || !blockingError)) {
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
      };
    }

    const screenshotPath = await saveDebugScreenshot(page, job.id);
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
        ? "Portal still showed required/invalid/CAPTCHA signals after submit."
        : "No usable submit/apply button was found.",
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
