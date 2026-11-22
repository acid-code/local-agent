#!/usr/bin/env bash
# Install (or refresh) the custom llama-server (exp-coalesced-dflash: ROCm HIP + DFlash2 +
# gf_res_prev[10] HIP graph cache) into /opt/llama-server under systemd.
#
#   sudo bash deploy/install-llama-server.sh [--keep-config] [--no-firewall] [build_bin_dir] [models_dir]
#
# Re-run any time after rebuilding llama.cpp-APU-upgrade. It:
#   1. copies the build into /opt/llama-server/bin and links the GGUFs into /opt/llama-server/models
#   2. writes /etc/default/llama-server with the verified Part B flags (old file kept as .bak.<time>)
#   3. caps Ollama to 1 resident model / 5m keep-alive so both servers fit in GTT
#   4. opens 8080/tcp to Docker bridges only (UFW) and blocks it on LAN + Tailscale
#   5. installs llama-server.service with a memory guard, then starts it
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-run with sudo: sudo bash deploy/install-llama-server.sh [--keep-config] [--no-firewall] [build_bin_dir] [models_dir]" >&2
  exit 1
fi

KEEP_CONFIG=0
FIREWALL=1
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --keep-config) KEEP_CONFIG=1 ;;
    --no-firewall) FIREWALL=0 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

APP_USER="${SUDO_USER:-acid}"
TARGET="/opt/llama-server"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APU_ROOT="/home/$APP_USER/projects/llama.cpp-APU-upgrade"
PORT="${LLAMA_PORT:-8080}"
DOCKER_NETS="${LLAMA_DOCKER_NETS:-172.16.0.0/12}"
DENY_IFACES="${LLAMA_DENY_IFACES:-}"
if [[ -z "$DENY_IFACES" ]]; then
  # The default-route interface(s) (eno1 here) plus Tailscale.
  DENY_IFACES="$(ip -o route show default 2>/dev/null | awk '{print $5}' | sort -u | tr '\n' ' ')tailscale0"
fi

# ---------- 1. binaries + models ----------
BUILD_SRC="${POSITIONAL[0]:-}"
if [[ -z "$BUILD_SRC" ]]; then
  for cand in \
    "$APU_ROOT/build-dspine-v2/bin" \
    /tmp/llama-apu-bench-builds/dspine-v2-custom/bin \
    /tmp/llama.cpp/build/bin \
    /tmp/build-dspine-v2/bin; do
    if [[ -x "$cand/llama-server" ]]; then BUILD_SRC="$cand"; break; fi
  done
fi
if [[ -z "$BUILD_SRC" || ! -x "$BUILD_SRC/llama-server" ]]; then
  echo "Could not find llama-server binary. Pass the build bin directory as the first argument." >&2
  exit 1
fi
if [[ -d "$APU_ROOT/.git" ]]; then
  branch="$(sudo -u "$APP_USER" git -C "$APU_ROOT" branch --show-current 2>/dev/null || true)"
  echo "llama.cpp-APU-upgrade branch: ${branch:-unknown}"
fi

MODEL_SRC="${POSITIONAL[1]:-}"
if [[ -z "$MODEL_SRC" ]]; then
  for cand in "$APU_ROOT/models" /tmp/models; do
    if [[ -d "$cand" ]]; then MODEL_SRC="$cand"; break; fi
  done
fi

# A running binary cannot be overwritten (ETXTBSY), so stop first.
systemctl stop llama-server 2>/dev/null || true
systemctl stop llama-uncensored 2>/dev/null || true

mkdir -p "$TARGET/bin" "$TARGET/models"
echo "Installing llama-server binaries and libs from $BUILD_SRC -> $TARGET/bin"
cp -a "$BUILD_SRC"/. "$TARGET/bin/"
mkdir -p "$TARGET/uncensored-bin"
if [[ -d "$REPO_ROOT/deploy/llama-inkling-bin" && -x "$REPO_ROOT/deploy/llama-inkling-bin/llama-server" ]]; then
  echo "Installing packaged uncensored llama-server binaries and libs"
  cp -a "$REPO_ROOT/deploy/llama-inkling-bin"/. "$TARGET/uncensored-bin/"
fi

