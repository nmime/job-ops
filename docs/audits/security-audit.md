# JobOps Mega — Security Audit

- Date: 2026-08-05
- Auditor: staff-engineer auditor (automated run)
- Scope: auth/session handling, secret management, injection (SQL/command/template),
  SSRF in extractors/services, XSS in client, dependency CVEs (`npm audit`), auto-apply
  abuse surface, third-party CAPTCHA-solver risk, file upload / PDF / DOCX import paths,
  CORS, Docker image hardening.
- Branch: `audit/security` (from `main` @ 8f7b411)

Severity legend: CRITICAL (remote compromise / credential theft), HIGH (meaningful
privilege escalation / data exposure / SSRF to internal network), MEDIUM (weakened
defenses, requires chaining or specific conditions), LOW (hardening / informational).

---

## Findings

### 1. CRITICAL — Umami `/stats/*` reverse proxy is exempt from authentication and forwards browser-controlled headers to a fixed upstream
Evidence: `orchestrator/src/server/app.ts:63-66` (`isStatsRoute`), `orchestrator/src/server/app.ts:311-318` (`requiresAuth` returns `false` for all `/stats` paths before auth), `orchestrator/src/server/app.ts:344-404` (`app.all(/^\/stats(?:\/.*)?$/)` proxies with `buildUmamiProxyHeaders`).
The route allow-lists only `/script.js` and `/api/send` (`app.ts:61-67`), so the blast radius is limited to the configured analytics origin, but any unauthenticated internet client can POST arbitrary bodies with most request headers (minus a skip-list) through this server to `https://umami.dakheera47.com`, using the JobOps host as an anonymous relay. Response headers are copied back to the client (`copyUmamiResponseHeaders`, `app.ts:129-136`) including `Set-Cookie`, which can poison the JobOps origin with third-party cookies.
Fix: keep the path/method allow-list, but (a) drop `set-cookie` and any `access-control-*` headers from the upstream response, (b) forward only a minimal fixed header set (content-type, user-agent, accept), and (c) add a small IP-based rate limit on `/stats/api/send`.

### 2. CRITICAL — Dependency vulnerabilities: `shell-quote` (critical) and `websocket-driver` (critical) in the production dependency tree
Evidence: `npm audit --omit=dev` (2026-08-05): 2 critical, 20 high, 42 moderate, 2 low. `shell-quote@1.8.3` (`package-lock.json`, `node_modules/shell-quote`) — `quote()` does not escape newlines in object `.op` values + quadratic DoS. `websocket-driver@0.7.4` (`node_modules/websocket-driver`) — resource-limit bypass via message compression + message corruption via protocol length headers. High-severity issues also affect `axios@1.14.0` (NO_PROXY SSRF bypass, prototype-pollution auth bypass), `undici@7.24.7` (TLS certificate validation bypass in SOCKS5 ProxyAgent; Set-Cookie header injection), `fast-uri@3.1.0` (path traversal, host confusion), `linkify-it@5.0.0`, `markdown-it@14.1.1`, `ip-address@10.1.0` (SSRF/trust-boundary bypass via octal octets), `drizzle-orm@0.38.4` (SQL injection via improperly escaped identifiers), `basic-ftp`, `form-data`, `adm-zip`, `ws`, `postcss`, `vite`, `express/qs/body-parser`.
Fix: apply `npm audit fix` for non-breaking bumps (applied mechanically to `package-lock.json` on this branch — see "Applied fixes" below). Follow up with tracked majors: `drizzle-orm@0.38.4 → >=0.45.2` (semver-major, fixes SQL identifier injection), `camoufox-js → 0.12.x` (pulls `adm-zip >= 0.6`), Docusaurus preset `→ 3.5.2` (serialize-javascript RCE chain). Note: `markdown-it`/`linkify-it` are used in the client notes editor (`orchestrator/src/client/lib/jobNoteContent.ts:1-6`) so their ReDoS/quadratic-DoS advisories are reachable with attacker-controlled note text.

