# job-ops multi-platform core (job-ops-native)

Autonomous freelance pipeline, generalized from the Contra-only pipeline into a
**multi-platform** system that lives **inside job-ops** (not a parallel sidecar):

- **State** = the job-ops SQLite `freelance_*` tables (`/app/data/jobs.db`, bind-mounted
  from `/opt/job-ops/data`). No per-platform JSON state/queue files.
- **Browser** = the **steel-browser** container (hardened+verified Chromium). Each platform
  gets a **persistent** steel session (`persist:true` + a per-platform `fingerprintSeed`),
  so login state / cookies survive across cycles — exactly how Contra stays logged in
  (`fingerprintSeed 424242`).
- **Scheduling** = a step in the job-ops **autonomous cycle**
  (`scripts/autonomous/jobops-autonomous-run.sh` → `run_multiplatform`), which the
  `jobops-autonomous.timer` fires every 37 min.

## Architecture (three roles, one pipeline)

```
host coordinator                       job-ops container                 steel-browser container
(orchestrator.mjs)                     (better-sqlite3, node)            (puppeteer-core + CDP :9222)
─────────────────                      ─────────────────                  ─────────────────────────
for each enabled platform:
  steelCreateSession(seed)  ────────────────────────────────┐
  steelRunTask(discover.mjs)  ─────────────────────────────────────────▶  discover (list/inspect)
  upsert-opportunity / score / approve  ─▶ freelance_opportunities
  get-queue  ─────────────────────▶ freelance_opportunities (approved)
  steelRunTask(apply.mjs)  ────────────────────────────────────────────▶  act (apply/post)
  set-opportunity-status / record-audit ─▶ freelance_opportunities + freelance_audit_events
  record-audit(platform_status) ──▶ freelance_audit_events
  steelRelease(session)  ────────────────────────────────┘  (profile persists via seed)
```

- **Host coordinator** (`multiplatform/orchestrator.mjs`) — runs on the host (node v24).
  Reads `registry.json`, seeds `freelance_sources`, and per enabled platform: creates a steel
  session by seed → runs `discover.mjs` → upserts/scores/approves opportunities → runs
  `apply.mjs` on the approved queue → records status + audit → releases the session.
  It talks to the DB through `dbCmd` (docker exec into the job-ops container) and to the
  browser through `docker exec steel-browser node steel-drive.mjs`.
- **job-ops container** — owns the DB. `orchestrator/scripts/multiplatform/db.cjs` is the
  in-container DB command handler: `seed-sources`, `upsert-opportunity`, `score-opportunity`,
  `approve-opportunity`, `get-queue`, `set-opportunity-status`, `record-audit`,
  `freelance-snapshot`, `summary`.
- **steel-browser container** — `orchestrator/steel-drive.mjs` attaches to the session's CDP
  (`:9222`) via puppeteer-core and runs a platform task module. A task is
  `export default async function run(page, ctx, arg) { ...; return result; }`; the driver prints
  `RESULT <json>` on the last line, which the coordinator parses.

## Layout
```
/opt/job-ops/multiplatform/
  registry.json          # THE source of truth: every platform (id, model, region, level, enabled)
  orchestrator.mjs       # host coordinator (drives steel + job-ops DB per platform)
  run.sh                 # stages db.cjs/steel-drive.mjs/platforms/secrets into the containers, runs the coordinator
  monitor.py             # monitor: containers + steel + timers + freelance_* DB (per-platform status/blocked)
  status.sh              # cross-platform status table + freelance_* DB section (+ --telegram)
  scaffold.sh            # add a new platform (registry entry + platforms/<id>/ template)
  lib/  notify.sh, common.sh
  platforms/<id>/
    manifest.json        # fingerprintSeed, home, login creds (secrets), endpoints, blockers
    discover.mjs         # brain: ensure logged in (seed profile), list/inspect actionable items
    apply.mjs            # driver: execute one action (apply/post) for a queued opportunity
/opt/job-ops/orchestrator/
  steel-drive.mjs        # attach to a persistent steel session (CDP :9222) and run a task
  scripts/multiplatform/db.cjs   # in-container freelance_* DB command handler
/opt/job-ops/scripts/autonomous/jobops-autonomous-run.sh   # has a `multiplatform` step (run_multiplatform)
```

