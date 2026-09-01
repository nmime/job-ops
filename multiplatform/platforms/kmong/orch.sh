#!/bin/bash
# kmong orchestration (BRAIN + WORKER) for kmong. Runs in the dispatcher.
set -uo pipefail
LOG=/opt/job-ops/logs/kmong-orch.log
touch "$LOG"
# BRAIN: ensure it's in the container, then write state + queue (in-container so /app/data is shared)
docker cp /opt/job-ops/multiplatform/platforms/kmong/kmong-orchestrator.mjs job-ops:/app/orchestrator/kmong-orchestrator.mjs >/dev/null 2>&1 || true
docker exec -w /app/orchestrator job-ops node kmong-orchestrator.mjs scan >> "$LOG" 2>&1 || true
# WORKER: process the queue (no-op until the driver is implemented)
QUEUE=$(docker exec job-ops cat /app/data/kmong-queue.json 2>/dev/null)
NGIGS=$(echo "$QUEUE" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('queue',[])))" 2>/dev/null || echo 0)
[ "${NGIGS:-0}" -eq 0 ] && { echo "[$(date -u +%FT%TZ)] kmong: queue empty" >> "$LOG"; exit 0; }
echo "[$(date -u +%FT%TZ)] kmong: $NGIGS queued (driver pending)" >> "$LOG"
# TODO(kmong): for each queued item, run the driver, record the outcome, notify on success.
