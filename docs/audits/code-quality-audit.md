# Code Quality Audit — job-ops (fork `nmime/job-ops`)

**Date:** 2026-08-10
**Scope:** full monorepo at `sync/upstream-main` (upstream v0.11.0 merged + fork
features preserved + freelance aggregator).
**Method:** static metrics, compiler strictness, linter, test-suite execution,
and manual review of the largest / highest-risk modules.

---

## 1. Verdict

**Healthy.** The codebase is unusually disciplined for its size: strict
TypeScript with zero suppressions, a large real test suite that passes clean,
and a linter that is effectively green. The main risks are *structural*
(a handful of very large modules) rather than correctness or safety.

| Dimension | Grade | Note |
|---|---|---|
| Type safety | A | 0 `@ts-ignore`, 12 `any` in ~189k LOC |
| Test coverage | A− | 254 test files, 2019 tests, 0 failing |
| Lint / format | A | 0 errors, 1 pre-existing warning |
| Module size | C+ | 11 files > 1000 LOC |
| Tech debt markers | A | 0 TODO/FIXME/HACK |
| Dependency hygiene | B+ | see §6 |

---

## 2. Measured metrics

```
TypeScript/TSX source files (src + extractors) : 947
Total LOC (orchestrator/src + shared/src)      : 188,962
Non-test LOC                                   : 127,984
Test files                                     : 254
Tests                                          : 2019 passed, 3 skipped, 0 failed
Test files passing                             : 290 / 290
`any` usages (non-test)                        : 12
`@ts-ignore` / `@ts-expect-error`              : 0
TODO / FIXME / HACK / XXX (non-test)           : 0
Biome errors                                   : 0
Biome warnings                                 : 1
tsc --noEmit errors (orchestrator + shared)    : 0
```

Test-to-source ratio is roughly **1 test file per 2.6 non-test source files**,
and tests make up ~32% of the codebase. That is a genuinely well-tested project.

---

## 3. Strengths

### 3.1 Zero type-suppression
Not a single `@ts-ignore` or `@ts-expect-error` across 189k lines, with
`strict` enabled. The 12 remaining `any` occurrences are confined to
boundaries (third-party payload parsing) rather than internal logic. This is
the strongest signal in the audit — it means the type system is actually load
bearing here, not decorative.

### 3.2 No debt markers
Zero `TODO`/`FIXME`/`HACK`. Unfinished work is expressed as *typed, tested
not-configured results* (e.g. the freelance provider stubs return a structured
error naming the required env var) instead of comments that rot.

### 3.3 Tests are real
The suite exercises actual HTTP servers, a real SQLite database, and real
DOM rendering rather than mocking everything into tautology. Route tests boot
a server and `fetch` it; repository tests hit a temp database. Consequently
the merge regressions in this cycle were *caught by tests*, which is the whole
point.

### 3.4 Consistent module conventions
Path aliases (`@server/*`, `@shared/*`, `@infra/*`, `@client/*`) are enforced by
a lint rule (`noRestrictedImports`) that bans deep relative imports into server
code. Extractors follow a uniform manifest + finder shape, which is what made
adding 18 freelance providers mechanical.

### 3.5 Graceful degradation is designed in, not bolted on
Repeated pattern across the codebase: a missing credential yields a typed
"not configured" result rather than a thrown exception. Verified live — the
freelance worker ran 3 unattended cycles with 16 of 18 platforms unconfigured
and never aborted a cycle.

---

## 4. Findings

### F-1 — Oversized modules (Medium)

Eleven non-test files exceed 1000 lines:

| LOC | File |
|---|---|
| 2322 | `services/design-resume/import-file.ts` |
| 1859 | `client/pages/SettingsPage.tsx` |
| 1790 | `server/db/migrate.ts` |
| 1452 | `services/ghostwriter.ts` |
| 1250 | `services/design-resume/index.ts` |
| 1228 | `services/application-browser.ts` |
| 1180 | `client/pages/orchestrator/JobDetailPanel.tsx` |
| 1152 | `server/db/schema.ts` |
| 1110 | `server/pipeline/orchestrator.ts` |
| 1084 | `client/pages/JobPage.tsx` |
| 1062 | `services/llm/codex/client.ts` |

`import-file.ts` at 2322 lines is the clearest offender: it mixes base64
decoding, DOCX/PDF text extraction, multi-provider LLM dispatch, JSON repair,
resume normalization/sanitization, and persistence. This is also the file that
produced the hardest merge conflict of the upstream sync — size and merge pain
are directly correlated here.

