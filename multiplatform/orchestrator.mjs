// orchestrator.mjs — host coordinator for the job-ops multi-platform freelance pipeline.
// Drives the steel container (puppeteer-core + CDP :9222) for browser work and the
// job-ops container (better-sqlite3) for the freelance_* DB. Per-platform persistent
// steel sessions keep each platform logged in across cycles (fingerprintSeed + persist).
// usage: node orchestrator.mjs [--platform <id>] [--limit N]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = "/opt/job-ops";
const MP = path.join(ROOT, "multiplatform");
const REGISTRY = path.join(MP, "registry.json");
const STEEL_API = "http://127.0.0.1:3000";
const DB_SCRIPT = "/app/orchestrator/scripts/multiplatform/db.cjs"; // in job-ops container
const log = (...a) => console.log("[" + new Date().toISOString() + "] " + a.join(" "));

const args = process.argv.slice(2);
const only = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : null;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 5;

function sh(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", timeout: opts.timeout || 600000, maxBuffer: 50 * 1024 * 1024, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
}
function dbCmd(cmd, arg = {}) {
  const out = sh("docker", ["exec", "-w", "/app/orchestrator", "job-ops", "node", DB_SCRIPT, cmd, JSON.stringify(arg)], { timeout: 120000 });
  const lines = out.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
async function steelCreateSession(seed, proxyUrl) {
  const body = { persist: true, humanize: true, fingerprintSeed: seed };
  if (proxyUrl) body.proxyUrl = proxyUrl;
  const r = await fetch(STEEL_API + "/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()).id;
}
async function steelRelease(id) { if (!id) return; await fetch(STEEL_API + "/v1/sessions/" + id + "/release", { method: "POST" }).catch(() => {}); }
function steelPageId() {
  const out = sh("docker", ["exec", "steel-browser", "curl", "-s", "-m", "8", "http://127.0.0.1:9222/json"], { timeout: 20000 });
  const d = JSON.parse(out);
  return (d.find((t) => t.type === "page") || {}).id;
}
function steelRunTask(relPath, arg) {
  const a = ["exec", "-w", "/app", "steel-browser", "node", "/app/steel-drive.mjs", "run", relPath];
  if (arg !== undefined) a.push(JSON.stringify(arg));
  const out = sh("docker", a, { timeout: 900000 });
  const lines = out.trim().split("\n").filter(Boolean);
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    const m = l.match(/^RESULT\s*(\{[\s\S]*\})$/);
    if (m) { try { result = JSON.parse(m[1]); break; } catch {} }
    if (l.startsWith("{")) { try { result = JSON.parse(l); break; } catch {} }
  }
  return { raw: out, result };
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8")).platforms;
  // seed all sources into the DB (idempotent upsert)
  const seed = dbCmd("seed-sources", { registry });
  log("seeded " + (seed.result?.seeded ?? seed.seeded ?? "?") + " sources");

  const ids = Object.keys(registry).filter((id) => (!only || id === only) && registry[id].enabled);
  log("enabled platforms to run: " + (ids.length ? ids.join(", ") : "(none)"));
  const summary = { platforms: {}, sources: seed.result?.seeded ?? seed.seeded ?? 0 };

  for (const id of ids) {
    const p = registry[id];
    const manifest = safeRead(path.join(MP, "platforms", id, "manifest.json")) || {};
    const seedNum = manifest.fingerprintSeed ?? p.fingerprintSeed ?? hashSeed(id);
    const entry = { model: p.model, level: p.level, status: "ok", discovered: 0, queued: 0, applied: 0, blocked: [], notes: [] };
    let sid = null;
    try {
      sid = await steelCreateSession(seedNum, manifest.proxyUrl);
      await sleep(1500);
      const pageId = steelPageId();
      if (!pageId) throw new Error("no steel page after session create");
      const taskDir = "/app/multiplatform/platforms/" + id;
      // DISCOVER
      let opps = [];
      const disc = steelRunTask(taskDir + "/discover.mjs", { manifest, pageId });
      entry.discoverLog = tail(disc.raw, 4);
      if (disc.result) {
        if (disc.result.blocked) entry.blocked = disc.result.blocked;
        entry.login = disc.result.login || null;
        opps = disc.result.opportunities || [];
      }
      entry.discovered = opps.length;
      for (const o of opps) {
        const r = dbCmd("upsert-opportunity", { ...o, source_id: id });
        const oid = r.result?.id || r.id;
        dbCmd("score-opportunity", { opportunity_id: oid, score: o.score ?? 70, reason: o.reason || "auto" });
        dbCmd("approve-opportunity", { opportunity_id: oid, status: "approved", decided_by: "autonomous", notes: "auto-approve" });
        dbCmd("record-audit", { opportunity_id: oid, source_id: id, event_type: "discovered", payload: { title: o.title } });
      }
      // APPLY (queue)
      const q = dbCmd("get-queue", { source_id: id, limit });
      const queue = q.result?.queue || q.queue || [];
      entry.queued = queue.length;
      for (const item of queue) {
        try {
          const ap = steelRunTask(taskDir + "/apply.mjs", { manifest, pageId, opp: item });
          const res = ap.result || {};
          const status = res.status || "unknown";
          dbCmd("set-opportunity-status", { opportunity_id: item.id, status: status === "applied" ? "applied" : status === "blocked" ? "blocked" : "failed", proof: { detail: res.detail || "" } });
          dbCmd("record-audit", { opportunity_id: item.id, source_id: id, event_type: status === "applied" ? "applied" : "apply_" + status, payload: { detail: res.detail || "" } });
          if (status === "applied") entry.applied++;
          if (status === "blocked") entry.blocked.push(res.detail || "blocked");
          if (status === "failed") entry.notes.push(res.detail || "failed");
        } catch (e) {
          dbCmd("record-audit", { opportunity_id: item.id, source_id: id, event_type: "apply_error", payload: { error: String(e.message || e) } });
          entry.notes.push(String(e.message || e));
        }
      }
    } catch (e) {
      entry.status = "error";
      entry.notes.push(String(e.message || e));
    } finally {
      await steelRelease(sid);
    }
    dbCmd("record-audit", { source_id: id, event_type: "platform_status", payload: { login: entry.login || null, blocked: entry.blocked, discovered: entry.discovered, queued: entry.queued, applied: entry.applied, status: entry.status } });
    summary.platforms[id] = entry;
    log(id + ": status=" + entry.status + " discovered=" + entry.discovered + " queued=" + entry.queued + " applied=" + entry.applied + (entry.blocked.length ? " blocked=" + JSON.stringify(entry.blocked) : ""));
  }
  const s = dbCmd("summary", {});
  summary.db = s.result || s;
  console.log("SUMMARY_JSON " + JSON.stringify(summary));
}
function safeRead(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function tail(s, n) { return (s || "").trim().split("\n").slice(-n).join(" | "); }
function hashSeed(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 900000) + 100000; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL " + (e.stack || e)); process.exit(1); });
