# Effectiveness eval (skeleton)

Runs small, real tasks against a local-agent server and scores how the agent used its tools:
tools used (or found with `find_tools`), arguments (`read_file` line ranges), reply patterns, model steps,
wall time, malformed tool arguments, and llama-server prompt-cache reuse (`cacheHitPct`).

```bash
# Check the fixtures (no network):
node scripts/eval/run.mjs --dry-run

# Run (owner API token; it is sent as a Bearer header and never printed):
LA_URL=http://127.0.0.1:8787 LA_TOKEN=la_xxx node scripts/eval/run.mjs
LA_URL=… LA_TOKEN=… node scripts/eval/run.mjs --task slides-by-slide
```

- Each task opens a **new chat** on the named persona (`House`, `Coder`, `Presenter`, `Researcher`); tasks
  whose persona does not exist are skipped. Runs that stop for an approval are scored as they stand.
- Results are written to `scripts/eval/results/<timestamp>.json` (git-ignored).
- Add a task: drop a JSON file in `tasks/` with `id`, `persona`, `prompt`, optional `mode: "code"`, and `expect`:
  `toolsUsed`, `toolsAnyOf`, `toolsNone`, `argsInclude {tool: [keys]}`, `replyMatches`, `replyNotMatches`
  (case-insensitive regex strings), `noMalformedArgs`, `maxSteps`, `maxSeconds`.
- Compare before/after a deploy by running the same set twice and diffing pass rate, steps, seconds and cache %.