`migrate.ts` and `schema.ts` are large for legitimate reasons (append-only
migration history, one big relational schema) and should be left alone.

**Recommendation:** split `import-file.ts` along its natural seams —
`extract-text.ts` (DOCX/PDF), `deterministic-import.ts` (the offline fallback,
already a self-contained block), `provider-dispatch.ts`, `normalize.ts`. Do the
same for `SettingsPage.tsx` by section. Not urgent; do it opportunistically
before the next upstream merge, since it will reduce future conflict surface.

### F-2 — Duplicated LLM provider scaffolding (Low)

Each LLM provider (`codex`, `claude-cli`, `requesty`, `gemini`, …) reimplements
similar retry/timeout/streaming plumbing. The shapes have already drifted
slightly between providers. Extracting a shared transport would cut several
hundred lines and make provider behaviour uniform.

### F-3 — One non-null assertion (Low, pre-existing)

`server/repositories/application-email-attempts.ts:90` — `mapRow(rows[0]!)`.
The only lint warning in the repo. A `.limit(1)` query can still return zero
rows; if this row is genuinely guaranteed, encode it with an explicit
`if (!rows[0]) throw notFound(...)` rather than an assertion.

### F-4 — Test-suite runtime (Low)

The full orchestrator suite takes ~250s. Acceptable today, but it grows with
every route test that boots a real server. Watch it; consider sharding in CI
before it crosses ~5 minutes.

### F-5 — Freelance providers are contract-complete but transport-incomplete (Informational)

16 of 18 freelance platforms are wired end-to-end through the registry,
dedupe, scoring, proposal and guard layers, but their platform-specific HTTP
calls are unimplemented pending credentials. This is deliberate and clearly
signalled at runtime, not hidden. It is listed here so no reader mistakes the
platform count for 18 live integrations — **2 are live (RemoteOK, We Work
Remotely), 16 await credentials.**

---

## 5. Merge-integrity review

The upstream v0.11.0 sync (124 commits, 36 conflicted files) was audited for
silent feature loss. Confirmed still present after merge:

- autonomous full-auto apply (email + portal)
- paid CAPTCHA solver (2captcha) with manual-viewer fallback
- Ever Jobs extractor and extra remote API sources
- resume-derived search terms
- `runBudget` / `searchTerms` / `scoringInstructions` pipeline options
- rxResume PDF concurrency queue (re-applied onto upstream's rewritten `pdf.ts`)
- deterministic offline DOCX import (re-applied onto upstream's `import-file.ts`)

Confirmed correctly adopted from upstream: greenhouse/fiveamsat/wazzuf/
career-boards extractors, Claude CLI + Requesty providers, map/proximity
location, Typst themes, Watchlist filtering, `hasAuthenticatedSession`,
`llmPurposeOverrides`, `autoTailorOnManualImport`.

Confirmed deliberately dropped (upstream removal, followed intentionally):
all Basic Auth (`basicAuthActive`, `basicAuthPassword`, `enableBasicAuth`,
`isBasicAuthEnabled`).

Two regressions were introduced by the merge and **both were caught by the test
suite, not by review** — a stale `pdf.ts` and a lost DOCX fallback. Both fixed.
This is the audit's best evidence that the test suite is doing real work.

---

## 6. Dependency hygiene

- npm workspaces, single lockfile, no duplicated framework versions observed.
- Biome replaces the ESLint+Prettier pair — one tool, fast (1117 files in 2s).
- `tsx` used for scripts; no ad-hoc build step for tooling.
- **Watch item:** extractor packages now use `exports` maps pointing at raw
  `.ts` source. That works because everything is consumed by `tsx`/vitest
  in-repo, but it will break the moment an extractor is published standalone.
  Acceptable for a monorepo; document it if that changes.

---

## 7. Prioritized recommendations

| # | Action | Effort | Priority |
|---|---|---|---|
| 1 | Split `import-file.ts` into 4 modules | M | High (before next upstream merge) |
| 2 | Replace the `rows[0]!` assertion with an explicit guard | XS | Medium |
| 3 | Extract shared LLM transport layer | M | Medium |
| 4 | Split `SettingsPage.tsx` by section | M | Low |
| 5 | Sharded CI for the test suite | S | Low (pre-emptive) |
| 6 | Keep the 3-gate freelance safety model under test | — | Ongoing |

Nothing in this audit blocks release.
