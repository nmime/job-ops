import { existsSync } from "node:fs";
import {
  FREELANCE_USER_AGENT,
  fetchWithTimeout,
  makeGig,
  reportProgress,
  stubNotFound,
} from "freelance-shared";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";
import type * as PW from "playwright";

const PLATFORM = "contra" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_CONTRA";
const ASHBY_BOARD = "https://api.ashbyhq.com/posting-api/job-board/contra";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Contra — REAL adapter.
 *
 * Discovery is CREDENTIAL-FREE: Contra's careers board is hosted on Ashby,
 * whose posting API is public:
 *   GET https://api.ashbyhq.com/posting-api/job-board/contra
 * Returns {jobs: [{id, title, department, team, employmentType, location,
 * publishedAt, isRemote, jobUrl, applyUrl, ...}]}
 *
 * NOTE: this covers Contra's OWN careers board (small — a handful of roles).
 * Contra does not expose a credential-free public feed of client
 * opportunities on contra.com; the marketplace is behind a login, so client
 * gigs would require ${ENV_PREFIX}_COOKIE (session cookie). Until then,
 * discovery covers the Ashby careers board only.
 *
 * Submit: no public API. The real path drives the job's Ashby application
 * page (jobs.ashbyhq.com/contra/<gigId>/application) end to end in a real
 * browser (Playwright) with the operator's session cookie attached to BOTH
 * .contra.com and .ashbyhq.com. It fills the form (names, email, phone,
 * portfolio, message, resume upload, work-authorization and consent boxes)
 * and clicks the actual submit control. It reports "submitted" ONLY after
 * observing a success signal (confirmation URL or text); anything less is
 * "drafted" or "error" with a precise reason. It never fabricates a
 * submission.
 */

type AshbyJob = {
  id?: string;
  title?: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  compensationTierSummary?: string;
};

function resolveCredential(settings: Record<string, string | undefined>): {
  apiKey?: string;
  cookie?: string;
} {
  return {
    apiKey:
      settings[`${ENV_PREFIX}_API_KEY`] ?? process.env[`${ENV_PREFIX}_API_KEY`],
    cookie:
      settings[`${ENV_PREFIX}_COOKIE`] ?? process.env[`${ENV_PREFIX}_COOKIE`],
  };
}

function matchesTerms(job: AshbyJob, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack =
    `${job.title ?? ""} ${job.department ?? ""} ${job.team ?? ""} ${
      job.descriptionPlain ?? ""
    }`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function jobToGig(job: AshbyJob): CreateGigInput {
  return makeGig({
    platform: PLATFORM,
    sourceGigId: job.id,
    title: job.title ?? "Untitled role",
    clientOrEmployer: "Contra",
    gigUrl: job.jobUrl ?? `https://jobs.ashbyhq.com/contra/${job.id ?? ""}`,
    applicationLink: job.applyUrl,
    datePosted: job.publishedAt ?? undefined,
    gigDescription: job.descriptionPlain ?? undefined,
    budget: job.compensationTierSummary ?? undefined,
    skillsRequired: [job.team, job.department].filter(
      (value): value is string => Boolean(value),
    ),
    jobType: job.employmentType ?? undefined,
    isRemote:
      job.isRemote ??
      (job.workplaceType
        ? job.workplaceType.toLowerCase() === "remote"
        : undefined),
    location:
      job.location ??
      job.secondaryLocations
        ?.map((l) => l.location)
        .filter(Boolean)
        .join("; ") ??
      undefined,
  });
}

export async function findContraGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching Ashby job board`);
    const res = await fetchWithTimeout(ASHBY_BOARD, 15_000, {
      headers: {
        "User-Agent": FREELANCE_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: Ashby board HTTP ${res.status} — retry later or set ${ENV_PREFIX}_COOKIE for authenticated marketplace discovery`,
      });
    }
    const json = (await res.json()) as { jobs?: AshbyJob[] };
    const jobs = Array.isArray(json.jobs) ? json.jobs : [];

    const terms = ctx.searchTerms
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!job.id || seen.has(job.id)) continue;
      if (!matchesTerms(job, terms)) continue;
      seen.add(job.id);
      gigs.push(jobToGig(job));
    }

    reportProgress(
      ctx,
      `${PLATFORM} returned ${gigs.length} gigs (Ashby careers board)`,
    );
    return { success: true, gigs };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Parse a raw `Cookie:` header into name/value pairs. */
