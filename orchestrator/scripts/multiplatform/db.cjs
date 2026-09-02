// db.cjs — in-container (job-ops) DB command handler for the multi-platform freelance pipeline.
// Runs against /app/data/jobs.db using the app's existing freelance_* schema.
// usage: node db.cjs <command> [jsonArg]
const Database = require("better-sqlite3");
const crypto = require("crypto");
const db = new Database("/app/data/jobs.db");
db.pragma("busy_timeout = 15000");
const [, , cmd, argJson] = process.argv;
const arg = argJson ? JSON.parse(argJson) : {};
const now = new Date().toISOString();
const uid = () => crypto.randomUUID();
const tenantId = (db.prepare("select id from tenants limit 1").get() || {}).id || "1";

function out(r) { console.log(JSON.stringify({ ok: true, command: cmd, ...r })); }
function fail(e) { console.log(JSON.stringify({ ok: false, command: cmd, error: String(e && e.message || e) })); process.exit(1); }
const ALLOWED_STATUS = ["discovered", "scored", "pending_approval", "approved", "rejected", "delegated", "archived", "expired"];
const STATUS_MAP = { applied: "delegated", blocked: "pending_approval", failed: "archived", posted: "approved" };
function mapStatus(s) { if (ALLOWED_STATUS.includes(s)) return s; return STATUS_MAP[s] || "discovered"; }

