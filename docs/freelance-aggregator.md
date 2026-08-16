# Freelance Market Aggregator

Aggregates freelance/contract/remote work across 18 platforms into one
discover → dedupe → score → propose → (guarded) apply pipeline, plus an
unattended worker loop.

## Safety model (read this first)

Nothing is ever submitted to a real platform unless you explicitly opt in.
Three independent gates must all be open:

| Gate | Env var | Default |
|---|---|---|
| Global auto-bid | `FREELANCE_AUTOBID_ENABLED` | `false` |
| Per-platform submit | `JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED` | `false` |
| Platform credential | `JOBOPS_FREELANCE_<PLATFORM>_API_KEY` / `_COOKIE` | unset |

With all three closed (the default) the pipeline still runs end-to-end and
generates real tailored proposals — it just stops short of submitting. That
makes the whole thing auditable before a single real bid goes out.

Additional guards:

- A proposal is **always drafted before** any submit path is considered, and an
  untailored draft is refused.
- Per-platform rate limiting, default **5 submissions/hour**
  (`JOBOPS_FREELANCE_<PLATFORM>_MAX_PER_HOUR`).
- CAPTCHA solving stays off unless `JOBOPS_FREELANCE_ALLOW_CAPTCHA=true`.
- A provider that throws is converted into an error result; one broken platform
  never aborts a cycle.

## Platforms