## DB model (the freelance_* tables — already in jobs.db)
- `freelance_sources` — one row per platform (source_type=marketplace, mode=user_authenticated_read,
  enabled, proof_metadata={model, level, region, url}).
- `freelance_opportunities` — discovered gigs/kworks (dedupe_key + opportunity_url unique,
  status ∈ discovered|scored|pending_approval|approved|rejected|delegated|archived|expired,
  proof_metadata holds scores + apply results).
- `freelance_scores` — per-opportunity scores + reasons.
- `freelance_approvals` — approval decisions (decided_by, notes).
- `freelance_audit_events` — full trail: `discovered`, `scored`, `approved`, `applied`,
  `apply_*`, `platform_status` (per-platform login/blocked/discovered/applied each cycle).

## Action models
- `apply`  — apply/bid to buyer-posted gigs (Contra, Upwork, FL.ru, PeoplePerHour, …)
- `post`   — post seller service listings (Kwork, Fiverr, ComeUp, Khamsat, …)
- `contest`— submit to design contests (99designs, DesignCrowd)
- `vetted` — apply to join a vetted network (Toptal, Arc, Braintrust)
- `leads`  — buy/respond to leads (Bark, Profi.ru)

## Levels (progress per platform)
- **0 registered** — in registry + manifest; monitored; no account yet
- **1 account+auth** — account created + verified; driver authenticates (persistent session)
- **2 discovery**   — discover.mjs lists/detects actionable items
- **3 live action verified** — a real apply/post succeeded end-to-end

## Running
- The pipeline runs as the `multiplatform` step of the **autonomous cycle** (every 37 min).
- Manual: `bash /opt/job-ops/multiplatform/run.sh` (all enabled) or `--platform kwork`.
- `jobops-mp-monitor.service` — persistent monitor (containers + steel + timers + freelance_* DB).
- `/opt/job-ops/multiplatform/status.sh` — status table + DB section; `--telegram` DMs @nmime.
- Contra keeps its own proven `jobops-contra-orch.timer` (`enabled:false` in this registry so it
  is not double-run; the monitor still watches it). Migrating Contra onto this core is a next step.

## Adding a platform
1. `scaffold.sh <id>` (registry entry + `platforms/<id>/` template) or add the registry entry manually.
2. Fill `platforms/<id>/manifest.json` (fingerprintSeed, home, login creds, endpoints, blockers).
3. Create the account (email, + phone if required), complete the profile.
4. Implement `discover.mjs` (L2) then `apply.mjs` (L3).
5. Flip `enabled:true` in `registry.json` once the driver is live-verified. The monitor picks it
   up on the next tick; the autonomous cycle runs it on the next firing.

## Status (2026-09-02)
- **Core wired + proven end-to-end** on **Kwork** (L1): each cycle creates a persistent steel
  session (seed 777), Kwork stays logged in across cycles, `discover.mjs` reads
  `isUserWorker=true` / `phone_verified=false`, records a `platform_status` audit
  (`blocked:["phone-verification-voice-call"]`), and the monitor reports it. 44 `freelance_sources`
  seeded. **Kwork's only blocker is the voice-call phone verification** (a real number + a human to
  answer) — the rental SMS provider is USA-consumer-only and cannot take a voice call.
- **Contra** — L3 live (5 applied, 0 failed) on its own proven timer; not yet migrated onto this core.
- **All 44 platforms** registered (L0 except Kwork L1, Contra L3).

## Known constraints
- **Rental SMS does NOT cover freelance platforms** and Kwork verifies by **voice call** (not SMS),
  so Kwork needs a real number. Prefer **email-only** platforms next.
- **Cloudflare/anti-bot** at signup on several global platforms; steel (hardened+verified Chromium)
  is the intended mitigation, per-platform egress/proxy configured in the manifest.
- **Per-platform browser persistence** is via the steel `fingerprintSeed` (profile persists); a
  platform must use a stable unique seed. `:9222` serves only the most-recently-created session, so
  the coordinator runs platforms **sequentially** (one session at a time).
