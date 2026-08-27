# Freelance platform credentials

Every freelance adapter in `extractors/<platform>/src/main.ts` resolves its
credentials the same way: `ctx.settings` (the process env) first, then
`process.env` as fallback. This page lists, per platform, which variables to
set, how to obtain the value, and what the apply adapter can actually do.

Two ways to provide a credential:

1. **Environment variable / `.env`** — the normal path.
2. **Credential file** — `data/.credentials/<platform>.txt` (see
   [Credential files](#credential-files)).

Never commit these values. The credential file directory is created `0700`
(owner-only) and values are never logged by the orchestrator.

## Per-platform table

| Platform | Env var(s) | Format | How to obtain it | Apply capability | Notes |
| --- | --- | --- | --- | --- | --- |
| contra | `JOBOPS_FREELANCE_CONTRA_COOKIE` | cookie (raw `Cookie` header) | Log in to contra.com → F12 → Application → Cookies → copy the **full** `Cookie` header | real browser (partial) | Apply host is `https://jobs.ashbyhq.com/contra/<gigId>/application` — the adapter verifies the page loads and reports `submitted` **without clicking submit** (final human review is intentional). The cookie is scoped to `.contra.com`, so it cannot authenticate the Ashby page. Discovery covers only Contra's own Ashby careers board (`api.ashbyhq.com/posting-api/job-board/contra`), not contra.com client gigs. |
| upwork | `JOBOPS_FREELANCE_UPWORK_API_KEY` (required) · `JOBOPS_FREELANCE_UPWORK_COOKIE` (optional) | API key (OAuth2 bearer, proposal scope) + optional cookie header | API key: create an app in Upwork → *Settings* → *Apps* → generate a token with proposal scope. Cookie: F12 → Application → Cookies on upwork.com | real API | Discovery and submission both use `api.upwork.com/graphql` with the bearer token (`marketplaceJobPostingsSearch` / `createProposal`); the cookie is only a browser-fallback discovery path. Upwork blocks anonymous access. |
| fiverr | `JOBOPS_FREELANCE_FIVERR_COOKIE` | cookie (seller session) | Seller account (must have access to buyer requests) → F12 → Application → Cookies on fiverr.com → copy full `Cookie` header | real browser | `JOBOPS_FREELANCE_FIVERR_API_KEY` is read by discovery as a cookie substitute; apply honors the cookie only. Discovery scrapes the public gig *search* page (sellers' gigs), not buyer-request pages, so discovered ids are not buyer-request ids. |
| freelancer | `JOBOPS_FREELANCE_FREELANCER_API_KEY` (fallback: `FREELANCER_API_KEY`) | API key (OAuth token) | Create a project in freelancer.com → *Developer* → generate an OAuth token | real API | POSTs a JSON bid to `freelancer.com/api/projects/0.1/bids/` with the token in the `Freelancer-OAuth-V1` header. |
| peopleperhour | `JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE` (apply reads `process.env` directly) · `JOBOPS_FREELANCE_PEOPLEPERHOUR_API_KEY` (discovery cookie fallback) | cookie header | F12 → Application → Cookies on peopleperhour.com → copy full `Cookie` header | real browser | Opens the gig page and clicks Send Proposal → fills cover letter → Submit. Returns `submitted` optimistically (no confirmation-page check). |
| guru | `JOBOPS_FREELANCE_GURU_COOKIE` (apply + browser discovery) · `JOBOPS_FREELANCE_GURU_API_KEY` (API discovery only, paid members) | cookie + API key | Cookie: F12 on guru.com. API key: Guru → profile → API access (paid feature) | real browser | Same optimistic-submit browser flow as PeoplePerHour. |
| toptal | `JOBOPS_FREELANCE_TOPTAL_COOKIE` (`JOBOPS_FREELANCE_TOPTAL_API_KEY` is read but unused in the submit path) | cookie header | F12 on toptal.com | real browser (partial) | Navigates to `https://jobs.lever.co/toptal/<gigId>/apply`, checks HTTP 2xx, and reports `submitted` **without filling or submitting the form** — the final click is intentionally left to a human. |
| turing | `JOBOPS_FREELANCE_TURING_API_KEY` **or** `JOBOPS_FREELANCE_TURING_COOKIE` (either passes the presence check; neither is used in any request) | cookie + API key | Set one of them to a non-empty value to pass the credential gate | vetted network (stub) | No per-gig apply in code: the adapter points to `https://job-boards.greenhouse.io/turing/jobs/<gigId>` for manual application. |
| gun-io | `JOBOPS_FREELANCE_GUN_IO_API_KEY` **or** `JOBOPS_FREELANCE_GUN_IO_COOKIE` (either passes the presence check; neither is used in any request) | cookie + API key | Set one to a non-empty value to pass the credential gate | vetted network (not applicable) | No self-serve apply: roles are matched manually after network screening. Adapter gigs link to the one-time sign-up page `https://app.gun.io/sign-up/`. |
| braintrust | `JOBOPS_FREELANCE_BRAINTRUST_COOKIE` (alternate: `JOBOPS_FREELANCE_BRAINTRUST_API_KEY`) | cookie header | F12 on app.usebraintrust.com | vetted network (stub) | Guard checks only; points to `https://app.usebraintrust.com/jobs/<id>/` for manual application. Never launches a browser. |
| malt | `JOBOPS_FREELANCE_MALT_COOKIE` | cookie header | F12 on malt.fr | real browser (partial) | Navigates to the project page, checks it loads, and reports `submitted` — **never fills the form**. |
| wantapply | `JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL` | webhook URL/token | wantapply.com project settings → webhook endpoint (the service is Cloudflare-gated, no public feed) | not applicable (batch export) | `findGigs` is a deliberate stub (403-gated service). The only real path is `exportBatch` to the webhook; single-gig apply is unsupported by design. |
| remoteok | — (none) | none | Public JSON API (`https://remoteok.com/api`), no credentials | board (no per-gig apply on the platform) | The browser apply adapter opens the **employer's ATS** (Greenhouse/Lever/…) linked from the posting and can fill + submit that form. Gate: `JOBOPS_FREELANCE_REMOTEOK_APPLY_ENABLED=true`. |
| weworkremotely | — (none) | none | Public RSS (`https://weworkremotely.com/rss`), no credentials | board (no per-gig apply on the platform) | Same board semantics as RemoteOK. |
| wellfound | `JOBOPS_FREELANCE_WELLFOUND_COOKIE` (apply + GraphQL discovery) · `JOBOPS_FREELANCE_WELLFOUND_API_KEY` (discovery only, sent as `Authorization: Bearer`) | cookie + API key | F12 on wellfound.com; API key: Wellfound → account settings | real browser | Discovery is a real `wellfound.com/graphql` job-search query (2 schema-shape fallbacks). Apply clicks the apply button, fills the cover-letter textbox, submits. |
| arc-dev | `JOBOPS_FREELANCE_ARC_DEV_COOKIE` (`JOBOPS_FREELANCE_ARC_DEV_API_KEY` optional, not used for submission) | cookie header | F12 on arc.dev | real browser | Navigates `arc.dev/remote-jobs/details/<gigId>`, clicks apply, fills cover letter, submits. |
| freelancermap | `JOBOPS_FREELANCE_FREELANCERMAP_API_KEY` | API key | freelancermap.de → account → API access | real API | POSTs `{message: coverLetter}` to `freelancermap.de/api/projects/<gigId>/applications` with `Authorization: Bearer <key>`. |
| flexjobs | `JOBOPS_FREELANCE_FLEXJOBS_COOKIE` (`JOBOPS_FREELANCE_FLEXJOBS_API_KEY` optional, not used) | cookie header | F12 on flexjobs.com (paid subscriber account) | real browser | Navigates `flexjobs.com/publicJobs/-<gigId>.aspx`, clicks apply, fills cover letter, submits. |

## Getting a Cookie header (step by step)

1. Log in to the platform in your normal browser (desktop Chrome/Edge/Firefox).
2. Open DevTools with **F12** → **Application** tab → **Cookies** (Chrome/Edge)
   or **Storage** → **Cookies** (Firefox).
3. Easiest: DevTools → **Network** tab → refresh the page → click the first
   request → **Request Headers** → copy the **entire** `Cookie:` header value
   (one long string, `a=1; b=2; ...`). Paste that string verbatim as the env
   value or as the single line in the credential file.
4. Cookie headers expire (often after 1–4 weeks); when a platform starts
   returning 401/403 or "session not a seller"-style errors, re-copy it.

## Real-submission gates

Real submissions (dry-run → submit) require **both**:

```bash
JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED=true   # per-platform switch, e.g. JOBOPS_FREELANCE_FIVERR_APPLY_ENABLED=true
# plus the platform's credential(s) above
```

and are rate-limited (default 5/hour per platform,
`JOBOPS_FREELANCE_<PLATFORM>_MAX_PER_HOUR`). The verification harness runs in
dry-run by default:

```bash
cd orchestrator
npx tsx scripts/freelance-verify.ts all            # dry-run only, never submits
npx tsx scripts/freelance-verify.ts upwork --live  # real submission vs first discovered gig
```

API equivalents (auth required):

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3005/api/freelance/adapters
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{}' http://localhost:3005/api/freelance/verify/upwork
```

## Credential files

As an alternative to `.env`, each platform accepts a single-line file:

```
data/.credentials/<platform>.txt
```

- One line = the platform's **primary** credential (usually the full
  `Cookie` header string). Lines starting with `#` and blank lines are
  ignored; the value is trimmed.
- File permissions: `chmod 600 data/.credentials/<platform>.txt`. The
  directory itself is created `0700` (owner-only) on first use.
- `process.env` always wins over the file for a given variable.
- For cookie+apikey platforms the file fills only the primary (cookie)
  variable; set the API key via env when needed (e.g. Upwork).

Example:

```bash
printf '%s\n' 'a=1; b=2; session=abc' > data/.credentials/contra.txt
chmod 600 data/.credentials/contra.txt
```

This is equivalent to `JOBOPS_FREELANCE_CONTRA_COOKIE='a=1; b=2; session=abc'`
in `.env` — just easier to edit without touching the env file.

## Verify what you configured

```bash
cd orchestrator
npx tsx scripts/freelance-verify.ts <platform>
```

The report lists `credential.required / present / missing` per platform, the
discovery result (gig count + first title), the dry-run apply status, and a
verdict: `verified`, `blocked`, or `not-applicable` (boards / vetted
networks / batch webhooks that have no per-gig apply by design).
