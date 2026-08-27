import { existsSync } from "node:fs";
import {
  fetchWithTimeout,
  reportProgress,
  stubNotFound,
} from "freelance-shared";
import type { Browser, Locator, Page } from "playwright";
import type {
  CreateGigInput,
  FreelanceApplyContext,
  FreelanceApplyResult,
  FreelanceFinderContext,
  FreelanceFinderResult,
} from "job-ops-shared/types/freelance";

const PLATFORM = "turing" as const;
const ENV_PREFIX = "JOBOPS_FREELANCE_TURING";
const BOARD_API = "https://boards-api.greenhouse.io/v1/boards/turing/jobs";
const GREENHOUSE_BOARD_BASE = "https://job-boards.greenhouse.io/turing";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Turing — REAL credential-free adapter.
 *
 * Discovery uses Turing's public Greenhouse board (no key required, verified
 * live): GET https://boards-api.greenhouse.io/v1/boards/turing/jobs?content=true
 * HTML job content is stripped to plain text and filtered client-side against
 * ctx.searchTerms on title + description.
 *
 * Applying happens on the hosted Greenhouse board. When the gig record
 * (passed through ctx.profile) or the gig id resolves to a per-gig Greenhouse
 * posting, the submit path drives the real application form in a browser:
 * open the posting, fill name/email/phone + cover letter, upload the resume
 * if the form has a file input, tick consent boxes, click the real Apply
 * control, and only report "submitted" after a Greenhouse success signal
 * (confirmation URL or a "thank you / application submitted" page state).
 * Anything short of a confirmed success is "error" with the precise reason —
 * never "submitted". If the gig carries no per-gig posting (pure network
 * pipeline), the result is an honest "skipped": the only apply path on the
 * Turing network is the one-time network application.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_TURING_APPLY_ENABLED=true, and the submit path additionally
 * requires JOBOPS_FREELANCE_TURING_API_KEY or _COOKIE to be configured.
 */

type TuringJob = {
  id: number;
  title?: string | null;
  absolute_url?: string | null;
  location?: { name?: string | null } | null;
  updated_at?: string | null;
  first_published?: string | null;
  content?: string | null;
  departments?: Array<{ name?: string | null }> | null;
  company_name?: string | null;
};

/**
 * What the apply path may receive in ctx.profile (typed `unknown` by the
 * contract). The manual apply path can pass a candidate profile, the gig
 * record, or both merged into one object. Field names follow the hosted
 * Greenhouse form fields observed on the Turing board (First/Last Name,
 * Email, Country, Phone, Resume/CV, Cover letter, LinkedIn, Website,
 * Education).
 */
interface TuringApplyProfile {
  coverLetter?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  country?: string;
  resumePath?: string;
  resumeFile?: string;
  coverLetterPath?: string;
  linkedinProfile?: string;
  website?: string;
  education?: { school?: string; degree?: string; discipline?: string };
  /**
   * Answers for custom file-upload questions on a posting (e.g. a writing
   * sample). `match` is a case-insensitive substring of the question text
   * that identifies the file field.
   */
  questionFiles?: Array<{ match: string; path: string }>;
  // gig record passthrough (so the posting can be resolved without a live
  // Greenhouse lookup)
  gigUrl?: string;
  applicationLink?: string;
  sourceGigId?: string;
}

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

