import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FREELANCE_USER_AGENT,
  fetchWithTimeout,
  makeGig,
  reportProgress,
} from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";
import type { Browser, Locator, Page } from "playwright";

const PLATFORM = "remoteok" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_REMOTEOK";
const REMOTEOK_API = "https://remoteok.com/api";
/** Real browser UA for the employer-apply flow (board feeds keep the bot UA). */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface RemoteOkJob {
  id?: string;
  slug?: string;
  position?: string;
  company?: string;
  tags?: string[];
  location?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string;
  description?: string;
  date?: string;
}

function toGig(job: RemoteOkJob): CreateGigInput | null {
  const title = job.position?.trim();
  const url = job.url;
  if (!title || !url) return null;

  const budgetMin = job.salary_min ?? undefined;
  const budgetMax = job.salary_max ?? undefined;
  const budget =
    budgetMin !== undefined || budgetMax !== undefined
      ? `${budgetMin !== undefined ? `$${budgetMin}` : "?"}-${budgetMax !== undefined ? `$${budgetMax}` : "?"}`
      : undefined;

  return makeGig({
    platform: PLATFORM,
    sourceGigId: job.id ?? job.slug,
    title,
    clientOrEmployer: job.company?.trim() || "RemoteOK client",
    gigUrl: url,
    applicationLink: url,
    budget,
    budgetMin,
    budgetMax,
    budgetCurrency: budget ? "USD" : undefined,
    skillsRequired: job.tags?.slice(0, 20),
    location: job.location || "Remote",
    isRemote: true,
    datePosted: job.date,
    gigDescription: job.description,
    jobType: "remote",
  });
}

/**
 * REAL RemoteOK finder — public JSON API (https://remoteok.com/api),
 * no credentials required. Search terms filter client-side across
 * title / company / tags / description.
 */
