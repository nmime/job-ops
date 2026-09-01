# job-ops multi-platform core

Autonomous freelance pipeline, generalized from the Contra-only pipeline into a
**multi-platform** system. One brain/queue/worker/monitor per platform, shared
infrastructure (steel-browser, notifications, monitoring, registry).

## Layout
```
/opt/job-ops/multiplatform/
  registry.json          # THE source of truth: every platform (id, model, region, level, enabled, paths)
  dispatcher.sh          # runs each ENABLED platform's orch.sh (isolated; one failure != all)
  monitor.py             # generalized monitor: containers + steel + per-platform timer/state/queue/log
  status.sh              # cross-platform status table (+ --telegram to DM the summary)
  lib/
    notify.sh            # Telegram push (sources /opt/job-ops/notify.env)
    common.sh            # shared helpers (read_json, counts, container_up, steel_ok)
  platforms/<id>/
    manifest.json        # platform config: account, model, auth, endpoints, blocker/notes
    orch.sh              # brain + worker for this platform (run by the dispatcher)
    <id>-orchestrator.mjs # brain: discover/select -> write state + queue
    <id>-apply.mjs        # driver: execute one action (applied in steel-browser or via HTTP)
```

## Data model (per platform)
- **state**  `/app/data/<id>-state.json`  `{ applied|posted: {key:{at,note}}, failed: {key:{at,note}} }`
- **queue**  `/app/data/<id>-queue.json`  `{ updatedAt, queue: [ {...action items...} ] }`

A platform's **brain** scans the platform, filters already-handled items (state),
and writes the queue of pending actions. The platform's **worker** pops queue items,
executes the action, records the outcome in state, and notifies on success.

## Action models (the key generalization)
- `apply`  — apply/bid to buyer-posted gigs (Contra, Upwork, FL.ru, PeoplePerHour, …)
- `post`   — post seller service listings (Kwork, Fiverr, ComeUp, Khamsat, …)
- `contest`— submit to design contests (99designs, DesignCrowd)
- `vetted` — apply to join a vetted network (Toptal, Arc, Braintrust) — join-flow, not gig-flow
- `leads`  — buy/respond to leads (Bark, Profi.ru)

A platform's driver is shaped by its model. `apply` drivers open a gig + submit a
proposal; `post` drivers create a service listing; etc.

## Levels (progress per platform)
- **0 registered** — in registry + manifest; monitored; no account yet
- **1 account+auth** — account created + verified; driver can authenticate
- **2 discovery**   — brain can list/detect actionable items
- **3 live action verified** — a real apply/post succeeded end-to-end

## Running
- `systemctl start jobops-mp-orch` (oneshot; runs the dispatcher over enabled platforms)
- `jobops-mp-orch.timer` fires it every 30 min
- `jobops-mp-monitor.service` — persistent monitor (all platforms + containers + steel)
- `/opt/job-ops/multiplatform/status.sh` — print status; `status.sh --telegram` to DM @nmime
- Contra keeps its own proven `jobops-contra-orch.timer` (it is `enabled:false` in the
  dispatcher registry so it is not double-run; the monitor still watches it).

## Adding a platform
1. Add an entry to `registry.json` (`platforms/<id>`: model, url, state/queue/timer/log,
   `proc_pattern`, `enabled:false`, `level:0`).
2. Create `platforms/<id>/manifest.json` (account + auth + endpoints + notes).
3. Write `platforms/<id>/<id>-orchestrator.mjs` (brain) + `<id>-apply.mjs` (driver) +
   `orch.sh` (brain + worker glue, mirroring contra-orch.sh / contra-worker.sh).
4. Create the account (email, + rental SMS via harness if phone is required), complete
   the profile, and confirm the driver can authenticate (level 1).
5. Implement discovery (level 2), then the live action (level 3).
6. Flip `enabled:true` when the driver is live-verified.
7. `systemctl daemon-reload` not needed (registry is read at runtime); the monitor picks
   it up on the next tick.

## Status (2026-09-01)
- **Contra** — L3 live (5 applied, 0 failed). Own timer.
- **Kwork**  — L1 (account + email-verified + HTTP auth). Blocker: complete seller profile
  to set `isUserWorker=true` (reveals Create-Kwork form); then reverse `/save-kwork` POST.
  See `platforms/kwork/manifest.json`.
- **All 44 platforms scaffolded** — every platform (except Contra, which has its own proven
  pipeline) has a complete, working, monitored pipeline structure at
  `platforms/<id>/` (manifest + `orch.sh` + brain + driver). The brain/driver start as safe
  no-ops (clear `TODO(<id>)` markers); enabling a platform runs a clean, harmless cycle.
  Wiring a platform live = fill the account (L1) + implement discovery (L2) + the action (L3),
  then flip `enabled:true`. Use `scaffold.sh <id>` to add any new platform.
  Registered L0: Fiverr, ComeUp, Khamsat, Legiit, FL.ru, Freelance.ru, Freelancehunt,
  Weblancer, Workzilla, Freelance.kz, Kabanchik, YouDo, Profi.ru, Workspace, TaskPay, Sribu,
  Fastwork, Fastlance, Kmong, ZBJ, EPWK, PeoplePerHour, Freelancer.com, Upwork, SEOClerks,
  Guru, Workana, Truelancer, Twine, Malt, Useme, 99designs, DesignCrowd, Toptal, Arc,
  Braintrust, Bark, Mostaql, Ureed, Projects.co.id, CrowdWorks, Lancers.

## Known constraints (discovered 2026-09-01)
- **Rental SMS does NOT cover freelance platforms.** `sms_services` lists 30 consumer
  services (linkedin, google, uber, telegram, vkcom, whatsapp, airbnb, ...). No freelance
  marketplace (kwork, flru, weblancer, upwork, fiverr, ...) is supported. So platforms that
  REQUIRE a phone number at signup/onboarding (most CIS: FL.ru, Weblancer, Freelancehunt,
  Workzilla, Kwork) cannot be phone-verified with a rental number. They need a real number
  the user controls, or a provider-supported number. Prefer **email-only** platforms first.
- **agent-browser sessions do not persist across shell invocations** (idle-out ~1-2 min).
  Any multi-step browser RE (login -> form -> submit -> capture) MUST be done in ONE
  command/session. Keep per-platform browser work in single self-contained scripts.
- **Cloudflare/anti-bot at signup** on several global platforms (Freelancehunt shows a
  Cloudflare challenge; FL.ru uses reCAPTCHA). These need the Cloudflare auto-solver /
  captcha handling and are slower/less reliable.
- **egress**: Contra uses a verified Vodafone-UK mobile proxy (reCAPTCHA-aware). Kwork
  works on direct egress (no proxy). Per-platform egress is set in each worker.

## Shared infra (already wired)
- **steel-browser** container — hardened+verified Chromium for the `apply`-model drivers
  (session API at :3000, CDP at :9222). Proven by Contra.
- **Telegram** — `notify.env` (TG_BOT_TOKEN, TG_CHAT_ID=305544740); monitor alerts + worker
  success DMs go to @nmime via `lib/notify.sh` + `/opt/job-ops/hooks/monitor-alert.sh`.
- **SMS (rental)** — harness `sms_number`/`sms_code` for phone verification at signups.
- **egress** — Contra uses a verified Vodafone-UK mobile proxy (`contra-proxy.env`); Kwork
  works on direct egress (no proxy); per-platform egress is set in each platform's worker.
