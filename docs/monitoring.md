# Remote monitoring API

Read-only JSON endpoints for checking the box from anywhere on your tailnet: run traces, tool calls, errors, approvals,
false-success flags, service health and the RAM queue. No browser session; a bearer token instead.

## Token

On the box (shown once, never logged):

```bash
node packages/server/dist/doctor-cli.js --monitor-token laptop      # or: docker exec local-agent node packages/server/dist/doctor-cli.js --monitor-token laptop
mkdir -p ~/.config/local-agent && umask 077 && cat > ~/.config/local-agent/monitor-token   # paste, Ctrl-D
```

Alternatives: `POST /api/monitor-tokens {"label":"phone"}` from a signed-in owner session (returns the token once),
or set `LA_MONITOR_TOKEN` (16+ chars) in the server environment. List with `GET /api/monitor-tokens`, revoke with
`DELETE /api/monitor-tokens/:id` (owner session only). Tokens are stored as SHA-256 hashes; a monitor token opens only
`/api/monitor/*` (GET), nothing else.

## Reaching it remotely

The app listens on port 8787. Over Tailscale use `http://<box-name>.<tailnet>.ts.net:8787` (MagicDNS) or
`http://100.x.y.z:8787` (`tailscale ip -4` on the box). For HTTPS on the tailnet: `sudo tailscale serve --bg 8787`, then
`https://<box-name>.<tailnet>.ts.net/api/monitor/health`. Do not forward the port on the router.

## Endpoints

| Endpoint | What |
|---|---|
| `GET /api/monitor/health` | Service checks (Ollama, Docker, SearXNG, OCR, disk…), RAM budget, active jobs and the admission queue, active runs, uptime, `ok` |
| `GET /api/monitor/summary?since=24h` | Runs by status and model, false-success list, tool failures per tool, duration p50/p90/max, tokens, approvals (pending/denied), error count |
| `GET /api/monitor/runs?since=72h&status=&flagged=1&limit=50` | Run summaries: agent, model, routing note, duration, tokens, tool calls/errors, error, `falseSuccess` |
| `GET /api/monitor/runs/:id/trace` | Every step: model steps (prompt budget and estimate, tokens, latency), tool steps (args and result clipped to 600 chars, duration, error), approvals, final reply, false-success verdict |
| `GET /api/monitor/errors?since=24h` | Error/warn log lines, failed runs, tool errors |

`since` accepts `2h`, `7d` or an ISO time.

**False success**: a run is flagged when a tool call failed, no later call of the same tool succeeded, the run still
ended as completed, and the final reply claims success (done, created, saved, ✅, בוצע, נשמר…) without mentioning the
failure.

**Privacy**: secrets are redacted (vault values, API keys, GitHub/Slack tokens, bearer headers, private keys, sensitive
JSON keys). Members' runs show metadata only (agent, model, timings, tool names, errors) with chat text, tool arguments
and results replaced by `[member content hidden: N chars]`. The owner can lift that with `LA_MONITOR_MEMBER_CONTENT=1`.

## Daily poll

```bash
LA_URL=http://<box>.<tailnet>.ts.net:8787 scripts/monitor.sh 24h
# or one call:
curl -fsS -H "Authorization: Bearer $(cat ~/.config/local-agent/monitor-token)" "http://<box>.<tailnet>.ts.net:8787/api/monitor/summary?since=24h" | jq
```

Cron on the laptop: `0 9 * * * LA_URL=… /path/to/scripts/monitor.sh 24h > ~/la-monitor.txt 2>&1`.