if [[ -n "$MODEL_SRC" && -d "$MODEL_SRC" ]]; then
  echo "Linking GGUF models from $MODEL_SRC -> $TARGET/models"
  for gguf in "$MODEL_SRC"/*.gguf; do
    [[ -f "$gguf" ]] || continue
    base="$(basename "$gguf")"
    [[ "$base" == ggml-vocab-* ]] && continue
    ln -sfn "$gguf" "$TARGET/models/$base"
  done
fi

# Inkling fallback assets are external GGUFs; link them into /opt when present.
for src in \
  "$MODEL_SRC/Inkling-2-Mini-Uncensored-AD-Q4_K.gguf" \
  "$MODEL_SRC/mmproj-Inkling-2-Mini-Uncensored-F16.gguf" \
  "$MODEL_SRC/dspark-Inkling-2-Mini-Q8_0.gguf" \
  "$APU_ROOT/models/Inkling-2-Mini-Uncensored-AD-Q4_K.gguf" \
  "$APU_ROOT/models/mmproj-Inkling-2-Mini-Uncensored-F16.gguf" \
  "$APU_ROOT/models/dspark-Inkling-2-Mini-Q8_0.gguf"; do
  [[ -f "$src" ]] || continue
  ln -sfn "$src" "$TARGET/models/$(basename "$src")"
done

install -m 0755 "$REPO_ROOT/deploy/llama-server-run.sh" "$TARGET/run.sh"
install -m 0755 "$REPO_ROOT/deploy/llama-uncensored-run.sh" "$TARGET/uncensored-run.sh"
install -m 0755 "$REPO_ROOT/deploy/llama-fallback-control.py" "$TARGET/fallback-control.py"
install -m 0755 "$REPO_ROOT/deploy/llama-server-guard.sh" "$TARGET/guard.sh"
install -m 0755 "$REPO_ROOT/deploy/llama-server-netguard.sh" "$TARGET/netguard.sh"
chown -R "$APP_USER:$APP_USER" "$TARGET"
# netguard runs as root: keep it root-owned so the app user cannot change what root executes.
chown root:root "$TARGET/netguard.sh"

# ---------- 2. /etc/default/llama-server ----------
DEFAULT_MODEL=""
for m in "$TARGET/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" "$TARGET/models/gpt-oss-20b-Q4_K_M.gguf"; do
  if [[ -e "$m" ]]; then DEFAULT_MODEL="$m"; break; fi
done
DRAFT_MODEL=""
ALIAS="gpt-oss-20b"
if [[ "$DEFAULT_MODEL" == *Qwen3.6-35B-A3B* ]]; then
  ALIAS="qwen3.6-35b-a3b"
  [[ -e "$TARGET/models/qwen36-35b-a3b-dflash-Q8_0.gguf" ]] && DRAFT_MODEL="$TARGET/models/qwen36-35b-a3b-dflash-Q8_0.gguf"
fi

CONF=/etc/default/llama-server
if [[ -f "$CONF" && "$KEEP_CONFIG" -eq 1 ]]; then
  echo "Keeping existing $CONF (--keep-config)"
else
  [[ -f "$CONF" ]] && cp -a "$CONF" "$CONF.bak.$(date +%Y%m%d-%H%M%S)"
  cat > "$CONF" <<EOF
# llama-server settings (read by /opt/llama-server/run.sh). Re-run install-llama-server.sh to regenerate.
# Verified Part B flags for Qwen3.6-35B-A3B + DFlash2 on Radeon 780M (gfx1103), exp-coalesced-dflash.

# 0.0.0.0 so Docker containers reach it at host.docker.internal:${PORT}.
# UFW + netguard.sh block it on LAN (eno1) and Tailscale; 127.0.0.1 and Docker bridges stay open.
LLAMA_HOST=0.0.0.0
LLAMA_PORT=${PORT}
LLAMA_DENY_IFACES="${DENY_IFACES}"

LLAMA_MODEL=${DEFAULT_MODEL:-$TARGET/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf}
LLAMA_ALIAS=${ALIAS}

# DFlash2 draft. block_size = 8 in this GGUF, so n_max 7 is the real ceiling (12/16 were clamped).
# p_min 0.55 + the gf_res_prev[10] graph cache: 33.2 -> 37.3 tok/s sustained, lossless.
LLAMA_DRAFT_MODEL=${DRAFT_MODEL}
LLAMA_DRAFT_N_MAX=7
LLAMA_DRAFT_N_MIN=1
LLAMA_DRAFT_P_MIN=0.55

# Only 10/40 layers use KV (Gated DeltaNet) and DFlash2 has a fixed 2048 window:
# Native f16 KV at 32K is only ~640 MiB and avoids per-step dequant / launch_fattn<256,4,8> faults on RDNA3.
LLAMA_CTX=32768
LLAMA_CACHE_K=
LLAMA_CACHE_V=
LLAMA_UBATCH=64
LLAMA_BATCH=512
LLAMA_THREADS=12

# Memory guard (guard.sh): refuse to start below this MemAvailable / above this GTT already in use.
LLAMA_GUARD_MIN_AVAIL_GB=26
LLAMA_GUARD_MAX_GTT_GB=14

# Optional: run straight from the build dir instead of the /opt copy, or pass extra flags.
#LLAMA_BIN=$APU_ROOT/build-dspine-v2/bin/llama-server
#LLAMA_EXTRA_ARGS=
EOF
  echo "Wrote $CONF"
fi

# ---------- 3. Ollama coexistence ----------
if systemctl list-unit-files ollama.service >/dev/null 2>&1 && systemctl cat ollama >/dev/null 2>&1; then
  OD=/etc/systemd/system/ollama.service.d
  mkdir -p "$OD"
  # Other drop-ins sort after limits.conf and would win, so the limits live only here.
  for f in "$OD"/*.conf; do
    [[ -f "$f" && "$(basename "$f")" != limits.conf ]] || continue
    sed -i '/OLLAMA_MAX_LOADED_MODELS=/d; /OLLAMA_KEEP_ALIVE=/d' "$f"
  done
  cat > "$OD/limits.conf" <<'EOF'
# Written by local-agent deploy/install-llama-server.sh.
# llama-server pins ~22.5 GiB GTT; two big Ollama models on top froze the host (TTM OOM).
[Service]
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_KEEP_ALIVE=5m"
EOF
  systemctl daemon-reload
  # Restarting unloads any big model Ollama holds, so the memory guard passes.
  systemctl try-restart ollama || true
  echo "Ollama capped: OLLAMA_MAX_LOADED_MODELS=1, OLLAMA_KEEP_ALIVE=5m ($OD/limits.conf)"
fi

# ---------- 4. Firewall ----------
if [[ "$FIREWALL" -eq 1 ]]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for net in $DOCKER_NETS; do
      ufw allow from "$net" to any port "$PORT" proto tcp comment 'llama-server from Docker'
      ufw allow from "$net" to any port 8081 proto tcp comment 'uncensored llama-server from Docker'
      ufw allow from "$net" to any port 8082 proto tcp comment 'llama fallback control from Docker'
    done
    for ifc in $DENY_IFACES; do
      ip link show "$ifc" >/dev/null 2>&1 || continue
      ufw insert 1 deny in on "$ifc" to any port "$PORT" proto tcp comment "block llama-server on $ifc" 2>/dev/null \
        || ufw deny in on "$ifc" to any port "$PORT" proto tcp comment "block llama-server on $ifc"
    done
    echo "UFW: $PORT/tcp allowed from $DOCKER_NETS, denied on: $DENY_IFACES"
  else
    echo "WARNING: ufw is not active. netguard.sh still drops $PORT on: $DENY_IFACES" >&2
  fi
fi

# ---------- 5. systemd ----------
sed "s/^User=.*/User=$APP_USER/; s/^Group=.*/Group=$APP_USER/" \
  "$REPO_ROOT/deploy/llama-server.service" > /etc/systemd/system/llama-server.service
