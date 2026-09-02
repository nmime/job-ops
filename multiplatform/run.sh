#!/usr/bin/env bash
# run.sh — stage the multi-platform pipeline into the containers and run the host coordinator.
# Called as a step by jobops-autonomous-run.sh (job-ops autonomous cycle).
set -uo pipefail
ROOT="/opt/job-ops"
CONTAINER="job-ops"
STEEL="steel-browser"

# 1. DB script into the job-ops container
docker exec "$CONTAINER" sh -lc "mkdir -p /app/orchestrator/scripts/multiplatform"
docker cp "$ROOT/orchestrator/scripts/multiplatform/db.cjs" "$CONTAINER:/app/orchestrator/scripts/multiplatform/db.cjs"

# 2. Steel browser layer + platform tasks + secrets into the steel container (root for perms)
docker exec --user root "$STEEL" sh -lc "mkdir -p /app/multiplatform && rm -rf /app/multiplatform/platforms"
docker cp "$ROOT/orchestrator/steel-drive.mjs" "$STEEL:/app/steel-drive.mjs"
docker cp "$ROOT/multiplatform/platforms" "$STEEL:/app/multiplatform/platforms"
if [ -f "$ROOT/multiplatform/secrets/kwork.env" ]; then
  docker cp "$ROOT/multiplatform/secrets/kwork.env" "$STEEL:/app/kwork.env"
fi
docker exec --user root "$STEEL" sh -lc "chmod -R a+rX /app/multiplatform /app/steel-drive.mjs; [ -f /app/kwork.env ] && chmod 644 /app/kwork.env"

# 3. Run the host coordinator
exec node "$ROOT/multiplatform/orchestrator.mjs" "$@"
