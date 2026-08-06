import type { BrowserContext } from "playwright";
import {
  type PaidCaptchaSolverOptions,
  solvePaidCaptcha,
} from "./captcha-provider.js";
import { isChallengePage } from "./challenge.js";
import { readCookieJar, saveCookies } from "./cookies.js";
import { createLaunchOptions } from "./launch.js";

export type SolverResult =
  | { status: "solved"; cookiesSaved: number }
  | { status: "timeout" }
  | { status: "error"; message: string };

export interface ChallengeSolveOptions {
  paidCaptcha?: PaidCaptchaSolverOptions;
  headless?: boolean;
  manualFallback?: boolean;
}

function noReusableCookiesError(): SolverResult {
  return {
    status: "error",
    message:
      "Challenge appeared solved, but no reusable Cloudflare clearance cookie was saved.",
  };
}

async function saveReusableCookies(
  context: BrowserContext,
  extractorId: string,
  storageDir: string,
): Promise<number | null> {
  const cookiesSaved = await saveCookies(context, extractorId, storageDir);
  if (cookiesSaved === 0) return null;

  const jar = await readCookieJar(extractorId, storageDir);
  return jar.hasClearanceCookie ? cookiesSaved : null;
}

const SOLVED_PAGE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0a; color:#4ade80; font-family:system-ui,sans-serif; text-align:center; }
  h1 { font-size:2rem; font-weight:600; margin-bottom:0.5rem; }
  p { color:#a1a1aa; font-size:1.1rem; }
</style></head><body>
  <div><h1>Challenge solved</h1><p>You can close this tab and return to Job Ops.</p></div>
</body>
</html>`)}`;

/**
 * Opens a browser to solve a Cloudflare challenge.
 *
 * With options.headless=false (default), a visible browser opens for a human
 * to interact with. With options.paidCaptcha set, a paid CAPTCHA-solver
 * service (2Captcha, etc.) attempts the challenge headlessly first, falling
 * back to the manual browser flow unless options.manualFallback=false.
 *
 * The saved cookies (especially cf_clearance) allow subsequent headless runs
 * to skip the challenge until the cookie expires.
 *
 * @param url - The URL that triggered the challenge
 * @param extractorId - Used to namespace the saved cookies
 * @param storageDir - Where to save cookies (e.g. "./storage")
 * @param timeoutMs - Max time to wait (default 5 minutes)
 * @param options - Solver options (paid captcha, headless, manual fallback)
 */
export async function solveChallenge(
  url: string,
  extractorId: string,
  storageDir: string,
  timeoutMs = 5 * 60 * 1000,
  options: ChallengeSolveOptions = {},
): Promise<SolverResult> {
  let context: BrowserContext | undefined;
  let browser:
    | Awaited<ReturnType<typeof import("playwright").firefox.launch>>
    | undefined;

  try {
    const { firefox } = await import("playwright");
    const { launchOptions } = await createLaunchOptions({
      headless: options.headless ?? false,
    });
    browser = await firefox.launch(launchOptions);
    context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // If there's no challenge, we're done — save cookies anyway since the
    // browser session established a valid cf_clearance
    if (!(await isChallengePage(page))) {
      const cookiesSaved = await saveReusableCookies(
        context,
        extractorId,
        storageDir,
      );
      if (cookiesSaved === null) return noReusableCookiesError();
      if (!options.headless) await showSolvedPage(page);
      return { status: "solved", cookiesSaved };
    }

    // Attempt paid CAPTCHA solver first if configured.
    if (options.paidCaptcha) {
      const paidResult = await solvePaidCaptcha(page, {
        ...options.paidCaptcha,
        pageUrl: url,
        timeoutMs,
      });
      if (paidResult.status === "solved") {
        const cookiesSaved = await saveReusableCookies(
          context,
          extractorId,
          storageDir,
        );
        if (cookiesSaved === null) return noReusableCookiesError();
        if (!options.headless) await showSolvedPage(page);
        return { status: "solved", cookiesSaved };
      }
      if (!options.manualFallback) {
        return paidResult.status === "timeout"
          ? { status: "timeout" }
          : { status: "error", message: paidResult.message };
      }
      // manualFallback: continue to manual polling below
    }

    // Poll until the challenge is resolved or timeout
    const start = Date.now();
    const pollInterval = 2_000;

    while (Date.now() - start < timeoutMs) {
      await page.waitForTimeout(pollInterval);

      if (!(await isChallengePage(page))) {
        const cookiesSaved = await saveReusableCookies(
          context,
          extractorId,
          storageDir,
        );
        if (cookiesSaved === null) return noReusableCookiesError();
        if (!options.headless) await showSolvedPage(page);
        return { status: "solved", cookiesSaved };
      }
    }

    return { status: "timeout" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close();
  }
}

/** Show a "challenge solved" page so the VNC user knows they can close the tab. */
async function showSolvedPage(page: {
  goto: (url: string, opts?: { timeout?: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
}): Promise<void> {
  try {
    await page.goto(SOLVED_PAGE, { timeout: 5_000 });
    // Brief pause so the user sees the message before the browser closes
    await page.waitForTimeout(3_000);
  } catch {
    // Non-critical - the solve already succeeded
  }
}