sed "s/^User=.*/User=$APP_USER/; s/^Group=.*/Group=$APP_USER/" \
  "$REPO_ROOT/deploy/llama-uncensored.service" > /etc/systemd/system/llama-uncensored.service
install -m 0644 "$REPO_ROOT/deploy/llama-fallback-control.service" /etc/systemd/system/llama-fallback-control.service
getent group render >/dev/null && usermod -aG render,video "$APP_USER" || true
systemctl daemon-reload
systemctl enable llama-server
systemctl restart llama-server
systemctl enable llama-fallback-control
systemctl restart llama-fallback-control

echo "Waiting for llama-server to load the model..."
ok=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [[ "$ok" -eq 1 ]]; then
  echo "llama-server is up: http://127.0.0.1:$PORT/v1 (Docker: http://host.docker.internal:$PORT/v1)"
  curl -fsS "http://127.0.0.1:$PORT/v1/models" || true; echo
else
  echo "llama-server did not answer yet. Check: journalctl -u llama-server -n 50" >&2
fi

UNCENSORED_MODEL="$TARGET/models/Inkling-2-Mini-Uncensored-AD-Q4_K.gguf"
UNCENSORED_MMPROJ="$TARGET/models/mmproj-Inkling-2-Mini-Uncensored-F16.gguf"
UNCENSORED_DRAFT="$TARGET/models/dspark-Inkling-2-Mini-Q8_0.gguf"
if [[ -f "$UNCENSORED_MODEL" && -x "$TARGET/uncensored-bin/llama-server" ]]; then
  cat > /etc/default/llama-uncensored <<EOF
# Automatic uncensored fallback for local-agent (llama-server on 8081).
LLAMA_UNCENSORED_HOST=0.0.0.0
LLAMA_UNCENSORED_PORT=8081
LLAMA_UNCENSORED_BIN=$TARGET/uncensored-bin/llama-server
LLAMA_UNCENSORED_MODEL=$UNCENSORED_MODEL
LLAMA_UNCENSORED_MMPROJ=$UNCENSORED_MMPROJ
LLAMA_UNCENSORED_DRAFT_MODEL=$UNCENSORED_DRAFT
LLAMA_UNCENSORED_DRAFT_N_MAX=1
LLAMA_UNCENSORED_DRAFT_N_MIN=1
LLAMA_UNCENSORED_DRAFT_P_MIN=0.00
LLAMA_UNCENSORED_CTX=32768
LLAMA_UNCENSORED_UBATCH=64
LLAMA_UNCENSORED_BATCH=512
LLAMA_UNCENSORED_THREADS=12
LLAMA_UNCENSORED_ALIAS=inkling-2-mini-uncensored
EOF
  systemctl daemon-reload
  systemctl disable llama-uncensored 2>/dev/null || true
  systemctl stop llama-uncensored 2>/dev/null || true
  echo "Uncensored llama-server is installed but inactive; local-agent starts it only after a Qwen refusal."
else
  echo "Uncensored fallback not installed: add the Inkling GGUF/MMProj/draft files to $TARGET/models." >&2
fi
echo "Config: $CONF | Logs: journalctl -u llama-server -f"