function parseCookieHeader(cookie: string): Array<{
  name: string;
  value: string;
}> {
  return cookie.split(";").flatMap((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return name && rest.length
      ? [{ name: name.trim(), value: rest.join("=") }]
      : [];
  });
}

interface ParsedContraProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  website?: string;
  coverLetter: string;
  resumePath?: string;
  jobTitle?: string;
  location?: string;
}

/**
 * ctx.profile is `unknown` in the shared contract. The orchestrator passes a
 * flat object ({name, email, coverLetter, skills, ...}); a
 * ResumeProfile-shaped {basics: {...}} is accepted too. Returns null when the
 * profile is missing or lacks the fields a real application needs (name,
 * email, tailored cover letter).
 */
function parseContraProfile(profile: unknown): ParsedContraProfile | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record<string, unknown>;
  const basics =
    record.basics && typeof record.basics === "object"
      ? (record.basics as Record<string, unknown>)
      : record;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const fullName = str(record.name) ?? str(basics.name);
  const email = str(record.email) ?? str(basics.email);
  const coverLetter = str(record.coverLetter) ?? str(record.message);
  if (!fullName || !email || !coverLetter) return null;

  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    fullName,
    firstName: parts[0] ?? fullName,
    lastName: parts.length > 1 ? parts[parts.length - 1] : "",
    email,
    phone: str(record.phone) ?? str(basics.phone),
    website:
      str(record.website) ?? str(record.portfolio) ?? str(basics.url),
    coverLetter,
    resumePath: str(record.resumePath) ?? str(record.resume) ?? str(record.cv),
    jobTitle: str(record.jobTitle) ?? str(record.gigTitle),
    location: str(record.location) ?? str(basics.location),
  };
}

/**
 * Fill a visible, empty form control, located first by its <label> text and
 * then by attribute fallback selectors. Returns true only when a value was
 * actually written into a field.
 */
