#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${JOBOPS_ROOT:-/opt/job-ops}"
CONTAINER="${JOBOPS_CONTAINER:-job-ops}"
SERVICE_LOG_DIR="${JOBOPS_AUTONOMOUS_LOG_DIR:-$ROOT/logs}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
HOST_RUN_DIR="$ROOT/data/autonomous-service/$RUN_ID"
CONTAINER_RUN_DIR="/app/data/autonomous-service/$RUN_ID"
STATUS_FILE="${JOBOPS_AUTONOMOUS_STATUS_FILE:-/tmp/jobops_autonomous_service_latest_status.json}"
HOST_STATUS_FILE="$SERVICE_LOG_DIR/autonomous-service-status.json"
STEPS_FILE="$HOST_RUN_DIR/steps.ndjson"
LOCK_FILE="${JOBOPS_AUTONOMOUS_LOCK_FILE:-/run/lock/jobops-autonomous.lock}"

mkdir -p "$SERVICE_LOG_DIR" "$HOST_RUN_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  python3 - "$STATUS_FILE" <<'PY'
import json, sys, datetime
path=sys.argv[1]
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
open(path,'w').write(json.dumps({"status":"skipped","reason":"previous autonomous run is still active","updatedAt":now}, indent=2))
print("previous autonomous run is still active; skipping")
PY
  exit 0
fi

cd "$ROOT"

echo "[$(date -Is)] jobops autonomous run $RUN_ID started"

record_step() {
  local name="$1" status="$2" rc="$3" started="$4" finished="$5" output_file="$6"
  python3 - "$STEPS_FILE" "$name" "$status" "$rc" "$started" "$finished" "$output_file" <<'PY'
import json, pathlib, sys
steps, name, status, rc, started, finished, output_file = sys.argv[1:]
text = pathlib.Path(output_file).read_text(errors="replace") if output_file else ""
entry = {
    "name": name,
    "status": status,
    "rc": int(rc),
    "startedAt": started,
    "finishedAt": finished,
    "summary": text[-4000:],
}
with open(steps, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(entry) + "\n")
PY
}

run_step() {
  local name="$1"; shift
  local started finished rc status output_file
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  output_file="$HOST_RUN_DIR/${name}.log"
  echo "[$(date -Is)] step $name started"
  set +e
  "$@" >"$output_file" 2>&1
  rc=$?
  set -e
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$rc" -eq 0 ]; then status="success"; else status="error"; fi
  record_step "$name" "$status" "$rc" "$started" "$finished" "$output_file"
  echo "[$(date -Is)] step $name $status rc=$rc"
  tail -n 40 "$output_file" || true
  return "$rc"
}

write_final_status() {
  local status="$1"
  python3 - "$STATUS_FILE" "$RUN_ID" "$status" "$HOST_RUN_DIR" "$STEPS_FILE" <<'PY'
import json, pathlib, sys, datetime
status_file, run_id, status, run_dir, steps_file = sys.argv[1:]
steps=[]
path=pathlib.Path(steps_file)
if path.exists():
    for line in path.read_text(errors="replace").splitlines():
        if line.strip():
            try: steps.append(json.loads(line))
            except Exception: pass
counts={"success":0,"error":0,"skipped":0}
for step in steps:
    counts[step.get("status", "error")] = counts.get(step.get("status", "error"), 0) + 1
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
payload = {
    "status": status,
    "runId": run_id,
    "updatedAt": now,
    "runDir": run_dir,
    "stepCounts": counts,
    "steps": steps,
}
pathlib.Path(status_file).write_text(json.dumps(payload, indent=2))
host_status = pathlib.Path("/opt/job-ops/logs/autonomous-service-status.json")
host_status.parent.mkdir(parents=True, exist_ok=True)
host_status.write_text(json.dumps(payload, indent=2))
PY
}

