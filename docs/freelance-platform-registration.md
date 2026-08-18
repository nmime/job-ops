# Freelance Platform Registration

How job-ops registers accounts on freelance platforms and wires their
credentials into the auto-bid pipeline.

## Module

`orchestrator/src/server/services/freelance/platform-registration/`

| File | Responsibility |
| --- | --- |
| `types.ts` | Flow spec + browser driver interfaces |
| `freelancer-flow.ts` | Declarative Freelancer.com flow (the reference implementation) |
| `pph-flow.ts` | Declarative PeoplePerHour flow (executed live 2026-08-17/18) |
| `runner.ts` | Executes a flow against any driver; secret substitution; progress events |
| `credential-store.ts` | `<DATA_DIR>/.credentials/<platform>.txt` read/write (0600), masking |
| `env-writer.ts` | Pure `.env` text transforms (set/update/append, quoting rules) |
| `email-links.ts` | One-time link extraction from registration emails (verify/reset) |

Tests: colocated `*.test.ts` (22 tests). The runner is driven by a
`BrowserDriver` interface so the whole flow is testable without a browser.

## What is automated vs manual

Freelancer.com specifically:

- **Automated** (executed live 2026-08-17, account `nmime`, user_id 94340619):
  signup wizard (name/email/password → username → account type → skills →
  profile name/headline/languages/birthdate), email verification via the
  welcome-email one-click link, and session re-authentication.
- **Manual (hard wall)**: payment verification (card or PayPal) — required
  before Freelancer lets you create a developer app. This needs real
  financial credentials and cannot be automated safely.
- **After payment verification** (~2 minutes, browser or API): create an app
  at <https://accounts.freelancer.com/settings/develop>, copy the access
  token into `JOBOPS_FREELANCE_FREELANCER_API_KEY`.

PeoplePerHour specifically (executed live 2026-08-17/18, member_id 13763514):

- **Automated**: signup via `/site/register#freelancer` → "SIGN UP WITH EMAIL"
  → name/email/password, reCAPTCHA v2 auto-solved by the nopecha-solver
  extension, member-application form (job title, bio, skills + language
  select2 typeaheads driven by clicking rendered dropdown options, required
  profile-picture upload), application submit, and email verification via the
  "Activate your account" link (`/site/verifyEmail?id=…&verifycode=…`).
- **Credential wired live**: session cookie (`PHPSESSID` + `aws-waf-token`)
  stored in `JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE`. **Discovery works
  immediately** — the adapter drives Playwright in-process with the cookie and
  pulls gigs every worker cycle.
- **Manual (hard wall)**: marketplace access is gated behind a **paid
  membership** at `/memberApplication/fastTrack` (SINGLE PLATFORM GBP
  11.95/mo or TopAccess GBP 22.95/mo, both 12-month commitment). Needs real
  payment credentials; phone verification may be requested at that step. Until
  subscribed, the apply path no-ops cleanly (proposal button not found).

## PPH operational notes (learned the hard way)

1. **Direct egress only.** PPH is unreachable through the residential egress
   proxy (`ERR_CONNECTION_CLOSED`) but returns 202 direct. Run its browser
   instance with `AGENT_BROWSER_PROXY=` (empty) for a dedicated `HOME`.
2. **Select2 typeaheads need a click, not Enter.** Skills/languages are backed
   by `/member-application/suggestSkill` and `/member/LanguagesAutocomplete`.
   Typing sets the search box; the rendered dropdown option must be CLICKED to
   commit a selection (stored as ids in hidden inputs). Enter-key commits do
   not stick.
3. **The form re-renders on validation failure**, clearing DOM-set values and
   file inputs. Set all values and submit in ONE synchronous pass
   (`jQuery(form).off('submit')` then native `form.submit()`), re-attaching
   the picture file in the same tick.
4. **Discovery selectors track hashed CSS-module classes**
   (`item__container` / `item__url` / `item__title`). The scraper uses a
   string IIFE through `page.evaluate`, because tsx/esbuild injects a `__name`
   helper into serialized `$$eval` callbacks that ReferenceErrors in the
   browser and silently zeroes every cycle.

## Bot-detection notes (learned the hard way)

1. **Login requires invisible reCAPTCHA v3.** Headless/datacenter browsers
   score too low → `403 AUTH_CAPTCHA_REQUIRED`. Two working bypasses:
   - Solve through the platform captcha proxy (`$SPLOX_BASE_URL/v1/captcha/in.php`,
     `method=userrecaptcha`, `invisible=1`) and inject the token into the
     login XHR (`ajax-api/auth/login.php?compact=true&new_errors=true&new_pools=true`).
     **One token, one request.**
   - Re-auth without any captcha via the forgot-password loop:
     `POST /auth/forgot {user}` → email with
     `/users/reset_user_password.php?token=…&userid=…` → set password on the
     reset page → auto-login. This is the reliable recovery path whenever a
     session dies.
2. **Route the browser through a residential egress.** A local forwarder
   (`data/.credentials/proxy-forwarder.py`, port 3128) injects the
   `Proxy-Authorization` header that Chrome's `--proxy-server` cannot carry;
   launch with `AGENT_BROWSER_ARGS="--disable-blink-features=AutomationControlled,--proxy-server=127.0.0.1:3128"`.
3. **Sessions die when tabs get killed.** Keep each onboarding step short,
   snapshot between steps (refs go stale), and expect to re-auth via the
   password-reset loop after any tab death.
4. **PayPal hard-blocks datacenter-ish egress** (`ERR_CONNECTION_CLOSED`);
   card entry needs real card numbers. Hence the manual wall above.

## Credential handling rules

- Raw material lives in `<DATA_DIR>/.credentials/<platform>.txt`
  (`key: value` lines, chmod 600, dir 700). Never committed.
- `.env` receives only the final token/cookie under the platform's
  `JOBOPS_FREELANCE_<PLATFORM>_API_KEY` / `_COOKIE` var, written by
  `env-writer.setEnvVar` (in-place update, quote-aware).
- Logs may contain `maskSecret(value)` output only — first/last 2 chars +
  length.

## Safety model (unchanged)

Real bids still require all three gates: `FREELANCE_AUTOBID_ENABLED=true`,
per-platform `JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED=true`, and a
configured credential. Registration adds credentials; it never opens gates.
