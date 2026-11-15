#!/usr/bin/env bash
# Pick the LLM runtime on this machine by measuring it: Ollama CPU vs Ollama Vulkan (iGPU) vs llama.cpp (if installed).
#   scripts/bench-runtime.sh [model] [--apply]
# model    : a pulled chat model (default gemma3:4b; pulled if missing). Use the real main model for real numbers.
# --apply  : write the winning env into the Ollama systemd override and restart Ollama (asks for sudo).
# LA_BENCH_GGUF=/path/model.gguf adds llama.cpp's llama-bench (Vulkan or CPU build on PATH).
# The running Ollama is left as it is: when it is not using the GPU, a second Ollama with Vulkan starts on :11499 for the GPU run and stops after.
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL=gemma3:4b; APPLY=0
for arg in "$@"; do case "$arg" in --apply) APPLY=1 ;; *) MODEL="$arg" ;; esac; done
OLLAMA="${OLLAMA_HOST:-http://127.0.0.1:11434}"; OLLAMA="${OLLAMA%/}"; [[ "$OLLAMA" == http* ]] || OLLAMA="http://$OLLAMA"
CLI=packages/server/dist/bench-cli.js
# Docker installs have no Node on the host: run the bench inside the app image (host network, so it reaches Ollama).
if command -v node >/dev/null && { [ -f "$CLI" ] || npm run build >/dev/null; }; then RUN=(node "$CLI")
elif [ -f docker-compose.yml ] && command -v docker >/dev/null; then RUN=(docker compose run --rm --no-deps -T -e OLLAMA_HOST -e LA_BENCH_GPU_BASE setup node packages/server/dist/bench-cli.js)
else echo "Needs Node 22 or the Docker install" >&2; exit 1; fi
curl -fsS "$OLLAMA/api/tags" >/dev/null || { echo "Ollama is not answering at $OLLAMA" >&2; exit 1; }
curl -fsS "$OLLAMA/api/tags" | grep -q "\"$MODEL\"" || { echo "pulling $MODEL"; curl -fsS "$OLLAMA/api/pull" -d "{\"name\":\"$MODEL\",\"stream\":false}" >/dev/null; }

VK=$(vulkaninfo --summary 2>/dev/null | sed -n 's/.*deviceName *= *//p' | grep -vi llvmpipe | head -1 || true)
echo "CPU: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-) | RAM: $(free -g | awk '/Mem:/{print $2}') GB | Vulkan: ${VK:-none}"
if [ -r /sys/class/drm/card0/device/mem_info_gtt_total ] || ls /sys/class/drm/card*/device/mem_info_gtt_total >/dev/null 2>&1; then
  for f in /sys/class/drm/card*/device/mem_info_gtt_total; do echo "GTT: $(( $(cat "$f") / 1073741824 )) GiB, VRAM carve-out: $(( $(cat "${f%gtt_total}vram_total") / 1073741824 )) GiB"; done
fi

GPU_BASE=""; TMP_PID=""
cleanup() { [ -n "$TMP_PID" ] && kill "$TMP_PID" 2>/dev/null || true; }
trap cleanup EXIT
if [ -n "$VK" ] && command -v ollama >/dev/null && ! systemctl show ollama -p Environment 2>/dev/null | grep -q OLLAMA_VULKAN=1 && [ "${OLLAMA_VULKAN:-}" != 1 ]; then
  MODELS_DIR="${OLLAMA_MODELS:-}"
  [ -z "$MODELS_DIR" ] && [ -d /usr/share/ollama/.ollama/models ] && MODELS_DIR=/usr/share/ollama/.ollama/models
  [ -z "$MODELS_DIR" ] && MODELS_DIR="$HOME/.ollama/models"
  echo "Starting a temporary Vulkan Ollama on :11499 (models from $MODELS_DIR)"
  RUNAS=(); [ -d /usr/share/ollama ] && [ "$MODELS_DIR" = /usr/share/ollama/.ollama/models ] && [ "$(id -un)" != ollama ] && RUNAS=(sudo -u ollama env)
  "${RUNAS[@]}" OLLAMA_HOST=127.0.0.1:11499 OLLAMA_MODELS="$MODELS_DIR" OLLAMA_VULKAN=1 OLLAMA_IGPU_ENABLE=1 GGML_VK_VISIBLE_DEVICES=0 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 ollama serve >/tmp/ollama-vulkan-bench.log 2>&1 &
  TMP_PID=$!
  for _ in $(seq 30); do curl -fsS http://127.0.0.1:11499/api/tags >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS http://127.0.0.1:11499/api/tags >/dev/null 2>&1 && GPU_BASE=http://127.0.0.1:11499 || echo "Vulkan Ollama did not start; see /tmp/ollama-vulkan-bench.log"
fi

export OLLAMA_HOST="$OLLAMA" LA_BENCH_GPU_BASE="$GPU_BASE"
REPORT=$("${RUN[@]}" "$MODEL")
cleanup; TMP_PID=""
mkdir -p "${DATA_DIR:-$PWD/data}"
echo "$REPORT" > "${DATA_DIR:-$PWD/data}/runtime-bench.json"
PICK=$(node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.pick);console.error(`\nPick: ${r.pick}\n${r.why}\n${r.untested.map(u=>"untested: "+u).join("\n")}`)' <<<"$REPORT")
echo "Saved to ${DATA_DIR:-$PWD/data}/runtime-bench.json (Setup shows it)."

if [ "$APPLY" = 1 ]; then
  case "$PICK" in
    ollama-vulkan) ENV="OLLAMA_VULKAN=1 OLLAMA_IGPU_ENABLE=1 GGML_VK_VISIBLE_DEVICES=0 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_MAX_LOADED_MODELS=2 OLLAMA_KEEP_ALIVE=15m" ;;
    ollama-cpu) ENV="OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_MAX_LOADED_MODELS=2 OLLAMA_KEEP_ALIVE=15m" ;;
    *) echo "Pick is $PICK: nothing to apply automatically (see docs/models.md)."; exit 0 ;;
  esac
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  { echo "[Service]"; for kv in $ENV; do echo "Environment=\"$kv\""; done; } | sudo tee /etc/systemd/system/ollama.service.d/local-agent.conf >/dev/null
  [ "$PICK" = ollama-vulkan ] && { getent group render >/dev/null && sudo usermod -aG render,video ollama || true; }
  sudo systemctl daemon-reload && sudo systemctl restart ollama
  echo "Applied $PICK to the Ollama service."
fi
