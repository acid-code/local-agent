# RAM budget

local-agent keeps everything it runs under one hard RAM cap, **40 GB by default** (setup site → Defaults → "RAM budget"). The cap covers:

- every Ollama model it has loaded, including the KV cache for the context size,
- the sd.cpp image runner while it generates,
- the server process itself.

Owner and members share the same budget.

## How admission works

Jobs still run **concurrently**. Before a local model call or a local image starts, it asks the budget for room:

1. **Usage** is measured: Ollama `/api/ps` sizes + image runner RSS + server RSS. For each running job, the larger of the measured and the estimated value counts. A model used by several chats counts once.
2. If usage + the new job fits under the cap, and the machine also has that much free RAM (minus a 1.5 GB reserve), the job starts right away.
3. Otherwise idle models are unloaded first (`keep_alive: 0`, largest first; never a model a running job uses).
4. If it still doesn't fit, the job waits in a queue. The order is chat replies, then images, then scheduled/triggered runs, FIFO within each. Chat shows "Waiting for memory, N ahead".
5. A job that can never fit fails fast. A chat first retries with an 8k context, then switches to a smaller local model, then explains the problem.

## Estimates

- **Model:** (GGUF size + f16 KV cache for `num_ctx`) × 1.1 + 300 MB. Layer and head counts come from Ollama `/api/show`.
- **Image:** model files × 1.05 + working memory (1.2 GB per 512² for SD, 3 GB for FLUX) + 200 MB.
- **Calibration:** after each run, the estimate moves halfway toward what was really measured (Ollama size or the runner's peak RSS). Results are saved in `data/memory-calibration.json`.

Health, `npm run doctor` and `GET /api/memory/budget` (owner only) show the current usage.
