# Shared workbench image for local-agent personas (node 22, python 3.12, uv, git, build tools).
# Build once on the host: docker build -t la-workbench:latest deploy/workbench
# Then set LA_WORKBENCH_IMAGE=la-workbench:latest (optional; stock node:22-bookworm also works and installs uv into a cache volume).
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     git curl ca-certificates build-essential python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    PIP_CACHE_DIR=/cache/pip \
    npm_config_cache=/cache/npm \
    UV_CACHE_DIR=/cache/uv \
    PYTHONDONTWRITEBYTECODE=1

RUN uv python install 3.12 \
  && ln -sf "$(uv python find 3.12)" /usr/local/bin/python3.12

WORKDIR /workspaces
CMD ["sleep", "infinity"]
