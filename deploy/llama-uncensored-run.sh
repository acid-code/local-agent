#!/usr/bin/env bash
# Launcher for the benchmarked Inkling uncensored llama-server fallback on port 8081.
set -euo pipefail

# Optional user-owned overrides (no sudo needed); they win over /etc/default/llama-uncensored.
LOCAL_ENV="${LLAMA_UNCENSORED_LOCAL_ENV:-/opt/llama-server/uncensored.local.env}"
# shellcheck disable=SC1090
[[ -r "$LOCAL_ENV" ]] && set -a && . "$LOCAL_ENV" && set +a

BIN="${LLAMA_UNCENSORED_BIN:-/opt/llama-server/uncensored-bin/llama-server}"
MODEL="${LLAMA_UNCENSORED_MODEL:-/opt/llama-server/models/Inkling-2-Mini-Uncensored-AD-Q4_K.gguf}"
MMPROJ="${LLAMA_UNCENSORED_MMPROJ:-/opt/llama-server/models/mmproj-Inkling-2-Mini-Uncensored-F16.gguf}"
DRAFT="${LLAMA_UNCENSORED_DRAFT_MODEL:-/opt/llama-server/models/dspark-Inkling-2-Mini-Q8_0.gguf}"

args=(-m "$MODEL")
[[ -n "$MMPROJ" && -e "$MMPROJ" ]] && args+=(--mmproj "$MMPROJ")
if [[ -n "$DRAFT" && -e "$DRAFT" ]]; then
  args+=(-md "$DRAFT" --spec-type draft-dspark
         --spec-draft-n-max "${LLAMA_UNCENSORED_DRAFT_N_MAX:-1}"
         --spec-draft-n-min "${LLAMA_UNCENSORED_DRAFT_N_MIN:-1}"
         --spec-draft-p-min "${LLAMA_UNCENSORED_DRAFT_P_MIN:-0.00}"
         -ngld 999)
fi

args+=(-ngl 999 -fit off -lm none -fa on
       -ctk "${LLAMA_UNCENSORED_CACHE_K:-q8_0}" -ctv "${LLAMA_UNCENSORED_CACHE_V:-q8_0}"
       -ub "${LLAMA_UNCENSORED_UBATCH:-512}" -b "${LLAMA_UNCENSORED_BATCH:-512}"
       -t "${LLAMA_UNCENSORED_THREADS:-12}" -c "${LLAMA_UNCENSORED_CTX:-32768}"
       -a "${LLAMA_UNCENSORED_ALIAS:-inkling-2-mini-uncensored}"
       --jinja --host "${LLAMA_UNCENSORED_HOST:-0.0.0.0}"
       --port "${LLAMA_UNCENSORED_PORT:-8081}")
[[ -n "${LLAMA_UNCENSORED_EXTRA_ARGS:-}" ]] && args+=($LLAMA_UNCENSORED_EXTRA_ARGS)

echo "exec $BIN ${args[*]}"
exec "$BIN" "${args[@]}"
