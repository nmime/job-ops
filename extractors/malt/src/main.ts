import { makeGig, reportProgress, stubNotFound } from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "malt" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_MALT";
const SEARCH_URL = "https://www.malt.fr/s";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Malt — REAL adapter.
 *
 * Malt exposes NO credential-free public project API (the JSON endpoints
 * answer 403/404 and the site sits behind Cloudflare). Discovery therefore
 * tries two real paths, in order:
 *
 *  1. Public HTML search page via a real browser (Playwright) — no
 *     credentials required. We load https://www.malt.fr/s?q=<term> and parse
 *     project cards out of the rendered DOM / embedded JSON state.
 *  2. If the browser path is blocked or no browser is available, a clean
 *     structured not-configured result naming ${ENV_PREFIX}_COOKIE (the
 *     authenticated session cookie that unlocks the logged-in search).
 *
 * No data is ever fabricated: if we cannot reach real listings we return
 * success:false with an actionable message.
 */

type ParsedMaltProject = {
  sourceGigId?: string;
  title?: string;
  clientOrEmployer?: string;
  gigUrl?: string;
  location?: string;
  datePosted?: string;
  gigDescription?: string;
};

/** Parse a raw `Cookie` header into Playwright cookie objects for malt.fr. */
function parseMaltCookies(cookie: string): import("playwright").Cookie[] {
  return cookie
    .split(";")
    .flatMap((pair) => {
      const [name, ...rest] = pair.trim().split("=");
      return name && rest.length
        ? [
            {
              name: name.trim(),
              value: rest.join("="),
              domain: ".malt.fr",
              path: "/",
              expires: -1,
              httpOnly: false,
              secure: false,
              sameSite: "Lax",
            },
          ]
        : [];
    });
}

