#!/bin/bash
# lib/notify.sh — Telegram push helper for job-ops multi-platform.
# Sources /opt/job-ops/notify.env (TG_BOT_TOKEN, TG_CHAT_ID) and sends a message.
#   usage: notify.sh "message text"        (plain)
#          notify.sh --html "html text"    (html mode)
set -uo pipefail
ENV=/opt/job-ops/notify.env
[ -f "$ENV" ] && . "$ENV"
[ -z "${TG_BOT_TOKEN:-}" ] && { echo "notify: no TG_BOT_TOKEN" >&2; return 1 2>/dev/null || exit 0; }
MODE="plain"; TEXT=""
if [ "${1:-}" = "--html" ]; then MODE="html"; TEXT="${2:-}"; else TEXT="${1:-}"; fi
[ -z "$TEXT" ] && return 0 2>/dev/null
curl -s -m 20 "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TG_CHAT_ID}" \
  ${MODE:+--data-urlencode "parse_mode=${MODE}"} \
  --data-urlencode "text=${TEXT}" >/dev/null 2>&1
