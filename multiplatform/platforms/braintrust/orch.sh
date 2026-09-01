#!/bin/bash
# braintrust orchestration (BRAIN + WORKER) for braintrust. Runs in the dispatcher.
set -uo pipefail
LOG=/opt/job-ops/logs/braintrust-orch.log
touch "$LOG"
# BRAIN: ensure it's in the container, then write state + queue (in-container so /app/data is shared)
docker cp /opt/job-ops/multiplatform/platforms/braintrust/braintrust-orchestrator.mjs job-ops:/app/orchestrator/braintrust-orchestrator.mjs >/dev/null 2>&1 || true
docker exec -w /app/orchestrator job-ops node braintrust-orchestrator.mjs scan >> "$LOG" 2>&1 || true
# WORKER: process the queue (no-op until the driver is implemented)
QUEUE=$(docker exec job-ops cat /app/data/braintrust-queue.json 2>/dev/null)
NGIGS=$(echo "$QUEUE" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('queue',[])))" 2>/dev/null || echo 0)
[ "${NGIGS:-0}" -eq 0 ] && { echo "[$(date -u +%FT%TZ)] braintrust: queue empty" >> "$LOG"; exit 0; }
echo "[$(date -u +%FT%TZ)] braintrust: $NGIGS queued (driver pending)" >> "$LOG"
# TODO(braintrust): for each queued item, run the driver, record the outcome, notify on success.
