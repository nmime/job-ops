#!/bin/bash
# dispatcher.sh — job-ops multi-platform dispatcher.
# Runs each ENABLED platform's orch.sh (brain + worker) sequentially, isolated:
# a failure in one platform never stops the others. Logs per-platform.
set -uo pipefail
MP=/opt/job-ops/multiplatform
REG=$MP/registry.json
DISPATCH_LOG=/opt/job-ops/logs/mp-dispatch.log
PLATFORM_TIMEOUT=900   # per-platform cap (seconds)
. "$MP/lib/common.sh"

log(){ echo "[$(now_u)] $*" | tee -a "$DISPATCH_LOG"; }

# platforms to run: enabled AND has an orch script AND is not "contra" handled by its own timer?
# We DO include contra here too (single source of truth) but guard against double-run:
# if a platform's own timer is active, the dispatcher still runs it (idempotent brains).
mapfile -t PLATFORMS < <(python3 -c "
import json
r=json.load(open('$REG'))
for p in r['platforms'].values():
    if p.get('enabled'):
        print(p['id'])
")

if [ "${#PLATFORMS[@]}" -eq 0 ]; then
  log "no enabled platforms; nothing to dispatch"
  exit 0
fi

log "dispatch cycle: ${PLATFORMS[*]}"
for pid in "${PLATFORMS[@]}"; do
  # resolve orch path (absolute or relative to MP)
  ORCH=$(python3 -c "import json;print(json.load(open('$REG'))['platforms']['$pid']['orch'])")
  case "$ORCH" in /*) : ;; *) ORCH="$MP/$ORCH" ;; esac
  PLOG=$(python3 -c "import json;print(json.load(open('$REG'))['platforms']['$pid'].get('log','/opt/job-ops/logs/$pid-orch.log'))")
  touch "$PLOG"
  if [ ! -f "$ORCH" ]; then
    log "[$pid] orch missing: $ORCH (skipped)"
    continue
  fi
  log "[$pid] running $ORCH (timeout ${PLATFORM_TIMEOUT}s)"
  START=$(date +%s)
  OUT=$(timeout "$PLATFORM_TIMEOUT" bash "$ORCH" 2>&1)
  RC=$?
  END=$(date +%s)
  echo "$OUT" | tee -a "$PLOG" >/dev/null
  if [ $RC -eq 0 ]; then
    log "[$pid] OK in $((END-START))s"
  elif [ $RC -eq 124 ]; then
    log "[$pid] TIMEOUT after ${PLATFORM_TIMEOUT}s"
  else
    log "[$pid] EXIT $RC after $((END-START))s"
  fi
done
log "dispatch cycle done"
