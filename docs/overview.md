# local-agent

A self-hosted agent platform for a Linux mini PC. You chat with it from a laptop on the LAN, or from a phone over Tailscale. It runs personas against local OpenAI-compatible servers (Ollama, llama.cpp, LM Studio, vLLM) and, when you allow it, Gemini or OpenRouter. The point of the product is that you can see every step and stop it.

## Why this stack

TypeScript, end to end.

- One language for the runtime and the UI, so a trace event, a tool call, and a chat message share types.
- Fastify streams tokens over server-sent events and a WebSocket without a second process.
- Node 22’s built-in `node:sqlite` stores sessions, checkpoints, and vectors. `sqlite-vec` is loaded when the extension is present; otherwise search is exact cosine over the same blobs.
- The MCP ecosystem’s reference client speaks JSON-RPC. So does this server. Python is a better fit for training loops. This box is a control plane.

React, Vite, and Tailwind sit in `packages/web`. The server serves the built files in production. Dev mode runs Vite on port 5173 and the API on 8787.

Day to day setup for the mini PC, the laptop, and the phone, including where API keys live, is in [SETUP.md](../SETUP.md).

## Run it

Docker, from this directory:

```bash
cp .env.example .env
docker compose up --build
```

Open `http://<the-mini-pc>:8787`. The first screen creates the owner account. Nothing else is reachable until that exists.

Without Docker, for development:

```bash
npm install
npm run dev
```

The API is `http://127.0.0.1:8787`. The UI is `http://127.0.0.1:5173`.

On the mini PC, `sudo bash scripts/install-server.sh --dry-run` prints every command, and the same script without `--dry-run` installs Docker, Compose, Mesa Vulkan for the Radeon 780M, the systemd unit, and the app. `--with-ollama` and `--with-tailscale` are optional. `scripts/uninstall-server.sh` removes the unit and keeps the data unless you pass `--purge`. The Windows laptop script is `scripts/setup-client.ps1`. The phone app is the Capacitor shell in `apps/mobile`. The Windows shell is `apps/desktop`. A laptop-sized WSL2 path, with one small Ollama model, is in [docs/wsl-quickstart.md](wsl-quickstart.md). Details, including the Android signing secrets and the unsigned Windows exe, are in [SETUP.md](../SETUP.md).

```bash
sudo cp deploy/local-agent.service /etc/systemd/system/
sudo systemctl enable --now local-agent
```

`npm test` covers routing, context budgeting, the resumable loop, edit rollback, the vault, and MCP framing. `npm run typecheck` and `npm run build` are what CI runs.

## What you can do in this version

- Finish the setup checklist. It probes Ollama, other OpenAI-compatible ports, Docker, the GPU, SearXNG, and Tailscale. One-click actions show the command, then run it only after you confirm.
- Create personas. Templates cover a house operator, a researcher, and a coder.
- Chat with streaming. Rehearsal, an on-box stand-in, calls tools so the loop is visible before a real model is loaded.
- Watch the trace: model calls, tool arguments, tool results, latency, token counts, and a cost estimate (local is zero).
- Pause, stop, resume, or retry from a checkpoint.
- Let personas consult each other in a room, one level deep.
- Run a coding session: a visible plan, grep and glob, search-and-replace edits with a checkpoint before the write, a diff, and revert. Git status, diff, branch, and commit stay in the workspace. Push asks. Host folders are mounted only after you grant them. If `cursor-agent`, `claude`, `aider`, or `codex` is on `PATH`, a handoff can use it after approval.
- Store credentials in the vault. A run that needs a key pauses, asks in a password field, and resumes. The model sees `secret:NAME`. Logs and traces are redacted. Reveal requires your password again. Every use is audited.
- Schedule a cron prompt per persona.
- Read RAM, disk, GPU/GTT when sysfs exposes it, and per-agent data size. Prune actions preview first.

## Remote access

Prefer Tailscale. Install it on the mini PC and on the phone or laptop. The UI is already bound to `0.0.0.0:8787`; Tailscale gives you a stable address without opening the port on your router. The owner login still applies.

Cloudflare Tunnel is the alternative when you cannot use Tailscale:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Do not port-forward 8787 to the public internet. Auth is single-user, not a substitute for a private network.

