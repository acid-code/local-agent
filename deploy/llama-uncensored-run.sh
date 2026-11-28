#!/usr/bin/env bash
# Launcher for the uncensored llama-server fallback on port 8081 (patched b12217: Qwen3.6-35B-A3B Uncensored + mmproj + DFlash2 + q8_0 KV, 256K ~24.9 GiB GTT).
set -euo pipefail

# Optional user-owned overrides (no sudo needed); they win over /etc/default/llama-uncensored.
LOCAL_ENV="${LLAMA_UNCENSORED_LOCAL_ENV:-/opt/llama-server/uncensored.local.env}"
# shellcheck disable=SC1090
[[ -r "$LOCAL_ENV" ]] && set -a && . "$LOCAL_ENV" && set +a

BIN="${LLAMA_UNCENSORED_BIN:-/opt/llama-server/uncensored-bin/llama-server}"
MODEL="${LLAMA_UNCENSORED_MODEL:-/opt/llama-server/models/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf}"
MMPROJ="${LLAMA_UNCENSORED_MMPROJ-/opt/llama-server/models/mmproj-Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-f16.gguf}"
DRAFT="${LLAMA_UNCENSORED_DRAFT_MODEL:-/opt/llama-server/models/qwen36-35b-a3b-dflash-Q8_0.gguf}"
SPEC_TYPE="${LLAMA_UNCENSORED_SPEC_TYPE-}"

args=(-m "$MODEL")
[[ -n "$MMPROJ" && -e "$MMPROJ" ]] && args+=(--mmproj "$MMPROJ")
if [[ -n "$DRAFT" && -e "$DRAFT" ]]; then
  args+=(-md "$DRAFT")
  [[ -n "$SPEC_TYPE" ]] && args+=(--spec-type "$SPEC_TYPE")
  args+=(--spec-draft-n-max "${LLAMA_UNCENSORED_DRAFT_N_MAX:-7}"
         --spec-draft-n-min "${LLAMA_UNCENSORED_DRAFT_N_MIN:-1}"
         --spec-draft-p-min "${LLAMA_UNCENSORED_DRAFT_P_MIN:-0.55}"
         -ngld 999)
fi

args+=(-ngl 999 -fit off -lm none -fa on
       -ub "${LLAMA_UNCENSORED_UBATCH:-256}" -b "${LLAMA_UNCENSORED_BATCH:-512}"
       -t "${LLAMA_UNCENSORED_THREADS:-12}" -c "${LLAMA_UNCENSORED_CTX:-262144}"
       -np "${LLAMA_UNCENSORED_SLOTS:-1}"
       -a "${LLAMA_UNCENSORED_ALIAS:-qwen3.6-35b-a3b-uncensored}"
       --jinja --host "${LLAMA_UNCENSORED_HOST:-0.0.0.0}"
       --port "${LLAMA_UNCENSORED_PORT:-8081}")
cache_k="${LLAMA_UNCENSORED_CACHE_K:-q8_0}"
cache_v="${LLAMA_UNCENSORED_CACHE_V:-q8_0}"
[[ -n "$cache_k" ]] && args+=(-ctk "$cache_k")
[[ -n "$cache_v" ]] && args+=(-ctv "$cache_v")
extra_raw="${LLAMA_UNCENSORED_EXTRA_ARGS---cache-ram 2048}"
if [[ -n "$extra_raw" ]]; then
  # shellcheck disable=SC2206
  extra=($extra_raw)
  args+=("${extra[@]}")
fi

echo "exec $BIN ${args[*]}"
exec "$BIN" "${args[@]}"
