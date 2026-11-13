#!/usr/bin/env bash
# Idempotent installer for the local-agent mini PC (Ubuntu/Debian).
# Re-run it any time. Use --dry-run to print every command and change nothing.
set -euo pipefail

DRY_RUN=0
MODE=docker
WITH_OLLAMA=0
WITH_TAILSCALE=0
APP_USER="${SUDO_USER:-${USER:-localagent}}"
INSTALL_ROOT=/opt/local-agent
PORT=8787

usage() {
  cat <<'EOF'
Usage: scripts/install-server.sh [options]

  --dry-run           Print every command. Change nothing.
  --native            Install Node 22 and run the app directly (no app container).
  --user NAME         Linux account that owns the app. Default: the invoking user.
                      The account is created if it does not exist.
  --with-ollama       Install Ollama if it is missing.
  --with-tailscale    Install Tailscale if it is missing.
  --root PATH         Install location. Default: /opt/local-agent
  -h, --help

Vulkan/Mesa (for the Radeon 780M), Docker, the Compose plugin, and git are always checked.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --native) MODE=native ;;
    --with-ollama) WITH_OLLAMA=1 ;;
    --with-tailscale) WITH_TAILSCALE=1 ;;
    --user) APP_USER="${2:?}"; shift ;;
    --root) INSTALL_ROOT="${2:?}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

need_root() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Re-run with sudo so packages and systemd can be installed." >&2
    exit 1
  fi
}

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  echo "This installer supports Ubuntu and Debian first. /etc/os-release is missing." >&2
  exit 1
fi
case "${ID:-}" in
  ubuntu|debian) ;;
  *) echo "This installer supports Ubuntu and Debian first (found ${ID:-unknown})." >&2; exit 1 ;;
esac

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
need_root

echo "local-agent server install"
echo "  mode: $MODE"
echo "  user: $APP_USER"
echo "  root: $INSTALL_ROOT"
echo "  dry-run: $DRY_RUN"

export DEBIAN_FRONTEND=noninteractive

if ! command -v git >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y git ca-certificates curl rsync openssl
fi

if ! command -v docker >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y ca-certificates curl
  run bash -lc 'curl -fsSL https://get.docker.com | sh'
fi
if ! docker compose version >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y docker-compose-plugin
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  run useradd --create-home --shell /bin/bash "$APP_USER"
fi
IN_DOCKER=0
if id "$APP_USER" >/dev/null 2>&1 && id -nG "$APP_USER" | tr ' ' '\n' | grep -qx docker; then
  IN_DOCKER=1
fi
if [[ "$IN_DOCKER" -eq 0 ]]; then
  run usermod -aG docker "$APP_USER"
fi

# Radeon 780M uses the amdgpu driver and Mesa's Vulkan ICD (RADV).
if ! dpkg -s mesa-vulkan-drivers >/dev/null 2>&1; then
  run apt-get update
  run apt-get install -y mesa-vulkan-drivers mesa-utils libvulkan1
fi
if [[ -d /dev/dri ]]; then
  echo "DRM render node is present (/dev/dri)."
else
  echo "No /dev/dri yet. After install, confirm the 780M with: lspci | grep -i vga"
fi

if [[ "$WITH_OLLAMA" -eq 1 ]] && ! command -v ollama >/dev/null 2>&1; then
  run bash -lc 'curl -fsSL https://ollama.com/install.sh | sh'
fi
if [[ "$WITH_TAILSCALE" -eq 1 ]] && ! command -v tailscale >/dev/null 2>&1; then
  run bash -lc 'curl -fsSL https://tailscale.com/install.sh | sh'
  echo "After install, run: tailscale up"
fi

if [[ "$MODE" == "native" ]] && ! command -v node >/dev/null 2>&1; then
  run bash -lc 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  run apt-get install -y nodejs
fi

run mkdir -p "$INSTALL_ROOT"
if [[ "$SRC" != "$INSTALL_ROOT" ]]; then
  run mkdir -p "$INSTALL_ROOT/data" "$INSTALL_ROOT/data/workspaces" "$INSTALL_ROOT/data/backups"
  run rsync -a --delete --exclude data --exclude node_modules --exclude .env "$SRC/" "$INSTALL_ROOT/"
fi
run chown -R "$APP_USER:$APP_USER" "$INSTALL_ROOT"

ENV_FILE="$INSTALL_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  SECRET="$(openssl rand -hex 32)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "+ write $ENV_FILE with LA_HOST, LA_PORT, DATA_DIR, and a generated LA_COOKIE_SECRET"
  else
    umask 077
    cat > "$ENV_FILE" <<EOF
