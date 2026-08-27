/**
 * Freelance adapter verification harness (CLI).
 *
 * Run from the orchestrator directory:
 *   npx tsx scripts/freelance-verify.ts [platform|all] [--live]
 *
 *   platform   one of the 18 platform ids (default: all)
 *   --live     opt in to a REAL submission attempt against the FIRST
 *              discovered gig (default OFF — dry-run only, never submits)
 *
 * Per platform the harness checks:
 *   a) credentials — which env vars / credential files are configured
 *   b) discovery   — provider findGigs, 60s timeout, errors reported, never
 *                    crashes the run
 *   c) apply       — manifest applyToGig in DRY RUN (ctx.dryRun=true)
 *   d) live        — only with --live, against the first discovered gig
 *
 * Output: a human-readable table on stderr, then the machine-readable JSON
 * report on stdout at the end:
 *   {"platforms": [ {platform, credential, discovery, apply, verdict,
 *                    blockers}, ... ]}
 */
import "../src/server/config/env";

import {
  FREELANCE_PLATFORM_IDS,
  type FreelancePlatformId,
} from "@shared/types/freelance";
import {
  type VerifyReport,
  verifyFreelanceAdapter,
} from "../src/server/services/freelance/verify";

const REAL_PLATFORMS = FREELANCE_PLATFORM_IDS.filter(
  (id) => id !== "aggregator-core",
);

function parseArgs(argv: string[]): {
  platform: FreelancePlatformId | "all";
  live: boolean;
} {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const live = flags.includes("--live");
  const target = (positional[0] ?? "all").toLowerCase();
  if (target === "all") return { platform: "all", live };
  if ((REAL_PLATFORMS as readonly string[]).includes(target)) {
    return { platform: target as FreelancePlatformId, live };
  }
  console.error(
    `Unknown platform "${target}". Expected one of: ${REAL_PLATFORMS.join(", ")} (or "all").`,
  );
  process.exit(2);
}

function tableCell(value: string, width: number): string {
  return value.length > width
    ? `${value.slice(0, width - 3)}...`
    : value.padEnd(width);
}

function printTable(reports: VerifyReport[]): void {
  const lines: string[] = [];
  lines.push(
    "platform          creds   discovery            dry-run    live     verdict",
  );
  lines.push("-".repeat(78));
  for (const r of reports) {
    const creds =
      r.credential.format === "none"
        ? "n/a"
        : `${r.credential.present.length}/${r.credential.required.length}`;
    const discovery = r.discovery.ok
      ? `${r.discovery.count} gigs`
      : `ERR ${r.discovery.error ?? "?"}`.slice(0, 24);
    const dryRun = r.apply.supported ? (r.apply.dryRun?.status ?? "-") : "n/a";
    const liveCell = r.apply.live ? r.apply.live.status : "-";
    lines.push(
      [
        tableCell(r.platform, 17),
        tableCell(creds, 8),
        tableCell(discovery, 24),
        tableCell(dryRun, 10),
        tableCell(liveCell, 8),
        r.verdict,
      ].join("  "),
    );
    for (const blocker of r.blockers) {
      lines.push(`  ↳ ${blocker}`);
    }
    if (r.discovery.ok && r.discovery.sample) {
      lines.push(`  ↳ first gig: ${r.discovery.sample.slice(0, 60)}`);
    }
  }
  console.error(lines.join("\n"));
}

async function main(): Promise<void> {
  const { platform, live } = parseArgs(process.argv.slice(2));
  const targets = platform === "all" ? [...REAL_PLATFORMS] : [platform];

  if (live) {
    console.error(
      "\n⚠  LIVE MODE — real submissions will be attempted against the first " +
        "discovered gig of each platform.\n",
    );
  }

  console.error(
    `Verifying ${targets.length} freelance adapter(s)${
      live ? " [LIVE]" : " [dry-run]"
    }...\n`,
  );

  // Sequential: browser-backed adapters share the machine; one platform's
  // failure must never abort the rest.
  const reports: VerifyReport[] = [];
  for (const id of targets) {
    try {
      const report = await verifyFreelanceAdapter(id, { live });
      reports.push(report);
    } catch (error) {
      // Last-resort guard: verifyFreelanceAdapter is designed not to throw,
      // but a harness must never crash the whole run.
      reports.push({
        platform: id,
        credential: {
          required: [],
          present: [],
          missing: [],
          format: "unknown",
          configured: false,
        },
        discovery: {
          ok: false,
          count: 0,
          error: error instanceof Error ? error.message : String(error),
        },
        apply: { supported: false, kind: "none", dryRun: null, live: null },
        verdict: "blocked",
        blockers: [
          `harness error: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }

  printTable(reports);
  console.log(JSON.stringify({ platforms: reports }, null, 2));
}

void main();
