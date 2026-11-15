#!/usr/bin/env bash
# Daily check of a local-agent box through the read-only monitoring API.
#   LA_URL=http://<box>.<tailnet>.ts.net:8787 scripts/monitor.sh [since]   (since: 24h default, or 2h, 7d, an ISO date)
# The token comes from LA_MONITOR_TOKEN or ~/.config/local-agent/monitor-token (chmod 600). It is never printed.
set -euo pipefail
URL="${LA_URL:-http://127.0.0.1:8787}"
SINCE="${1:-24h}"
TOKEN="${LA_MONITOR_TOKEN:-$(cat "${HOME}/.config/local-agent/monitor-token" 2>/dev/null || true)}"
[ -n "$TOKEN" ] || { echo "No token: set LA_MONITOR_TOKEN or create ~/.config/local-agent/monitor-token" >&2; exit 2; }
get() { curl -fsS --max-time 20 -H "Authorization: Bearer ${TOKEN}" "${URL}$1"; }
fmt() { if command -v jq >/dev/null; then jq "$@"; else cat; fi; }
echo "== health"; get /api/monitor/health | fmt '{ok, uptimeSec, activeRuns, failing: [.checks[] | select(.ok == false) | {id, detail}], ram: .memory.budgetGiB, queue: (.memory.queue | length?)}'
echo "== summary since ${SINCE}"; get "/api/monitor/summary?since=${SINCE}" | fmt '{runs, byStatus, falseSuccess, toolFailures, durationMs, approvals, errors}'
echo "== flagged runs"; get "/api/monitor/runs?since=${SINCE}&flagged=1" | fmt '[.runs[] | {id, status, agent, model, toolErrors, falseSuccess, error}]'
echo "== errors"; get "/api/monitor/errors?since=${SINCE}" | fmt '{failedRuns: (.failedRuns | length), toolErrors: (.toolErrors[:10]), logs: (.logs[:10])}'
