#!/usr/bin/env bash
# Launcher for llama-server (exp-coalesced-dflash: ROCm HIP + DFlash2 + gf_res_prev[10] graph cache).
# Settings come from /etc/default/llama-server (via systemd EnvironmentFile). Kept as a script so
# systemd never has to expand ${VAR:-default} (it does not support that syntax).
set -euo pipefail

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
# -ub 64: avoids RDNA3 MES watchdog resets on MoE MUL_MAT_ID. -t 12 leaves 4 threads for the OS/Docker/Tailscale.
# Leave KV at native f16 by default: Qwen3.6-35B-A3B (head_dim=256, gqa_ratio=8) + DFlash2 dispatches
# BEST_FATTN_KERNEL_MMA_F16 which needs F16 K/V (q8_0 forces per-step dequant and faults launch_fattn).
args+=(-ngl 999 -fit off -lm none -fa on
       -ub "${LLAMA_UBATCH:-64}" -b "${LLAMA_BATCH:-512}" -t "${LLAMA_THREADS:-12}"
       -c "${LLAMA_CTX:-65536}" -np "${LLAMA_SLOTS:-1}"
       --jinja
       --host "${LLAMA_HOST:-0.0.0.0}" --port "${LLAMA_PORT:-8080}")
[[ -n "${LLAMA_CACHE_K:-}" ]] && args+=(-ctk "$LLAMA_CACHE_K")
[[ -n "${LLAMA_CACHE_V:-}" ]] && args+=(-ctv "$LLAMA_CACHE_V")
[[ -n "${LLAMA_ALIAS:-}" ]] && args+=(-a "$LLAMA_ALIAS")
if [[ -n "${LLAMA_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  extra=($LLAMA_EXTRA_ARGS)
  args+=("${extra[@]}")
fi

echo "exec $BIN ${args[*]}"
exec "$BIN" "${args[@]}"
