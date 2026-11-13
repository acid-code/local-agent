# Roadmap

## In this version

These work end to end:

- OpenAI-compatible, Gemini, and OpenRouter providers, plus the on-box Rehearsal model so the loop runs before Ollama is installed.
- Personas, rooms, and one-level `consult_agent`.
- SQLite sessions, rolling and hierarchical summaries, pinned notes, and retrieval over hashed embeddings with `sqlite-vec` when the extension loads.
- Routing that stays on a local model unless the turn is hard reasoning, a synthesis past the local budget, or the local model has failed twice. Gemini RPM/RPD caps are enforced and configurable. The 13 Nov 2026 AI Studio reading is the default quota.
- Backups of the database, encrypted vault, and workspaces, with optional rsync/rclone/S3 copy and a one-click restore.
- A watchdog that restarts this app's containers, Telegram approve/deny, web push, and optional faster-whisper / Kokoro containers.
- Kill switch, daily token and spend caps, and read-only mode.
- Checkpoints, leases, heartbeats, resume, and retry-from-checkpoint. Mutating tools interrupted mid-flight are not repeated automatically.
- Shell (Docker sandbox when the socket exists, otherwise a workspace jail), files, SearXNG search, fetch, Docker list/inspect/run/remove, and memory tools.
- MCP import, registry browse, vetting, and a container spec for stdio servers.
- Coding mode: editable plan, grep, glob, patch with a pre-image checkpoint and diff, git (including pull and push, both approved), folder grants, and an optional CLI handoff.
- Workshops: one coding chat over several project folders, with the project named on git, shell, and edits, and routing toward a model that can code.
- Vault: encrypted secrets, mid-run prompt, handles only for the model, redaction, reveal-with-password, rotate, revoke, audit.
- Setup checklist with preview-then-run actions, including a pull of `nomic-embed-text`, resource page with previewed prune, cron schedules, single-user login, API tokens, PWA shell.
- Persona faces: a name, title, emoji, accent color, initials or a built-in face or an uploaded image stored on the box. The sidebar can pin, hide, and reorder them. Agent-to-agent messages wear the sender's face and color.
- Versioned persona contracts in `personas/<slug>/contract.json` for the house operator, coder, planner, researcher, voice, Auto router, and trigger runs. Tool calls are checked against those contracts, repaired once, then failed in the timeline. `npm run eval:local` runs the planner sample on Ollama when it is up.
- Knowledge base: drop files or a folder, structure-aware chunks with overlap, Ollama embeddings (`nomic-embed-text`, hash if Ollama is down), sqlite-vec plus BM25, per-agent or shared collections, re-index when the bytes change, size on the resource page, and a `kb_search` tool that cites sources.
- Skills: `skills/<slug>/SKILL.md` with a name and a when-to-use description, optional scripts and assets, a shared catalog, per-agent enable, version history, and import/export. A persona loads a skill with `load_skill` when the description fits.
- Triggers: a secret-protected webhook, a signature-checked GitHub webhook, a debounced folder watch, and a read-only IMAP poll whose password comes from the vault. Each one starts a normal checkpointed run. The page shows status, recent events, and a test fire.
- Tests for the loop, routing, context, discovery parsers, MCP framing, coding rollback, the vault, chunking, hybrid search, skills, and triggers. CI runs test, typecheck, and build.

## Partial, on purpose

- **Tokenizers.** Counts are family-calibrated estimates. Gemini `countTokens` is used near the budget when a key exists. Official Gemma 4 and Qwen tokenizers are not shipped.
- **Hierarchical summaries** are two levels (chunk, then root), not an arbitrary tree.
- **Embeddings.** Hash embeddings always work. Gemini Embedding 2 is selected when its free-tier cap is open; a failed call falls back to the hash. `sqlite-vec` is used for the 256-dimension hash index when `vec0` loads.
- **MCP vetting** inspects registry metadata, install scripts, and OSV. It does not clone the repo and read every file. The optional model review runs only when you wire a reviewer; v1 records that it was skipped.
- **MCP runtime** attaches stdio to a container. Streamable HTTP session resume is not implemented. Remote HTTP servers are vetted and called, not containerized.
- **Pause** waits at a step boundary. Stop aborts the in-flight request.
- **Retry from an old checkpoint** archives later messages and continues. It does not roll back files or containers. Edit batches have their own revert.
- **Vision.** Routing notices images and image URLs. There is no upload widget; pass an image URL.
- **Free-tier usage.** Limits are stored. Minute-window usage from the screenshot expires after 90 seconds. Requests this app makes are counted locally. AI Studio remains the source of truth for the rest of the project. Settings can mark the key as paid.
- **External coding CLIs** run only if the binary is on `PATH`, and only after approval.
- **Cloudflare Tunnel** is documented, not provisioned. Tailscale is detected, not installed.
- **Ollama itself** is not installed by the checklist (that depends on the distro). Pulling a model is one click once Ollama answers.
- **GPU.** Detection reads sysfs, `/dev/dri`, and notes when a container cannot see the device. It does not tune llama.cpp or Vulkan.
- **Master key** is a `0600` file. OS keyring storage is the upgrade when `secret-tool` has a session. age/libsodium is equivalent cryptography; this build uses Node's AES-256-GCM so there is no native crypto dependency.

## Designed, not built

Evals still have a type stub in `packages/server/src/stubs.ts` and no runtime.

- **Evals.** Save a task and the trace you liked, rerun it after a model or prompt change, and diff the new trace. The trace store is the fixture format. The runner is not.

## Later

- A richer Android client than the Capacitor shell (offline transcript, a share sheet that edits before send).
- Multi-user accounts and SSO.
- OS keyring or age for the vault master key, and per-container secret mounts that are not also process env.
- Full streamable-HTTP MCP, including elicitation.
- Branching run timelines, not only retry-from-checkpoint.
- Official tokenizer files. The knowledge base already embeds with `nomic-embed-text` when Ollama has it.
- Image upload and vision bytes through to Gemma 4 and Qwen3.6.
- Deeper coding tools: multi-file unified diffs, test watchers, and a review queue that can block the next step until you accept the diff.
- Voice, and a hook a video pipeline can drive without scraping the chat UI.
- Resource trends that survive months, and cgroup-accurate stats when the app itself runs in Docker.
- Self-hosted fonts so the UI does not ask Google Fonts on first paint.
