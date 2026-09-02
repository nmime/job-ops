#!/bin/bash
# status.sh — cross-platform status for job-ops multi-platform.
#   status.sh            -> print table to stdout
#   status.sh --telegram -> also DM the summary to @nmime
set -uo pipefail
MP=/opt/job-ops/multiplatform
REG=$MP/registry.json
. "$MP/lib/common.sh"

read_json_local(){ # path (host or /app/)
  case "$1" in /app/*) docker exec job-ops cat "$1" 2>/dev/null;; *) cat "$1" 2>/dev/null;; esac
}

echo "======================================================================"
echo " job-ops multi-platform status  $(now_u)"
echo "======================================================================"
printf "%-16s %-6s %-6s %-8s %-9s %-8s %s\n" "PLATFORM" "MODEL" "LVL" "ENABLED" "APPLIED" "FAILED" "QUEUE"
echo "----------------------------------------------------------------------"
python3 -c "
import json,sys
r=json.load(open('$REG'))
for p in r['platforms'].values(): print(p['id'])
" | while read -r pid; do
  read -r name model level enabled state queue < <(python3 -c "
import json
p=json.load(open('$REG'))['platforms']['$pid']
print(p['name'], p['model'], p.get('level',0), int(p.get('enabled',False)), p['state'], p['queue'])
")
  applied=""; failed=""; qlen=""
  S=$(read_json_local "$state"); [ -n "$S" ] && applied=$(jget "$S" "print(len(d.get('applied',{})))")
  F=$(read_json_local "$state"); [ -n "$F" ] && failed=$(jget "$F" "print(len(d.get('failed',{})))")
  Q=$(read_json_local "$queue"); [ -n "$Q" ] && qlen=$(jget "$Q" "print(len(d.get('queue',[])))")
  applied=${applied:-0}; failed=${failed:-0}; qlen=${qlen:-0}
  printf "%-16s %-6s %-6s %-8s %-9s %-8s %s\n" "$name" "$model" "$level" "$([ "$enabled" = "1" ] && echo yes || echo -)" "$applied" "$failed" "$qlen"
done
echo "======================================================================"
# totals
python3 - "$REG" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
lv={}
for v in r["platforms"].values(): lv[v.get("level",0)]=lv.get(v.get("level",0),0)+1
en=sum(1 for v in r["platforms"].items() for v in [v] if v[1].get("enabled"))
print(f"platforms: {len(r['platforms'])} total | enabled={en} | by level: {dict(sorted(lv.items()))}")
print("level key: 0=registered 1=account+auth 2=discovery 3=live action verified")
PY

echo "======================================================================"
echo " freelance_* DB (job-ops multi-platform pipeline)"
echo "======================================================================"
docker exec -w /app/orchestrator job-ops node /app/orchestrator/scripts/multiplatform/db.cjs freelance-snapshot 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print('  (unavailable)'); sys.exit(0)
per=d.get('per',{})
print(f\"  sources={d.get('sources')} enabled={d.get('enabled')}\")
for pid,info in per.items():
    if not info.get('enabled'): continue
    last=info.get('last') or {}
    opps=info.get('opps') or {}
    login=last.get('login') or {}
    print(f\"  [{pid}] login={login.get('logged_in')} phone_verified={login.get('phone_verified')} blocked={last.get('blocked')} opps={opps} status={last.get('status')} at={last.get('at')}\")
"

if [ "${1:-}" = "--telegram" ]; then
  . "$MP/lib/notify.sh" 2>/dev/null || true
  # build a compact summary
  SUMMARY=$(python3 - "$REG" <<'PY'
import json,sys,subprocess
r=json.load(open(sys.argv[1]))
def rd(path):
    try:
        if path.startswith("/app/"):
            t=subprocess.run(["docker","exec","job-ops","cat",path],capture_output=True,text=True,timeout=20).stdout
        else:
            t=open(path).read()
        return json.loads(t)
    except Exception: return None
lines=["📊 job-ops multi-platform"]
lv={}
for v in r["platforms"].values():
    lv[v.get("level",0)]=lv.get(v.get("level",0),0)+1
lines.append(f"platforms {len(r['platforms'])} | by level: {lv}")
act=0
for v in r["platforms"].values():
    if v.get("enabled") or v.get("level",0)>=1:
        s=rd(v["state"]); q=rd(v["queue"])
        a=len(s.get("applied",{})) if isinstance(s,dict) else 0
        f=len(s.get("failed",{})) if isinstance(s,dict) else 0
        ql=len(q.get("queue",[])) if isinstance(q,dict) else 0
        mark="✅" if v.get("enabled") else "▪️"
        lines.append(f"{mark} {v['name']} (L{v.get('level',0)}): applied={a} failed={f} queue={ql}")
        act+=1
print("\n".join(lines))
PY
)
  notify.sh --html "$SUMMARY" 2>/dev/null || true
  echo "sent summary to Telegram"
fi
