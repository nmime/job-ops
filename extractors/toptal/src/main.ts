import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
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

const PLATFORM = "toptal" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_TOPTAL";
const LEVER_API = "https://api.lever.co/v0/postings/toptal?mode=json";
const LEVER_APPLY_BASE = "https://jobs.lever.co/toptal";
/** Lever forms for Toptal are served from jobs.lever.co — the session cookie
 *  has to reach BOTH the toptal.com and lever.co domains. */
const LEVER_COOKIE_DOMAINS = [".toptal.com", ".lever.co"];
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** Lever posting ids are UUIDs; anything else (e.g. the 32-char dedupHash the
 *  orchestrator currently passes as gigId) is a wiring bug, not a posting. */
const LEVER_POSTING_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Toptal — REAL adapter.
 *
 * Discovery is CREDENTIAL-FREE: Toptal publishes its openings on Lever, and
 * the Lever postings API is public:
 *   GET https://api.lever.co/v0/postings/toptal?mode=json
 * Returns an array of postings {id, text, hostedUrl, categories, ...}.
 * We fetch the full list once and filter client-side by search terms against
 * title + plain-text description. No API key or cookie is required.
 *
 * NOTE: this board mostly lists Toptal's own internal roles; Toptal does not
 * expose a public client-project feed for freelancers.
 *
 * Submit: Toptal has no public application API. With a session cookie
 * (JOBOPS_FREELANCE_TOPTAL_COOKIE) the real path drives the Lever-hosted
 * apply form in a real browser (Playwright): it fills name/email/phone/
 * location, the cover letter into the card textareas, uploads a resume when
 * one is provided, ticks consent boxes, then clicks the real submit control
 * and only reports "submitted" after Lever's confirmation is observed.
 * Every unconfirmed outcome is reported as "drafted" (or "error") with a
 * precise reason — a page load is never mistaken for a submission.
 */

type LeverPosting = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  categories?: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  };
};

/** What the orchestrator may carry for an applicant. name/email/coverLetter
 *  are required for a real submission; the rest are best-effort. */
interface ApplyProfile {
  name?: string;
  email?: string;
  coverLetter?: string;
  skills?: string[] | string;
  phone?: string;
  location?: string;
  company?: string;
  resumePath?: string;
  resumeFile?: string;
  resume?: string;
}

type Browser = import("playwright").Browser;
type Page = import("playwright").Page;
type Locator = import("playwright").Locator;

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

