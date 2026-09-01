#!/bin/bash
# toptal orchestration (BRAIN + WORKER) for toptal. Runs in the dispatcher.
set -uo pipefail
LOG=/opt/job-ops/logs/toptal-orch.log
touch "$LOG"
# BRAIN: ensure it's in the container, then write state + queue (in-container so /app/data is shared)
docker cp /opt/job-ops/multiplatform/platforms/toptal/toptal-orchestrator.mjs job-ops:/app/orchestrator/toptal-orchestrator.mjs >/dev/null 2>&1 || true
docker exec -w /app/orchestrator job-ops node toptal-orchestrator.mjs scan >> "$LOG" 2>&1 || true
# WORKER: process the queue (no-op until the driver is implemented)
QUEUE=$(docker exec job-ops cat /app/data/toptal-queue.json 2>/dev/null)
NGIGS=$(echo "$QUEUE" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('queue',[])))" 2>/dev/null || echo 0)
[ "${NGIGS:-0}" -eq 0 ] && { echo "[$(date -u +%FT%TZ)] toptal: queue empty" >> "$LOG"; exit 0; }
echo "[$(date -u +%FT%TZ)] toptal: $NGIGS queued (driver pending)" >> "$LOG"
# TODO(toptal): for each queued item, run the driver, record the outcome, notify on success.
