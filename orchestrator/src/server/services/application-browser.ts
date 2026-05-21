import { existsSync, readdirSync } from "node:fs";
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
      `(() => {
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

async function hasBlockingErrorSignal(page: Page): Promise<boolean> {
  return await page
    .evaluate<boolean>(
      `(() => {
      var text = document.body.innerText.toLowerCase();
      var signals = [
        "required",
        "invalid",
        "captcha",
        "verification failed",
        "please complete",
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
  let browser: Browser | undefined;
  let browserName: "chromium" | "firefox" | undefined;
  let page: Page | undefined;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    browserName = launched.browserName;
    const context = await browser.newContext({
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

    const fieldsFilled = await fillApplicationForm(page, job, profile);
    await dismissCookieOverlays(page).catch(() => undefined);
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

    const submitOutcome = await clickSubmit(page);
    page = submitOutcome.page;
    const submitClicked = submitOutcome.clicked;
    await page
      .waitForLoadState("domcontentloaded", { timeout: 20_000 })
      .catch(() => undefined);
    await page.waitForTimeout(3_000);

    const success = await hasSuccessSignal(page);
    const blockingError = await hasBlockingErrorSignal(page);
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