ensure_container() {
  if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker compose up -d job-ops
  elif [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
    docker compose up -d job-ops
  fi

  for _ in $(seq 1 90); do
    local health
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{if .State.Running}}running{{else}}stopped{{end}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"
    if [ "$health" = "healthy" ] || [ "$health" = "running" ]; then
      echo "container $CONTAINER is $health"
      return 0
    fi
    sleep 2
  done
  echo "container $CONTAINER did not become healthy" >&2
  docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}'
  return 1
}

make_cleanup_script() {
  cat > "$HOST_RUN_DIR/cleanup-stale-runs.js" <<'NODE'
const Database = require("better-sqlite3");
const dbPath = process.env.JOBOPS_DB_PATH || "/app/data/jobs.db";
const staleHours = Math.max(1, Number.parseInt(process.env.JOBOPS_AUTONOMOUS_STALE_RUN_HOURS || "6", 10));
const cutoffMs = Date.now() - staleHours * 60 * 60 * 1000;
const now = new Date().toISOString();
const db = new Database(dbPath);
const rows = db.prepare("select id, started_at, status from pipeline_runs where status in ('pending','running')").all();
const stale = rows.filter((row) => {
  const parsed = Date.parse(row.started_at || "");
  return Number.isFinite(parsed) && parsed < cutoffMs;
});
const update = db.prepare("update pipeline_runs set status='failed', completed_at=?, error_message=coalesce(error_message, ?), result_summary=coalesce(result_summary, ?) where id=?");
const message = `Autonomous watchdog marked stale after ${staleHours}h without completion.`;
const summary = JSON.stringify({ stage: "watchdog", processingErrors: [message] });
const tx = db.transaction(() => {
  for (const row of stale) update.run(now, message, summary, row.id);
});
tx();
console.log(JSON.stringify({ staleHours, staleClosed: stale.length, ids: stale.map((row) => row.id) }, null, 2));
NODE
}

ensure_playwright_browsers() {
  docker exec "$CONTAINER" sh -lc "cd /app/orchestrator && node - <<'NODE'
const { existsSync } = require('node:fs');
const { chromium, firefox } = require('playwright');
const paths = [chromium.executablePath(), firefox.executablePath()];
if (!paths.every((path) => existsSync(path))) process.exit(42);
NODE
  " >/dev/null 2>&1 || docker exec "$CONTAINER" sh -lc "cd /app/orchestrator && npx playwright install chromium firefox"
}


pipeline_active_count() {
  docker exec "$CONTAINER" sh -lc "cd /app/orchestrator && node -e \"const Database=require('better-sqlite3'); const db=new Database('/app/data/jobs.db',{readonly:true}); const row=db.prepare(\\\"select count(*) as count from pipeline_runs where status in ('pending','running')\\\").get(); console.log(row.count || 0);\""
}

wait_for_pipeline_idle() {
  local wait_seconds="${JOBOPS_AUTONOMOUS_PIPELINE_IDLE_WAIT_SECONDS:-900}"
  local interval_seconds="${JOBOPS_AUTONOMOUS_PIPELINE_IDLE_POLL_SECONDS:-15}"
  local deadline=$((SECONDS + wait_seconds))
  local active="0"
  while true; do
    active="$(pipeline_active_count 2>/dev/null || echo 0)"
    if [ "${active:-0}" = "0" ]; then
      echo "pipeline idle"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "pipeline still active after ${wait_seconds}s; skipping DB-mutating autonomous steps this cycle" >&2
      return 75
    fi
    echo "pipeline active (${active}); waiting ${interval_seconds}s before autonomous DB-mutating steps"
    sleep "$interval_seconds"
  done
}

run_imap_sync() {
  if [ ! -x "$ROOT/scripts/do_all_email_sync.py" ]; then
    echo "scripts/do_all_email_sync.py is not installed; skipping IMAP sync"
    return 0
  fi
  mkdir -p "$HOST_RUN_DIR/imap"
  DO_ALL_DIR="$HOST_RUN_DIR/imap" python3 "$ROOT/scripts/do_all_email_sync.py"
}


