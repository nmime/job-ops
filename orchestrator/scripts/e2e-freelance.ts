/**
 * REAL end-to-end freelance aggregator run.
 *
 * Hits LIVE public endpoints (RemoteOK JSON API, We Work Remotely RSS).
 * No credentials required. Writes evidence JSON to ./e2e-evidence/.
 *
 * Usage:
 *   npx tsx orchestrator/scripts/e2e-freelance.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findRemoteOkGigs } from "../../extractors/remoteok/src/main";
import { findWwrGigs } from "../../extractors/weworkremotely/src/main";
import {
  dedupeGigs,
  heuristicGigScore,
  rankGigs,
} from "../src/server/services/freelance/dedupe";
import {
  applyToFreelanceGig,
  buildDeterministicProposal,
} from "../src/server/services/freelance/apply-adapter";
import type {
  CreateGigInput,
  FreelanceFinderContext,
} from "../../shared/src/types/freelance";

const OUT_DIR = join(process.cwd(), "e2e-evidence");

const SEARCH_TERMS = ["typescript", "react", "node", "python", "engineer"];
const PROFILE_SKILLS = [
  "TypeScript",
  "React",
  "Node.js",
  "PostgreSQL",
  "Python",
  "AWS",
];

function ctx(platform: "remoteok" | "weworkremotely"): FreelanceFinderContext {
  return {
    platform,
    searchTerms: SEARCH_TERMS,
    selectedCountry: "",
    settings: process.env as Record<string, string | undefined>,
    onProgress: (event) => {
      if (event.detail) console.log(`  [${platform}] ${event.detail}`);
    },
  };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  console.log(`\n=== JobOps Freelance Aggregator E2E — ${startedAt} ===\n`);

  // ---- PHASE 1: LIVE DISCOVERY ----
  console.log("PHASE 1: live discovery against public endpoints");
  const [remoteok, wwr] = await Promise.all([
    findRemoteOkGigs(ctx("remoteok")),
    findWwrGigs(ctx("weworkremotely")),
  ]);

  console.log(
    `  RemoteOK:        success=${remoteok.success} gigs=${remoteok.gigs.length}${remoteok.error ? ` error=${remoteok.error}` : ""}`,
  );
  console.log(
    `  WeWorkRemotely:  success=${wwr.success} gigs=${wwr.gigs.length}${wwr.error ? ` error=${wwr.error}` : ""}`,
  );

  const discovered: CreateGigInput[] = [...remoteok.gigs, ...wwr.gigs];
  if (discovered.length === 0) {
    console.error("\nFAIL: zero gigs discovered from live endpoints.");
    process.exitCode = 1;
  }

  // ---- PHASE 2: DEDUPE ----
  console.log("\nPHASE 2: dedupe (exact hash + fuzzy title/employer)");
  const { unique, duplicatesRemoved, fuzzyMerges } = dedupeGigs(discovered);
  console.log(
    `  ${discovered.length} discovered -> ${unique.length} unique (exact=${duplicatesRemoved}, fuzzy=${fuzzyMerges})`,
  );

  // ---- PHASE 3: SCORE + RANK ----
  console.log("\nPHASE 3: score + rank");
  const scored = unique.map((gig) => ({
    ...gig,
    suitabilityScore: heuristicGigScore(gig, PROFILE_SKILLS),
  }));
  const ranked = rankGigs(scored);
  console.log("  Top 5:");
  for (const gig of ranked.slice(0, 5)) {
    console.log(
      `    [${gig.suitabilityScore}] ${gig.platform} — ${gig.title} @ ${gig.clientOrEmployer}`,
    );
  }

  // ---- PHASE 4: PROPOSAL GENERATION ----
  console.log("\nPHASE 4: proposal generation (deterministic, offline)");
  const proposals = ranked.slice(0, 3).map((gig) =>
    buildDeterministicProposal({
      gigId: gig.gigUrl,
      platform: gig.platform,
      gigTitle: gig.title,
      gigDescription: gig.gigDescription ?? gig.title,
      profileSkills: PROFILE_SKILLS,
    }),
  );
  console.log(`  generated ${proposals.length} tailored proposals`);
  if (proposals[0]) {
    console.log("  --- sample proposal ---");
    console.log(
      proposals[0].coverLetter
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }

  // ---- PHASE 5: GUARDED APPLY (dry-run) ----
  console.log("\nPHASE 5: guarded apply — expecting DRY-RUN (no env flags set)");
  const applies = [];
  for (const gig of ranked.slice(0, 3)) {
    const result = await applyToFreelanceGig({
      gigId: gig.gigUrl,
      platform: gig.platform,
      gigTitle: gig.title,
      gigDescription: gig.gigDescription ?? gig.title,
      profileSkills: PROFILE_SKILLS,
      env: {},
    });
    applies.push(result);
    console.log(
      `    ${result.platform}: mode=${result.mode} status=${result.status}${result.error ? ` (${result.error.slice(0, 80)})` : ""}`,
    );
  }

  const anyRealSubmission = applies.some((r) => r.mode === "submit");
  console.log(
    `\n  SAFETY CHECK: real submissions attempted = ${anyRealSubmission} (must be false)`,
  );
  if (anyRealSubmission) process.exitCode = 1;

  // ---- EVIDENCE ----
  const finishedAt = new Date().toISOString();
  const evidence = {
    startedAt,
    finishedAt,
    live: true,
    phases: {
      discovery: {
        remoteok: {
          success: remoteok.success,
          count: remoteok.gigs.length,
          error: remoteok.error ?? null,
        },
        weworkremotely: {
          success: wwr.success,
          count: wwr.gigs.length,
          error: wwr.error ?? null,
        },
        total: discovered.length,
      },
      dedupe: {
        input: discovered.length,
        unique: unique.length,
        duplicatesRemoved,
        fuzzyMerges,
      },
      scoring: {
        scored: scored.length,
        top10: ranked.slice(0, 10).map((g) => ({
          platform: g.platform,
          title: g.title,
          employer: g.clientOrEmployer,
          url: g.gigUrl,
          score: g.suitabilityScore,
        })),
      },
      proposals: proposals.map((p) => ({
        platform: p.platform,
        gigId: p.gigId,
        tailored: p.tailored,
        coverLetterChars: p.coverLetter.length,
        coverLetter: p.coverLetter,
      })),
      apply: applies.map((a) => ({
        platform: a.platform,
        mode: a.mode,
        status: a.status,
        error: a.error ?? null,
        hasProposal: Boolean(a.proposalDraft),
      })),
    },
    safety: {
      realSubmissionsAttempted: anyRealSubmission,
      autobidEnabled: process.env.FREELANCE_AUTOBID_ENABLED === "true",
    },
  };

  const path = join(OUT_DIR, "freelance-e2e.json");
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written: ${path}`);
  console.log(
    `\n=== RESULT: discovered=${discovered.length} unique=${unique.length} proposals=${proposals.length} dryRun=${!anyRealSubmission} ===\n`,
  );
}

main().catch((error) => {
  console.error("E2E FAILED:", error);
  process.exit(1);
});