### 3. HIGH — SSRF via `POST /api/manual-jobs/fetch`: server fetches any user-supplied URL with no scheme/host filtering
Evidence: `orchestrator/src/server/api/routes/manual-jobs.ts:23` (zod only checks `z.string().trim().url()`), `manual-jobs.ts:101-127` (`fetch(input.url, …)` with no `http(s)` allow-list, no private-IP/localhost block, redirects followed by default, response body read unbounded via `response.text()` and parsed into a full JSDOM at `manual-jobs.ts:143`).
An authenticated user (or any user in the default-unauthenticated deployment, see finding 7) can make the server request `http://169.254.169.254/…` (cloud metadata), internal services, or `file:`-style schemes depending on the fetch implementation, and read the response text back. `getBlockedAutofetchLabel` (`manual-jobs.ts:79-95`) only blocks a hard-coded list of job boards — it is an anti-scraping courtesy list, not a security control.
Fix: replicate the `isLocalOrPrivateHostname` logic that already exists in `orchestrator/src/server/services/design-resume/index.ts:199-243` into a shared util; restrict to `http:`/`https:`, resolve and pin DNS (block RFC-1918/loopback/link-local including IPv6 ULA), set `redirect: "manual"` and re-validate each hop, and cap response size before `response.text()`.

### 4. HIGH — Outbound job-complete webhook URL is fully user-controllable (SSRF + credential exfiltration)
Evidence: `orchestrator/src/server/services/jobs/webhooks.ts:7-16` (`jobCompleteWebhookUrl` from tenant settings or `JOB_COMPLETE_WEBHOOK_URL`, no validation), `webhooks.ts:20-24` (sends `Authorization: Bearer ${WEBHOOK_SECRET}` to that URL), `webhooks.ts:38-42` (`fetch(webhookUrl, …)`).
Any user who can PATCH settings (finding 7: by default, everyone) can point the webhook at an attacker host and receive the shared `WEBHOOK_SECRET`, or at internal infrastructure to port-scan/probe. The secret is also sent over plaintext if the URL is `http://`.
Fix: validate scheme is `https:` (allow `http:` only for loopback in dev), apply the same private-host block as finding 3, and do not attach `Authorization` unless the destination host matches an allow-list derived from the configured URL's origin — or drop the shared-secret forwarding entirely and sign payloads (HMAC) instead.

### 5. HIGH — Auth is disabled by default and the entire API (settings, secrets hints, auto-apply, backups) is then world-accessible
Evidence: `.env.example:22-25` ("The app is fully unauthenticated if this isn't set, which is the default."), `orchestrator/src/server/app.ts:285-298` (when `countUsers() === 0`, protected routes return "Initial setup is required" but every non-`/api` route and the explicitly-public `/api` routes stay open; and once a user exists, all `/api/*` requires a token — but deployments are encouraged to run without `BASIC_AUTH_*`), plus `docker-compose.yml` ships no auth env by default.
Specifically exposed without auth (user count 0 / fresh container): `POST /api/auth/setup` (`orchestrator/src/server/api/routes/auth.ts:88-131`) — first unauthenticated request creates the system admin; any internet-exposed fresh instance can be taken over by whoever hits `/api/auth/setup` first. `GET /api/profile/status`, `POST /api/visa-sponsors/search`, design-resume asset content, all `/*/health` endpoints (`app.ts:189-213`) are public by design.
Fix: generate a one-time setup token on first boot (written to `DATA_DIR` like the JWT secret at `orchestrator/src/server/auth/jwt.ts:28-63`) and require it for `/api/auth/setup`, or bind to loopback until setup completes. Document that deploying on 0.0.0.0 without completing setup is a takeover risk. Add a loud startup warning when no users exist and `NODE_ENV=production`.

### 6. HIGH — Docker production image runs as root and ships a broad attack surface
Evidence: `Dockerfile` — no `USER` directive anywhere; production stage (`Dockerfile:181-227`) inherits root. Container installs Codex CLI globally (`Dockerfile:34`), Xvfb/x11vnc/noVNC/websockify (`Dockerfile:128-131`), Playwright browsers for two engines plus camoufox cache copied from `/root/.cache` (`Dockerfile:186-187`), and `curl` remains in the runtime image (`Dockerfile:19-33`). `docker-entrypoint.sh` runs the server as root; `x11vnc` is started with `-nopw` (`orchestrator/src/server/services/challenge-viewer.ts:204-216`).
Fix: create a non-root user (`node` exists in the base image), `chown` `/app/data`, and end with `USER node`. Move `curl` out of the final stage (use `HEALTHCHECK` with node fetch or a wget from busybox), and scope the VNC stack to a build-time-selectable target since `-nopw` VNC is only safe because it binds to loopback (`challenge-viewer.ts:96-99` defaults) — keep it that way and fail closed if `VNC_HOST`/`NOVNC_HOST` is set to a non-loopback address.

