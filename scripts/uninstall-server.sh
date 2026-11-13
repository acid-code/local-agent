#!/usr/bin/env bash
# Remove the local-agent systemd service. Keeps /opt/local-agent unless --purge.
set -euo pipefail

DRY_RUN=0
PURGE=0
INSTALL_ROOT=/opt/local-agent
APP_USER=localagent

usage() {
  cat <<'EOF'
Usage: scripts/uninstall-server.sh [options]

  --dry-run     Print every command. Change nothing.
  --purge       Also delete the install directory, data, and the localagent user if it exists.
  --root PATH   Install location. Default: /opt/local-agent
  --user NAME   User to delete with --purge. Default: localagent
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
    --root) INSTALL_ROOT="${2:?}"; shift ;;
    --user) APP_USER="${2:?}"; shift ;;
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

if [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  echo "Re-run with sudo." >&2
  exit 1
fi

if [[ -d "$INSTALL_ROOT" || "$DRY_RUN" -eq 1 ]]; then
  run bash -lc "cd '$INSTALL_ROOT' && docker compose down || true"
fi
run systemctl disable --now local-agent || true
run rm -f /etc/systemd/system/local-agent.service
run systemctl daemon-reload

if [[ "$PURGE" -eq 1 ]]; then
  echo "Purging $INSTALL_ROOT and user $APP_USER"
  run rm -rf "$INSTALL_ROOT"
  if [[ "$DRY_RUN" -eq 1 ]] || id "$APP_USER" >/dev/null 2>&1; then
    run userdel --remove "$APP_USER" || true
  fi
else
  echo "Kept $INSTALL_ROOT (including data and secrets). Pass --purge to remove it."
fi
