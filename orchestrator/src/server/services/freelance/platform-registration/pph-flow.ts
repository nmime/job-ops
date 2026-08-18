import type { PlatformRegistrationFlow } from "./types";

/**
 * PeoplePerHour registration flow — declarative spec.
 *
 * Mirrors the flow executed live on 2026-08-17/18 (account member_id
 * 13763514, email-verified, member application approved). Key operational
 * facts baked in from that run:
 *
 *  - Signup entry is /site/register#freelancer (/signup and /join 404).
 *  - reCAPTCHA v2 checkbox is auto-solved by the nopecha-solver extension
 *    loaded into the agent-browser daemon; no manual captcha proxy needed.
 *  - The site is UNREACHABLE through the residential egress proxy
 *    (ERR_CONNECTION_CLOSED) — the browser instance must run with DIRECT
 *    sandbox egress (AGENT_BROWSER_PROXY= for that HOME).
 *  - The member-application form is a Yii app: skills and languages are
 *    select2 typeaheads backed by /member-application/suggestSkill and
 *    /member/LanguagesAutocomplete. Typing alone does NOT commit an entry —
 *    the rendered dropdown option must be clicked (selections are stored as
 *    ids in hidden inputs SellerShowCase[topSkillsList] /
 *    SellerShowCase[languagesString]).
 *  - A profile picture file upload is REQUIRED ("Please upload at least 1
 *    file"); job title + ≥1 skill + ≥1 language are required server-side.
 *  - The session cookie (PHPSESSID, plus aws-waf-token) is the credential:
 *    discovery works with it immediately; the adapter drives Playwright in
 *    process with the Cookie header.
 */
export const PPH_FLOW: PlatformRegistrationFlow = {
  platformId: "peopleperhour",
  signupUrl: "https://www.peopleperhour.com/site/register#freelancer",
  credentialEnvVar: "JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE",
  credentialFile: "peopleperhour.txt",
  manualFollowUps: [
    "Subscribe to a membership plan at the fastTrack page (SINGLE PLATFORM GBP 11.95/mo or TopAccess GBP 22.95/mo, 12-month commitment) — marketplace access and proposal submission are gated behind it. Needs real payment credentials.",
    "Phone verification may be requested at subscription/payment time; complete it in the browser (SMS code).",
    "If discovery starts failing, refresh JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE by re-reading PHPSESSID + aws-waf-token from a logged-in browser session.",
  ],
  steps: [
    {
      id: "open-signup",
      kind: "open",
      url: "https://www.peopleperhour.com/site/register#freelancer",
      description:
        "Open signup with the freelancer anchor (direct egress required — residential proxy is blocked by PPH).",
    },
    {
      id: "choose-email-signup",
      kind: "click",
      selector: 'button "SIGN UP WITH EMAIL"',
      description:
        "Pick the email signup path (Google/Microsoft offered first).",
    },
    {
      id: "fill-name-email-password",
      kind: "fill",
      selector: 'textbox "First Name"',
      value: "{{first_name}} {{last_name}} / {{email}} / {{password}}",
      description: "Fill first name, last name, email and password fields.",
    },
    {
      id: "recaptcha-v2",
      kind: "wait",
      ms: 45000,
      description:
        "reCAPTCHA v2 checkbox (sitekey 6Ldy80EsAAAAAHranaiQRlFMjcOFhIyM-_n6JKQ9) — auto-solved by the nopecha-solver extension; wait for the redirect.",
    },
    {
      id: "member-application-form",
      kind: "fill",
      selector: 'textbox "JOB TITLE"',
      value: "{{job_title}}",
      description:
        "On /member-application?registeredAs=freelancer: JOB TITLE + ABOUT YOU bio.",
    },
    {
      id: "add-skills",
      kind: "click",
      selector:
        "select2 dropdown option per typed skill (TypeScript, Node.js, React, NestJS, PostgreSQL)",
      description:
        "Skills typeahead: trusted fill triggers /member-application/suggestSkill, then CLICK the rendered dropdown option — each click commits a skill id into SellerShowCase[topSkillsList]. Enter-key commits do not work.",
    },
    {
      id: "add-language",
      kind: "click",
      selector: "select2 dropdown option 'English'",
      description:
        "Language typeahead (/member/LanguagesAutocomplete): fill 'English', wait for the option, click it — commits 'en' into SellerShowCase[languagesString].",
    },
    {
      id: "upload-profile-picture",
      kind: "check",
      selector: "input[type=file]",
      description:
        "Upload a profile picture (required). CDP upload or DataTransfer File injection onto input[type=file]; re-attach if a validation re-render clears it.",
    },
    {
      id: "submit-application",
      kind: "click",
      selector: 'button "SUBMIT APPLICATION"',
      description:
        "Submit the member application. Client-side Yii validation can race DOM-set values — set values and submit in one synchronous pass (jQuery off('submit') + native form.submit() proven to work). Success lands on /memberApplication/fastTrack.",
    },
    {
      id: "verify-email",
      kind: "extract",
      artifact: "verify-link",
      description:
        "Read the 'Activate your account' email from the splox inbox; open https://www.peopleperhour.com/site/verifyEmail?id=<member_id>&verifycode=<code> (strip the mailtrack wrapper).",
    },
    {
      id: "membership-plan",
      kind: "skip-if",
      condition: "operator has provided payment credentials",
      description:
        "MANUAL: choose SINGLE PLATFORM (GBP 11.95/mo) or TopAccess (GBP 22.95/mo) at /memberApplication/fastTrack. 12-month commitment; blocks proposal submission until paid.",
    },
    {
      id: "capture-session-cookie",
      kind: "extract",
      artifact: "cookie-header",
      description:
        "Read PHPSESSID + aws-waf-token (+ g_state) from the browser session and store as a Cookie-header string in JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE. Discovery works immediately; proposals arm once subscribed.",
    },
  ],
};