The phone UI is a PWA. Add it to the home screen. A native client can use the same HTTP API with a bearer token from Settings, plus `/api/live` (WebSocket) and `/api/runs/:id/events` (SSE).

## Secrets

API keys belong in `.env` or `data/secrets.env`. Neither is committed. The vault is separate: values are AES-256-GCM ciphertext in SQLite. The 32-byte master key is `data/master.key` with mode `0600`. Copying the database without that file does not reveal the secrets. The master key is still on the same disk; an OS keyring (`secret-tool`) is the next place to put it when a login session exists. Headless SSH usually does not have one, so the file is the default.

The model never receives a secret value. Tools that need one get it as an environment variable at execution time. Outputs are scrubbed before they are stored or shown back to the model. Pasting a key into chat is detected and offered a move into the vault.

## Models on this machine

The mini PC has 48 GB. A Qwen3.6 35B-A3B Q4 build is about 23 GB and Gemma 4 26B-A4B is in the high teens. Only one of those is loaded at a time. If the other is busy, the router steps aside and says so in one line. If it is idle, it can be unloaded first. The theoretical windows are 256K. The practical budget defaults to 32K because the KV cache, not the brochure, is what fits beside the weights.

Cloud routing follows the free-tier reading from 13 Nov 2026:

| Model | Free tier on this key | Role |
| --- | --- | --- |
| Gemini 3.5 Flash Lite | 15 RPM, 250K TPM, 500 RPD | Cloud fallback with the widest daily cap |
| Gemini 3.1 Flash Lite | 15 RPM, 250K TPM, 500 RPD | Alternate lite |
| Gemini 3.8 Flash | 5 RPM, 250K TPM, 20 RPD | Reserve. The reading showed 110.6K TPM that minute |
| Gemini 4 Hydrogen | 5 RPM, 250K TPM, 20 RPD | Hard reasoning |
| Gemini 4 Argon, Carbon | 0 / 0 / 0 | Not selected unless Settings says the key is paid |
| Gemini Embedding 2 | 100 RPM, 30K TPM, 1K RPD | Retrieval, with hash embeddings as the fallback |

Ordinary turns stay on the local model. Gemini is used only for a hard reasoning question, a synthesis that does not fit the local practical budget, or after two local failures. Per-model request caps default to the free-tier reading and can be changed in settings. A call that would pass the cap does not go out. The turn falls back to the local model, and the Models page shows what is left.

## Backups, watchdog, notices, voice

Snapshots land in `data/backups`. Each one has the database, the encrypted vault, `master.key`, and the persona workspaces. Settings can copy the file onward with rsync or rclone (including an S3-compatible target). Restore is one confirmation, then the process exits so it can start on the restored files.

The watchdog checks Ollama and restarts containers this app created when they have stopped. It does not try to reinstall Ollama.

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` and the bot long-polls. Approval requests arrive with Approve and Deny buttons. Failures, low memory, and an empty Gemini quota are messages. The same events can go out as web push after the browser subscribes.

Push-to-talk records in the browser and posts the audio to faster-whisper if that container is up. Kokoro does the reverse for speech. Both are optional:

```bash
docker compose --profile voice up -d whisper kokoro
```

The setup screen shows those commands before it runs them.

A kill switch stops current runs and refuses new ones. A daily token cap, a daily spend cap, and a read-only mode are in Settings. Read-only blocks tools that change files, shells, or containers.

A switch is announced once, in one line. Staying on the current model is silent, including a quiet fallback when Gemini is out of quota. Pin a persona to stop the router from moving.

## Layout

```
packages/shared   types, routing, context budgets, token estimates
packages/server   Fastify, SQLite, the run loop, tools, MCP, vault
packages/web      React UI
apps/mobile       Capacitor Android shell
apps/desktop      Electron Windows shell
deploy/           systemd unit
```

More detail is in `ARCHITECTURE.md`. What is real, what is partial, and what comes later is in `ROADMAP.md`.

## Remote monitoring

Read-only, token-protected run traces, errors and health over Tailscale: see [docs/monitoring.md](monitoring.md).

## Models for your machine

Per-role defaults, the Ryzen 780M mini PC guide, the installer and the runtime bench: see [docs/models.md](models.md).