/** Decode HTML entities (twice — Greenhouse content is double-escaped) and strip tags. */
function htmlToText(html: string): string {
  const decode = (value: string) =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  const once = decode(html);
  const twice = decode(once);
  return twice
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesTerms(job: TuringJob, terms: string[], text: string): boolean {
  if (!terms.length) return true;
  const haystack = `${job.title ?? ""} ${text}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.trim().toLowerCase()));
}

function toGig(job: TuringJob, description: string): CreateGigInput {
  const url =
    job.absolute_url ??
    `https://job-boards.greenhouse.io/turing/jobs/${job.id}`;
  return {
    platform: PLATFORM,
    sourceGigId: String(job.id),
    title: job.title ?? "Untitled Turing role",
    clientOrEmployer: job.company_name ?? "Turing",
    gigUrl: url,
    applicationLink: `${url}#app`,
    datePosted: job.first_published ?? job.updated_at ?? undefined,
    gigDescription: description.slice(0, 4000) || undefined,
    skillsRequired: (job.departments ?? [])
      .map((dept) => dept.name)
      .filter((name): name is string => Boolean(name)),
    jobType: "contract",
    isRemote: job.location?.name ? /remote/i.test(job.location.name) : true,
    location: job.location?.name ?? "Remote",
  };
}

export async function findTuringGigs(
  ctx: FreelanceFinderContext,
): Promise<FreelanceFinderResult> {
  try {
    reportProgress(ctx, `${PLATFORM}: fetching Greenhouse board`);
    const res = await fetchWithTimeout(`${BOARD_API}?content=true`, 15_000, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Turing Greenhouse board HTTP ${res.status}`);
    }
    const json = (await res.json()) as { jobs?: TuringJob[] };

    const terms = (ctx.searchTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 5);

    const gigs: CreateGigInput[] = [];
    const seen = new Set<string>();
    for (const job of json.jobs ?? []) {
      const id = String(job.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const description = htmlToText(job.content ?? "");
      if (!matchesTerms(job, terms, description)) continue;
      gigs.push(toGig(job, description));
    }

    reportProgress(ctx, `${PLATFORM} returned ${gigs.length} gigs`);
    return { success: true, gigs: gigs.slice(0, 250) };
  } catch (error) {
    return stubNotFound({
      platform: PLATFORM,
      message: `${PLATFORM}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}


// --- Greenhouse apply-flow helpers (real browser submission) ---

interface GreenhousePosting {
  url: string;
  jobId: string;
}

/**
 * Normalize any Greenhouse job URL (with #app anchors, tracking params or
 * board hosts/paths) to the canonical posting URL + job id. Returns
 * undefined when the string is not a per-gig Greenhouse posting.
 */
export function normalizeGreenhouseUrl(raw: string): GreenhousePosting | undefined {
  const match = raw.match(/(https?:\/\/[^/]*greenhouse\.io[^#?]*?)\/jobs\/(\d+)/i);
  if (!match) return undefined;
  return { url: `${match[1].replace(/\/$/, "")}/jobs/${match[2]}`, jobId: match[2] };
}

/**
 * Resolve the per-gig Greenhouse posting for this apply call. Sources, in
 * order: an explicit Greenhouse URL on the gig record (ctx.profile), a
 * numeric gig source id, or a numeric ctx.gigId (only true when the caller
 * passed the Greenhouse job id directly — the worker passes a dedupe hash).
 */
function resolveGreenhousePosting(
  ctx: FreelanceApplyContext,
  profile: TuringApplyProfile,
): GreenhousePosting | undefined {
  for (const candidate of [profile.applicationLink, profile.gigUrl]) {
    if (candidate) {
      const normalized = normalizeGreenhouseUrl(candidate.trim());
      if (normalized) return normalized;
    }
  }
  const sourceId = profile.sourceGigId?.trim();
  const numericId =
    sourceId && /^\d{2,}$/.test(sourceId)
      ? sourceId
      : /^\d{2,}$/.test(ctx.gigId)
        ? ctx.gigId
        : undefined;
  if (numericId) {
    return {
      url: `${GREENHOUSE_BOARD_BASE}/jobs/${numericId}`,
      jobId: numericId,
    };
  }
  return undefined;
}

/** Success phrases Greenhouse shows after a confirmed submission. */
const GREENHOUSE_CONFIRMATION_TEXTS = [
  "thank you for your application",
  "thank you for applying",
  "thanks for applying",
  "your application was submitted",
  "your application has been submitted",
  "application submitted",
  "application received",
  "we received your application",
  "we've received your application",
  "we have received your application",
  "successfully submitted",
  "submitted successfully",
  "application sent",
];

/** Signals that the form rejected the submission (validation / bot gate). */
const GREENHOUSE_BLOCKING_TEXTS = [
  "this field is required",
  "please fill out all required fields",
  "invalid email",
  "email address is invalid",
  "unusual traffic",
  "are you a robot",
  "please verify you are human",
  "access denied",
];

/**
 * Common profile spellings -> Greenhouse's canonical degree labels (the
 * hosted board's degree list uses "Master's Degree", not "Masters").
 */
const DEGREE_LABEL_ALIASES: Record<string, string> = {
  master: "Master's Degree",
  masters: "Master's Degree",
  bachelor: "Bachelor's Degree",
  bachelors: "Bachelor's Degree",
  associate: "Associate's Degree",
  phd: "Doctor of Philosophy (Ph.D.)",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the input id of a react-select combobox by its label text (the
 * Country / School / Degree / Discipline fields on hosted Greenhouse boards
 * are react-select controls, e.g. <label for="country">Country*
 * <input id="country" class="select__input">).
 */
async function reactSelectIdByLabel(
  page: Page,
  labelPattern: string,
): Promise<string | undefined> {
  return page
    .evaluate((src) => {
      const re = new RegExp(src, "i");
      for (const label of Array.from(document.querySelectorAll("label"))) {
        const text = (label.innerText || "").replace(/\s+/g, " ").trim();
        const forId = label.getAttribute("for");
        if (forId && re.test(text)) return forId;
      }
      return undefined;
    }, labelPattern)
    .catch(() => undefined);
}

/**
 * Fill a react-select combobox (Country / School / Degree / Discipline on
 * the hosted Greenhouse board). Options only render in response to real
 * keystrokes — typing character by character, then clicking the best
 * matching option (exact, then prefix, then substring; the menu is already
 * filtered by the typed text). Returns false when nothing could be
 * selected — the required-field audit then reports the field honestly.
 */
async function fillReactSelect(
  page: Page,
  inputId: string,
  value: string,
): Promise<boolean> {
  try {
    const input = page.locator(`#${inputId}`);
    if (!(await input.count())) return false;
    await input.click({ timeout: 5_000 });
    await input.fill("").catch(() => undefined); // clear any previous filter text
    await input.pressSequentially(value, { delay: 30, timeout: 5_000 });
    const options = page.locator(".select__option");
    await options
      .first()
      .waitFor({ timeout: 5_000, state: "visible" })
      .catch(() => undefined);
    const exact = options
      .filter({ hasText: new RegExp(`^${escapeRegExp(value)}$`, "i") })
      .first();
    const starts = options
      .filter({ hasText: new RegExp(`^${escapeRegExp(value)}\\b`, "i") })
      .first();
    const contains = options.filter({ hasText: value }).first();
    const target =
      (await exact.count().catch(() => 0))
        ? exact
        : (await starts.count().catch(() => 0))
          ? starts
          : contains;
    if (!(await target.count().catch(() => 0))) return false;
    await target.waitFor({ timeout: 5_000, state: "visible" });
    await target.click({ timeout: 5_000 });
    // verify a selection chip actually appeared in the control
    const chip = page
      .locator(
        `.select__container:has(#${inputId}) .select__single-value`,
      )
      .first();
    const chipVisible = await chip
      .waitFor({ timeout: 5_000, state: "visible" })
      .then(() => true)
      .catch(() => false);
    return chipVisible;
  } catch {
    return false;
  }
}

/**
 * Pre-submit audit: labels of required fields that are still empty.
 * Greenhouse marks required fields with a trailing "*". We run this so the
 * submit control is never clicked on a form we know cannot pass validation
 * — the alternative would be a fake "submitted" or a form-level error we
 * could not attribute to a specific field.
 */
async function findMissingRequiredFields(page: Page): Promise<string[]> {
  return page
    .evaluate<string[]>(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const cleanLabel = (t: string) =>
        (t || "").replace(/\s+/g, " ").trim().replace(/\*\s*$/, "").trim();
      const missing: string[] = [];
      const seen = new Set<string>();
      const push = (name: string) => {
        const key = name || "an unnamed field";
        if (!seen.has(key)) {
          seen.add(key);
          missing.push(key.slice(0, 90));
        }
      };
      const labelFor = (el: Element): string => {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l && visible(l))
            return (
              (l as HTMLElement).innerText || ""
            ).replace(/\s+/g, " ").trim();
        }
        return el.getAttribute("aria-label") || "";
      };

      document
        .querySelectorAll(
          "input:not([type=hidden]):not([type=file]), textarea, select",
        )
        .forEach((el) => {
          if (!visible(el)) return;
          const label = labelFor(el);
          if (!/\*\s*$/.test(label)) return; // only audit required fields
          let filled: boolean;
          if (el.tagName === "SELECT") {
            filled = (el as HTMLSelectElement).selectedIndex > 0;
          } else if ((el.className || "").toString().includes("select__input")) {
            // react-select: the selection is a chip, not input.value
            const c = el.closest(".select__container");
            const single = c ? c.querySelector(".select__single-value") : null;
            const placeholder = c ? c.querySelector(".select__placeholder") : null;
            filled =
              !!single ||
              (placeholder
                ? (placeholder as HTMLElement).offsetWidth === 0
                : (el as HTMLInputElement).value.trim().length > 0);
          } else {
            filled = ((el as HTMLInputElement).value || "").trim().length > 0;
          }
          if (!filled) push(cleanLabel(label));
        });

      // Required file fields, driven by the file inputs themselves (not by
      // labels): Greenhouse removes the input from the DOM after a
      // successful upload (leaving a filename chip), and "Enter manually"
      // replaces the file upload with a textarea — so filled state is
      // judged per field wrapper.
      document.querySelectorAll("input[type=file]").forEach((rawEl) => {
        const el = rawEl as HTMLInputElement;
        if (el.files && el.files.length > 0) return;
        // field wrapper = nearest ancestor holding the upload button row
        let wrapper: Element | null = null;
        let node: Element | null = el.parentElement;
        for (let i = 0; i < 6 && node; i++) {
          const hasUploadBtn = Array.from(node.querySelectorAll("button")).some(
            (b) =>
              visible(b) &&
              /attach|dropbox|google drive|enter manually/i.test(
                (b as HTMLElement).textContent || "",
              ),
          );
          if (hasUploadBtn) {
            wrapper = node;
            break;
          }
          node = node.parentElement;
        }
        if (!wrapper) return;
        // manual-entry mode with a filled textarea satisfies the field
        const filledTa = Array.from(
          wrapper.querySelectorAll("textarea"),
        ).find(
          (t) =>
            visible(t) &&
            ((t as HTMLTextAreaElement).value || "").trim().length > 0,
        );
        if (filledTa) return;
        // uploaded state: filename chip present, upload UI gone
        const wrapperText = ((wrapper as HTMLElement).innerText || "")
          .replace(/\s+/g, " ")
          .trim();
        const hasVisibleUploadUi = Array.from(
          wrapper.querySelectorAll("button"),
        ).some(
          (b) =>
            visible(b) &&
            /attach|dropbox|google drive|enter manually/i.test(
              (b as HTMLElement).textContent || "",
            ),
        );
        if (/\.(pdf|docx?|txt|rtf)\b/i.test(wrapperText) && !hasVisibleUploadUi) {
          return;
        }
        // required marker inside the field wrapper
        const hit = Array.from(
          wrapper.querySelectorAll("label, p, div, span, .label, h1, h2, h3, h4"),
        ).find((l) => {
          const t = ((l as HTMLElement).innerText || "")
            .replace(/\s+/g, " ")
            .trim();
          return visible(l) && t.length > 3 && t.length < 300 && /\*\s*$/.test(t);
        });
        if (hit) push(cleanLabel((hit as HTMLElement).innerText));
      });

      return missing;
    })
    .catch(() => []);
}

/**
 * Poll the page after clicking submit for a real confirmation. Returns
 * `confirmed` only on a Greenhouse success signal (a confirmation URL the
 * job page no longer is, or a "thank you / submitted" page state, including
 * the in-dialog success panel). Returns `blocking` when the page shows a
 * visible validation/bot-gate error instead.
 */
async function waitForGreenhouseConfirmation(
  page: Page,
  timeoutMs: number,
): Promise<{ confirmed: boolean; signal?: string; blocking?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url().toLowerCase();
    if (
      /thank|success|confirm|submitted|applied|receipt/.test(url) &&
      !/\/jobs\//.test(url)
    ) {
      return { confirmed: true, signal: `confirmation URL ${page.url()}` };
    }
    const finding = await page
      .evaluate<{ signal?: string; blocking?: string }>(
        `(args) => {
          var confirm = args.confirm;
          var blocking = args.blocking;
          var body = (document.body && document.body.innerText || "").toLowerCase();
          for (var i = 0; i < confirm.length; i++) {
            if (body.indexOf(confirm[i]) >= 0) return { signal: confirm[i] };
          }
          var dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (dialog) {
            var dtext = (dialog.innerText || "").toLowerCase();
            for (var k = 0; k < confirm.length; k++) {
              if (dtext.indexOf(confirm[k]) >= 0) return { signal: confirm[k] };
            }
          }
          for (var j = 0; j < blocking.length; j++) {
            if (body.indexOf(blocking[j]) >= 0) return { blocking: blocking[j] };
          }
          return {};
        }`,
        {
          confirm: GREENHOUSE_CONFIRMATION_TEXTS,
          blocking: GREENHOUSE_BLOCKING_TEXTS,
        },
      )
      .catch(() => null);
    if (finding?.signal) return { confirmed: true, signal: finding.signal };
    if (finding?.blocking) return { confirmed: false, blocking: finding.blocking };
    await page.waitForTimeout(1_000);
  }
  return { confirmed: false };
}

function parseCookieHeader(cookie: string, domain: string) {
  return cookie.split(";").flatMap((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return name ? [{ name, value: rest.join("="), domain, path: "/" }] : [];
  });
}

/**
 * Turing apply adapter.
 *
 * GUARDED: ctx.dryRun is forced true by the orchestrator unless
 * JOBOPS_FREELANCE_TURING_APPLY_ENABLED=true, and the submit path additionally
 * requires JOBOPS_FREELANCE_TURING_API_KEY or _COOKIE (candidate session).
 *
 * Honest semantics:
 *   - posting resolvable from the gig record/id  -> real browser application
 *     on the hosted Greenhouse form: fill name/email/phone (+ country,
 *     LinkedIn, website, education when the profile carries them), upload
 *     the resume, the cover letter (file or the form's "Enter manually"
 *     text entry), tick consent boxes, run a required-field audit, click
 *     the real submit control, and report "submitted" ONLY after a
 *     confirmed Greenhouse success signal. Anything short of that is
 *     "error" with the precise reason — never "submitted".
 *   - no per-gig posting on the record           -> "skipped" with the
 *     vetted-network message (apply is the one-time network application).
 */
export async function applyToTuringGig(
  ctx: FreelanceApplyContext,
): Promise<FreelanceApplyResult> {
  if (ctx.dryRun) {
    return {
      platform: PLATFORM,
      mode: "dry_run",
      status: "skipped",
      error: `dry-run: ${PLATFORM} submission disabled (set ${ENV_PREFIX}_APPLY_ENABLED=true and configure ${ENV_PREFIX}_API_KEY to submit for real)`,
    };
  }

  const { apiKey, cookie } = resolveCredential(
    process.env as Record<string, string | undefined>,
  );
  if (!apiKey && !cookie) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: missing ${ENV_PREFIX}_API_KEY or ${ENV_PREFIX}_COOKIE (candidate session) — cannot apply`,
    };
  }

  const profile = (ctx.profile ?? {}) as TuringApplyProfile;

  const posting = resolveGreenhousePosting(ctx, profile);
  if (!posting) {
    // Nothing per-gig to apply to: this record rides the vetted network
    // pipeline, whose only apply path is the one-time network application.
    // Reported as an honest, machine-readable skip — not a fake error and
    // never "submitted".
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "skipped",
      error: `${PLATFORM}: Vetted network: apply requires the one-time network application (no per-gig bidding)`,
    };
  }

  const coverLetter = profile.coverLetter?.trim();
  if (!coverLetter) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: no tailored cover letter in profile — refusing to submit an untailored application`,
    };
  }

  const email = (profile.email ?? "").trim();
  let firstName = (profile.firstName ?? "").trim();
  let lastName = (profile.lastName ?? "").trim();
  if (!firstName || !lastName) {
    const parts = (profile.fullName ?? "").trim().split(/\s+/);
    if (parts.length > 0 && parts[0]) {
      firstName = firstName || parts[0];
      lastName = lastName || parts.slice(1).join(" ");
    }
  }
  const phone = (profile.phone ?? "").trim();
  const resumePath = profile.resumePath ?? profile.resumeFile;

  const missing: string[] = [];
  if (!email) missing.push("email");
  if (!firstName || !lastName) missing.push("name");
  if (missing.length > 0) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: cannot fill the Greenhouse form — ctx.profile is missing ${missing.join(
        " + ",
      )} (the orchestrator currently passes profile:null; pass email + name through the manual apply path)`,
    };
  }

  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
    });
    if (cookie) {
      const cookies = parseCookieHeader(cookie, ".greenhouse.io");
      if (cookies.length) await context.addCookies(cookies);
    }
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(30_000);
    await page.goto(posting.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);

    // The hosted board's application form is inline on the job page; the
    // page-level "Apply" control scrolls to it (and opens it on boards that
    // keep it collapsed). "Autofill my application" is never touched.
    let applyEntry = page
      .getByRole("button", { name: /^apply$/i })
      .or(page.getByRole("link", { name: /^apply$/i }))
      .first();
    if (!(await applyEntry.count().catch(() => 0))) {
      applyEntry = page
        .getByRole("button", { name: /apply/i })
        .filter({ hasNotText: /autofill/i })
        .first();
    }
    if (await applyEntry.count().catch(() => 0)) {
      await applyEntry.click({ timeout: 10_000 }).catch(() => undefined);
    }

    // The email textbox (accessible name "Email"; on this board a text
    // input, not input[type=email]) is the anchor proving the form is
    // present and interactable.
    const emailLoc = page
      .getByRole("textbox", { name: /e-?mail/i })
      .or(page.locator('input[type="email"]'));
    const formAppeared = await emailLoc
      .first()
      .waitFor({ timeout: 20_000, state: "visible" })
      .then(() => true)
      .catch(() => false);
    if (!formAppeared) {
      const alreadyApplied = await page
        .evaluate(
          `(signals) => signals.some((s) =>
            (document.body && document.body.innerText || "").toLowerCase().includes(s))`,
          [
            ...GREENHOUSE_CONFIRMATION_TEXTS,
            "already applied",
            "you've already applied",
          ],
        )
        .catch(() => false);
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        externalRef: posting.jobId,
        error: alreadyApplied
          ? `${PLATFORM}: the posting already shows a submitted application (possible duplicate) — verify the existing application manually at ${posting.url}`
          : `${PLATFORM}: no Greenhouse application form appeared on ${posting.url} (board may be closed, the posting removed, or the page bot-gated) — apply manually at ${posting.url}`,
      };
    }

    const filled: string[] = [];
    const fillText = async (
      locator: Locator,
      value: string,
      label: string,
    ): Promise<boolean> => {
      try {
        const first = locator.first();
        if (!(await first.count())) return false;
        await first.scrollIntoViewIfNeeded().catch(() => undefined);
        if (!(await first.isVisible().catch(() => false))) return false;
        await first.fill(value, { timeout: 5_000 });
        filled.push(label);
        return true;
      } catch {
        return false;
      }
    };

    // --- plain text fields, matched by accessible name ---
    if (!(await fillText(emailLoc, email, "email"))) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        externalRef: posting.jobId,
        error: `${PLATFORM}: could not fill the email field on the Greenhouse form — form state changed, manual review needed at ${posting.url}`,
      };
    }
    const nameFilled =
      (await fillText(
        page.getByRole("textbox", { name: /first name/i }),
        firstName,
        "first name",
      )) &&
      (await fillText(
        page.getByRole("textbox", { name: /last name/i }),
        lastName,
        "last name",
      ));
    if (!nameFilled) {
      await fillText(
        page.getByRole("textbox", { name: /full name/i }),
        `${firstName} ${lastName}`,
        "name",
      );
    }
    if (phone) {
      await fillText(
        page.getByRole("textbox", { name: /phone/i }),
        phone,
        "phone",
      );
    }
    if (profile.linkedinProfile?.trim()) {
      await fillText(
        page.getByRole("textbox", { name: /linkedin( profile)?/i }),
        profile.linkedinProfile.trim(),
        "linkedin",
      );
    }
    if (profile.website?.trim()) {
      await fillText(
        page.getByRole("textbox", { name: /website/i }),
        profile.website.trim(),
        "website",
      );
    }

    // --- react-select comboboxes (Country; Education: School/Degree/Discipline) ---
    if (profile.country?.trim()) {
      const countryId = await reactSelectIdByLabel(page, "country");
      if (countryId && (await fillReactSelect(page, countryId, profile.country.trim()))) {
        filled.push("country");
      }
    }
    for (const [key, pattern] of [
      ["school", "school"],
      ["degree", "degree"],
      ["discipline", "discipline"],
    ] as const) {
      const value = profile.education?.[key]?.trim();
      if (!value) continue;
      const id = await reactSelectIdByLabel(page, pattern);
      if (!id) continue;
      let ok = await fillReactSelect(page, id, value);
      if (!ok && key === "degree") {
        // profile values like "Masters" vs the board's "Master's Degree"
        const alias = DEGREE_LABEL_ALIASES[value.toLowerCase()];
        if (alias) ok = await fillReactSelect(page, id, alias);
      }
      if (ok) filled.push(`education: ${key}`);
    }

    // --- file uploads ---
    const fileInputs = page.locator('input[type="file"]');
    const fileCount = await fileInputs.count().catch(() => 0);
    if (fileCount > 0) {
      // Resume/CV — required on the hosted board; never submit without one.
      const resumeLoc = page
        .locator(
          'input[type="file"][id*="resume" i], input[type="file"][aria-label*="resume" i], input[type="file"][id*="cv" i]',
        )
        .first();
      const resumeTarget = (await resumeLoc.count().catch(() => 0))
        ? resumeLoc
        : fileInputs.first();
      if (!resumePath) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "error",
          externalRef: posting.jobId,
          error: `${PLATFORM}: the Greenhouse form has a resume upload but ctx.profile has no resumePath — refusing to submit without a resume (form left untouched; apply manually at ${posting.url})`,
        };
      }
      if (!existsSync(resumePath)) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "error",
          externalRef: posting.jobId,
          error: `${PLATFORM}: resume file not found at ${resumePath} — refusing to submit (form left untouched; apply manually at ${posting.url})`,
        };
      }
      try {
        await resumeTarget.setInputFiles(resumePath, { timeout: 10_000 });
        filled.push("resume");
      } catch (error) {
        return {
          platform: PLATFORM,
          mode: "submit",
          status: "error",
          externalRef: posting.jobId,
          error: `${PLATFORM}: resume upload failed — ${
            error instanceof Error ? error.message : String(error)
          } (form left untouched; apply manually at ${posting.url})`,
        };
      }

      // Cover letter — a file on some postings, a textarea on others. When a
      // file input exists and no coverLetterPath is given, use the form's
      // own "Enter manually" control to switch that field to text entry.
      const coverFileLoc = page
        .locator(
          'input[type="file"][id*="cover" i], input[type="file"][aria-label*="cover" i]',
        )
        .first();
      if (await coverFileLoc.count().catch(() => 0)) {
        const coverPath = profile.coverLetterPath?.trim();
        if (coverPath && existsSync(coverPath)) {
          try {
            await coverFileLoc.setInputFiles(coverPath, { timeout: 10_000 });
            filled.push("cover letter");
          } catch {
            /* fall through to the manual-entry path */
          }
        }
        if (!filled.includes("cover letter")) {
          const switched = await page
            .evaluate(() => {
              const input = document.querySelector(
                'input[type="file"][id*="cover" i], input[type="file"][aria-label*="cover" i]',
              );
              if (!input) return false;
              let node: Element | null = input.parentElement;
              for (let i = 0; i < 10 && node; i++) {
                const btn = Array.from(node.querySelectorAll("button")).find(
                  (b) => /enter manually/i.test((b as HTMLElement).textContent || ""),
                );
                if (btn && (btn as HTMLButtonElement).offsetWidth > 0) {
                  (btn as HTMLButtonElement).click();
                  return true;
                }
                node = node.parentElement;
              }
              return false;
            })
            .catch(() => false);
          if (switched) {
            const ta = page.locator("textarea").first();
            const taVisible = await ta
              .waitFor({ timeout: 5_000, state: "visible" })
              .then(() => true)
              .catch(() => false);
            if (taVisible) await fillText(ta, coverLetter, "cover letter");
          }
        }
      } else {
        const letterLoc = page
          .getByRole("textbox", {
            name: /cover letter|additional|comments?|message/i,
          })
          .or(page.locator("textarea"));
        await fillText(letterLoc, coverLetter, "cover letter");
      }

      // Custom file questions (e.g. a writing sample) answered from the
      // profile via questionFiles: [{ match: "writing sample", path }].
      for (const q of profile.questionFiles ?? []) {
        const match = q?.match?.trim();
        const path = q?.path?.trim();
        if (!match || !path || !existsSync(path)) continue;
        const count = await fileInputs.count().catch(() => 0);
        let uploaded = false;
        for (let i = 0; i < count && !uploaded; i++) {
          const matches = await fileInputs
            .nth(i)
            .evaluate((el, src) => {
              const re = new RegExp(src, "i");
              let node: Element | null = el.parentElement;
              for (let k = 0; k < 12 && node; k++) {
                node = node.parentElement;
                if (node && re.test(node.textContent || "")) return true;
              }
              return false;
            }, match)
            .catch(() => false);
          if (matches) {
            try {
              await fileInputs.nth(i).setInputFiles(path, { timeout: 10_000 });
              filled.push(`file: ${match}`);
              uploaded = true;
            } catch {
              /* reported below via the required-field audit */
            }
          }
        }
      }
    } else {
      // No file inputs at all: offer the cover letter text via the textarea.
      const letterLoc = page
        .getByRole("textbox", {
          name: /cover letter|additional|comments?|message/i,
        })
        .or(page.locator("textarea"));
      await fillText(letterLoc, coverLetter, "cover letter");
    }

    // Consent / EEO checkboxes — same selector pattern as the job portal
    // automation (application-browser.ts): only boxes labeled agree/consent/
    // privacy/terms are touched, capped at 5.
    const consentBoxes = page.locator(
      'label:has-text("agree") input[type="checkbox"], label:has-text("consent") input[type="checkbox"], label:has-text("privacy") input[type="checkbox"], label:has-text("terms") input[type="checkbox"], input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][name*="consent" i], input[type="checkbox"][id*="consent" i]',
    );
    const consentCount = Math.min(
      await consentBoxes.count().catch(() => 0),
      5,
    );
    for (let index = 0; index < consentCount; index += 1) {
      const checkbox = consentBoxes.nth(index);
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.check({ timeout: 1_000 }).catch(() => undefined);
      }
    }

    // Required-field audit: never click submit on a form we know cannot
    // pass validation — report precisely what the profile still lacks.
    const missingRequired = await findMissingRequiredFields(page);
    if (missingRequired.length > 0) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        externalRef: posting.jobId,
        error: `${PLATFORM}: the Greenhouse form still requires: ${missingRequired.join(
          "; ",
        )} — extend ctx.profile (e.g. country, education, linkedinProfile, coverLetterPath, questionFiles) and retry, or apply manually at ${posting.url}`,
      };
    }

    // The form's real action button (on the hosted board:
    // <button type="submit">Submit application</button>); prefer
    // type=submit, fall back to the form's Apply/Submit button text.
    const typedSubmit = page.locator('button[type="submit"], input[type="submit"]');
    const submitButton = (await typedSubmit.count().catch(() => 0))
      ? typedSubmit.last()
      : page.getByRole("button", { name: /submit|apply/i }).last();
    if (!(await submitButton.count().catch(() => 0))) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "error",
        externalRef: posting.jobId,
        error: `${PLATFORM}: form opened but no submit control found on the Greenhouse form — manual review needed at ${posting.url}`,
      };
    }
    await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await submitButton.click({ timeout: 10_000 });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 20_000 })
      .catch(() => undefined);

    // "submitted" ONLY on a confirmed Greenhouse success signal.
    const outcome = await waitForGreenhouseConfirmation(page, 20_000);
    if (outcome.confirmed) {
      return {
        platform: PLATFORM,
        mode: "submit",
        status: "submitted",
        externalRef: posting.jobId,
        exportPayload: {
          greenhouseJobId: posting.jobId,
          applyUrl: posting.url,
          confirmationUrl: page.url(),
          successSignal: outcome.signal,
          fieldsFilled: filled,
        },
      };
    }
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      externalRef: posting.jobId,
      error: outcome.blocking
        ? `${PLATFORM}: Greenhouse form rejected the submission (${outcome.blocking}) — review the form and apply manually at ${posting.url}`
        : `${PLATFORM}: submit clicked but no success confirmation (final URL: ${page.url()}) — verify whether the application went through manually at ${posting.url}`,
    };
  } catch (error) {
    return {
      platform: PLATFORM,
      mode: "submit",
      status: "error",
      error: `${PLATFORM}: submit failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (browser) await browser.close();
  }
}