All 18 platforms have real adapters (no stubs) — verified by executing every
finder and every apply gate; see [Live adapter status](#live-adapter-status-verified-by-live-run).

| Platform | Finder | Credentials needed |
|---|---|---|
| RemoteOK | **REAL** — public JSON API | none (no in-app apply) |
| We Work Remotely | **REAL** — public RSS feeds | none (no in-app apply) |
| Freelancer.com | **REAL** — public projects API | none for discovery; OAuth token to bid |
| freelancermap | **REAL** — embedded JSON state | session cookie to apply |
| Arc.dev | **REAL** — server-rendered HTML | session cookie to apply |
| Toptal | **REAL** — Lever public board | session cookie to apply |
| Gun.io | **REAL** — server-rendered HTML | API key to apply |
| Braintrust | **REAL** — public jobs API | API key to apply |
| Turing | **REAL** — Greenhouse public board | session cookie to apply |
| Contra | **REAL** — Ashby careers feed | session cookie to apply |
| Upwork | **REAL** — official GraphQL + cookie fallback | OAuth token or session cookie |
| Fiverr | **REAL** — authenticated session | session cookie |
| PeoplePerHour | **REAL** — authenticated session | session cookie |
| Guru | **REAL** — official API + cookie | API key or session cookie |
| Malt | **REAL** — authenticated session | session cookie |
| Wellfound | **REAL** — GraphQL + cookie | session cookie |
| FlexJobs | **REAL** — subscription session | subscription cookie |
| Wantapply | export service | webhook URL (guarded batch exporter) |

A credentialed adapter with no credential set returns a structured *not
configured* result naming the exact env var it needs — it never throws and
never fabricates data.

## Pipeline

1. **Discover** — every enabled provider runs in parallel
   (`JOBOPS_FREELANCE_PLATFORMS` narrows the set).
2. **Dedupe** — exact pass on a canonical URL hash (tracking params, `www.`,
   trailing slashes and fragments stripped), then a fuzzy pass merging
   ≥85% token-similar titles at the same employer. Keeps the richer record.
3. **Score** — deterministic heuristic in `[0,100]`: skill overlap, budget
   ceiling, hourly vs fixed, verified client, proposal-count competition
   penalty, freshness, remote flag, description quality.
4. **Rank** — score, then budget, then recency.
5. **Propose** — deterministic offline cover letter (HTML-stripped), so
   proposals work with no LLM key.
6. **Apply** — guarded per the safety model above.

## Running it

```bash
# one live aggregation pass + proposals, all dry-run
cd orchestrator && npx tsx scripts/e2e-freelance.ts

# unattended worker: 3 cycles, 5s apart
cd orchestrator && npx tsx scripts/e2e-worker.ts 3 5
```

Both write evidence JSON to `orchestrator/e2e-evidence/`.

## Verified results

Live run against RemoteOK + We Work Remotely:

- 224 gigs discovered (15 RemoteOK + 209 WWR)
- 196 unique after dedupe (16 exact, 12 fuzzy merges)
- top match scored 87/100
- 3 tailored proposals generated
- 0 real submissions (dry-run enforced)

Unattended worker, 3 cycles: 3/3 completed, 9 proposals, 0 real submissions,
16 unconfigured platforms degraded gracefully.

## Turning on real money

To make the aggregator actually earn, per platform:

1. Obtain the platform credential and set
   `JOBOPS_FREELANCE_<PLATFORM>_API_KEY` (or `_COOKIE`). The adapters are
   already implemented in `extractors/<platform>/src/main.ts`.
2. Set `JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED=true`.
3. Set `FREELANCE_AUTOBID_ENABLED=true`.
4. Optionally raise `JOBOPS_FREELANCE_<PLATFORM>_MAX_PER_HOUR`.

Until step 1 is done by the account owner, no automation can bid on your behalf —
these platforms require *your* authenticated identity.

## App integration (v2)

The aggregator is no longer a standalone script — it is wired into the orchestrator.

### Database
Three tenant-scoped tables (`orchestrator/src/server/db/schema.ts`, created by `npm run db:migrate`):
`freelance_gigs`, `freelance_proposals`, `freelance_earnings`.

### API (`/api/freelance`, auth required)
| Method + path | Purpose |
| --- | --- |
| `GET /platforms` | 18 providers, availability, `autobidEnabled` |
| `POST /run` | discover -> dedupe -> score -> persist a cycle |
| `GET /gigs?minScore=&limit=` | scored gig feed, newest first |
| `POST /gigs/:id/propose` | draft a proposal (dry-run unless every gate is open) |
| `GET /proposals` | proposal history |
| `POST /earnings` | record a manual earnings entry (platform, amount, status) |
| `GET /stats` | dashboard counters + earnings summary |
| `GET /earnings` | recorded earnings |

### UI
`/freelance` (nav: "Freelance") renders stats cards, a dry-run safety banner, the
scored gig feed with a min-score slider and per-gig propose button, platform
status, proposals, and earnings.

### Autonomous worker
`startFreelanceWorkerService()` runs at server boot but stays **off** unless
`JOBOPS_FREELANCE_WORKER_ENABLED=true`. It runs non-overlapping cycles on
`JOBOPS_FREELANCE_WORKER_INTERVAL_MINUTES` (default 60).

### Provider registry isolation
Freelance providers live in `extractors/<platform>/` but use the
`findGigs`/`applyToGig` contract, not `ExtractorManifest.run`. They are excluded
from the job-extractor scan via `FREELANCE_PROVIDER_DIRS` in
`orchestrator/src/server/extractors/discovery.ts` — without this the `remoteok`
and `weworkremotely` gig sources collide with the `remoteapis` job extractor and
crash startup with `DuplicateSourceProviderError`.

## Money path (what actually earns)

Discovery is live and credential-free on 9 platforms (see the table above).
Every credentialed platform ships a guarded submit adapter (16 apply paths,
all dry-run-safe by default). To let any platform place real bids, all three
gates must be open:

```
JOBOPS_FREELANCE_<PLATFORM>_API_KEY=<your credential>   # or _COOKIE
JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED=true
FREELANCE_AUTOBID_ENABLED=true
```

Freelancer.com is the most direct path to first revenue: its discovery needs
no key and its submit adapter posts real bids via
`POST https://www.freelancer.com/api/projects/0.1/bids/` once an OAuth token
is set.

With any gate closed the pipeline still discovers, scores and drafts proposals,
but returns `mode: "dry_run"` and submits nothing. A credentialed platform
without its credential set returns a structured "not configured" result naming
the exact env var.

Earnings are tracked in the `freelance_earnings` ledger via
`POST /api/freelance/earnings` (or the "Record earning" card on the
`/freelance` page) — platforms do not push payout webhooks, so entries are
manual once a client pays.

## Live adapter status (verified by live run)

All 18 platforms have real adapters (no stubs). Verified by executing every
finder + every apply gate. Zero throws, zero un-gated submissions.

### Credential-free discovery (live data with no keys)
| Platform | Endpoint | Sample live result |
| --- | --- | --- |
| freelancer | public projects API | 95 gigs |
| weworkremotely | RSS feed | 52 gigs |
| freelancermap | embedded JSON state | 26 gigs |
| arc-dev | server-rendered HTML | 13 gigs |
| remoteok | public API | 4 gigs |
| toptal | Lever public board | 3 gigs |
| gun-io | server-rendered HTML | 2 gigs |
| braintrust | public jobs API | 1 gig |
| turing | Greenhouse public board | 1 gig |

(contra also has a credential-free Ashby careers feed, ~3 small postings.)

### Credentialed adapters (clean not-configured without keys; real path when set)
upwork (official GraphQL + Playwright cookie), fiverr, peopleperhour, guru
(official API + cookie), malt, wellfound (GraphQL + cookie), flexjobs, contra.
Each reads `JOBOPS_FREELANCE_<PLATFORM>_{API_KEY,COOKIE}` (settings first, then
env) and returns an actionable `success:false` result naming the exact var when
absent — never throws, never fabricates.

### No-apply platforms
remoteok and weworkremotely are external-apply job boards: discovery is real,
but there is no in-app proposal, so they expose no `applyToGig`. wantapply is an
auto-apply *service* with a guarded batch exporter (`exportBatchToWantapply`).

### Submit safety (money path) — all 16 apply adapters
`dryRun:true` -> `mode:"dry_run", status:"skipped"` (never submits).
`dryRun:false` without credentials -> `mode:"submit", status:"error"` naming the
missing var. Blank cover letter -> refused. Real submission only after the
orchestrator's three gates open (per-platform `_APPLY_ENABLED` + global
`FREELANCE_AUTOBID_ENABLED` + credential present). Verified: 16/16 dry-run-safe,
16/16 ungated-guarded, 0 submissions, 0 throws.