function matchesTerms(posting: LeverPosting, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${posting.text ?? ""} ${posting.descriptionPlain ?? ""} ${
    posting.categories?.team ?? ""
  } ${posting.categories?.department ?? ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function postingToGig(posting: LeverPosting): CreateGigInput {
  const categories = posting.categories ?? {};
  const location =
    categories.allLocations?.join("; ") ?? categories.location ?? undefined;
  return makeGig({
    platform: PLATFORM,
    sourceGigId: posting.id,
    title: posting.text ?? "Untitled role",
    clientOrEmployer: "Toptal",
    gigUrl:
      posting.hostedUrl ?? `https://jobs.lever.co/toptal/${posting.id ?? ""}`,
    applicationLink: posting.hostedUrl,
    datePosted: posting.createdAt
      ? new Date(posting.createdAt).toISOString()
      : undefined,
    gigDescription: posting.descriptionPlain ?? undefined,
    skillsRequired: [categories.team, categories.department].filter(
      (value): value is string => Boolean(value),
    ),
    jobType: categories.commitment ?? undefined,
    isRemote:
      posting.workplaceType?.toLowerCase() === "remote" ||
      (location ?? "").toLowerCase().includes("remote"),
    location,
  });
}

export async function findToptalGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching Lever postings feed`);
    const res = await fetchWithTimeout(LEVER_API, 15_000, {
      headers: {
        "User-Agent": FREELANCE_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: Lever feed HTTP ${res.status} — retry later or set ${ENV_PREFIX}_COOKIE for authenticated discovery`,
      });
    }
    const postings = (await res.json()) as LeverPosting[];
    if (!Array.isArray(postings)) {
      return stubNotFound({
        platform: PLATFORM,
        message: `${PLATFORM}: unexpected Lever response shape (expected array)`,
      });
    }

    const terms = ctx.searchTerms
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    for (const posting of postings) {
      if (!posting.id || seen.has(posting.id)) continue;
      if (!matchesTerms(posting, terms)) continue;
      seen.add(posting.id);
      gigs.push(postingToGig(posting));
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Apply — real Lever form submission
// ---------------------------------------------------------------------------

function parseCookieHeader(
  cookie: string,
): Array<{ name: string; value: string }> {
  return cookie.split(";").flatMap((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return name && rest.length
      ? [{ name: name.trim(), value: rest.join("=") }]
      : [];
  });
}

function splitFullName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function normalizeSkills(skills?: string[] | string): string[] {
  if (!skills) return [];
  const list = Array.isArray(skills) ? skills : skills.split(/[,;]/);
  return list
    .map((skill) => skill.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function firstSentence(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = clean.split(/[.!?]\s/)[0] ?? clean;
  return first.slice(0, max).trim();
}

/** Deterministic, honest answer for Lever's custom card questions. Same
 *  spirit as the orchestrator's buildDeterministicProposal: templated
 *  professional text derived from the profile, never invented facts. */
function cardAnswer(
  question: string,
  skills: string[],
  coverLetter: string,
): string {
  const skillList = skills.slice(0, 6).join(", ");
  const lead = firstSentence(coverLetter);
  const q = question.toLowerCase();
  if (/impact|accomplishment|proud|achievement/.test(q)) {
    return `${lead} In practice that means owning end-to-end delivery: agreeing scope and acceptance criteria up front, shipping a reviewable increment early, and handing over documented, tested work the team can build on without rework.`;
  }
  if (/attribute|environment|thrive|culture|team/.test(q)) {
    return `I do my best work where ownership is expected and feedback is direct: small senior teams, clear decision-making, and code that gets reviewed. My core stack${skillList ? ` — ${skillList}` : ""} — lets me contribute from the first week.`;
  }
  if (/project|love to work|interest|looking for/.test(q)) {
    return `I want to work on projects where ${skillList || "my core stack"} meets real user impact: production systems, measurable outcomes, and a clear path from spec to shipped. ${lead}`;
  }
  if (/availability|start|rate|timeline|when/.test(q)) {
    return "I am available to start promptly and can commit to the engagement timeline described in the listing.";
  }
  return lead;
}

/** Lever card questions whose label should receive the actual cover letter. */
const COVER_LETTER_LABEL =
  /cover letter|additional information|about yourself|tell us|why (you|me)|introduction/i;

async function textareaLabel(ta: Locator): Promise<string> {
  return ta
    .evaluate((el) => {
      const question =
        el.closest("li, .application-question, fieldset, .field") ??
        el.parentElement;
      const label =
        question?.querySelector(".application-label, label, legend") ?? null;
      return label ? (label.textContent ?? "").replace(/\s+/g, " ").trim() : "";
    })
    .catch(() => "");
}

interface FillReport {
  filled: string[];
  skipped: string[];
}

/** Fill the Lever apply form fields. Returns what was filled/skipped;
 *  never throws — a missing optional field is recorded, not fatal. */
async function fillLeverForm(
  page: Page,
  profile: {
    name: string;
    email: string;
    phone?: string;
    location?: string;
    company?: string;
    coverLetter: string;
  },
  skills: string[],
): Promise<FillReport> {
  const report: FillReport = { filled: [], skipped: [] };
  const count = async (locator: Locator) => locator.count().catch(() => 0);

  // Name — Lever boards differ: some use first_name/last_name, Toptal's
  // hosted form uses a single "Full name" field (input[name=name]).
  const firstName = page.locator(
    'input[name="first_name"], input[name="firstName"]',
  );
  const lastName = page.locator(
    'input[name="last_name"], input[name="lastName"]',
  );
  if ((await count(firstName)) > 0 && (await count(lastName)) > 0) {
    const parts = splitFullName(profile.name);
    await firstName.first().fill(parts.first);
    await lastName.first().fill(parts.last);
    report.filled.push("first_name", "last_name");
  } else {
    const fullName = page.locator('input[name="name"]');
    if ((await count(fullName)) > 0) {
      await fullName.first().fill(profile.name);
      report.filled.push("full_name");
    } else {
      report.skipped.push("name (no name input found on the form)");
    }
  }

  const emailInput = page.locator('input[name="email"]');
  if ((await count(emailInput)) > 0) {
    await emailInput.first().fill(profile.email);
    report.filled.push("email");
  } else {
    report.skipped.push("email (no email input found on the form)");
  }

  const optional: Array<[Locator, string, string | undefined]> = [
    [
      page.locator('input[name="phone"], input[name="phone_number"]'),
      "phone",
      profile.phone,
    ],
    [
      page.locator('input[name="org"], input[name="company"]'),
      "company",
      profile.company,
    ],
  ];
  for (const [locator, label, value] of optional) {
    if (!value?.trim()) continue; // optional on the form — leave untouched
    if ((await count(locator)) > 0) {
      await locator.first().fill(value.trim());
      report.filled.push(label);
    }
  }

  // Location has an autocomplete: type the value, then accept the first
  // dropdown suggestion when one appears (that also populates the hidden
  // selectedLocation field). If nothing matches, the field keeps whatever
  // Lever retains — it is optional on the form, so never fatal.
  const locationInput = page
    .locator('input[name="location"], input[name="current_location"]')
    .first();
  if (profile.location?.trim()) {
    if ((await count(locationInput)) > 0) {
      await locationInput.fill(profile.location.trim());
      try {
        await page.waitForTimeout(1_000);
        const suggestion = page
          .locator(
            ".dropdown-results li, .dropdown-results div[role='option'], .dropdown-results a",
          )
          .first();
        if (await suggestion.isVisible().catch(() => false)) {
          await suggestion.click({ timeout: 3_000 });
        }
      } catch {
        /* optional field — the typed value stands */
      }
      const retained = (
        await locationInput.inputValue().catch(() => "")
      ).trim();
      if (retained) {
        report.filled.push("location");
      } else {
        report.skipped.push(
          "location (typed value not retained — no autocomplete match)",
        );
      }
    }
  }

  // Cover letter + Lever's custom card textareas. The cover letter goes into
  // the textarea whose label matches best (falling back to the first one);
  // the remaining card questions get templated answers from the profile so
  // the application is complete rather than rejected on required fields.
  const textareas = page.locator("textarea");
  const total = await count(textareas);
  const visible: number[] = [];
  for (let i = 0; i < total; i += 1) {
    if (
      await textareas
        .nth(i)
        .isVisible()
        .catch(() => false)
    )
      visible.push(i);
  }
  if (visible.length === 0) {
    report.skipped.push("cover letter (no textarea found on the form)");
  } else {
    // DOM index of the textarea that should receive the actual cover
    // letter (best label match, else the first visible one).
    let coverDomIndex = -1;
    for (const k of visible) {
      const label = await textareaLabel(textareas.nth(k));
      if (COVER_LETTER_LABEL.test(label)) {
        coverDomIndex = k;
        break;
      }
    }
    if (coverDomIndex === -1) coverDomIndex = visible[0];
    for (const i of visible) {
      const ta = textareas.nth(i);
      const label = await textareaLabel(ta);
      const answer =
        i === coverDomIndex
          ? profile.coverLetter
          : cardAnswer(
              label || `Question ${i + 1}`,
              skills,
              profile.coverLetter,
            );
      await ta.fill(answer);
      report.filled.push(
        i === coverDomIndex
          ? "cover_letter"
          : `card answer: ${(label || "unnamed question").slice(0, 60)}`,
      );
    }
  }

  return report;
}

/** Upload the resume into the Lever file input when a file was provided.
 *  Lever uploads the file asynchronously after the input change; we wait a
 *  bounded time for the success/failure indicator but do not treat the wait
 *  as a submission gate (a slow parse must not block the click). */
async function uploadResume(
  page: Page,
  resumePath?: string,
): Promise<
  | { status: "uploaded"; detail?: string }
  | { status: "skipped"; detail: string }
  | { status: "failed"; detail: string }
> {
  const input = page
    .locator('input[type="file"][name="resume"]')
    .or(page.locator('input[type="file"]'))
    .first();
  if ((await input.count().catch(() => 0)) === 0) {
    return { status: "skipped", detail: "no resume file input on the form" };
  }
  if (!resumePath?.trim()) {
    return { status: "skipped", detail: "no resume file in profile" };
  }
  try {
    await stat(resumePath);
  } catch {
    return {
      status: "failed",
      detail: `resume file not found at ${resumePath}`,
    };
  }
  const buffer = await readFile(resumePath);
  try {
    await input.setInputFiles({
      name: basename(resumePath) || "resume.pdf",
      mimeType: "application/pdf",
      buffer,
    });
  } catch (error) {
    return {
      status: "failed",
      detail: `setInputFiles failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const indicator = page
    .locator(".resume-upload-success, .resume-upload-failure")
    .first();
  try {
    await indicator.waitFor({ state: "visible", timeout: 20_000 });
    const text = (await indicator.innerText().catch(() => "")) || "confirmed";
    return {
      status: "uploaded",
      detail: `Lever resume upload: ${text.trim()}`,
    };
  } catch {
    return {
      status: "uploaded",
      detail:
        "file set on the resume input; Lever's async upload state unconfirmed within 20s",
    };
  }
}

/** Tick the consent/privacy checkboxes Lever sometimes renders near the
 *  submit button (job-side pattern from application-browser.ts). */
async function checkConsentBoxes(page: Page): Promise<number> {
  const boxes = page.locator(
    'form input[type="checkbox"], label:has-text("agree") input[type="checkbox"], label:has-text("consent") input[type="checkbox"], label:has-text("privacy") input[type="checkbox"], label:has-text("terms") input[type="checkbox"]',
  );
  const total = Math.min(await boxes.count().catch(() => 0), 5);
  let clicked = 0;
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    if (await box.isChecked().catch(() => false)) continue;
    if (!(await box.isVisible().catch(() => false))) continue;
    await box.check({ timeout: 5_000 }).catch(() => undefined);
    clicked += 1;
  }
  return clicked;
}

interface HcaptchaState {
  inputFound: boolean;
  widgetVisible: boolean;
  iframePresent: boolean;
  tokenPresent: boolean;
  rendered: boolean;
}

async function probeCaptcha(page: Page): Promise<HcaptchaState> {
  return page
    .evaluate<HcaptchaState>(() => {
      const input =
        document.getElementById("hcaptchaResponseInput") ??
        document.querySelector('input[name="h-captcha-response"]');
      const widget =
        document.getElementById("h-captcha") ??
        document.querySelector(".h-captcha");
      const rect = widget ? widget.getBoundingClientRect() : null;
      // The page declares `let captchaId` at top level (a lexical binding —
      // NOT on window), so it must be referenced bare inside a function
      // compiled in the page context.
      let rendered = false;
      try {
        const check = new Function(
          "try { return typeof captchaId === 'string'; } catch (e) { return false; }",
        );
        rendered = Boolean(check());
      } catch {
        rendered = false; // captcha script has not initialised yet
      }
      return {
        inputFound: Boolean(input),
        widgetVisible: Boolean(rect && rect.height > 0),
        iframePresent: Boolean(widget?.querySelector("iframe")),
        tokenPresent: Boolean(
          input && input instanceof HTMLInputElement && input.value,
        ),
        rendered,
      };
    })
    .catch(() => ({
      inputFound: false,
      widgetVisible: false,
      iframePresent: false,
      tokenPresent: false,
      rendered: false,
    }));
}

type CaptchaGate =
  | { gate: "none" }
  | { gate: "token" }
  | { gate: "pending"; detail: string };

/**
 * Figure out the hCaptcha situation right before the submit click.
 *  - "none":  no captcha input/widget in the DOM (form submits directly)
 *  - "token": a captcha token is already present
 *  - "pending": captcha present, no token yet. We do the best-effort human
 *    steps (click the checkbox only when allowCaptcha, trigger invisible
 *    mode) and the submit phase decides the outcome: Lever's own handler
 *    auto-submits once a token lands, so a pending gate can still become a
 *    real submission.
 */
async function awaitCaptchaGate(
  page: Page,
  allowCaptcha: boolean,
): Promise<CaptchaGate> {
  let state = await probeCaptcha(page);
  // The React form hydrates in stages — the captcha inputs may appear a
  // couple of seconds after the text fields. Give them a grace period.
  const graceDeadline = Date.now() + 10_000;
  while (
    !state.inputFound &&
    !state.widgetVisible &&
    Date.now() < graceDeadline
  ) {
    await page.waitForTimeout(1_000);
    state = await probeCaptcha(page);
  }
  if (!state.inputFound && !state.widgetVisible) return { gate: "none" };
  if (state.tokenPresent) return { gate: "token" };

  if (state.iframePresent && allowCaptcha) {
    await page
      .locator("#h-captcha iframe, .h-captcha iframe")
      .first()
      .click({ position: { x: 32, y: 32 }, timeout: 5_000 })
      .catch(() => undefined);
  }
  if (state.rendered) {
    // Trigger managed/invisible mode (Lever's own submit handler does the
    // same; doing it early just starts the clock sooner). `captchaId` is a
    // top-level lexical binding, so the call must run in the page context.
    await page
      .evaluate(
        "() => { try { hcaptcha.execute(captchaId); return true; } catch (e) { return false; } }",
      )
      .catch(() => undefined);
  }
  return {
    gate: "pending",
    detail: state.rendered
      ? "invisible/managed hCaptcha triggered, waiting for a token"
      : "hCaptcha input present but the challenge has not initialised on this page yet",
  };
}

/** Click the real submit control, then wait for a CONFIRMED outcome:
 *  Lever replaces the form with a .confirmation-message block (or a
 *  thank-you page) on success, or reveals .error-message validation errors
 *  when the form is rejected. With a "pending" captcha gate, Lever's own
 *  handler auto-submits once an invisible token lands — so the same loop
 *  also distinguishes "token never arrived" from "submitted but unconfirmed".
 *  Anything else is "no-signal". */
async function submitAndConfirm(
  page: Page,
  captcha: CaptchaGate,
): Promise<{
  outcome:
    | "submitted"
    | "validation"
    | "no-signal"
    | "captcha-unsolved"
    | "token-no-signal";
  errors: string[];
  finalUrl: string;
}> {
  // Lever's visible submit control is #btn-submit (type=button — Lever's JS
  // drives the hidden #hcaptchaSubmitBtn after the captcha token is present).
  // Prefer it explicitly; only fall back to generic submit controls when it
  // is absent, so we never click the hidden captcha button by accident.
  const directSubmit = page.locator("#btn-submit");
  let submitBtn: Locator;
  if ((await directSubmit.count().catch(() => 0)) > 0) {
    submitBtn = directSubmit.first();
  } else {
    submitBtn = page
      .locator("button[type='submit']:visible, input[type='submit']:visible")
      .or(page.getByRole("button", { name: /submit|apply/i }))
      .first();
  }
  await submitBtn.click({ timeout: 15_000 });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(750);
    const state = await page
      .evaluate<{
        confirmVisible: boolean;
        formGone: boolean;
        thankYou: boolean;
        tokenPresent: boolean;
        errors: string[];
      }>(() => {
        const visible = (el: Element): boolean => {
          const cs = getComputedStyle(el as HTMLElement);
          const rect = el.getBoundingClientRect();
          return (
            cs.display !== "none" &&
            cs.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const confirm = document.querySelector(".confirmation-message");
        const confirmVisible =
          Boolean(confirm) && visible(confirm as HTMLElement);
        const formGone = !document.querySelector(
          'input[name="name"], input[name="first_name"], #btn-submit',
        );
        const text = (document.body?.innerText ?? "").toLowerCase();
        const thankYou =
          /thank you|received your application|application (has been |was )?(submitted|sent|complete)|we'?ll be in touch/.test(
            text,
          );
        const tokenInput =
          document.getElementById("hcaptchaResponseInput") ??
          document.querySelector('input[name="h-captcha-response"]');
        // Only COUNT error messages that are actually rendered — Lever ships
        // hidden template messages (e.g. the resume-oversize span) that
        // would otherwise look like validation failures.
        const errors = Array.from(
          document.querySelectorAll(
            ".error-message, .field-error, [role='alert']",
          ),
        )
          .filter((el) => visible(el))
          .map((el) => (el as HTMLElement).innerText)
          .map((t) => t.replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 0 && t.length < 200);
        return {
          confirmVisible,
          formGone,
          thankYou,
          tokenPresent: Boolean(
            tokenInput &&
              tokenInput instanceof HTMLInputElement &&
              tokenInput.value,
          ),
          errors: Array.from(new Set(errors)).slice(0, 8),
        };
      })
      .catch(() => null);
    if (!state) continue;
    if (state.confirmVisible || (state.formGone && state.thankYou)) {
      return { outcome: "submitted", errors: [], finalUrl: page.url() };
    }
    if (state.errors.length > 0) {
      const formStillThere = await page
        .locator('input[name="name"], input[name="first_name"], #btn-submit')
        .count()
        .catch(() => 0);
      if (formStillThere > 0) {
        return {
          outcome: "validation",
          errors: state.errors,
          finalUrl: page.url(),
        };
      }
    }
  }
  if (captcha.gate === "pending") {
    const late = await page
      .evaluate<boolean>(
        "() => { const el = document.getElementById('hcaptchaResponseInput') || document.querySelector('input[name=\"h-captcha-response\"]'); return Boolean(el && el instanceof HTMLInputElement && el.value); }",
      )
      .catch(() => false);
    return {
      outcome: late ? "token-no-signal" : "captcha-unsolved",
      errors: [],
      finalUrl: page.url(),
    };
  }
  return { outcome: "no-signal", errors: [], finalUrl: page.url() };
}

/**
 * Toptal apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_TOPTAL_APPLY_ENABLED=true. The real path drives the
 * Lever-hosted apply form in a real browser with the operator's session
 * cookie (scoped to both .toptal.com and .lever.co), fills every field the
 * profile carries, and submits for real. It reports "submitted" ONLY after
 * Lever's confirmation is observed; every other outcome is "drafted" or
 * "error" with a precise reason.
 */
export async function applyToToptalGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and ${ENV_PREFIX}_COOKIE to a valid Lever session cookie to submit for real)`,
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

  const profile = (ctx.profile ?? {}) as ApplyProfile;
  if (
    !profile.name?.trim() ||
    !profile.email?.trim() ||
    !profile.coverLetter?.trim()
  ) {
    const missing = [
      !profile.name?.trim() ? "name" : null,
      !profile.email?.trim() ? "email" : null,
      !profile.coverLetter?.trim() ? "coverLetter" : null,
    ].filter((field): field is string => field !== null);
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: profile missing required field(s) ${missing.join(", ")} — a real Lever application needs at least {name, email, coverLetter}`,
    };
  }
  const name = profile.name.trim();
  const email = profile.email.trim();
  const coverLetter = profile.coverLetter.trim();
  const skills = normalizeSkills(profile.skills);
  const resumePath = [profile.resumePath, profile.resumeFile, profile.resume]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);

  if (!LEVER_POSTING_ID.test(ctx.gigId)) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: gigId "${ctx.gigId}" is not a Lever posting id (expected a UUID — the gig's sourceGigId); the apply URL ${LEVER_APPLY_BASE}/${ctx.gigId}/apply would 404. Fix the orchestrator wiring (it currently passes gig.dedupHash instead of gig.sourceGigId)`,
    };
  }

  const applyUrl = `${LEVER_APPLY_BASE}/${ctx.gigId}/apply`;
  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    const parsedCookies = parseCookieHeader(cookie);
    if (parsedCookies.length === 0) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: ${ENV_PREFIX}_COOKIE is not a valid cookie header (expected "name=value; name2=value2")`,
      };
    }
    // The session must be present on BOTH domains: the Toptal cookie was
    // copied from toptal.com, but the Lever form itself is served from
    // jobs.lever.co.
    await context.addCookies(
      parsedCookies.flatMap(({ name, value }) =>
        LEVER_COOKIE_DOMAINS.map((domain) => ({
          name,
          value,
          domain,
          path: "/",
        })),
      ),
    );
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(25_000);
    const response = await page.goto(applyUrl, {
      waitUntil: "domcontentloaded",
    });
    if (!response || !response.ok()) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: apply page unreachable (HTTP ${response?.status() ?? "no response"}) for ${applyUrl}`,
      };
    }

    // The apply form is server-rendered; wait until it actually exists.
    const formControl = page
      .locator(
        "#application-form input[name='name'], #application-form input[name='email'], #btn-submit",
      )
      .first();
    try {
      await formControl.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      const pageHint = await page
        .evaluate(() =>
          (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 160),
        )
        .catch(() => "");
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: Lever apply form did not appear at ${applyUrl} (position closed, or the session cookie was not recognized — page says: "${pageHint}")`,
      };
    }

    const fillReport = await fillLeverForm(
      page,
      {
        name,
        email,
        phone: profile.phone,
        location: profile.location,
        company: profile.company,
        coverLetter,
      },
      skills,
    );
    if (!fillReport.filled.includes("email")) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        error: `${PLATFORM}: email field not found on the Lever form at ${applyUrl} — form layout changed, cannot submit without a recipient address`,
      };
    }

    const resume = await uploadResume(page, resumePath);
    if (resume.status === "failed") {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        externalRef: applyUrl,
        error: `${PLATFORM}: form filled but resume upload failed — ${resume.detail}; nothing was submitted. Fields filled: ${fillReport.filled.join(", ")}`,
      };
    }
    const consentClicked = await checkConsentBoxes(page);
    const captcha = await awaitCaptchaGate(page, ctx.allowCaptcha);

    const outcome = await submitAndConfirm(page, captcha);
    if (outcome.outcome === "submitted") {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "submitted",
        externalRef: applyUrl,
        ...(captcha.gate !== "none"
          ? {
              captcha: {
                attempted: true,
                solved: true,
                type: "hcaptcha",
                provider: null,
                message: "hCaptcha token present at submit time",
              },
            }
          : {}),
      };
    }
    if (outcome.outcome === "validation") {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        externalRef: applyUrl,
        error: `${PLATFORM}: Lever rejected the submission with form validation errors: ${outcome.errors.join(" | ")} — nothing was submitted; fix the profile/required fields and retry. Filled so far: ${fillReport.filled.join(", ")}`,
      };
    }
    if (outcome.outcome === "captcha-unsolved") {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        externalRef: applyUrl,
        captcha: {
          attempted: true,
          solved: false,
          type: "hcaptcha",
          provider: null,
          message:
            "no invisible hCaptcha token within 45s — no hCaptcha solver is wired into the repo (JOBOPS_FREELANCE_ALLOW_CAPTCHA=true only clicks a visible checkbox)",
        },
        error: `${PLATFORM}: the Lever form is hCaptcha-protected and no token was obtained within 45s. The form at ${applyUrl} was fully filled (fields: ${fillReport.filled.join(", ")}) but NOT submitted — no data left this browser`,
      };
    }
    if (outcome.outcome === "token-no-signal") {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "drafted",
        externalRef: applyUrl,
        captcha: {
          attempted: true,
          solved: true,
          type: "hcaptcha",
          provider: null,
          message: "token obtained; Lever's handler should have submitted",
        },
        error: `${PLATFORM}: an hCaptcha token was obtained and Lever's own handler should have submitted the form, but no success signal (confirmation/thank-you) was confirmed within 45s — final state at ${outcome.finalUrl}. Treat this application as NOT submitted and verify manually`,
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "drafted",
      externalRef: applyUrl,
      error: `${PLATFORM}: submit control was clicked but no success signal (Lever confirmation/thank-you) was confirmed within 45s — final state at ${outcome.finalUrl}. Treat this application as NOT submitted and verify manually (fields filled: ${fillReport.filled.join(", ")}; consent boxes ticked: ${consentClicked})`,
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
