# End-to-end scenarios

CI runs the guards in `packages/server/test` against the rehearsal model and mocked collaborators. Rows marked **mini PC** need the real box, a phone, or a live network, and are not claimed as passing here.

| Scenario | Where it is checked |
| --- | --- |
| Installer run twice keeps `.env` | **mini PC.** `install-server.sh` refuses to overwrite an existing env file. Dry-run prints the commands. |
| No GPU or Vulkan | **mini PC.** The installer still installs. The checklist marks GPU optional. |
| Ollama down or empty | CI health check reports Ollama down and the app still boots on the rehearsal model. Pulling a model is a setup action on the box. |
| Disk too full to pull | CI doctor check warns under 5 GB free. The pull itself is **mini PC**. |
| Ports 8787 or 8788 busy | **mini PC.** The process logs `EADDRINUSE` and does not kill the other listener. |
| Docker missing or user not in the docker group | **mini PC.** Shell falls back to the workspace jail. MCP stays off. |
| Service restarts mid-install | **mini PC.** Run the installer again. It is idempotent. |
| Setup token expired, reused, or wrong | CI. A consumed token is rejected. `npm run reset-owner` issues a new one. |
| Two browsers, one token | The token is consumed on the first successful owner create. The second request is rejected. Race on the same millisecond is **mini PC**. |
| Tailscale, public IP, or spoofed X-Forwarded-For | CI LAN guard. The setup site ignores `X-Forwarded-For`. |
| Forgotten password | `npm run reset-owner` over SSH. Documented in SETUP.md. |
| Bad Gemini, OpenRouter, or Telegram key | The setup test button returns the provider status. A live bad key is **mini PC**. |
| Key changed | Docker does not see a new `secrets.env` until restart. The setup page says values stay on the box. A restart banner is **mini PC**. |
| Vault or master key missing or corrupt | A missing key file is created on first boot. A corrupt vault refuses to decrypt that secret rather than inventing a value. Full refusal-to-boot is **mini PC** if you replace `master.key` with garbage; do not delete it. |
| Laptop on LAN then Tailscale | Same origin, port 8787. The host changes. **mini PC**. |
| Phone wrong URL, APK offline, share of a huge file, mic denied | **mini PC** / the phone. The app stores the URL you type and polls approvals. |
| Cookie expires mid-chat | The next `/api` call returns 401 and the UI returns to login. |
| "fix the bug in my server repo" | CI Auto routing picks the coder role when a repo is in the text and the change is not a small typo. A registered repo plus a workshop is the path that attaches the project. |
| Plan across both projects, then approve, then code | The plan tool waits on an approval before `stage` becomes `implement`. Denying does not start coding. |
| Short thanks | A line under 24 characters stays on the fast role. |
| Gemini quota 0, 429, or 5xx | Quota exhaustion stays on the local model and says so. A provider 429/5xx during a live call is **mini PC**; the overflow path retries a smaller budget once, then a larger model. |
| Pinned model deleted | The pin is cleared and the routing note says the pinned model is gone. |
| Two failures, then drop back | CI `decideAuto`. The next ordinary turn is main again. |
| Rapid model thrash | A 45 second dwell keeps the current model unless the turn escalates, is pinned, or uses `/model`. |
| Two big models at once | The second run publishes `Waiting for <model>` and waits up to 20 seconds. |
| Model cannot call tools | The setup probe records it, later turns skip it, and the setup page warns. |
| Context: huge message, tool cap, smaller window, root cap, failed summary, trimmed skills, provider overflow, num_ctx | CI context tests and the Ollama `num_ctx` test. A 500-turn chat recalling turn 3 is the summary plus retrieval path; a full 500-turn soak is **mini PC**. |
| Hebrew or mixed text | CI. Estimates count Hebrew and Arabic as their own tokens. Excerpts keep the characters. |
| Dirty tree, merge conflict, branch behind, rejected push | CI explains a conflict and skips pull when the tree is dirty. A real non-fast-forward rejection is **mini PC**. Force-push asks. |
| Two writers, stale lock | CI. A lock older than 3 minutes can be taken. Crash cleanup releases locks for that run. |
| Patch fails, revert a revert | Edit batches have their own revert. A second revert of an already reverted edit is **mini PC**. |
| Secrets in a commit, gitignored file | The vault scanner flags known key shapes. A full `git` commit hook on a huge repo is **mini PC**. |
| Missing workshop repo | Registering a missing folder throws. |
| Approval with no answer | The run stays `awaiting_approval`. Nothing auto-approves. |
| MCP vetting or bad reputation | CI reputation tests block a known-bad verdict. A live container is **mini PC**. |
| Container OOM | **mini PC.** The watchdog restarts containers this app created. |
| MCP outside its grant | The container spec drops all capabilities and does not mount the host unless a grant says so. |
| Prune of an in-use volume | Prune previews first and waits for confirm. It does not delete Ollama model files. |
| Bad webhook secret, GitHub signature, folder burst, IMAP password, duplicate events | Signature and secret checks are in the hook routes. Folder events debounce. Duplicate delivery across a restart is **mini PC**. |
| Corrupt PDF, 200 MB file, missing embedder, reindex during search | Oversized and unreadable files fail that document and leave the rest. Hash embeddings run until `nomic-embed-text` is pulled. |
| Skill script timeout, bad avatar | Avatars over 512 KB or not an image are rejected in CI. A hung skill script timeout is **mini PC**. |
| Power loss, SQLite busy, restore, hung run, Telegram down, NTP jump | Telegram failures queue in `telegram-queue.json` and retry. Restore stages an archive and the process restarts onto it. A real power cut is **mini PC**. |
| Quota day | CI. The Gemini day is UTC, including when the mini PC is on Asia/Jerusalem time. |
| Fresh install through first chat, two-repo change, phone approval, lecture PDFs, scheduled research, new MCP URL | **mini PC.** The pieces those flows use (setup, workshops, plan approval, Telegram buttons, knowledge search, MCP vetting) are covered separately above. |
