#!/usr/bin/env bash
# Launcher for llama-server (patched b12217 / b2143c676: ROCm HIP + DFlash2 + fa-tile-dequant-on-load q8_0 KV).
# Settings come from /etc/default/llama-server (via systemd EnvironmentFile). Kept as a script so
# systemd never has to expand ${VAR:-default} (it does not support that syntax).
set -euo pipefail

# Optional user-owned overrides (no sudo needed); they win over /etc/default/llama-server.
LOCAL_ENV="${LLAMA_LOCAL_ENV:-/opt/llama-server/llama.local.env}"
# shellcheck disable=SC1090
[[ -r "$LOCAL_ENV" ]] && set -a && . "$LOCAL_ENV" && set +a

BIN="${LLAMA_BIN:-/opt/llama-server/bin/llama-server}"
MODEL="${LLAMA_MODEL:-/opt/llama-server/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf}"

args=(-m "$MODEL")
if [[ -n "${LLAMA_DRAFT_MODEL:-}" ]]; then
  # dflash.block_size = 8 in qwen36-35b-a3b-dflash-Q8_0.gguf, so 7 is the real maximum.
  n_max="${LLAMA_DRAFT_N_MAX:-7}"
  (( n_max > 7 )) && { echo "LLAMA_DRAFT_N_MAX=$n_max is clamped to 7 by the DFlash block size; using 7." >&2; n_max=7; }
  args+=(-md "$LLAMA_DRAFT_MODEL" -ngld 999
         --spec-draft-n-max "$n_max" --spec-draft-n-min "${LLAMA_DRAFT_N_MIN:-1}")
  [[ -n "${LLAMA_DRAFT_P_MIN:-}" ]] && args+=(--spec-draft-p-min "$LLAMA_DRAFT_P_MIN")
fi

# -fit off -lm none: no double allocation in RAM/GTT, no KFD teardown at startup.
# -ub 256 + -t 12: verified on RDNA3 without MES watchdog resets while leaving 4 threads for OS/Docker/Tailscale.
# Patched b12217 (b2143c676) with fa-tile-dequant-on-load makes q8_0 KV faster than f16 on RDNA3
# (+35.5% decode at 24K, +59.5% at 56K) and shrinks 256K GTT footprint to ~24.5 GiB.
args+=(-ngl 999 -fit off -lm none -fa on
       -ub "${LLAMA_UBATCH:-256}" -b "${LLAMA_BATCH:-512}" -t "${LLAMA_THREADS:-12}"
       -c "${LLAMA_CTX:-262144}" -np "${LLAMA_SLOTS:-1}"
       --jinja
       --host "${LLAMA_HOST:-0.0.0.0}" --port "${LLAMA_PORT:-8080}")
cache_k="${LLAMA_CACHE_K:-q8_0}"
cache_v="${LLAMA_CACHE_V:-q8_0}"
[[ -n "$cache_k" ]] && args+=(-ctk "$cache_k")
[[ -n "$cache_v" ]] && args+=(-ctv "$cache_v")
[[ -n "${LLAMA_ALIAS:-}" ]] && args+=(-a "$LLAMA_ALIAS")
extra_raw="${LLAMA_EXTRA_ARGS---cache-ram 2048}"
if [[ -n "$extra_raw" ]]; then
  # shellcheck disable=SC2206
  extra=($extra_raw)
  args+=("${extra[@]}")
fi

echo "exec $BIN ${args[*]}"
exec "$BIN" "${args[@]}"
