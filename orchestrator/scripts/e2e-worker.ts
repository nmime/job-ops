/**
 * REAL unattended autonomous freelance worker E2E.
 *
 * Runs N full cycles (discover -> dedupe -> score -> propose -> guarded apply)
 * with no human interaction, against LIVE public endpoints. Proves the worker
 * survives platform failures and never submits without explicit opt-in.
 *
 * Usage:
 *   npx tsx scripts/e2e-worker.ts [cycles] [intervalSeconds]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runFreelanceWorker,
  type WorkerCycleReport,
} from "../src/server/services/freelance/worker";

const OUT_DIR = join(process.cwd(), "e2e-evidence");

const CYCLES = Number.parseInt(process.argv[2] ?? "3", 10);
const INTERVAL_S = Number.parseInt(process.argv[3] ?? "5", 10);

const PROFILE_SKILLS = [
  "TypeScript",
  "React",
  "Node.js",
  "PostgreSQL",
  "Python",
  "AWS",
];

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();

  console.log(`\n=== Autonomous Freelance Worker E2E ===`);
  console.log(`cycles=${CYCLES} interval=${INTERVAL_S}s started=${startedAt}`);
  console.log(
    `FREELANCE_AUTOBID_ENABLED=${process.env.FREELANCE_AUTOBID_ENABLED ?? "(unset -> dry-run)"}\n`,
  );

  const reports = await runFreelanceWorker({
    cycles: CYCLES,
    intervalMs: INTERVAL_S * 1000,
    bidsPerCycle: 3,
    minScore: 50,
    searchTerms: ["typescript", "react", "node", "python", "engineer"],
    profileSkills: PROFILE_SKILLS,
    onCycle: (report: WorkerCycleReport) => {
      console.log(`--- cycle ${report.cycle} ---`);
      console.log(
        `  discovered=${report.aggregate.discovered} deduped=${report.aggregate.deduped} enqueued=${report.aggregate.enqueued}`,
      );
      for (const platform of report.aggregate.perPlatform) {
        const status = platform.success ? "ok " : "ERR";
        console.log(
          `    [${status}] ${platform.platform.padEnd(16)} found=${platform.found}${platform.error ? ` (${platform.error.slice(0, 60)})` : ""}`,
        );
      }
      for (const gig of report.topGigs) {
        console.log(`    -> [${gig.suitabilityScore}] ${gig.title}`);
      }
      for (const apply of report.applies) {
        console.log(
          `    apply ${apply.platform}: mode=${apply.mode} status=${apply.status}`,
        );
      }
      if (report.errors.length > 0) {
        console.log(`    errors: ${report.errors.length}`);
      }
      console.log("");
    },
  });

  const finishedAt = new Date().toISOString();

  const totalApplies = reports.reduce((sum, r) => sum + r.applies.length, 0);
  const realSubmissions = reports
    .flatMap((r) => r.applies)
    .filter((a) => a.mode === "submit").length;
  const allProposalsTailored = reports
    .flatMap((r) => r.applies)
    .every((a) => a.proposalDraft?.tailored !== false);
  const survivedAllCycles = reports.length === CYCLES;

  console.log("=== SUMMARY ===");
  console.log(`  cycles completed:       ${reports.length}/${CYCLES}`);
  console.log(`  total apply attempts:   ${totalApplies}`);
  console.log(`  REAL submissions:       ${realSubmissions} (must be 0)`);
  console.log(`  all proposals tailored: ${allProposalsTailored}`);
  console.log(
    `  platforms failing gracefully: ${reports[0]?.aggregate.perPlatform.filter((p) => !p.success).length ?? 0}`,
  );

  const evidence = {
    startedAt,
    finishedAt,
    config: { cycles: CYCLES, intervalSeconds: INTERVAL_S },
    assertions: {
      survivedAllCycles,
      noRealSubmissions: realSubmissions === 0,
      allProposalsTailored,
      unattended: true,
    },
    reports,
  };

  const path = join(OUT_DIR, "worker-e2e.json");
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written: ${path}`);

  const ok = survivedAllCycles && realSubmissions === 0 && allProposalsTailored;
  console.log(`\n=== RESULT: ${ok ? "PASS" : "FAIL"} ===\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("WORKER E2E FAILED:", error);
  process.exit(1);
});
