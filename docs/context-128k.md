# 128K context on llama-server (prepared, not applied)

Status: **not applied.** It needs sudo on the mini PC and a benchmark before it stays on.

## What changes
- llama-server: `LLAMA_CTX=32768` becomes `131072` in `/etc/default/llama-server`. Example values:
  `deploy/llama-server-128k.env.example`.
- The app needs no code change. Discovery reads `n_ctx` from llama-server's `/props` and sets Qwen's
  `contextWindow` and `practicalBudget` to it. Budgets per role (`roleContextBudget`):
  - **coder on a repo task:** up to 128K (64K target, 128K for extended runs), capped by the window.
  - **main/chat:** stays at 32K, so chat turns don't get slower.
  - **fast/voice/small models:** stay at 16K.
- Memory: only 10/40 layers keep KV, so f16 KV goes from about 0.6 GiB to about 2.5 GiB. DFlash2's draft window
  stays fixed at 2048.
- The run-aware context from PR 1 (whole run kept, append-only, digests) is what makes 128K useful. Long coding
  runs stop losing early file reads, and the prompt cache keeps prefill cheap after the first step.

## Apply (Asaf, on the mini PC)
```bash
sudo cp /etc/default/llama-server /etc/default/llama-server.bak-$(date +%F)
sudo sed -i 's/^LLAMA_CTX=.*/LLAMA_CTX=131072/' /etc/default/llama-server
# optional guard headroom (see the example file):
sudo sed -i 's/^LLAMA_GUARD_MIN_AVAIL_GB=.*/LLAMA_GUARD_MIN_AVAIL_GB=28/; s/^LLAMA_GUARD_MAX_GTT_GB=.*/LLAMA_GUARD_MAX_GTT_GB=12/' /etc/default/llama-server
sudo systemctl restart llama-server
journalctl -u llama-server -n 50 --no-pager | grep -Ei 'n_ctx|error|fault|oom'
curl -s http://127.0.0.1:8080/props | jq '.default_generation_settings.n_ctx'   # expect 131072
```
Then refresh models in the app (Setup → Models → Refresh, or restart local-agent). Qwen should show a
131072-token window.

## Benchmark before keeping it
1. **Decode speed at short context** must not regress (it was about 37 tok/s with DFlash2):
   `curl -s localhost:8080/completion -d '{"prompt":"Hello","n_predict":256}' | jq '.timings.predicted_per_second'`
2. **Prefill at long context:** send a 60K-token and a 120K-token prompt and record `timings.prompt_per_second` and the
   total time. Also check that the second request with the same prefix shows `cache_n` close to the prompt size
   (the prompt cache works).
3. **Stability:** run one long coding task, for example `npm run eval -- --task read-range` plus a real multi-file
   change. Watch `journalctl -u llama-server -f` for MES watchdog resets or `launch_fattn` faults, and
   `cat /sys/class/drm/card*/device/mem_info_gtt_used`.
4. **App view:** the monitor run trace should show `perf.cacheHitPct` and `perf.promptEvalMs` per step.

Keep it if decode is unchanged, there are no faults, and a 120K prefill finishes in a time you accept.
Otherwise try `LLAMA_CTX=65536` first.

## Roll back
```bash
sudo cp /etc/default/llama-server.bak-YYYY-MM-DD /etc/default/llama-server && sudo systemctl restart llama-server
```