export async function findRemoteOkGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  reportProgress(ctx, "Fetching RemoteOK API", REMOTEOK_API);
  try {
    const res = await fetchWithTimeout(REMOTEOK_API, 20_000, {
      headers: {
        "User-Agent": FREELANCE_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        success: false,
        gigs: [],
        error: `RemoteOK API returned HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      return {
        success: false,
        gigs: [],
        error: "RemoteOK API returned an unexpected payload shape",
      };
    }

    const terms = ctx.searchTerms
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);

    let jobs = (data as RemoteOkJob[]).filter(
      (job) => job && typeof job === "object" && Boolean(job.position),
    );

    if (terms.length > 0) {
      jobs = jobs.filter((job) => {
        const haystack = [
          job.position ?? "",
          job.company ?? "",
          (job.tags ?? []).join(" "),
          job.description ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return terms.some((term) => haystack.includes(term));
      });
    }

    const gigs = jobs
      .map(toGig)
      .filter((gig): gig is CreateGigInput => gig !== null);

    reportProgress(ctx, `RemoteOK returned ${gigs.length} gigs`);
    return { success: true, gigs };
  } catch (error) {
    return {
      success: false,
      gigs: [],
      error: `RemoteOK fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Employer-ATS browser apply adapter
// ---------------------------------------------------------------------------
//
// RemoteOK is a public board: there is no platform account and no apply
// form on the board side. Each posting carries (or links to) the employer's
// ATS (Greenhouse, Lever, Workday, ...). This adapter:
//
//   1. re-resolves the board posting for ctx.gigId by re-fetching the same
//      public feed the finder uses and recomputing the dedup hash (kept in
//      sync with orchestrator/src/server/services/freelance/dedupe.ts);
//   2. opens the posting in a real Playwright browser (stealth init script)
//      and resolves the employer apply target: the posting URL itself when
//      it is already an ATS page, otherwise the external apply link or the
//      apply button found on the posting page;
//   3. fills the portal form from ctx.profile (name / email / phone /
//      cover letter), uploads a resume when one is provided, checks consent
//      boxes and dismisses cookie banners;
//   4. clicks the real submit control (walking Review/Continue steps) and
//      reports "submitted" ONLY when a success signal (URL or text pattern)
//      is confirmed afterwards. Every other outcome is "drafted" with a
//      precise error — no fake submissions.
//
// Real submission happens only when the orchestrator flips dryRun off,
// which happens exclusively via JOBOPS_FREELANCE_REMOTEOK_APPLY_ENABLED=true.
// No credentials are needed (boards have no accounts).

/** Employer ATS hosts/paths used to detect direct-apply URLs. */
const ATS_PATTERN =
  /greenhouse|lever\.co|myworkdayjobs|workday|ashbyhq|bamboohr|jobvite|smartrecruiters|icims|recruitee|personio|teamtailor|pinpointhq|comeet|workable|applytojob/i;

const BROWSER_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

// --- Dedup identity (must stay in sync with orchestrator dedupe.ts) ---

function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(senior|junior|sr|jr|lead|staff|principal)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|gclid|fbclid|mc_)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    let path = url.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function gigDedupHash(gig: CreateGigInput): string {
  const url = canonicalizeUrl(gig.gigUrl);
  const key = `${normalizeForCompare(gig.title)}|${normalizeForCompare(gig.clientOrEmployer)}`;
  return createHash("sha256")
    .update(`${url}::${key}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Re-fetch the public RemoteOK feed and return the posting whose dedup hash
 * matches gigId (the id the orchestrator passes as ctx.gigId).
 */
async function findPostingByGigId(
  gigId: string,
): Promise<CreateGigInput | null> {
  const res = await fetchWithTimeout(REMOTEOK_API, 20_000, {
    headers: {
      "User-Agent": FREELANCE_USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`RemoteOK API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("RemoteOK API returned an unexpected payload shape");
  }
  for (const job of data as RemoteOkJob[]) {
    const gig = toGig(job);
    if (gig && gigDedupHash(gig) === gigId) return gig;
  }
  return null;
}

// --- Candidate profile (ctx.profile is `unknown` upstream) ---

export interface ApplyIdentity {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  website: string;
  location: string;
  coverLetter: string;
  resumePath: string | null;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function locationToString(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const location = raw as Record<string, unknown>;
    return [
      pickString(location.address),
      pickString(location.city),
      pickString(location.region),
      pickString(location.countryCode),
    ]
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function buildCoverLetter(
  name: string,
  headline: string,
  summary: string,
  title: string,
  employer: string,
): string {
  return [
    `Hello ${employer} team,`,
    "",
    `I am applying for the ${title} role.`,
    headline ? `\n${stripHtml(headline)}` : null,
    summary ? `\n${stripHtml(summary)}` : null,
    "",
    "I have attached my tailored resume for your review.",
    "",
    "Best regards,",
    name || "Candidate",
  ]
    .filter((line): line is string => line !== null && line !== "")
    .join("\n");
}

/**
 * Pull the candidate identity out of ctx.profile. Accepts both the
 * ResumeProfile shape ({ basics: { name, email, ... } }) and a flat shape
 * ({ name, email, phone, coverLetter, resumePath, ... }). Returns null when
 * name and email are both missing — an employer form cannot be filled
 * without at least those, and submitting without them would be a fake.
 */
export function extractApplyIdentity(
  raw: unknown,
  posting: CreateGigInput,
): ApplyIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const basics = (
    obj.basics && typeof obj.basics === "object" ? obj.basics : {}
  ) as Record<string, unknown>;

  const fullName = pickString(
    obj.name,
    basics.name,
    [
      pickString(obj.firstName, basics.firstName),
      pickString(obj.lastName, basics.lastName),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const parts = fullName.split(/\s+/).filter(Boolean);
  const email = pickString(obj.email, basics.email);
  if (!fullName && !email) return null;

  const headline = pickString(obj.headline, basics.headline, basics.label);
  const summary = pickString(obj.summary, basics.summary);
  const coverLetter =
    pickString(obj.coverLetter, obj.message) ||
    buildCoverLetter(
      fullName,
      headline,
      summary,
      posting.title,
      posting.clientOrEmployer,
    );

  let resumePath = pickString(obj.resumePath, obj.resumePdfPath, obj.resumePdf);
  if (resumePath && !existsSync(resumePath)) resumePath = "";
  const resumeBase64 = pickString(obj.resumeBase64, obj.resumePdfBase64);
  if (!resumePath && resumeBase64) {
    const candidate = join(
      tmpdir(),
      `jobops-${PLATFORM}-resume-${Date.now()}.pdf`,
    );
    try {
      writeFileSync(candidate, Buffer.from(resumeBase64, "base64"));
      resumePath = candidate;
    } catch {
      resumePath = "";
    }
  }

  return {
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : "",
    fullName,
    email,
    phone: pickString(obj.phone, basics.phone),
    website: pickString(obj.website, basics.url, obj.linkedin),
    location: locationToString(obj.location ?? basics.location),
    coverLetter,
    resumePath: resumePath || null,
  };
}

// --- Portal automation (self-contained port of the orchestrator's
//     application-browser.ts form-fill / consent / submit / signal logic) ---

export type ClickOutcome = { clicked: boolean; page: Page };

export async function installStealth(page: Page): Promise<void> {
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

export async function dismissCookieOverlays(page: Page): Promise<void> {
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

export async function fillVisibleLocator(
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

/** Consent checkboxes are only touched here (explicit full-auto submit). */
export async function clickConsentBoxes(page: Page): Promise<void> {
  const matches: number[] =
    ((await page.evaluate(
      `(() => {
        var labels = /agree|consent|privacy|data (protection|processing)|gdpr|terms|verarbeit|datenschutz|candidature|cgv/i;
        var boxes = Array.from(document.querySelectorAll('input[type=checkbox]'));
        var out = [];
        boxes.forEach(function (box, index) {
          if (box.checked || box.offsetParent === null) return;
          var text = '';
          var label = null;
          if (box.id) label = document.querySelector('label[for="' + box.id + '"]');
          if (!label && box.closest) label = box.closest('label');
          if (label) text = (label.textContent || '');
          if (!text && box.getAttribute('aria-label')) text = box.getAttribute('aria-label');
          if (!text && box.parentElement) text = (box.parentElement.textContent || '').slice(0, 200);
          if (labels.test(text)) out.push(index);
        });
        return out;
      })()`,
    )) as number[]) ?? [];
  for (const index of matches.slice(0, 3)) {
    const box = page.locator("input[type=checkbox]").nth(index);
    await box.check({ timeout: 2_000 }).catch(() => undefined);
  }
}

export async function fillApplicationForm(
  page: Page,
  identity: ApplyIdentity,
): Promise<number> {
  let fieldsFilled = 0;
  const fill = async (selectors: string[], value: string) => {
    if (!value) return;
    for (const selector of selectors) {
      if (await fillVisibleLocator(page.locator(selector), value)) {
        fieldsFilled += 1;
        return;
      }
    }
  };

  await fill(
    [
      'input[name*="first" i]',
      'input[id*="first" i]',
      'input[placeholder*="first" i]',
      'input[aria-label*="first" i]',
    ],
    identity.firstName,
  );
  await fill(
    [
      'input[name*="last" i]',
      'input[id*="last" i]',
      'input[placeholder*="last" i]',
      'input[aria-label*="last" i]',
    ],
    identity.lastName,
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
    identity.fullName,
  );
  await fill(
    [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
    ],
    identity.email,
  );
  await fill(
    [
      'input[type="tel"]',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[name*="mobile" i]',
      'input[placeholder*="phone" i]',
    ],
    identity.phone,
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
    identity.website,
  );
  await fill(
    [
      'input[name*="location" i]',
      'input[id*="location" i]',
      'input[placeholder*="location" i]',
      'input[name*="city" i]',
      'input[id*="city" i]',
    ],
    identity.location,
  );
  await fill(
    [
      'textarea[name*="cover" i]',
      'textarea[id*="cover" i]',
      'textarea[placeholder*="cover" i]',
      'textarea[name*="message" i]',
      'textarea[id*="message" i]',
    ],
    identity.coverLetter,
  );

  await clickConsentBoxes(page).catch(() => undefined);
  return fieldsFilled;
}

export async function uploadResume(
  page: Page,
  pdfPath: string,
): Promise<boolean> {
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

export async function detectCaptcha(page: Page): Promise<string | null> {
  return await page
    .evaluate<string | null>(
      `(() => {
      var turnstile = document.querySelector(".cf-turnstile,[name='cf-turnstile-response']");
      if (turnstile && turnstile.dataset && turnstile.dataset.sitekey && turnstile.dataset.sitekey.trim()) return "turnstile";
      if (document.querySelector(".h-captcha,[data-hcaptcha-sitekey]")) return "hcaptcha";
      var recaptcha = document.querySelector(".g-recaptcha,[name='g-recaptcha-response']");
      if (recaptcha && recaptcha.dataset && recaptcha.dataset.sitekey && recaptcha.dataset.sitekey.trim()) return "recaptcha-v2";
      if (document.querySelector('img[src*="captcha" i], img[alt*="captcha" i], input[name*="captcha" i]')) return "image";
      var bodyText = (document.body && document.body.innerText || "").toLowerCase();
      var titleText = (document.title || "").toLowerCase();
      if (
        titleText.includes("just a moment") ||
        bodyText.includes("performing security verification") ||
        bodyText.includes("verify you are not a bot")
      ) return "cloudflare";
      return null;
    })()`,
    )
    .catch(() => null);
}

export async function hasApplicationFormSignal(page: Page): Promise<boolean> {
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

/**
 * Find the employer's external apply URL on a board posting page: an ATS
 * link, an "Apply"-style link, or an ATS form action. Ported from the
 * orchestrator's application-browser.ts.
 */
export async function findExternalApplyUrl(page: Page): Promise<string | null> {
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

export async function humanClick(locator: Locator): Promise<boolean> {
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

export async function clickAndFollow(
  locator: Locator,
): Promise<ClickOutcome | null> {
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

export async function clickFirstMatching(
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

/** Apply controls on the board posting page itself (if it is not an ATS). */
const boardApplySelectors = [
  'a[target="_blank"]:has-text("Apply")',
  'button:has-text("Apply now")',
  '[role="button"]:has-text("Apply now")',
  '[role="link"]:has-text("Apply now")',
  'a:has-text("Apply to this job")',
  'button:has-text("Apply to this job")',
  'a:has-text("Apply on website")',
  'button:has-text("Apply on website")',
  'a:has-text("Apply on company site")',
  'button:has-text("Apply on company site")',
  'a:has-text("Start application")',
  'button:has-text("Start application")',
  'a:has-text("Apply")',
  'button:has-text("Apply")',
  '[role="button"]:has-text("Apply")',
  '[role="link"]:has-text("Apply")',
  '[data-testid*="apply" i]',
  '[data-qa*="apply" i]',
  '[aria-label*="Apply" i]',
  'a[href*="/apply" i]',
];

/**
 * Click the real submit control, walking multi-step ATS flows (Review /
 * Continue / Next / Save and continue) for at most 6 steps. `clicked` is
 * true when any submit-flow control was clicked; confirmation of the
 * submission is done separately via the success signal.
 */
export async function clickSubmit(page: Page): Promise<ClickOutcome> {
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
    await clickConsentBoxes(currentPage).catch(() => undefined);
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

/**
 * Success confirmation: a thank-you/confirmation URL, or a known
 * confirmation phrase in the page text (multilingual). Ported from the
 * orchestrator's application-browser.ts.
 */
export async function hasSuccessSignal(
  page: Page,
  options: { hadForm?: boolean } = {},
): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (
    /thank|success|confirm|applied|submitted|completed|receipt|vielen-dank|dank-fuer-ihre|merci/.test(
      url,
    )
  ) {
    return true;
  }
  return await page
    .evaluate<boolean, boolean>((hadForm: boolean): boolean => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      const signals = [
        "application submitted",
        "application received",
        "thank you for applying",
        "thank you for your application",
        "thanks for applying",
        "your application has been submitted",
        "your application was submitted",
        "we received your application",
        "we've received your application",
        "successfully submitted",
        "submitted successfully",
        "application sent",
        "application was sent",
        "application complete",
        "applied successfully",
        "we have received your application",
        "we'll be in touch",
        "bewerbung erfolgreich",
        "dank f\u00fcr ihre bewerbung",
        "dank fuer ihre bewerbung",
        "ihre bewerbung wurde \u00fcbermittelt",
        "merci pour votre candidature",
        "votre candidature a bien \u00e9t\u00e9",
        "candidature envoy\u00e9e",
      ];
      if (signals.some((signal) => text.includes(signal))) return true;
      if (hadForm) {
        const fields = document.querySelectorAll(
          "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select",
        ).length;
        const submit = document.querySelectorAll(
          "button[type=submit], input[type=submit]",
        ).length;
        const short = (document.body?.innerText ?? "").length < 900;
        if (fields < 2 && submit === 0 && short) return true;
      }
      return false;
    }, options.hadForm === true)
    .catch(() => false);
}

export async function hasBlockingErrorSignal(page: Page): Promise<boolean> {
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

/**
 * RemoteOK apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_REMOTEOK_APPLY_ENABLED=true. No credentials exist for
 * this platform (public board) — the submit path drives the employer's ATS
 * form in a real browser and only reports "submitted" on a confirmed
 * success signal.
 */
export async function applyToRemoteOkGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true to submit for real)`,
    };
  }

  try {
    const posting = await findPostingByGigId(ctx.gigId);
    if (!posting) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        error: `${PLATFORM}: gig ${ctx.gigId} not found on the RemoteOK board (posting may be closed) — cannot open its employer apply page`,
      };
    }

    const identity = extractApplyIdentity(ctx.profile, posting);
    if (!identity) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        error: `${PLATFORM}: no candidate profile in the apply context (ctx.profile ${
          ctx.profile === null || ctx.profile === undefined
            ? "is null"
            : "lacks name/email"
        }) — employer form needs at least a name and an email`,
      };
    }

    let browser: Browser | undefined;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
      const context = await browser.newContext({ userAgent: BROWSER_UA });
      let page = await context.newPage();
      await installStealth(page);
      page.setDefaultNavigationTimeout(30_000);

      await page.goto(posting.gigUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => undefined);

      // Resolve the employer apply target: the posting URL itself when it is
      // already an ATS page, otherwise the external apply link or the apply
      // button on the posting page.
      if (!ATS_PATTERN.test(posting.gigUrl)) {
        let reached = await hasApplicationFormSignal(page);
        if (!reached) {
          const externalUrl = await findExternalApplyUrl(page);
          if (externalUrl) {
            await page.goto(externalUrl, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await page
              .waitForLoadState("networkidle", { timeout: 15_000 })
              .catch(() => undefined);
            await installStealth(page).catch(() => undefined);
          } else {
            const outcome = await clickFirstMatching(page, boardApplySelectors);
            if (outcome) page = outcome.page;
          }
          reached = await hasApplicationFormSignal(page);
        }
        if (!reached) {
          return {
            platform: PLATFORM,
            mode: "submit",
            status: "drafted",
            error: `${PLATFORM}: no employer application link found on posting ${posting.gigUrl}`,
          };
        }
      }

      await dismissCookieOverlays(page).catch(() => undefined);
      const hadForm = await hasApplicationFormSignal(page);
      await fillApplicationForm(page, identity);
      if (identity.resumePath) {
        await uploadResume(page, identity.resumePath);
      }

      const captcha = await detectCaptcha(page);
      if (captcha) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "drafted",
          error: `${PLATFORM}: CAPTCHA (${captcha}) detected on ${page.url()} — this adapter does not auto-solve CAPTCHAs; manual submission needed`,
          captcha: {
            attempted: ctx.allowCaptcha,
            solved: false,
            type: captcha,
            provider: null,
          },
        };
      }

      const submitOutcome = await clickSubmit(page);
      const finalPage = submitOutcome.page;
      await finalPage
        .waitForLoadState("domcontentloaded", { timeout: 20_000 })
        .catch(() => undefined);
      await finalPage.waitForTimeout(3_000);

      // "submitted" ONLY on a confirmed success signal after a real click.
      if (
        submitOutcome.clicked &&
        (await hasSuccessSignal(finalPage, { hadForm }))
      ) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "submitted",
          externalRef: finalPage.url(),
        };
      }
      if (!submitOutcome.clicked) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "drafted",
          error: `${PLATFORM}: no submit control found on the employer application form at ${finalPage.url()} — manual review needed`,
        };
      }
      if (await hasBlockingErrorSignal(finalPage)) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "drafted",
          error: `${PLATFORM}: submit clicked but the portal still shows validation signals (required/invalid/CAPTCHA) at ${finalPage.url()} — application not confirmed`,
        };
      }
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        error: `${PLATFORM}: submit clicked but no success signal detected at ${finalPage.url()} — application not confirmed; manual review needed`,
      };
    } finally {
      if (browser) await browser.close();
    }
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: apply failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