run_post_application_cleanup() {
  cat > "$HOST_RUN_DIR/post-application-cleanup.js" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/app/data/jobs.db');
db.pragma('busy_timeout = 15000');
const nowEpoch = Math.floor(Date.now() / 1000);
const nowIso = new Date().toISOString();
const staleHours = Math.max(1, Number.parseInt(process.env.JOBOPS_AUTONOMOUS_STALE_RUN_HOURS || '6', 10));
const cutoffEpoch = nowEpoch - staleHours * 60 * 60;
const staleSyncRuns = db.prepare("select id, started_at, status from post_application_sync_runs where status in ('pending','running') and coalesce(started_at, 0) < ?").all(cutoffEpoch);
const pendingBefore = db.prepare("select processing_status, classification_label, message_type, count(*) as count from post_application_messages group by processing_status, classification_label, message_type order by count desc").all();
const noiseMessages = db.prepare("select id, subject from post_application_messages where processing_status = 'pending_user' and matched_job_id is null and lower(coalesce(subject, '')) like '%security alert%'").all();
const tx = db.transaction(() => {
  const closeSync = db.prepare("update post_application_sync_runs set status='failed', completed_at=?, error_code=coalesce(error_code, 'autonomous_stale_sync_run'), error_message=coalesce(error_message, ?), updated_at=? where id=?");
  for (const row of staleSyncRuns) {
    closeSync.run(nowEpoch, `Autonomous service marked stale post-application sync run after ${staleHours}h without completion.`, nowIso, row.id);
  }
  const ignoreNoise = db.prepare("update post_application_messages set processing_status='ignored', decided_at=?, decided_by='system', error_code=coalesce(error_code, 'autonomous_non_job_noise'), error_message=coalesce(error_message, 'Autonomous service ignored non-job security alert.'), updated_at=? where id=?");
  for (const row of noiseMessages) ignoreNoise.run(nowEpoch, nowIso, row.id);
});
tx();
const pendingAfter = db.prepare("select processing_status, classification_label, message_type, count(*) as count from post_application_messages group by processing_status, classification_label, message_type order by count desc").all();
const unresolvedFollowups = db.prepare("select classification_label, message_type, processing_status, count(*) as count from post_application_messages where processing_status not in ('auto_linked','approved','denied','ignored') or processing_status is null group by classification_label, message_type, processing_status order by count desc").all();
const directPortalNeedsHuman = db.prepare("select count(*) as count from stage_events where outcome='needs_human' and metadata like '%direct portal application required%'").get();
console.log(JSON.stringify({
  staleHours,
  staleSyncRunsClosed: staleSyncRuns.length,
  ignoredNonJobSecurityAlerts: noiseMessages.length,
  unresolvedFollowups,
  directPortalNeedsHuman: directPortalNeedsHuman?.count ?? 0,
  pendingBefore,
  pendingAfter,
}, null, 2));
NODE
  docker exec \
    -e JOBOPS_AUTONOMOUS_STALE_RUN_HOURS="${JOBOPS_AUTONOMOUS_STALE_RUN_HOURS:-6}" \
    "$CONTAINER" sh -lc "cd /app/orchestrator && node '$CONTAINER_RUN_DIR/post-application-cleanup.js'"
}

