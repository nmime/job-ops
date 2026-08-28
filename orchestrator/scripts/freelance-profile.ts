/**
 * Freelance profile campaign CLI.
 *
 * Run from the orchestrator directory:
 *   npx tsx scripts/freelance-profile.ts <status|complete|post|publish|promote|seed> [platform|all]
 *
 *   status    list all 14 platforms with field-level state (DB + registry)
 *   complete  run the profile fill through the platform's backend
 *   post      run the "post" action (gigs / posts / portfolio items)
 *   publish   run the "publish" action (drafts -> public)
 *   promote   run the "promote" action (availability / community / featured)
 *   seed      idempotently seed the phase-1 state (2026-08-28 report)
 *
 * Backends (see docs/freelance-profile-campaign.md):
 *   api             runs the idempotent profile-fill scripts and re-verifies
 *   browser_mac     queues a pending operator step list (visible in status)
 *   browser_sandbox Playwright + cookie; degrades to a queued mac step list
 *
 * Machine-readable: add --json to any command to print JSON on stdout.
 */
import {
  PROFILE_PLATFORMS,
  getProfilePlatform,
  isProfilePlatform,
} from "../src/server/services/freelance/profile/platforms";
import {
  type MergedProfile,
  listMergedProfiles,
} from "../src/server/services/freelance/profile/state";
import {
  type ProfileActionKind,
  type ProfileActionResult,
  runProfileAction,
} from "../src/server/services/freelance/profile/backends";
import { seedProfileCampaignState } from "../src/server/services/freelance/profile/seed";

const COMMANDS = [
  "status",
  "complete",
  "post",
  "publish",
  "promote",
  "seed",
] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  target: string; // platform id or "all"
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const command = (positional[0] ?? "") as Command;
  if (!COMMANDS.includes(command)) {
    console.error(
      `Usage: freelance-profile.ts <${COMMANDS.join("|")}> [platform|all]\n` +
        `Platforms: ${PROFILE_PLATFORMS.map((p) => p.id).join(", ")}`,
    );
    process.exit(2);
  }
  let target = (positional[1] ?? "all").toLowerCase();
  if (command === "seed") target = "all";
  if (target !== "all" && !isProfilePlatform(target)) {
    console.error(
      `Unknown platform "${target}". Expected one of: ${PROFILE_PLATFORMS.map(
        (p) => p.id,
      ).join(", ")} (or "all").`,
    );
    process.exit(2);
  }
  return { command, target, json: flags.includes("--json") };
}

// --- status ---------------------------------------------------------------------

function fieldCell(name: string, label: string, state: { status: string; evidence?: string } | undefined, width: number): string {
  const spec = label ?? "";
  const value = state ? state.status : "pending";
  const evidence = state?.evidence ? ` — ${state.evidence}` : "";
  const text = `${name.padEnd(18)} ${value.padEnd(10)} ${spec}${evidence}`;
  return text.length > width ? `${text.slice(0, width - 3)}...` : text.padEnd(width);
}

