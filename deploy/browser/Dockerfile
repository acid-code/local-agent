# Managed real browser container for local-agent (Playwright Chromium + Xvfb + x11vnc + noVNC).
# All services bind strictly to 127.0.0.1 inside the container (never exposed on host ports or Tailscale).
# Build once (~1.5 GB) after owner approval:
#   docker build -t la-browser:latest deploy/browser
FROM mcr.microsoft.com/playwright:v1.52.0-noble

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     xvfb x11vnc novnc websockify fluxbox \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g playwright@1.52.0

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    CDP_PORT=9222 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    NODE_PATH=/usr/lib/node_modules

VOLUME ["/profiles"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
