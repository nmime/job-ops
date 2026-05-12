import type { Page } from "playwright";
import { isChallengePage } from "./challenge.js";

export type PaidCaptchaProvider = "2captcha";

export type PaidCaptchaResult =
  | { status: "solved" }
  | { status: "unavailable"; message: string }
  | { status: "timeout" }
  | { status: "error"; message: string };

export interface PaidCaptchaSolverOptions {
  provider: PaidCaptchaProvider;
  apiKey: string;
  pageUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface TurnstileChallengeData {
  sitekey: string;
  pageUrl: string;
  action?: string;
  cData?: string;
}

interface CreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
}

interface TaskResultResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: "processing" | "ready";
  solution?: { token?: string };
}

export async function solvePaidCaptcha(
  page: Page,
  options: PaidCaptchaSolverOptions,
): Promise<PaidCaptchaResult> {
  if (options.provider !== "2captcha") {
    return { status: "unavailable", message: "Unsupported CAPTCHA provider" };
  }

  const challenge = await extractTurnstileChallenge(page, options.pageUrl);
  if (!challenge) {
    return { status: "unavailable", message: "No Turnstile challenge found" };
  }

  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const startedAt = Date.now();

  try {
    const taskId = await create2CaptchaTask(options.apiKey, challenge);

    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(pollIntervalMs);
      const token = await get2CaptchaTaskToken(options.apiKey, taskId);
      if (!token) continue;

      await injectTurnstileToken(page, token);
      await page.waitForTimeout(3_000);

      if (!(await isChallengePage(page))) {
        return { status: "solved" };
      }
    }

    return { status: "timeout" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function extractTurnstileChallenge(
  page: Page,
  pageUrl?: string,
): Promise<TurnstileChallengeData | null> {
  const domData = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      ".cf-turnstile,[data-sitekey]",
    );
    const sitekey = element?.dataset.sitekey?.trim();
    if (!element || !sitekey) return null;
    return {
      sitekey,
      pageUrl: window.location.href,
      action: element.dataset.action?.trim() || undefined,
      cData:
        element.dataset.cdata?.trim() ||
        element.getAttribute("data-cData")?.trim() ||
        undefined,
    };
  });

  if (domData) {
    return { ...domData, pageUrl: pageUrl || domData.pageUrl };
  }

  const html = await page.content();
  const sitekey =
    html.match(/data-sitekey=["']([^"']+)["']/i)?.[1]?.trim() ||
    html.match(/sitekey["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1]?.trim();

  return sitekey ? { sitekey, pageUrl: pageUrl || page.url() } : null;
}

async function create2CaptchaTask(
  apiKey: string,
  challenge: TurnstileChallengeData,
): Promise<number> {
  const task: Record<string, string> = {
    type: "TurnstileTaskProxyless",
    websiteURL: challenge.pageUrl,
    websiteKey: challenge.sitekey,
  };

  if (challenge.action) task.action = challenge.action;
  if (challenge.cData) task.data = challenge.cData;

  const response = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });
  const body = (await response.json()) as CreateTaskResponse;

  if (!response.ok || body.errorId !== 0 || !body.taskId) {
    throw new Error(body.errorDescription || body.errorCode || "2Captcha task creation failed");
  }

  return body.taskId;
}

async function get2CaptchaTaskToken(
  apiKey: string,
  taskId: number,
): Promise<string | null> {
  const response = await fetch("https://api.2captcha.com/getTaskResult", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, taskId }),
  });
  const body = (await response.json()) as TaskResultResponse;

  if (!response.ok || body.errorId !== 0) {
    throw new Error(body.errorDescription || body.errorCode || "2Captcha task failed");
  }

  return body.status === "ready" ? body.solution?.token || null : null;
}

async function injectTurnstileToken(page: Page, token: string): Promise<void> {
  await page.evaluate((captchaToken) => {
    for (const name of [
      "cf-turnstile-response",
      "g-recaptcha-response",
      "h-captcha-response",
    ]) {
      let textarea = document.querySelector<HTMLTextAreaElement>(
        `textarea[name="${name}"]`,
      );
      if (!textarea) {
        textarea = document.createElement("textarea");
        textarea.name = name;
        textarea.style.display = "none";
        document.body.appendChild(textarea);
      }
      textarea.value = captchaToken;
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

    if (typeof callback === "function") {
      callback(captchaToken);
      return;
    }

    const form = document.forms.length === 1 ? document.forms[0] : null;
    form?.requestSubmit();
  }, token);
}