function printStatus(profiles: MergedProfile[]): void {
  const lines: string[] = [];
  lines.push("freelance profile campaign — status");
  lines.push("=".repeat(100));
  lines.push(
    ["platform", "backend", "complete", "status", "fields(done/total)", "pending steps", "content"].join("  "),
  );
  lines.push("-".repeat(100));
  for (const p of profiles) {
    const names = Object.keys(p.fields);
    const counted = names.filter((n) => p.fields[n]?.status !== "user_only");
    const done = counted.filter((n) => p.fields[n]?.status === "done").length;
    const counts = {
      done: names.filter((n) => p.fields[n]?.status === "done").length,
      pending: names.filter((n) => p.fields[n]?.status === "pending").length,
      blocked: names.filter((n) => p.fields[n]?.status === "blocked").length,
      userOnly: names.filter((n) => p.fields[n]?.status === "user_only").length,
    };
    lines.push(
      [
        p.platform.padEnd(14),
        p.backend.padEnd(15),
        (p.completeness ?? "-").padEnd(8),
        p.status.padEnd(15),
        `${counts.done}/${counted.length} (${counts.pending} pending, ${counts.blocked} blocked, ${counts.userOnly} user_only)`.slice(0, 34).padEnd(34),
        String(p.pendingSteps.length).padEnd(13),
        p.content.length,
      ].join("  "),
    );
    for (const note of p.notes) {
      lines.push(`  note: ${note}`);
    }
  }
  lines.push("");
  lines.push("field-level state:");
  lines.push("-".repeat(100));
  for (const p of profiles) {
    lines.push(`\n${p.name} (${p.platform}) — ${p.status}, ${p.completeness ?? "-"} complete, backend=${p.backend}`);
    if (p.profileUrl) lines.push(`  profile: ${p.profileUrl}`);
    const specs = getProfilePlatform(p.platform)?.fields ?? [];
    const labelOf = new Map(specs.map((f) => [f.name, f.label]));
    for (const [name, state] of Object.entries(p.fields)) {
      lines.push(
        "  " + fieldCell(name, labelOf.get(name) ?? "", state, 96),
      );
    }
    if (p.pendingSteps.length) {
      lines.push("  pending operator steps:");
      for (const s of p.pendingSteps) {
        lines.push(`    [${s.id}] ${s.kind}${s.steps.length ? ` — ${s.steps.length} steps` : ""}`);
        for (const step of s.steps) lines.push(`        - ${step}`);
      }
    }
    if (p.content.length) {
      lines.push("  content:");
      for (const c of p.content) {
        lines.push(
          `    [${c.id}] ${c.kind}: ${c.title} — ${c.status}${c.externalRef ? ` (${c.externalRef})` : ""}`,
        );
      }
    }
  }
  console.log(lines.join("\n"));
}

// --- action runner ------------------------------------------------------------------

function printResult(r: ProfileActionResult): void {
  const lines: string[] = [];
  lines.push(`${r.platform} ${r.kind} [${r.backend}] -> ${r.status}${r.verified ? " (verified)" : ""}`);
  for (const note of r.notes) lines.push(`  ${note}`);
  if (r.evidence !== undefined) {
    lines.push(`  evidence: ${typeof r.evidence === "string" ? r.evidence : JSON.stringify(r.evidence).slice(0, 600)}`);
  }
  console.log(lines.join("\n"));
}

async function runActionCommand(
  command: Command,
  target: string,
  json: boolean,
): Promise<void> {
  const kind: ProfileActionKind =
    command === "complete" ? "complete" : (command as "post" | "publish" | "promote");
  const ids =
    target === "all"
      ? PROFILE_PLATFORMS.filter((p) => p.backend !== "none").map((p) => p.id)
      : [target];
  const results: ProfileActionResult[] = [];
  for (const id of ids) {
    try {
      const r = await runProfileAction(id, kind);
      results.push(r);
      if (!json) printResult(r);
    } catch (error) {
      results.push({
        platform: id,
        kind,
        backend: "none",
        status: "error",
        verified: false,
        notes: [error instanceof Error ? error.message : String(error)],
      });
      if (!json) printResult(results[results.length - 1]);
    }
  }
  if (json) {
    console.log(JSON.stringify({ command, results }, null, 2));
  }
  const failed = results.filter((r) => r.status === "error");
  if (failed.length > 0 && !json) {
    console.error(
      `\n${failed.length} platform(s) reported error/gate — see notes above.`,
    );
  }
}

// --- main ------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, target, json } = parseArgs(process.argv.slice(2));

  if (command === "seed") {
    const seeded = seedProfileCampaignState();
    if (json) {
      console.log(JSON.stringify({ seeded }, null, 2));
    } else {
      console.log(
        `Seeded phase-1 state for ${seeded.length} platforms: ${seeded.join(", ")}`,
      );
    }
    return;
  }

  if (command === "status") {
    const profiles =
      target === "all"
        ? listMergedProfiles()
        : listMergedProfiles([target]);
    if (profiles.length === 0) {
      console.error(`No profile state for platform "${target}"`);
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify({ profiles }, null, 2));
    } else {
      printStatus(profiles);
    }
    return;
  }

  await runActionCommand(command, target, json);
}

void main();