LA_HOST=0.0.0.0
LA_PORT=$PORT
DATA_DIR=$INSTALL_ROOT/data
LA_COOKIE_SECRET=$SECRET
OLLAMA_CONTEXT_LENGTH=32768
EOF
    chown "$APP_USER:$APP_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
else
  echo "Keeping existing $ENV_FILE"
  if ! grep -q '^OLLAMA_CONTEXT_LENGTH=' "$ENV_FILE"; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "+ append OLLAMA_CONTEXT_LENGTH=32768 to $ENV_FILE"
    else
      echo 'OLLAMA_CONTEXT_LENGTH=32768' >> "$ENV_FILE"
    fi
  fi
fi

# Fallback when a request does not pass num_ctx. The app still sends num_ctx per call.
if command -v ollama >/dev/null 2>&1 || [[ "$WITH_OLLAMA" -eq 1 ]]; then
  DROP_IN=/etc/systemd/system/ollama.service.d/context.conf
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "+ write $DROP_IN with OLLAMA_CONTEXT_LENGTH=32768 and restart ollama"
  else
    mkdir -p /etc/systemd/system/ollama.service.d
    cat > "$DROP_IN" <<'EOF'
[Service]
Environment=OLLAMA_CONTEXT_LENGTH=32768
EOF
    systemctl daemon-reload || true
    systemctl try-restart ollama || true
  fi
fi

UNIT_SRC="$INSTALL_ROOT/deploy/local-agent.service"
UNIT_DST=/etc/systemd/system/local-agent.service
if [[ "$MODE" == "docker" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "+ write $UNIT_DST (docker compose) for user $APP_USER"
  else
    cat > "$UNIT_DST" <<EOF
[Unit]
Description=local-agent personal agent platform
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_ROOT
EnvironmentFile=-$ENV_FILE
ExecStart=/usr/bin/docker compose up --remove-orphans
ExecStop=/usr/bin/docker compose down
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  fi
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "+ write $UNIT_DST (node) for user $APP_USER"
  else
    cat > "$UNIT_DST" <<EOF
[Unit]
Description=local-agent personal agent platform
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_ROOT
Environment=NODE_ENV=production
Environment=DATA_DIR=$INSTALL_ROOT/data
Environment=LA_HOST=0.0.0.0
Environment=LA_PORT=$PORT
EnvironmentFile=-$ENV_FILE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $INSTALL_ROOT/packages/server/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  fi
fi

run systemctl daemon-reload
run systemctl enable local-agent

if [[ "$MODE" == "native" ]]; then
  run sudo -u "$APP_USER" bash -lc "cd '$INSTALL_ROOT' && npm install && npm run build"
else
  run sudo -u "$APP_USER" bash -lc "cd '$INSTALL_ROOT' && docker compose pull || true"
  run sudo -u "$APP_USER" bash -lc "cd '$INSTALL_ROOT' && docker compose build"
fi
TOKEN_FILE="$INSTALL_ROOT/data/setup.token"
USED_FILE="$INSTALL_ROOT/data/setup-token.used"
HASH_FILE="$INSTALL_ROOT/data/setup-token.sha256"
SETUP_TOKEN=""
if [[ ! -f "$USED_FILE" && ! -f "$HASH_FILE" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "+ write a one-time setup token to $TOKEN_FILE (mode 600) and print it"
  else
    SETUP_TOKEN="$(openssl rand -hex 16)"
    umask 077
    printf '%s' "$SETUP_TOKEN" > "$TOKEN_FILE"
    chown "$APP_USER:$APP_USER" "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
  fi
fi

run systemctl restart local-agent

LAN=""
LAN172=""
for ip in $(hostname -I 2>/dev/null); do
  case "$ip" in
    10.*|192.168.*) LAN="$ip"; break ;;
    172.17.*) ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) LAN172="${LAN172:-$ip}" ;;
  esac
done
LAN="${LAN:-$LAN172}"
TS=""
if command -v tailscale >/dev/null 2>&1; then
  TS="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi
echo
echo "LAN:       http://${LAN:-<this-host>}:$PORT"
if [[ -n "$TS" ]]; then
  echo "Tailscale: http://$TS:$PORT"
else
  echo "Tailscale: not up. Install with --with-tailscale, then run: tailscale up"
fi
echo "Setup (LAN only): http://${LAN:-<lan-ip>}:8788"
if [[ -n "$SETUP_TOKEN" ]]; then
  echo "Setup token (one time): $SETUP_TOKEN"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Setup token: a real run prints a one-time token, unless the owner account already exists."
else
  echo "Setup token: already issued. Sign in with the owner password."
fi
echo "The setup page answers only on private LAN addresses. Tailscale and public addresses are refused."
echo "First visit on the LAN setup page creates the owner account. Do not forward port $PORT or 8788 on the router."
