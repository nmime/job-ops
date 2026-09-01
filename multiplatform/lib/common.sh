#!/bin/bash
# lib/common.sh — shared helpers for job-ops multi-platform. Source it: . /opt/job-ops/multiplatform/lib/common.sh
#
# Provides:
#   now_u            -> UTC timestamp string
#   log_file <file> <msg>
#   read_json <file-in-container> [container]  -> print JSON (via docker exec or local cat)
#   count_applied <state-json> / count_failed / queue_len   (operate on a JSON string)
#   container_up <name> -> 0/1
#   steel_ok        -> 0 if steel-browser up + hardened + verified
set -uo pipefail

now_u(){ date -u +%Y-%m-%d\ %H:%M:%SZ; }

log_file(){ local f="$1"; shift; echo "[$(now_u)] $*" >> "$f" 2>/dev/null; }

# read a JSON file that lives either in the job-ops container (/app/...) or on the host
read_json(){
  local path="$1" cont="${2:-job-ops}"
  case "$path" in
    /app/*) docker exec "$cont" cat "$path" 2>/dev/null ;;
    *)      cat "$path" 2>/dev/null ;;
  esac
}

jget(){ # jget <json> <python-expr-on-d>
  printf '%s' "$1" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
exec(sys.argv[1])" "$2" 2>/dev/null
}

count_applied(){ jget "$1" "print(len(d.get('applied',{})))"; }
count_failed(){  jget "$1" "print(len(d.get('failed',{})))"; }
queue_len(){     jget "$1" "print(len(d.get('queue',[])))"; }

container_up(){ docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

steel_ok(){
  container_up steel-browser || return 1
  local h
  h=$(curl -s -m 8 http://127.0.0.1:3000/v1/health 2>/dev/null)
  echo "$h" | grep -qi "hardened" && echo "$h" | grep -qi "verified"
}
