#!/usr/bin/env bash
# ExecStartPre memory guard for llama-server.
# Qwen3.6-35B-A3B + DFlash2 + 32K q8_0 KV pins ~22.5 GiB of unswappable GTT. If another process
# (usually Ollama) already holds a big model, starting would push GTT past what the kernel can
# reclaim and freeze the host. Refuse to start instead; systemd retries later (RestartSec).
set -u

MIN_AVAIL_GB="${LLAMA_GUARD_MIN_AVAIL_GB:-26}"
MAX_GTT_GB="${LLAMA_GUARD_MAX_GTT_GB:-14}"

avail_gb=$(awk '/^MemAvailable:/ {printf "%d", $2/1048576}' /proc/meminfo)
gtt_gb=0
for f in /sys/class/drm/card*/device/mem_info_gtt_used; do
  [[ -r "$f" ]] || continue
  g=$(awk '{printf "%d", $1/1073741824}' "$f")
  (( g > gtt_gb )) && gtt_gb=$g
done

if (( avail_gb >= MIN_AVAIL_GB )) && (( gtt_gb <= MAX_GTT_GB )); then
  echo "Memory guard OK: MemAvailable=${avail_gb}GiB (need >= ${MIN_AVAIL_GB}), GTT used=${gtt_gb}GiB (max ${MAX_GTT_GB})"
  exit 0
fi
echo "Refusing start: MemAvailable=${avail_gb}GiB (need >= ${MIN_AVAIL_GB}) GTT used=${gtt_gb}GiB (max ${MAX_GTT_GB})." >&2
echo "Free memory first, e.g. unload Ollama models: curl -s localhost:11434/api/ps ; ollama stop <model>" >&2
exit 1
