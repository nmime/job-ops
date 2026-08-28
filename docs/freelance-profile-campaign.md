# Freelance Profile Campaign — job-ops subsystem spec

Goal: profile completion + post + publish + promote, managed INSIDE job-ops:
server-driven, repeatable, idempotent, state in the DB, execution via
API (sandbox) and/or browser (sandbox Playwright w/ cookies, or the user's
Mac Chrome as a remote operator backend). Not a one-off manual session.

## Data model (SQLite — existing data/jobs.db)
- `freelance_profiles(platform TEXT PRIMARY KEY, profile_url TEXT, completeness TEXT, status TEXT, fields TEXT /* JSON: field -> {value, status, verified_at} */, updated_at TEXT)`
- `freelance_profile_actions(id INTEGER PRIMARY KEY, platform TEXT, kind TEXT /* fill|post|publish|promote */, target TEXT, payload TEXT /* JSON */, status TEXT /* pending|done|error|user_only */, evidence TEXT, created_at TEXT, completed_at TEXT)`
- `freelance_profile_content(id INTEGER PRIMARY KEY, platform TEXT, kind TEXT /* gig|post|portfolio_item|community_apply */, title TEXT, status TEXT /* drafted|published|error */, external_ref TEXT, created_at TEXT, published_at TEXT)`

## Platform registry
`orchestrator/src/server/services/freelance/profile/platforms.ts` — one spec per platform:
- id, profile URL (identity slug), backend: `api` | `browser_sandbox` | `browser_mac` | `none`
- fields: read/write method (API path or UI selector), userOnly fields (DOB, phone, face photo, street address — NEVER autofilled; status `user_only`)
- actions: post (gigs/posts/portfolio items), publish (drafts -> public), promote (availability, community applications, featured) — definitions derived from the live platform playbooks (Contra work, Fiverr gigs, Toptal communities, etc.)

## Execution
- CLI: `npx tsx scripts/freelance-profile.ts <status|complete|post|publish|promote> [platform|all]`
- API: `GET /api/freelance/profiles`, `POST /api/freelance/profiles/:platform/:action` (extend api/routes/freelance.ts)
- Backends:
  - `api`: direct HTTP with session cookie (auth pattern = discovery adapters)
  - `browser_sandbox`: Playwright + cookies (platforms NOT IP-blocked from the datacenter)
  - `browser_mac`: step list persisted as `pending`; an operator agent applies via the Mac toolchain (runjs.applescript / click.js / typer) and POSTs results back
- Verification: every fill/post/publish/promote is re-read through its backend; marked `done` only on confirmed read. Evidence (selector hit / API response snippet) stored on the action row.
- Identity: CV facts (sandbox /tmp/cv-real.pdf) via `JOBOPS_FREELANCE_PROFILE_*` env; rate anchor 685 EUR/day / ~60 USD/hr; availability immediate; languages DE native + EN; location Falkenstein (Hesse), Germany.

## Acceptance
1. `freelance-profile status` lists all 14 platforms with field-level state.
2. End-to-end proven for at least: Contra (browser_mac backend, real publish attempt), Braintrust + Wellfound + Freelancer (api backend), and 2+ browser_sandbox platforms.
3. Re-runs are idempotent (no duplicate gigs/posts).
4. `tsc --noEmit` clean; existing orchestrator tests pass; committed + pushed.

## Boundaries
- Do not touch data/.credentials (parent installs cookies).
- Do not alter discovery/apply adapters outside profile scope.
- Server restarts only with the setsid command; watchdog owns recovery.
