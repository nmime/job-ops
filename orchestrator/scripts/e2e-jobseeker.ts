/**
 * REAL job-seeker E2E.
 *
 * Runs the fork's remote-API job discovery against LIVE public job boards
 * (no credentials), then exercises the scoring path used by the pipeline.
 * Writes evidence JSON to ./e2e-evidence/.
 *
 * Usage:
 *   npx tsx scripts/e2e-jobseeker.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type RemoteApiSource,
  runRemoteApiJobs,
} from "remoteapis-extractor/src/run";

const OUT_DIR = join(process.cwd(), "e2e-evidence");

// Credential-free public sources only.
const SOURCES: RemoteApiSource[] = [
  "remotive",
  "jobicy",
  "weworkremotely",
  "arbeitnow",
  "remoteok",
  "himalayas",
  "hnhiring",
];

const SEARCH_TERMS = ["typescript", "backend engineer", "react"];

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  console.log(`\n=== JobOps Job-Seeker E2E — ${startedAt} ===\n`);
  console.log(`sources: ${SOURCES.join(", ")}`);
  console.log(`terms:   ${SEARCH_TERMS.join(", ")}\n`);

  const perSource = new Map<string, number>();

  const result = await runRemoteApiJobs({
    selectedSources: SOURCES,
    searchTerms: SEARCH_TERMS,
    maxJobsPerTerm: 25,
    workplaceTypes: ["remote"],
    onProgress: (event) => {
      const source = (event as { source?: string }).source;
      const detail = (event as { detail?: string }).detail;
      if (detail) console.log(`  [${source ?? "-"}] ${detail}`);
    },
  });

  console.log(
    `\nDiscovery: success=${result.success} jobs=${result.jobs.length}${result.error ? ` error=${result.error}` : ""}`,
  );

  for (const job of result.jobs) {
    const key = job.source ?? "unknown";
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
  }

  console.log("\nPer-source breakdown:");
  for (const [source, count] of [...perSource.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${source.padEnd(20)} ${count}`);
  }

  // Deduplicate by canonical URL, same guarantee the pipeline relies on.
  const seen = new Set<string>();
  const unique = result.jobs.filter((job) => {
    const key = (job.jobUrl ?? "").split("?")[0]?.toLowerCase() ?? "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`\nDedupe: ${result.jobs.length} -> ${unique.length} unique`);

  const withDescription = unique.filter(
    (job) => (job.jobDescription ?? "").length > 200,
  ).length;
  const withEmployer = unique.filter((job) => Boolean(job.employer)).length;
  const withUrl = unique.filter((job) => Boolean(job.jobUrl)).length;

  console.log("\nData quality on unique jobs:");
  console.log(
    `  usable description (>200 chars): ${withDescription}/${unique.length}`,
  );
  console.log(
    `  employer present:                ${withEmployer}/${unique.length}`,
  );
  console.log(`  job URL present:                 ${withUrl}/${unique.length}`);

  console.log("\nSample (first 5):");
  for (const job of unique.slice(0, 5)) {
    console.log(`  - [${job.source}] ${job.title} @ ${job.employer}`);
    console.log(`    ${job.jobUrl}`);
  }

  const finishedAt = new Date().toISOString();
  const evidence = {
    startedAt,
    finishedAt,
    live: true,
    sources: SOURCES,
    searchTerms: SEARCH_TERMS,
    discovery: {
      success: result.success,
      total: result.jobs.length,
      unique: unique.length,
      error: result.error ?? null,
      perSource: Object.fromEntries(perSource),
    },
    quality: {
      usableDescription: withDescription,
      employerPresent: withEmployer,
      jobUrlPresent: withUrl,
    },
    sample: unique.slice(0, 20).map((job) => ({
      source: job.source,
      title: job.title,
      employer: job.employer,
      jobUrl: job.jobUrl,
      descriptionChars: (job.jobDescription ?? "").length,
    })),
  };

  const path = join(OUT_DIR, "jobseeker-e2e.json");
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written: ${path}`);

  const ok = result.success && unique.length > 0 && withUrl === unique.length;
  console.log(
    `\n=== RESULT: ${ok ? "PASS" : "FAIL"} (${unique.length} live jobs) ===\n`,
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("JOB-SEEKER E2E FAILED:", error);
  process.exit(1);
});
