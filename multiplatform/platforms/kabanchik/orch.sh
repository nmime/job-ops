#!/bin/bash
# kabanchik orchestration (BRAIN + WORKER) for kabanchik. Runs in the dispatcher.
set -uo pipefail
LOG=/opt/job-ops/logs/kabanchik-orch.log
touch "$LOG"
# BRAIN: ensure it's in the container, then write state + queue (in-container so /app/data is shared)
docker cp /opt/job-ops/multiplatform/platforms/kabanchik/kabanchik-orchestrator.mjs job-ops:/app/orchestrator/kabanchik-orchestrator.mjs >/dev/null 2>&1 || true
docker exec -w /app/orchestrator job-ops node kabanchik-orchestrator.mjs scan >> "$LOG" 2>&1 || true
# WORKER: process the queue (no-op until the driver is implemented)
QUEUE=$(docker exec job-ops cat /app/data/kabanchik-queue.json 2>/dev/null)
NGIGS=$(echo "$QUEUE" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('queue',[])))" 2>/dev/null || echo 0)
[ "${NGIGS:-0}" -eq 0 ] && { echo "[$(date -u +%FT%TZ)] kabanchik: queue empty" >> "$LOG"; exit 0; }
echo "[$(date -u +%FT%TZ)] kabanchik: $NGIGS queued (driver pending)" >> "$LOG"
# TODO(kabanchik): for each queued item, run the driver, record the outcome, notify on success.
