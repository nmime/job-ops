#!/bin/bash
# upwork orchestration (BRAIN + WORKER) for upwork. Runs in the dispatcher.
set -uo pipefail
LOG=/opt/job-ops/logs/upwork-orch.log
touch "$LOG"
# BRAIN: ensure it's in the container, then write state + queue (in-container so /app/data is shared)
docker cp /opt/job-ops/multiplatform/platforms/upwork/upwork-orchestrator.mjs job-ops:/app/orchestrator/upwork-orchestrator.mjs >/dev/null 2>&1 || true
docker exec -w /app/orchestrator job-ops node upwork-orchestrator.mjs scan >> "$LOG" 2>&1 || true
# WORKER: process the queue (no-op until the driver is implemented)
QUEUE=$(docker exec job-ops cat /app/data/upwork-queue.json 2>/dev/null)
NGIGS=$(echo "$QUEUE" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('queue',[])))" 2>/dev/null || echo 0)
[ "${NGIGS:-0}" -eq 0 ] && { echo "[$(date -u +%FT%TZ)] upwork: queue empty" >> "$LOG"; exit 0; }
echo "[$(date -u +%FT%TZ)] upwork: $NGIGS queued (driver pending)" >> "$LOG"
# TODO(upwork): for each queued item, run the driver, record the outcome, notify on success.