### 7. MEDIUM — Challenge viewer: unauthenticated noVNC proxy guarded only by a 5-minute in-memory token, spawned via `sh -c` with env-interpolated values
Evidence: `orchestrator/src/server/app.ts:393-395` mounts `/challenge-viewer/session` outside the auth-guarded `/api` router and `requiresAuth` returns false for it (non-API GET). `orchestrator/src/server/services/challenge-viewer.ts:269-279` validates only `viewerTokens` (TTL `5 * 60 * 1000`, `challenge-viewer.ts:18`). Tokens are not bound to a user/session, so a leaked URL is replayable by anyone for 5 minutes. Separately, `buildNoVncCommand` (`challenge-viewer.ts:101-118`) interpolates `NOVNC_HOST/PORT`, `VNC_HOST/PORT` env values into a `sh -c` string (`challenge-viewer.ts:220-223`) — a malicious env value containing `"` or `$(...)` would inject shell commands (requires env control, hence MEDIUM).
Fix: require a valid JWT (same auth guard) before issuing/proxying viewer sessions, bind tokens to the requesting user id and single-use websocket upgrade, and validate the four host/port envs against `^\d{1,5}$` / hostname regex before interpolation (or pass as argv to `websockify` directly instead of `sh -c`).

### 8. MEDIUM — CORS is wide open (`cors()` default) on all routes except `/stats`
Evidence: `orchestrator/src/server/app.ts:316` (`const corsMiddleware = cors();`) applied at `app.ts:362-369` with no `origin` option — reflects any `Origin` with `Access-Control-Allow-Origin: *` for all API and static routes.
Because the API authenticates via `Authorization: Bearer` (not cookies) the classic credentialed-CORS theft is blunted, but `*` allows any website to read public/demo-mode endpoints and, combined with finding 5 (no-auth default), lets any web page drive a victim's local/network JobOps instance (CSRF-by-CORS: fetch from `http://localhost:3001` or a LAN IP with full read of JSON responses).
Fix: configure `cors({ origin: process.env.JOBOPS_CORS_ORIGIN?.split(",") ?? false })` — same-origin SPA does not need CORS at all; default to disabling it and let operators opt in.

### 9. MEDIUM — No HTTP security headers on any response
Evidence: `orchestrator/src/server/app.ts` (no `helmet`/`res.set` for `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`; SPA fallback `app.ts:521-549` serves cached HTML with only `Content-Type`).
The client renders Markdown-generated HTML and hosts a noVNC iframe; absence of CSP/frame-ancestors/nosniff leaves clickjacking (e.g., embedding the auto-apply UI) and MIME-sniffing open. The docs site is served from the same origin (`app.ts:496-519`), so a docs-site XSS would share origin with the API.
Fix: add `helmet` with a strict-but-workable CSP (`default-src 'self'`, allow `blob:`/`data:` for PDF/image previews, `frame-ancestors 'none'` except the challenge-viewer route), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on `/cv/:slug` redirects (tracer links currently leak the full slug URL as `Referer` to third-party job boards — see `handleTracerRedirect`, `app.ts:320-358`).

### 10. MEDIUM — No rate limiting anywhere: login, setup, webhook trigger, OAuth state, tracer redirects
Evidence: no `rate-limit` middleware in `orchestrator/src/server` (grep finds only retry-after parsers). `POST /api/auth/login` (`orchestrator/src/server/api/routes/auth.ts:24-77`) is an online scrypt brute-force oracle with generic "Invalid credentials" (good) but unlimited attempts (bad). `POST /api/webhook/trigger` (`orchestrator/src/server/api/routes/webhook.ts:14-50`) starts a full pipeline run per request; the auth-guard exemption (`app.ts:199-202`) only requires `WEBHOOK_SECRET` to be *set*, and the comparison at `webhook.ts:17-19` is a plain `!==` string compare (not timing-safe). Gmail OAuth state store is in-memory with a 1000-entry cap (`post-application-providers.ts:43-101`) — restart invalidates in-flight logins, and the cap eviction is global, letting one tenant DoS another's OAuth flow.
Fix: add `express-rate-limit` (login: ~5/min/IP with exponential backoff; webhook: per-IP + shared-secret; setup: 1/boot), use `crypto.timingSafeEqual` for `WEBHOOK_SECRET` comparison, and persist OAuth state in SQLite keyed by tenant.

