/**
 * Live E2E of the freelance aggregator THROUGH THE PERSISTED API LAYER:
 * discovery (incl. real Freelancer API) -> DB persistence -> proposal -> stats.
 * Boots the real server, hits real endpoints + real external APIs. No mocks.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import { closeDb } from "../src/server/db";
import { createApp } from "../src/server/app";

const OUT_DIR = join(process.cwd(), "e2e-evidence");

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Bootstrap first user (setup route is public until a user exists).
  const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "e2e", password: "e2e-password-123" }),
  });
  const setupBody = (await setupRes.json()) as {
    ok: boolean;
    data?: { token?: string };
  };
  const token = setupBody.data?.token ?? "";
  const authHeaders = { Authorization: `Bearer ${token}` };

  try {
    console.log(`\n=== Freelance API E2E — ${startedAt} ===`);
    console.log(`server: ${baseUrl}\n`);

    const get = async (path: string) => {
      const res = await fetch(`${baseUrl}/api${path}`, { headers: authHeaders });
      const body = (await res.json()) as { ok: boolean; data?: unknown };
      return body.data as Record<string, unknown>;
    };
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${baseUrl}/api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return (await res.json()) as { ok: boolean; data?: unknown };
    };

    // 1. platforms registry
    const platforms = (await get("/freelance/platforms")) as {
      platforms: Array<{ id: string; available: boolean }>;
      autobidEnabled: boolean;
    };
    console.log(
      `platforms: ${platforms.platforms.length} registered, autobid=${platforms.autobidEnabled}`,
    );

    // 2. run discovery (Freelancer now has a REAL finder; remoteok/wwr too)
    const run = (await post("/freelance/run", {
      searchTerms: ["typescript", "react"],
      profileSkills: ["TypeScript", "React", "Node.js"],
      minScore: 40,
      platforms: ["freelancer", "remoteok", "weworkremotely"],
    })) as { ok: boolean; data?: {
      discovered: number;
      deduped: number;
      enqueued: number;
      persisted: { created: number; updated: number };
      perPlatform: Array<{ platform: string; success: boolean; found: number; error?: string }>;
    } };
    const r = run.data!;
    console.log(`\ndiscovery: discovered=${r.discovered} enqueued=${r.enqueued}`);
    console.log(
      `persisted: created=${r.persisted.created} updated=${r.persisted.updated}`,
    );
    for (const p of r.perPlatform) {
      console.log(
        `  ${p.success ? "ok " : "ERR"} ${p.platform}: found=${p.found}${p.error ? ` (${p.error.slice(0, 50)})` : ""}`,
      );
    }

    // 3. read persisted gigs
    const gigs = (await get("/freelance/gigs?limit=5")) as {
      gigs: Array<{ id: string; title: string; platform: string; suitabilityScore: number | null }>;
      count: number;
    };
    console.log(`\npersisted gigs in DB: ${gigs.count}`);
    for (const g of gigs.gigs.slice(0, 3)) {
      console.log(`  [${g.suitabilityScore}] ${g.platform}: ${g.title}`);
    }

    // 4. generate + persist a proposal for the top gig
    let proposal: { mode: string; status: string } | null = null;
    if (gigs.gigs[0]) {
      const proposeRes = (await post(
        `/freelance/gigs/${gigs.gigs[0].id}/propose`,
        { profileSkills: ["TypeScript", "React"] },
      )) as { ok: boolean; data?: { mode: string; proposal: { status: string; coverLetter: string } } };
      proposal = {
        mode: proposeRes.data!.mode,
        status: proposeRes.data!.proposal.status,
      };
      console.log(
        `\nproposal: mode=${proposal.mode} status=${proposal.status}`,
      );
      console.log(
        `  cover letter starts: ${proposeRes.data!.proposal.coverLetter.slice(0, 90)}...`,
      );
    }

    // 5. stats
    const stats = (await get("/freelance/stats")) as {
      gigsByStatus: Record<string, number>;
      proposalsByStatus: Record<string, number>;
      earnings: { totalPaid: number; totalPending: number };
    };
    console.log(`\nstats:`);
    console.log(`  gigs: ${JSON.stringify(stats.gigsByStatus)}`);
    console.log(`  proposals: ${JSON.stringify(stats.proposalsByStatus)}`);
    console.log(
      `  earnings: paid=${stats.earnings.totalPaid} pending=${stats.earnings.totalPending}`,
    );

    const freelancerLive =
      r.perPlatform.find((p) => p.platform === "freelancer")?.success ===
        true &&
      (r.perPlatform.find((p) => p.platform === "freelancer")?.found ?? 0) > 0;
    const persistedOk = r.persisted.created > 0;
    const dryRun = proposal?.mode === "dry_run";

    const evidence = {
      startedAt,
      finishedAt: new Date().toISOString(),
      platforms: platforms.platforms.length,
      discovery: r,
      persistedGigs: gigs.count,
      proposal,
      stats,
      assertions: { freelancerLive, persistedOk, dryRun },
    };
    const path = join(OUT_DIR, "freelance-api-e2e.json");
    await writeFile(path, JSON.stringify(evidence, null, 2));

    const ok = freelancerLive && persistedOk && dryRun;
    console.log(
      `\n=== RESULT: ${ok ? "PASS" : "FAIL"} (freelancerLive=${freelancerLive} persisted=${persistedOk} dryRun=${dryRun}) ===`,
    );
    console.log(`Evidence: ${path}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    server.close();
    closeDb();
  }
}

main().catch((error) => {
  console.error("FREELANCE API E2E FAILED:", error);
  process.exit(1);
});
