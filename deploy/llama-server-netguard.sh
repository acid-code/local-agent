#!/usr/bin/env bash
# Runs as root (ExecStartPre=+) before llama-server starts.
# llama-server binds 0.0.0.0 so Docker containers can reach it via host.docker.internal.
# UFW already denies the port on LAN/Tailscale; this adds a raw-table drop that applies before
# any other INPUT chain (Tailscale's ts-input accepts tailscale0 traffic ahead of UFW).
# Loopback and Docker bridges (docker0, br-*) are untouched.
set -u

PORT="${LLAMA_PORT:-8080}"
UNCENSORED_PORT="${LLAMA_UNCENSORED_PORT:-8081}"
FALLBACK_CONTROL_PORT="${LLAMA_FALLBACK_CONTROL_PORT:-8082}"
IFACES="${LLAMA_DENY_IFACES:-eno1 tailscale0}"

for ifc in $IFACES; do
  ip link show "$ifc" >/dev/null 2>&1 || continue
  for port in "$PORT" "$UNCENSORED_PORT" "$FALLBACK_CONTROL_PORT"; do
    for ipt in iptables ip6tables; do
      command -v "$ipt" >/dev/null 2>&1 || continue
      "$ipt" -t raw -C PREROUTING -i "$ifc" -p tcp --dport "$port" -j DROP 2>/dev/null \
        || "$ipt" -t raw -I PREROUTING -i "$ifc" -p tcp --dport "$port" -j DROP 2>/dev/null \
        || echo "warn: could not add $ipt raw drop for $ifc:$port" >&2
    done
  done
done
exit 0
