#!/bin/bash
# scaffold.sh — create the full pipeline structure for one platform (idempotent).
#   scaffold.sh <id> [name] [model]
# Creates platforms/<id>/{manifest.json,orch.sh,<id>-orchestrator.mjs,<id>-apply.mjs}
# and ensures a registry entry. The brain/driver start as SAFE no-ops (clear TODOs),
# so enabling the platform runs a clean, harmless cycle until discovery+action are built.
set -euo pipefail
MP=/opt/job-ops/multiplatform
REG=$MP/registry.json
ID="${1:?usage: scaffold.sh <id> [name] [model]}"
NAME="${2:-$ID}"
MODEL="${3:-apply}"
DIR=$MP/platforms/$ID
mkdir -p "$DIR"

# ensure registry entry
python3 - "$REG" "$ID" "$NAME" "$MODEL" <<'PY'
import json,sys
reg,pid,name,model=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
r=json.load(open(reg))
p=r["platforms"].setdefault(pid,{})
p.setdefault("id",pid); p.setdefault("name",name); p.setdefault("model",model)
p.setdefault("region","Global"); p.setdefault("fee","varies"); p.setdefault("url","")
p.setdefault("notes",""); p.setdefault("enabled",False); p.setdefault("level",0)
p.setdefault("orch",f"platforms/{pid}/orch.sh"); p.setdefault("state",f"/app/data/{pid}-state.json")
p.setdefault("queue",f"/app/data/{pid}-queue.json"); p.setdefault("timer","jobops-mp-orch.timer")
p.setdefault("log",f"/opt/job-ops/logs/{pid}-orch.log"); p.setdefault("worker_log",f"/opt/job-ops/logs/{pid}-worker.log")
p.setdefault("proc_pattern",f"{pid}-worker.sh|{pid}-apply|{pid}-orchestrator.mjs")
json.dump(r,open(reg,"w"),indent=1)
PY

# manifest (if absent)
[ -f "$DIR/manifest.json" ] || cat > "$DIR/manifest.json" <<EOF
{
  "id": "$ID",
  "name": "$NAME",
  "model": "$MODEL",
  "level": 0,
  "enabled": false,
  "account": { "email": null, "password": null, "verified": false, "notes": "create account: email-only if possible; rental SMS does NOT cover freelance platforms" },
  "auth": { "method": "TODO (http|steel-browser)", "login_url": "" },
  "discovery": { "endpoint": "TODO", "notes": "how to list actionable items (gigs to apply / services to post)" },
  "action": { "endpoint": "TODO", "method": "TODO", "fields": "TODO", "notes": "the apply/post submission" },
  "egress": "TODO (direct|proxy)"
}
EOF

# brain stub (safe no-op until discovery is implemented)
[ -f "$DIR/${ID}-orchestrator.mjs" ] || cat > "$DIR/${ID}-orchestrator.mjs" <<EOF
// $ID-orchestrator.mjs — BRAIN for $NAME (model: $MODEL).
//   node $ID-orchestrator.mjs scan    -> discover actionable items, write state + queue
//   node $ID-orchestrator.mjs record <key> <applied|posted|failed> [note]
// State: /app/data/$ID-state.json  Queue: /app/data/$ID-queue.json
// TODO($ID): implement discovery for the $MODEL model. Until then this is a safe no-op.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const DATA = "/app/data";
const STATE_FILE = DATA + "/$ID-state.json";
const QUEUE_FILE = DATA + "/$ID-queue.json";
const NAME = "Nikita N0xeid";
function load(){ try { return { applied:{}, failed:{}, ...JSON.parse(readFileSync(STATE_FILE,"utf8")) }; } catch { return { applied:{}, failed:{} }; } }
function save(s){ mkdirSync(DATA,{recursive:true}); writeFileSync(STATE_FILE, JSON.stringify(s,null,1)); }
async function scan(){
  const state = load();
  const queue = [];
  // TODO($ID): populate queue with undiscovered items (skip state.applied / recent state.failed).
  //   e.g. for apply: fetch open gigs; for post: generate service ideas not yet posted.
  writeFileSync(QUEUE_FILE, JSON.stringify({ updatedAt:new Date().toISOString(), queue }, null, 1));
  console.log(JSON.stringify({ platform:"$ID", model:"$MODEL", discovery:"not-implemented", queued:queue.length, applied:Object.keys(state.applied).length }));
}
function record(key,status,note){
  const s=load(); const e={ at:new Date().toISOString(), note:note||"" };
  if(status==="applied"||status==="posted"){ s.applied[key]=e; delete s.failed[key]; }
  else { s.failed[key]=e; }
  save(s); console.log(JSON.stringify({ok:true,key,status}));
}
const [cmd,...a]=process.argv.slice(2);
(async()=>{ if(cmd==="record") record(a[0],a[1],a[2]??""); else await scan(); })();
EOF

# driver stub (safe no-op until action is implemented)
[ -f "$DIR/${ID}-apply.mjs" ] || cat > "$DIR/${ID}-apply.mjs" <<EOF
// $ID-apply.mjs — DRIVER for $NAME (model: $MODEL). Executes ONE queued action.
// Run in steel-browser (apply model) or via HTTP (post/simple models). Emits RESULT_JSON.
//   env: ACTION_ITEM_JSON (the queue item), plus platform creds from manifest.
// TODO($ID): implement the actual $MODEL action. Until then it reports not-implemented.
const item = process.env.ACTION_ITEM_JSON ? JSON.parse(process.env.ACTION_ITEM_JSON) : {};
console.log("platform=$ID action=$MODEL item=" + (item.key || item.url || JSON.stringify(item).slice(0,120)));
console.log("RESULT_JSON " + JSON.stringify({ success:false, notImplemented:true, platform:"$ID", reason:"driver not implemented yet" }));
EOF

# orch glue (brain + worker), mirroring the contra pattern (quoted heredoc + sed to avoid $ expansion)
if [ ! -f "$DIR/orch.sh" ]; then
cat > "$DIR/orch.sh" <<'ORCHEOF'
#!/bin/bash
# @ID@ orchestration (BRAIN + WORKER) for @NAME@. Runs in the dispatcher.
set -uo pipefail
LOG=/opt/job-ops/logs/@ID@-orch.log
touch "$LOG"
# BRAIN: ensure it's in the container, then write state + queue (in-container so /app/data is shared)
docker cp /opt/job-ops/multiplatform/platforms/@ID@/@ID@-orchestrator.mjs job-ops:/app/orchestrator/@ID@-orchestrator.mjs >/dev/null 2>&1 || true
docker exec -w /app/orchestrator job-ops node @ID@-orchestrator.mjs scan >> "$LOG" 2>&1 || true
# WORKER: process the queue (no-op until the driver is implemented)
QUEUE=$(docker exec job-ops cat /app/data/@ID@-queue.json 2>/dev/null)
NGIGS=$(echo "$QUEUE" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('queue',[])))" 2>/dev/null || echo 0)
[ "${NGIGS:-0}" -eq 0 ] && { echo "[$(date -u +%FT%TZ)] @ID@: queue empty" >> "$LOG"; exit 0; }
echo "[$(date -u +%FT%TZ)] @ID@: $NGIGS queued (driver pending)" >> "$LOG"
# TODO(@ID@): for each queued item, run the driver, record the outcome, notify on success.
ORCHEOF
sed -i "s/@ID@/$ID/g; s/@NAME@/$NAME/g" "$DIR/orch.sh"
fi
chmod +x "$DIR/orch.sh"

echo "scaffolded $ID ($MODEL) at $DIR"
ls "$DIR"