### 11. MEDIUM — JWT/session: 24 h tokens, no refresh rotation, secret file permissiveness, `isSystemAdmin` claim trusted cross-workspace
Evidence: `orchestrator/src/server/auth/jwt.ts:9` (default 86400 s, env-overridable with no upper bound — `getJwtExpirySeconds`, `jwt.ts:88-95`), `verifyToken` (`jwt.ts:141-186`) checks the session row by `jti` (good: revocation works), but `payload.isSystemAdmin === true` is taken from the *token* claim (`jwt.ts:183`) rather than re-read from the user row — `getAuthorizationContext` (`app.ts:152-167`) does re-read the user, mitigating this, but any other consumer of `verifyToken` that trusts the claim directly (e.g. `auth.ts:137` `/me`) inherits stale admin flags after demotion until token expiry/revocation. Persisted secret file is created with `0o600` (good) but `DATA_DIR` itself is a bind-mounted volume (`docker-compose.yml`) whose host permissions are uncontrolled.
Fix: cap `JWT_EXPIRY_SECONDS` (e.g. ≤ 7 days) and ignore larger values, drop `isSystemAdmin` from the JWT payload entirely (always read from DB), and `chmod 700` the data dir on boot.

### 12. MEDIUM — Secret material handling: SMTP password and LLM keys live in `process.env` snapshots and settings table in plaintext; logs redaction is key-name based only
Evidence: `orchestrator/src/server/services/envSettings.ts:6` (`const envDefaults = { ...process.env }` — a permanent in-memory copy of the whole environment, including `JWT_SECRET`, SMTP pass, OAuth client secret), `orchestrator/src/server/services/auto-apply.ts:121-148` (SMTP creds from env, AUTH LOGIN base64 — `auto-apply.ts:344-348`), secrets stored in the `settings` table plaintext (`orchestrator/src/server/repositories/settings.ts`) and returned to the client only as 4-char hints (good: `envSettings.ts:37-50`). Log redaction (`orchestrator/src/server/infra/sanitize.ts:3-4`) triggers on key *names* only — a secret inside a free-text field (e.g. an SMTP banner containing the password, `expectSmtp` errors include server `response` text, `auto-apply.ts:275-282`) is logged raw.
Fix: narrow `envDefaults` to the keys actually consumed by `settingsRegistry`; encrypt settings-table secrets at rest with the persisted JWT secret (or a dedicated key) using AES-GCM; scrub values matching known secret patterns in `sanitizeError`, not just keys.

### 13. MEDIUM — Auto-apply abuse surface is intentionally gated but has weak per-job confirmation and no per-recipient verification
Evidence: `orchestrator/src/server/services/autonomous-auto-apply.ts:60-96` (env gates: queue, email, full-auto, browser-submit, captcha — all opt-in; good), mode defaults to `dry_run` (`:163-165`; good), `classifyAutonomousAutoApply` leaves CAPTCHA/portal jobs human-in-loop unless explicit flags (`:105-148`; good). However the recipient is chosen by `chooseApplicationRecipient` from scraped job text (`auto-apply.ts:400-412` area) — a poisoned job description can embed an attacker email and the system will mail the tailored resume PDF (PII) to it with one click; there is no domain verification against the job board origin. `sendAutoApplication` builds `MAIL FROM`/`RCPT TO` from strings with no CRLF filtering of header fields — `buildMimeMessage` input from job fields could inject SMTP headers if a scraped value contains `\r\n` (`auto-apply.ts:349-351`, `command()` writes raw `${value}\r\n` at `:289-292`).
Fix: strip/CRLF-reject every string interpolated into SMTP commands and MIME headers; require recipient domain match (or explicit user confirm) when the recipient email differs from the job-board domain; add a per-day send cap and an audit log of recipient + PDF hash.

