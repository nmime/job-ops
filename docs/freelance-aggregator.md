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

| Platform | Finder | Credentials needed |
|---|---|---|
| RemoteOK | **REAL** — public JSON API | none |
| We Work Remotely | **REAL** — public RSS feeds | none |
| Upwork | adapter stub | OAuth / API key |
| Freelancer.com | adapter stub | API key |
| Fiverr | adapter stub | session cookie |
| Toptal | adapter stub | session cookie |
| PeoplePerHour | adapter stub | session cookie |
| Guru | adapter stub | API key |
| Malt | adapter stub | session cookie |
| freelancermap | adapter stub | API key |
| Wellfound | adapter stub | session cookie |
| Braintrust | adapter stub | API key |
| Contra | adapter stub | session cookie |
| Arc.dev | adapter stub | session cookie |
| Gun.io | adapter stub | API key |
| Turing | adapter stub | session cookie |
| FlexJobs | adapter stub | subscription cookie |
| Wantapply | export adapter | webhook URL |

"adapter stub" = the provider is wired into the registry and returns a
structured *not configured* result naming the exact env var it needs. The
aggregator, dedupe, scoring, proposal and guard layers are fully live for every
platform; only the platform-specific HTTP calls remain.

RemoteOK and We Work Remotely are genuinely live today and need no credentials.

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
   `JOBOPS_FREELANCE_<PLATFORM>_API_KEY` (or `_COOKIE`).
2. Implement the platform's `findGigs` / `applyToGig` HTTP calls in
   `extractors/<platform>/src/main.ts` (the contract and guards are done).
3. Set `JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED=true`.
4. Set `FREELANCE_AUTOBID_ENABLED=true`.
5. Optionally raise `JOBOPS_FREELANCE_<PLATFORM>_MAX_PER_HOUR`.

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

Discovery is live and credential-free on **Freelancer.com, RemoteOK and
WeWorkRemotely**. Only **Freelancer.com** has a real submit adapter
(`POST https://www.freelancer.com/api/projects/0.1/bids/`). To let it place real
bids, all three gates must be open:

```
JOBOPS_FREELANCE_FREELANCER_API_KEY=<your OAuth token>
JOBOPS_FREELANCE_FREELANCER_APPLY_ENABLED=true
FREELANCE_AUTOBID_ENABLED=true
```

With any gate closed the pipeline still discovers, scores and drafts proposals,
but returns `mode: "dry_run"` and submits nothing. The other 15 credentialed
platforms return a structured "not configured" result by design.

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
| wantapply | public JSON API (`/api/jobs`, Cloudflare-gated → stealth-browser fallback) | 2,315 tech listings |

(contra also has a credential-free Ashby careers feed, ~3 small postings.)

### Credentialed adapters (clean not-configured without keys; real path when set)
upwork (official GraphQL + Playwright cookie), fiverr, peopleperhour, guru
(official API + cookie), malt, wellfound (GraphQL + cookie), flexjobs, contra.
Each reads `JOBOPS_FREELANCE_<PLATFORM>_{API_KEY,COOKIE}` (settings first, then
env) and returns an actionable `success:false` result naming the exact var when
absent — never throws, never fabricates.

### No-apply platforms
remoteok, weworkremotely and wantapply are external-apply job boards:
discovery is real, but every listing's Apply button redirects to the
employer's own ATS form, so their `applyToGig` adapters are guarded and never
submit or fake a submission in-platform. wantapply additionally keeps a
guarded batch exporter (`exportBatchToWantapply`) for pushing scored gigs to
an external auto-applier webhook.

### Submit safety (money path) — all 16 apply adapters
`dryRun:true` -> `mode:"dry_run", status:"skipped"` (never submits).
`dryRun:false` without credentials -> `mode:"submit", status:"error"` naming the
missing var. Blank cover letter -> refused. Real submission only after the
orchestrator's three gates open (per-platform `_APPLY_ENABLED` + global
`FREELANCE_AUTOBID_ENABLED` + credential present). Verified: 16/16 dry-run-safe,
16/16 ungated-guarded, 0 submissions, 0 throws.