run_ready_drain() {
  local host_script="$ROOT/orchestrator/scripts/autonomous-ready-drain.ts"
  local drain_script="scripts/autonomous-ready-drain.ts"
  if [ -f "$host_script" ]; then
    docker exec "$CONTAINER" sh -lc "mkdir -p /app/orchestrator/scripts"
    docker cp "$host_script" "$CONTAINER:/app/orchestrator/$drain_script"
  fi

  if docker exec "$CONTAINER" test -f "/app/orchestrator/$drain_script"; then
    docker exec \
      -e DO_ALL_DIR="$CONTAINER_RUN_DIR/ready-drain" \
      -e JOBOPS_FULL_AUTO_BROWSER="${JOBOPS_FULL_AUTO_BROWSER:-firefox}" \
      -e JOBOPS_AUTONOMOUS_DRAIN_DELAY_MS="${JOBOPS_AUTONOMOUS_DRAIN_DELAY_MS:-1200}" \
      "$CONTAINER" sh -lc "mkdir -p '$CONTAINER_RUN_DIR/ready-drain' && cd /app/orchestrator && npx tsx $drain_script"
    return $?
  fi

  if docker exec "$CONTAINER" test -f /app/orchestrator/do_all_continuation_20260519.ts; then
    echo "new ready-drain script not in container; using legacy continuation fallback"
    docker exec \
      -e DO_ALL_DIR="$CONTAINER_RUN_DIR/ready-drain" \
      -e JOBOPS_FULL_AUTO_BROWSER="${JOBOPS_FULL_AUTO_BROWSER:-firefox}" \
      -e DO_ALL_DELAY_MS="${JOBOPS_AUTONOMOUS_DRAIN_DELAY_MS:-1200}" \
      "$CONTAINER" sh -lc "mkdir -p '$CONTAINER_RUN_DIR/ready-drain' && cd /app/orchestrator && npx tsx do_all_continuation_20260519.ts"
    return $?
  fi

  echo "No autonomous ready-drain script found in container" >&2
  return 2
}
run_health_summary() {
  docker exec "$CONTAINER" sh -lc "cd /app/orchestrator && node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/app/data/jobs.db');
const q = (sql) => db.prepare(sql).all();
console.log(JSON.stringify({
  jobs: q(\"select status, count(*) as count from jobs group by status order by status\"),
  pipelineRuns: q(\"select status, count(*) as count from pipeline_runs group by status order by status\"),
  staleActiveRuns: q(\"select id, started_at, status from pipeline_runs where status in ('pending','running') order by started_at\"),
  emailAttempts: q(\"select status, count(*) as count from application_email_attempts group by status order by status\"),
  postApplicationSyncRuns: q(\"select status, count(*) as count from post_application_sync_runs group by status order by status\"),
  postApplicationMessages: q(\"select processing_status, classification_label, message_type, count(*) as count from post_application_messages group by processing_status, classification_label, message_type order by count desc\"),
  queuedJobs: q(\"select status, count(*) as count from jobs where status in ('ready','retry','manual','needs_manual','updated') group by status order by status\"),
  activeClosedItems: q(\"select status, outcome, count(*) as count from jobs where status='in_progress' group by status, outcome order by outcome\"),
}, null, 2));
NODE"
}

STATUS="success"
run_step ensure_container ensure_container || STATUS="partial"
make_cleanup_script
run_step stale_pipeline_cleanup docker exec -e JOBOPS_AUTONOMOUS_STALE_RUN_HOURS="${JOBOPS_AUTONOMOUS_STALE_RUN_HOURS:-6}" "$CONTAINER" sh -lc "cd /app/orchestrator && node '$CONTAINER_RUN_DIR/cleanup-stale-runs.js'" || STATUS="partial"
run_step ensure_playwright_browsers ensure_playwright_browsers || STATUS="partial"
if run_step pipeline_idle_wait wait_for_pipeline_idle; then
  run_step imap_status_sync run_imap_sync || STATUS="partial"
  run_step post_application_cleanup run_post_application_cleanup || STATUS="partial"
  run_step ats_contact_ready_drain run_ready_drain || STATUS="partial"
else
  STATUS="partial"
fi
run_step health_summary run_health_summary || STATUS="partial"
write_final_status "$STATUS"
echo "[$(date -Is)] jobops autonomous run $RUN_ID finished status=$STATUS"