async function tryFillField(
  page: PW.Page,
  value: string | undefined,
  labelPattern: RegExp,
  fallbackSelectors: string[],
): Promise<boolean> {
  if (!value) return false;
  const candidates: PW.Locator[] = [];

  const labelIndex = await page
    .evaluate((patternSource: string) => {
      const pattern = new RegExp(patternSource, "i");
      const controls = Array.from(
        document.querySelectorAll("input, textarea, select"),
      );
      const indexForLabel = (label: HTMLLabelElement): number | null => {
        const forId = label.getAttribute("for");
        if (forId) {
          const el = document.getElementById(forId);
          const idx = el ? controls.indexOf(el) : -1;
          if (idx >= 0) return idx;
        }
        const nested = label.querySelector("input, textarea, select");
        return nested ? controls.indexOf(nested) : null;
      };
      for (const label of Array.from(document.querySelectorAll("label"))) {
        if (pattern.test((label.textContent ?? "").trim())) {
          const idx = indexForLabel(label);
          if (idx !== null && idx >= 0) return idx;
        }
      }
      return null;
    }, labelPattern.source)
    .catch(() => null);
  if (labelIndex !== null && labelIndex !== undefined) {
    candidates.push(page.locator("input, textarea, select").nth(labelIndex));
  }
  for (const selector of fallbackSelectors) {
    candidates.push(page.locator(selector).first());
  }

  for (const candidate of candidates) {
    try {
      if ((await candidate.count().catch(() => 0)) === 0) continue;
      const visible = await candidate
        .waitFor({ state: "visible", timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      if (!visible) continue;
      const existing = await candidate.inputValue().catch(() => "");
      if (existing.trim()) continue;
      await candidate.fill(value, { timeout: 2_000 });
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/**
 * Best-effort native click on unchecked boxes whose label/name matches.
 * Ashby is a React app; a real bubbling click is what the framework listens
 * for, so this runs in-page rather than via locator.check().
 */
async function checkBoxesForLabels(
  page: PW.Page,
  pattern: RegExp,
): Promise<number> {
  return page
    .evaluate((patternSource: string) => {
      const pat = new RegExp(patternSource, "i");
      let checked = 0;
      for (const box of Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      )) {
        if (box.checked) continue;
        const label =
          (box.id
            ? document.querySelector(`label[for="${CSS.escape(box.id)}"]`)
            : null) ?? box.closest("label");
        const text = `${label?.textContent ?? ""} ${box.name ?? ""}`.trim();
        if (!pat.test(text)) continue;
        box.click();
        checked += 1;
      }
      return checked;
    }, pattern.source)
    .catch(() => 0);
}

/** If work authorization is a Yes/No radio group, select "Yes". */
async function selectWorkAuthorizationYes(page: PW.Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const groupPattern =
        /work authorization|authorized to work|right to work|work permit|eligible to work/i;
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      );
      for (const radio of radios) {
        const label =
          (radio.id
            ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)
            : null) ?? radio.closest("label");
        if ((label?.textContent ?? "").trim().toLowerCase() !== "yes")
          continue;
        const group =
          radio.closest("fieldset") ??
          radio.closest('div[class*="question" i], div[class*="field" i]') ??
          radio.parentElement?.parentElement;
        if (!groupPattern.test(group?.textContent ?? "")) continue;
        radio.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

/** Upload the resume PDF into the first file input that accepts it. */
async function uploadResumeFile(
  page: PW.Page,
  pdfPath: string,
): Promise<boolean> {
  const inputs = page.locator('input[type="file"]');
  const count = Math.min(await inputs.count().catch(() => 0), 3);
  for (let index = 0; index < count; index += 1) {
    const ok = await inputs
      .nth(index)
      .setInputFiles(pdfPath, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

/** True when the apply page reports the position as closed/removed. */
async function pageReportsGone(page: PW.Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      return /no longer available|not currently available|position (is )?closed|job (posting )?no longer open|has been removed|is not open to/i.test(
        text,
      );
    })
    .catch(() => false);
}

/** Confirmation URL or on-page success text after a real submit. */
async function detectSuccessSignal(page: PW.Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (
    /thank|success|confirm|applied|submitted|completed|receipt/.test(url)
  ) {
    return true;
  }
  return page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      const signals = [
        "application submitted",
        "application received",
        "thank you for applying",
        "thank you for your application",
        "thanks for applying",
        "your application has been",
        "your application was submitted",
        "we received your application",
        "we've received your application",
        "successfully submitted",
        "submitted successfully",
        "application sent",
        "application complete",
        "applied successfully",
        "we'll be in touch",
      ];
      return signals.some((signal) => text.includes(signal));
    })
    .catch(() => false);
}

/** Form validation errors shown after a failed submit attempt. */
async function detectFormError(page: PW.Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      const signals = [
        "is required",
        "please fix the",
        "check your answers",
        "fix the errors",
        "invalid email",
        "please enter a",
      ];
      const hit = signals.find((signal) => text.includes(signal));
      return hit ?? null;
    })
    .catch(() => null);
}

async function saveDebugScreenshot(
  page: PW.Page,
  gigId: string,
): Promise<string | null> {
  try {
    const path = `/tmp/contra-apply-${gigId}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true, timeout: 10_000 });
    return path;
  } catch {
    return null;
  }
}

/**
 * Contra apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_CONTRA_APPLY_ENABLED=true. With a session cookie the real
 * path drives the posting's Ashby application form end to end: fills the
 * fields, uploads the resume when provided, accepts work-authorization and
 * consent boxes, clicks the real submit control, and confirms a success
 * signal before ever reporting "submitted". It never fabricates a
 * submission.
 */
export async function applyToContraGig(
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

  const { cookie } = resolveCredential(
    process.env as Record<string, string | undefined>,
  );
  if (!cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_COOKIE (session cookie) — cannot open an authenticated application session`,
    };
  }

  const profile = parseContraProfile(ctx.profile);
  if (!profile) {
    const reason =
      ctx.profile == null ||
      !(ctx.profile instanceof Object) ||
      Object.keys(ctx.profile as object).length === 0
        ? "no profile provided by the orchestrator (expected {name, email, coverLetter, ...})"
        : "profile lacks name/email/tailored cover letter — refusing to submit an untailored application";
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: ${reason}`,
    };
  }

  const applyUrl = `https://jobs.ashbyhq.com/contra/${encodeURIComponent(
    ctx.gigId,
  )}/application`;
  let browser: PW.Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
    });
    // The apply host is jobs.ashbyhq.com while Contra's session cookie is
    // scoped to .contra.com — attach it to BOTH domains so either side can
    // authenticate the page.
    const parsedCookies = parseCookieHeader(cookie);
    if (parsedCookies.length === 0) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: ${ENV_PREFIX}_COOKIE is not a parseable Cookie header (expected "name=value; name2=value2")`,
      };
    }
    await context.addCookies(
      [".contra.com", ".ashbyhq.com"].flatMap((domain) =>
        parsedCookies.map((c) => ({ ...c, domain, path: "/" })),
      ),
    );
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);

    const response = await page.goto(applyUrl, {
      waitUntil: "domcontentloaded",
    });
    if (!response) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: no HTTP response from ${applyUrl}`,
      };
    }
    if (!response.ok()) {
      const unavailable = response.status() === 404 || response.status() === 410;
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: ${
          unavailable
            ? "gig unavailable or already filled"
            : "apply page unreachable"
        } (HTTP ${response.status()}) for ${applyUrl}`,
      };
    }

    // Ashby hydrates the form client-side — wait for real form controls.
    await page
      .waitForSelector(
        'input:not([type="hidden"]), textarea, button[type="submit"]',
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);

    if (await pageReportsGone(page)) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: gig no longer available — apply page at ${applyUrl} shows a closed/removed notice`,
      };
    }

    let fieldsFilled = 0;
    const fill = async (
      value: string | undefined,
      labelPattern: RegExp,
      fallbackSelectors: string[] = [],
    ): Promise<void> => {
      if (await tryFillField(page, value, labelPattern, fallbackSelectors))
        fieldsFilled += 1;
    };

    await fill(profile.firstName, /first name/i, [
      'input[name*="first" i]',
      'input[id*="first" i]',
      'input[placeholder*="first" i]',
    ]);
    await fill(profile.lastName, /last name|surname/i, [
      'input[name*="last" i]',
      'input[name*="surname" i]',
      'input[id*="last" i]',
      'input[placeholder*="last" i]',
    ]);
    await fill(profile.fullName, /^(full name|your name|name|applicant name)$/i, [
      'input[name="name" i]',
      'input[placeholder*="full name" i]',
    ]);
    await fill(profile.email, /e-?mail/i, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[placeholder*="email" i]',
    ]);
    await fill(profile.phone, /phone|mobile|cell/i, [
      'input[type="tel"]',
      'input[name*="phone" i]',
    ]);
    await fill(profile.website, /website|portfolio|linkedin/i, [
      'input[type="url"]',
      'input[name*="website" i]',
      'input[name*="portfolio" i]',
    ]);
    // Required "which position/role" style inputs, filled when a title is known.
    await fill(profile.jobTitle, /job title|applied for|which position|which role/i, [
      'input[name*="jobtitle" i]',
      'input[name*="position" i]',
    ]);
    await fill(profile.coverLetter, /cover letter|your message|message|notes|why (are you )?applying/i, [
      'textarea[name*="message" i]',
      'textarea[name*="cover" i]',
      "textarea",
    ]);

    let resumeUploaded = false;
    if (profile.resumePath && existsSync(profile.resumePath)) {
      resumeUploaded = await uploadResumeFile(page, profile.resumePath);
    }

    // Work-authorization first (Yes/No radio or checkbox), then GDPR/consent.
    await selectWorkAuthorizationYes(page);
    await checkBoxesForLabels(page, /work authorization|authorized to work|right to work|work permit/i);
    await checkBoxesForLabels(page, /agree|consent|privacy|terms|gdpr/i);

    const submitButton = page
      .getByRole("button", { name: /submit|send application|apply now/i })
      .or(page.locator('button[type="submit"]'))
      .first();
    if ((await submitButton.count().catch(() => 0)) === 0) {
      const screenshotPath = await saveDebugScreenshot(page, ctx.gigId);
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        externalRef: page.url(),
        error: `${PLATFORM}: application form opened but no submit control found (fields filled: ${fieldsFilled}, resume uploaded: ${resumeUploaded ? "yes" : "no"}) — manual review needed; final URL ${page.url()}, screenshot ${screenshotPath}`,
      };
    }

    await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await submitButton.click({ timeout: 10_000 });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 20_000 })
      .catch(() => undefined);
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);

    let success = await detectSuccessSignal(page);
    for (let i = 0; i < 8 && !success; i += 1) {
      await page.waitForTimeout(1_000);
      success = await detectSuccessSignal(page);
    }

    if (success && (fieldsFilled > 0 || resumeUploaded)) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "submitted",
        externalRef: page.url(),
      };
    }

    const formError = await detectFormError(page);
    const screenshotPath = await saveDebugScreenshot(page, ctx.gigId);
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "drafted",
      externalRef: page.url(),
      error:
        formError ??
        `${PLATFORM}: submit clicked but no success confirmation observed (fields filled: ${fieldsFilled}, resume uploaded: ${
          resumeUploaded ? "yes" : "no"
        }) — final URL ${page.url()}, screenshot ${screenshotPath}`,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: browser submit failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