### 14. LOW — 2Captcha integration sends page screenshots and the API key over the public API; CAPTCHA solving of job portals may violate ToS and leaks API key in error paths
Evidence: `orchestrator/src/server/services/application-browser.ts:456-467` (`createTask` with `clientKey` in JSON body to `https://api.2captcha.com`), `:481-489` (poll), `:494-504` (`screenshotImageCaptcha` uploads page imagery — page may contain logged-in portal content/PII to a third party), `:509-514` (solution injected via `page.evaluate` string interpolation — payload is `JSON.stringify`'d first, so this is safe against injection, noted for completeness). Provider errors bubble `errorDescription` into thrown errors (`:463-469`) which are logged; 2Captcha echo fields can contain the client key.
Fix: document the third-party data-flow (screenshots leave the host), scrub `clientKey` from any logged 2Captcha error, and keep portal CAPTCHA human-review-only per the stated policy in `captcha-solver.ts:29-33` (already the case for extractors — extend the guarantee to portal submissions by removing `JOBOPS_FULL_AUTO_CAPTCHA…` bypass or gating it behind a big warning).

### 15. LOW — File import paths: PDF/DOCX resume import forwards raw file bytes to external LLM providers; MIME sniffing trusts extension/header; base64 15 MB JSON limit
Evidence: `orchestrator/src/server/app.ts:376-382` (`/api/design-resume/import/file` JSON limit 15 MB), `orchestrator/src/server/services/design-resume/import-file.ts:139` (extension regex), `:1058/1144/1251` (file forwarded as `input_file`/`file` base64 to OpenAI/OpenRouter/Gemini). Content is not locally scanned (no magic-byte validation for PDF `%PDF-` / DOCX `PK\x03\x04`); a user uploading an arbitrary blob has it shipped to third-party LLM APIs. Risk is data-governance more than code execution (parsing is delegated), hence LOW. RxResume picture fetch *does* have a robust private-host block (`design-resume/index.ts:199-243`) — reuse it per finding 3.
Fix: validate magic bytes before accepting imports, and state plainly in docs/UI that imported resumes are sent to the configured LLM provider.

### 16. LOW — Client XSS surface is mostly contained; residual items: Markdown linkify + `template.innerHTML`, Gmail OAuth `postMessage`, tracer redirect referrer leakage
Evidence: `orchestrator/src/client/lib/jobNoteContent.ts:2-6` (`MarkdownIt({ html: false, linkify: true })` — raw HTML disabled, good), `:155-158` (`template.innerHTML = html` used only to *parse* editor HTML back to Markdown — inert `template` element, no script execution; safe). `orchestrator/src/client/pages/GmailOauthCallbackPage.tsx:13-21` posts the OAuth code to `window.opener` with `window.location.origin` as target origin (correct origin pinning — verified safe). `TrackingInboxPage.tsx:261` validates `event.origin === window.location.origin` (correct). No `dangerouslySetInnerHTML` found in client code. Remaining: `linkify-it` CVE (finding 2) applies to note text; tracer links leak slug via `Referer` (finding 9).
Fix: bump `linkify-it`/`markdown-it` (lockfile bump applied), set `Referrer-Policy` on tracer redirects, and add the CSP from finding 9 as defense-in-depth.

### 17. LOW — Demo mode exposes nearly the whole API read/write anonymously by design
Evidence: `orchestrator/src/server/app.ts:225-238` (`isPublicDemoRoute` — everything under `/api/` except a small protected list is public when `DEMO_MODE=true`), `orchestrator/src/server/config/demo.ts:22-24` (env-flag only). Destructive routes are individually blocked via `sendDemoBlocked`, but this is an opt-out list per route — any new route forgetting the check is anonymously writable on the public demo.
Fix: invert to an allow-list of demo-readable routes, and keep the 6-hour reset (`demo.ts:12`) plus consider per-IP throttles.

---

## Applied mechanical fixes (safe, no behavior change)

1. **`package-lock.json`**: `npm audit fix --package-lock-only` — in-range bumps only (no semver-major changes), remediating the non-major advisories from finding 2 (`shell-quote`, `websocket-driver`, `express`/`body-parser`/`qs`, `undici`, `fast-uri`, `linkify-it`, `markdown-it`, `ip-address`, `js-yaml`, `form-data`, `ws`, `postcss`, `vite`, `axios` and transitive crawlee/file-type chains, as permitted by declared ranges). Runtime `node_modules` were not installed here; CI/deploy builds will pick the bumped pins from the lockfile. No source or manifest (`package.json`) changes were required, so declared behavior is unchanged.

> No code edits were made: every remaining finding needs a behavior-affecting change
> (auth default, CORS policy, SSRF guards, headers, Docker USER) and is left as a
> recommendation with a concrete fix above.

## Suggested next steps (priority order)

1. Fix finding 3 + 4 with a shared `assertPublicHttpUrl` util (reuse `design-resume/index.ts:199-243`).
2. Gate `/api/auth/setup` with a first-boot token (finding 5) and add rate limits (finding 10).
3. Run the container as non-root (finding 6).
4. Set restrictive CORS + security headers (findings 8, 9).
5. Plan semver-major upgrades: `drizzle-orm ≥ 0.45.2`, `camoufox-js 0.12.x`, Docusaurus 3.5.2 (finding 2).