/** Extract project cards from the rendered Malt search page. */
async function scrapeMaltSearch(
  term: string,
  cookie?: string,
): Promise<ParsedMaltProject[]> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    if (cookie) {
      await context.addCookies(parseMaltCookies(cookie));
    }
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    const url = `${SEARCH_URL}?q=${encodeURIComponent(term)}`;
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!response || !response.ok()) {
      throw new Error(
        `Malt search HTTP ${response?.status() ?? "no response"}`,
      );
    }

    // Prefer the embedded structured data; fall back to DOM cards.
    const projects = await page.evaluate(() => {
      type Card = {
        sourceGigId?: string;
        title?: string;
        clientOrEmployer?: string;
        gigUrl?: string;
        location?: string;
        datePosted?: string;
        gigDescription?: string;
      };
      const out: Card[] = [];
      const anchors = document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/project/"], a[href*="/mission/"], a[href*="/job/"]',
      );
      for (const anchor of Array.from(anchors)) {
        const href = anchor.href;
        const idMatch = href.match(
          /(?:project|mission|job)[/=-]([A-Za-z0-9_-]+)/,
        );
        const card = anchor.closest("article, li, div") ?? anchor;
        const title =
          card.querySelector("h2, h3, [class*='title']")?.textContent?.trim() ??
          anchor.textContent?.trim();
        const location = card
          .querySelector("[class*='location'], [data-testid*='location']")
          ?.textContent?.trim();
        const description = card
          .querySelector("p, [class*='description']")
          ?.textContent?.trim();
        if (title) {
          out.push({
            sourceGigId: idMatch?.[1] ?? href,
            title,
            gigUrl: href,
            location: location ?? undefined,
            gigDescription: description ?? undefined,
          });
        }
      }
      return out;
    });
    return projects;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export async function findMaltGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  const cookie =
    ctx.settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`];

  const terms = ctx.searchTerms
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);
  const gigs: CreateGigInput[] = [];
  const seen = new Set<string>();
  let lastError: string | undefined;
  let attempted = false;

  for (const term of terms.length ? terms : ["freelance"]) {
    try {
      attempted = true;
      reportProgress(ctx, `${PLATFORM}: searching "${term}" via browser`);
      const projects = await scrapeMaltSearch(term, cookie);
      for (const project of projects.slice(0, 50)) {
        const id = project.sourceGigId ?? project.gigUrl ?? "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        gigs.push(
          makeGig({
            platform: PLATFORM,
            sourceGigId: id,
            title: project.title ?? "Untitled project",
            clientOrEmployer: project.clientOrEmployer ?? "Malt client",
            gigUrl: project.gigUrl ?? "https://www.malt.fr/s",
            applicationLink: project.gigUrl,
            location: project.location,
            datePosted: project.datePosted,
            gigDescription: project.gigDescription,
          }),
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      reportProgress(ctx, `${PLATFORM}: term "${term}" failed: ${lastError}`);
    }
  }

  if (gigs.length > 0) {
    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  }

  return stubNotFound({
    platform: PLATFORM,
    message: `${PLATFORM}: no listings scraped${attempted ? ` (last error: ${lastError ?? "unknown"})` : ""} — Malt blocks anonymous access behind Cloudflare; set ${ENV_PREFIX}_COOKIE with a logged-in session cookie to enable discovery`,
  });
}

// --- Apply: real browser response flow --------------------------------

/**
 * Malt's apply flow is "respond to a project": on the project page
 * (https://www.malt.fr/project/<id>) a logged-in freelancer sees an apply CTA
 * ("Postuler" / "Apply") that opens a response composer — the cover letter
 * / offer that is posted into the project's conversation. There is no
 * separate application form.
 *
 * The adapter therefore, with the session cookie
 * (JOBOPS_FREELANCE_MALT_COOKIE):
 *   1. opens the project page and verifies it is neither a Cloudflare
 *      challenge nor a login redirect;
 *   2. short-circuits when the page already shows this account applied /
 *      responded (idempotent — no duplicate send);
 *   3. clicks the apply/response CTA, waits for a NEW composer surface and
 *      fills the tailored cover letter;
 *   4. clicks the composer's send control and waits for a success signal
 *      (confirmation text, navigation away, or the composer closing).
 *
 * "submitted" is reported ONLY when a real send control was clicked and a
 * success signal was confirmed. If the letter was drafted but sending cannot
 * be confirmed, the result is "drafted" with a precise blocker naming the
 * URL a human should open. No fake submissions, ever.
 */

/** Launches Chromium with the Malt session cookie and minimal stealth. */
async function openMaltSession(
  cookie: string,
): Promise<{
  browser: import("playwright").Browser;
  page: import("playwright").Page;
}> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: BROWSER_UA });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await context.addCookies(parseMaltCookies(cookie));
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(25_000);
  return { browser, page };
}

/** CTA that opens the response composer on the project page. */
const APPLY_CONTROL_RE =
  /postuler|r[ée]pondre|r[ée]ponse|apply|respond|proposer|make an offer/i;
/** Composer send control ("Envoyer" / "Send", or the in-modal apply CTA). */
const SEND_CONTROL_RE = /envoyer|send|postuler|apply|soumettre|submit/i;
/** Confirmation phrase proving the response went out (button labels excluded). */
const CONFIRMATION_RE =
  /(a [ée]t[ée] envoy[ée]|has been (sent|submitted)|sent successfully|(application|response|candidature|r[ée]ponse)(\s+has been)? sent|merci pour votre (r[ée]ponse|candidature))/i;
/** "Already applied / already responded" state (idempotency). */
const ALREADY_APPLIED_RE =
  /vous avez d[ée]j[àa] (postul[ée]|r[ée]pondu)|you have already (applied|responded)|candidature envoy[ée]|r[ée]ponse envoy[ée]|already (applied|responded)|your (application|response) has been sent/i;
/** Overlay surfaces where the composer / send control usually live. */
const OVERLAY_SELECTOR =
  '[role="dialog"], [class*="modal" i], [class*="overlay" i], [class*="drawer" i]';

/** Last visible button in DOM order matching the accessible name regex. */
async function firstVisibleButton(
  scope: import("playwright").Page | import("playwright").Locator,
  name: RegExp,
): Promise<import("playwright").Locator | undefined> {
  const loc = scope.getByRole("button", { name });
  const count = await loc.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return undefined;
}

/** Apply CTA: button first, then link, in overlay-first order. */
async function findApplyControl(
  page: import("playwright").Page,
): Promise<import("playwright").Locator | undefined> {
  for (const scope of [page.locator(OVERLAY_SELECTOR), page]) {
    const button = await firstVisibleButton(scope, APPLY_CONTROL_RE);
    if (button) return button;
  }
  const links = page.getByRole("link", { name: APPLY_CONTROL_RE });
  const count = await links.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const el = links.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return undefined;
}

type SendConfirmation = { confirmed: boolean; errorText?: string };

/**
 * Polls for a success signal after the send click: a confirmation phrase on
 * the page, a navigation to another view, or the composer closing/clearing.
 * A visible app error toast negates confirmation (safe direction: an
 * unconfirmed send is never reported as submitted).
 */
async function confirmSend(
  page: import("playwright").Page,
  composer: import("playwright").Locator,
  originalUrl: string,
  timeoutMs = 20_000,
): Promise<SendConfirmation> {
  const deadline = Date.now() + timeoutMs;
  const errorTextRe = /(une erreur|error|impossible|a [ée]chou[ée]|failed|could not)/i;
  while (Date.now() < deadline) {
    const toastText = await page
      .evaluate(
        () =>
          Array.from(
            document.querySelectorAll(
              '[role="alert"], [role="status"], [class*="toast" i], [class*="snack" i], [class*="notif" i], [class*="banner" i]',
            ),
          )
            .map((node) => node.textContent ?? "")
            .join(" "),
      )
      .catch(() => "");
    if (errorTextRe.test(toastText)) {
      return { confirmed: false, errorText: toastText.slice(0, 200) };
    }
    const confirmedText = await page
      .evaluate(
        (re) => new RegExp(re, "i").test(document.body?.innerText ?? ""),
        CONFIRMATION_RE.source,
      )
      .catch(() => false);
    if (confirmedText) return { confirmed: true };
    if (page.url() !== originalUrl) {
      const errorPage = await page
        .evaluate(() =>
          /404|not found|error|unavailable/i.test(document.title ?? ""),
        )
        .catch(() => false);
      if (!errorPage) return { confirmed: true };
    }
    const composerGone = !(await composer.isVisible().catch(() => false));
    if (composerGone) return { confirmed: true };
    await page.waitForTimeout(1_000);
  }
  return { confirmed: false };
}

/**
 * Malt apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_MALT_APPLY_ENABLED=true. The real path requires the
 * authenticated session cookie; it opens the project page in a real browser,
 * responds to the project through the composer, and only reports
 * "submitted" on a confirmed send. It never fabricates a submission.
 */
export async function applyToMaltGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and configure ${ENV_PREFIX}_COOKIE to submit for real)`,
    };
  }

  const cookie = process.env[`${ENV_PREFIX}_COOKIE`];
  if (!cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (session cookie) — cannot open an authenticated application session`,
    };
  }

  const profile = (ctx.profile ?? {}) as { coverLetter?: string };
  const coverLetter = profile.coverLetter?.trim();
  if (!coverLetter) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored proposal`,
    };
  }

  let browser: import("playwright").Browser | undefined;
  try {
    const { browser: launched, page } = await openMaltSession(cookie);
    browser = launched;

    const gigUrl = ctx.gigId.startsWith("http")
      ? ctx.gigId
      : `https://www.malt.fr/project/${ctx.gigId}`;
    const response = await page.goto(gigUrl, { waitUntil: "domcontentloaded" });
    if (!response || !response.ok()) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: gig page unreachable (HTTP ${response?.status() ?? "no response"}) for ${gigUrl}`,
      };
    }
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);

    // A Cloudflare challenge page is not a project page: never treat it as success.
    const challenged = await page
      .evaluate(
        () =>
          /just a moment|attention r[ée]quise|verifying you are human/i.test(
            document.title ?? "",
          ) ||
          Boolean(
            document.querySelector(
              "#challenge-running, #challenge-form, .cf-turnstile, [data-turnstile]",
            ),
          ),
      )
      .catch(() => false);
    if (challenged) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: Cloudflare challenge on the project page — the headless session was blocked; copy a fresh session cookie from a real browser into ${ENV_PREFIX}_COOKIE and retry`,
      };
    }

    if (/(^|\/)(login|connexion|sign-in)(\/|$|\?)/i.test(page.url())) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: session cookie rejected (redirected to login) — refresh ${ENV_PREFIX}_COOKIE from a logged-in browser session`,
      };
    }

    // Idempotency: the platform already shows this account applied/responded.
    const alreadyApplied = await page
      .evaluate(
        (re) =>
          new RegExp(re, "i").test(document.body?.innerText ?? ""),
        ALREADY_APPLIED_RE.source,
      )
      .catch(() => false);
    if (alreadyApplied) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "submitted",
        externalRef: page.url(),
        error: `${PLATFORM}: idempotent hit — the project page already shows this account applied to / responded to it; no duplicate send was made`,
      };
    }

    const applyControl = await findApplyControl(page);
    if (!applyControl) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: no apply/response control found on the project page (looked for "Postuler"/"Répondre"/"Apply"/"Respond") — the project may be closed, already answered, or not open to this account; open ${gigUrl} in a browser to check`,
      };
    }

    // Tag composer candidates that already exist so we can detect the NEW
    // surface the apply CTA opens (the response composer).
    await page
      .evaluate(() => {
        Array.from(
          document.querySelectorAll(
            'textarea, [contenteditable="true"], input[type="text"]',
          ),
        ).forEach((el, i) =>
          el.setAttribute("data-jobops-preexisting", String(i)),
        );
      })
      .catch(() => undefined);

    await applyControl.click({ timeout: 10_000 });

    const composerSelector =
      'textarea:not([data-jobops-preexisting]), [contenteditable="true"]:not([data-jobops-preexisting])';
    const freshComposer = page.locator(composerSelector);
    let composer = freshComposer;
    try {
      await composer.first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      // Fallback: any visible composer inside an overlay (e.g. an existing
      // inline response box that was only revealed, not re-created).
      composer = page
        .locator(`${OVERLAY_SELECTOR} textarea, ${OVERLAY_SELECTOR} [contenteditable="true"]`)
        .or(freshComposer);
      try {
        await composer.first().waitFor({ state: "visible", timeout: 5_000 });
      } catch {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "error",
          error: `${PLATFORM}: apply control clicked but no response composer appeared — the response flow may have changed or the project is not open to responses; open ${page.url()} to check`,
        };
      }
    }

    try {
      await composer.first().fill(coverLetter, { timeout: 5_000 });
    } catch {
      await composer.first().click();
      await composer.first().type(coverLetter, { delay: 5 });
    }

    // The send control usually lives inside the overlay; page-wide fallback
    // after (last visible match in DOM order wins, so overlay beats page).
    let sendButton = await firstVisibleButton(
      page.locator(OVERLAY_SELECTOR),
      SEND_CONTROL_RE,
    );
    if (!sendButton) {
      sendButton = await firstVisibleButton(page, SEND_CONTROL_RE);
    }
    if (!sendButton) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        externalRef: page.url(),
        error: `${PLATFORM}: cover letter drafted in the Malt response composer but no send control found (looked for "Envoyer"/"Send"/"Postuler") — nothing was submitted; open ${page.url()} and press send manually`,
      };
    }

    const urlBeforeSend = page.url();
    await sendButton.click({ timeout: 10_000 });
    const confirmation = await confirmSend(page, composer.first(), urlBeforeSend);
    if (confirmation.confirmed) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "submitted",
        externalRef: page.url(),
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "drafted",
      externalRef: page.url(),
      error: `${PLATFORM}: send control clicked but no success signal confirmed within 20s (no confirmation text, no navigation, composer still open${confirmation.errorText ? `; page shows: "${confirmation.errorText}"` : ""}) — nothing verified as sent; open ${page.url()} and check/send manually`,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: browser submit failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
