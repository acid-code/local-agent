#!/usr/bin/env bash
# Safe zero-data-loss updater for an existing local-agent install (default /opt/local-agent).
# Always backs up DATA_DIR before syncing code or recreating containers.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${1:-/opt/local-agent}"

if [[ ! -d "$INSTALL_ROOT" ]]; then
  echo "Install root $INSTALL_ROOT does not exist. Run scripts/install-server.sh instead." >&2
  exit 1
fi

if [[ ! -f "$INSTALL_ROOT/data/local-agent.db" ]]; then
  echo "Refusing to update $INSTALL_ROOT: data/local-agent.db is missing." >&2
  echo "Check that you pointed at the right install directory (live install is /opt/local-agent)." >&2
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BACKUP="$INSTALL_ROOT/data/backups/pre-update-${STAMP}.tar"
mkdir -p "$INSTALL_ROOT/data/backups"
ITEMS=()
for f in local-agent.db local-agent.db-wal local-agent.db-shm master.key cookie.secret secrets.env workspaces; do
  [[ -e "$INSTALL_ROOT/data/$f" ]] && ITEMS+=("$f")
done
if [[ "$(id -u)" -eq 0 ]]; then
  tar -C "$INSTALL_ROOT/data" -cf "$BACKUP" "${ITEMS[@]}"
else
  # Container-created files like master.key may be owned by root:root (0600); archive via Docker if available.
  if tar -C "$INSTALL_ROOT/data" -cf "$BACKUP" "${ITEMS[@]}" 2>/dev/null; then
    :
  else
    rm -f "$BACKUP"
    docker run --rm -v "$INSTALL_ROOT/data:/data" debian:bookworm-slim \
      tar -C /data -cf "/data/backups/pre-update-${STAMP}.tar" "${ITEMS[@]}"
  fi
fi
echo "Backed up $INSTALL_ROOT/data -> $BACKUP"

if [[ "$SRC" != "$INSTALL_ROOT" ]]; then
  rsync -a --delete --exclude data --exclude node_modules --exclude .env --exclude .git "$SRC/" "$INSTALL_ROOT/"
  echo "Synced code from $SRC -> $INSTALL_ROOT"
fi

cd "$INSTALL_ROOT"
docker compose build
docker compose up -d --remove-orphans
echo "Updated and restarted $INSTALL_ROOT cleanly."