try {
  switch (cmd) {
    case "seed-sources": {
      const upsert = db.prepare(`
        insert into freelance_sources (id, tenant_id, source_type, mode, name, enabled, terms_profile, rate_limit_policy, credential_ref, supports_outbound, dedupe_policy, proof_metadata, created_at, updated_at)
        values (@id,@tid,'marketplace','user_authenticated_read',@name,@enabled,'{}','{}',@cred,@so,'external_id',@proof,@now,@now)
        on conflict(id) do update set enabled=@enabled, name=@name, updated_at=@now,
          credential_ref=coalesce(freelance_sources.credential_ref,@cred),
          proof_metadata=coalesce(@proof,freelance_sources.proof_metadata)`);
      let n = 0;
      const tx = db.transaction((entries) => {
        for (const [id, p] of entries) {
          upsert.run({ id, tid: tenantId, name: p.name || id, enabled: p.enabled ? 1 : 0, cred: p.credential_ref || null, so: p.model !== "post" ? 1 : 0, proof: JSON.stringify({ model: p.model || "apply", level: p.level || 0, region: p.region || null, url: p.url || null }), now });
          n++;
        }
      });
      tx(Object.entries(arg.registry || {}));
      out({ seeded: n });
      break;
    }
    case "upsert-opportunity": {
      const o = arg;
      const dedupeKey = o.dedupe_key || (o.source_id + ":" + (o.external_id || o.opportunity_url || o.title || uid()));
      const url = o.opportunity_url || ("mp://" + (o.source_id || "unknown") + "/" + dedupeKey);
      const title = o.title || o.opportunity_url || "untitled";
      const status = mapStatus(o.status || "discovered");
      const skills = o.skills ? (typeof o.skills === "string" ? o.skills : JSON.stringify(o.skills)) : "[]";
      const proof = o.proof_metadata ? JSON.stringify(o.proof_metadata) : "{}";
      const existing = db.prepare("select id from freelance_opportunities where tenant_id=? and (dedupe_key=? or opportunity_url=?)").get(tenantId, dedupeKey, url);
      if (existing) {
        db.prepare("update freelance_opportunities set title=?, opportunity_url=?, description=coalesce(?,description), budget=coalesce(?,budget), status=?, updated_at=? where id=? and tenant_id=?")
          .run(title, url, o.description || null, o.budget || null, status, now, existing.id, tenantId);
        out({ id: existing.id, dedupe_key: dedupeKey, existed: true });
      } else {
        const id = o.id || uid();
        db.prepare(`insert into freelance_opportunities (id,tenant_id,source_id,source_type,external_id,opportunity_url,title,client_name,description,budget,currency,location,is_remote,skills,dedupe_key,proof_metadata,status,discovered_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, tenantId, o.source_id || null, "marketplace", o.external_id || null, url, title, o.client_name || null, o.description || null, o.budget || null, o.currency || null, o.location || null, o.is_remote ? 1 : 0, skills, dedupeKey, proof, status, now, now, now);
        out({ id, dedupe_key: dedupeKey, existed: false });
      }
      break;
    }
    case "score-opportunity": {
      const id = uid();
      db.prepare("insert into freelance_scores (id,tenant_id,opportunity_id,score,reason,model,rubric_version,created_at) values (?,?,?,?,?,?,?,?)")
        .run(id, tenantId, arg.opportunity_id, arg.score, arg.reason || null, arg.model || "rule-v1", "v1", now);
      out({ score_id: id });
      break;
    }
    case "approve-opportunity": {
      const id = uid();
      db.prepare("insert into freelance_approvals (id,tenant_id,opportunity_id,status,decided_by,decided_at,notes,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
        .run(id, tenantId, arg.opportunity_id, arg.status || "approved", arg.decided_by || "autonomous", now, arg.notes || null, now, now);
      out({ approval_id: id });
      break;
    }
    case "set-opportunity-status": {
      const r = db.prepare("update freelance_opportunities set status=?, updated_at=?, proof_metadata=coalesce(?, proof_metadata) where id=? and tenant_id=?").run(mapStatus(arg.status), now, arg.proof ? JSON.stringify(arg.proof) : null, arg.opportunity_id, tenantId);
      out({ changed: r.changes });
      break;
    }
    case "record-audit": {
      const id = uid();
      db.prepare("insert into freelance_audit_events (id,tenant_id,opportunity_id,source_id,event_type,actor,event_payload,created_at) values (?,?,?,?,?,?,?,?)")
        .run(id, tenantId, arg.opportunity_id || null, arg.source_id || null, arg.event_type, arg.actor || "autonomous", JSON.stringify(arg.payload || {}), now);
      out({ audit_id: id });
      break;
    }
    case "get-queue": {
      const rows = db.prepare(`
        select o.id, o.source_id, o.external_id, o.opportunity_url, o.title, o.budget, o.status
        from freelance_opportunities o
        where o.tenant_id=? and o.source_id=? and o.status in ('approved','discovered','scored')
          and not exists (select 1 from freelance_audit_events a where a.opportunity_id=o.id and a.event_type='applied')
        order by o.discovered_at desc limit ?`).all(tenantId, arg.source_id, Math.max(1, arg.limit || 5));
      out({ queue: rows });
      break;
    }
    case "summary": {
      const by = {};
      for (const r of db.prepare("select status, count(*) c from freelance_opportunities where tenant_id=? and (? is null or source_id=?) group by status").all(tenantId, arg.source_id || null, arg.source_id || null)) by[r.status] = r.c;
      const sources = db.prepare("select count(*) c from freelance_sources where tenant_id=?").get(tenantId).c;
      const opps = db.prepare("select count(*) c from freelance_opportunities where tenant_id=? and (? is null or source_id=?)").get(tenantId, arg.source_id || null, arg.source_id || null).c;
      out({ sources, opportunities: opps, by_status: by });
      break;
    }
    case "freelance-snapshot": {
      const sources = db.prepare("select id, enabled from freelance_sources where tenant_id=?").all(tenantId);
      const opps = db.prepare("select source_id, status, count(*) c from freelance_opportunities where tenant_id=? group by source_id, status").all(tenantId);
      const latest = {};
      for (const r of db.prepare("select source_id, event_payload, created_at from freelance_audit_events where tenant_id=? and event_type='platform_status'").all(tenantId)) {
        if (!latest[r.source_id] || r.created_at > latest[r.source_id].created_at) latest[r.source_id] = r;
      }
      const per = {};
      for (const s of sources) per[s.id] = { enabled: !!s.enabled, opps: {}, last: null };
      for (const o of opps) if (per[o.source_id]) per[o.source_id].opps[o.status] = (per[o.source_id].opps[o.status] || 0) + o.c;
      for (const [sid, r] of Object.entries(latest)) if (per[sid]) { try { per[sid].last = Object.assign({}, JSON.parse(r.event_payload || "{}"), { at: r.created_at }); } catch { per[sid].last = { at: r.created_at }; } }
      out({ sources: sources.length, enabled: sources.filter((s) => s.enabled).length, per });
      break;
    }
    default:
      fail("unknown command: " + cmd);
  }
} catch (e) { fail(e); }
