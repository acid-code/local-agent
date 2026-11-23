#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN_W="${SCREEN_WIDTH:-1280}"
SCREEN_H="${SCREEN_HEIGHT:-800}"
CDP_PORT="${CDP_PORT:-9222}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

mkdir -p /profiles/default /tmp/.X11-unix
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb "$DISPLAY" -screen 0 "${SCREEN_W}x${SCREEN_H}x24" -ac -nolisten tcp &
for _ in $(seq 1 25); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.2
done

fluxbox >/dev/null 2>&1 &

# VNC stays 127.0.0.1; websockify listens on the private container interface (zero host ports published).
x11vnc -display "$DISPLAY" -listen 127.0.0.1 -rfbport "$VNC_PORT" -nopw -forever -shared -quiet &

CHROME_BIN="$(find /ms-playwright -name chrome -type f 2>/dev/null | head -n 1 || command -v chromium || command -v google-chrome || true)"
if [ -n "$CHROME_BIN" ]; then
  "$CHROME_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir=/profiles/default \
    --window-size="${SCREEN_W},${SCREEN_H}" \
    about:blank >/dev/null 2>&1 &
fi

exec websockify --web=/usr/share/novnc "0.0.0.0:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}"
