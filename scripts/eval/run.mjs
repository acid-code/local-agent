#!/usr/bin/env node
// Effectiveness eval: runs task fixtures against a local-agent server and scores tool use, replies, steps,
// time and prompt-cache reuse. Needs an owner API token (la_…) in LA_TOKEN; never printed.
//
//   node scripts/eval/run.mjs --dry-run                 validate fixtures only (no network)
//   LA_URL=http://127.0.0.1:8787 LA_TOKEN=la_… node scripts/eval/run.mjs [--task id] [--persona Name]
//
// Each task opens a new chat on the named persona, so it does not touch existing chats. Results go to
// scripts/eval/results/<timestamp>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };

export function loadTasks(dir = path.join(here, 'tasks')) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const problems = [];
    if (!task.id || typeof task.id !== 'string') problems.push('id');
    if (!task.persona || typeof task.persona !== 'string') problems.push('persona');
    if (!task.prompt || typeof task.prompt !== 'string') problems.push('prompt');
    if (!task.expect || typeof task.expect !== 'object') problems.push('expect');
    for (const key of ['replyMatches', 'replyNotMatches']) for (const re of task.expect?.[key] ?? []) { try { new RegExp(re, 'i'); } catch { problems.push(`${key}: ${re}`); } }
    if (problems.length) throw new Error(`${name}: missing or invalid ${problems.join(', ')}`);
    return task;
  });
}

/** Score one finished run: steps and final reply against the task's expectations. */
export function score(task, run, steps, reply) {
  const e = task.expect;
  const tools = steps.filter((step) => step.kind === 'tool');
  const used = new Set(tools.map((step) => step.name));
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  check('completed', run.status === 'completed', run.status);
  for (const name of e.toolsUsed ?? []) check(`used ${name}`, used.has(name));
  if (e.toolsAnyOf?.length) check(`used one of ${e.toolsAnyOf.join('/')}`, e.toolsAnyOf.some((name) => used.has(name)));
  if (e.toolsNone) check('no tools', tools.length === 0, [...used].join(','));
  for (const [name, keys] of Object.entries(e.argsInclude ?? {})) {
    check(`${name} args ${keys.join(',')}`, tools.some((step) => step.name === name && keys.every((key) => step.input && key in step.input)));
  }
  for (const re of e.replyMatches ?? []) check(`reply ~ /${re}/`, new RegExp(re, 'i').test(reply));
  for (const re of e.replyNotMatches ?? []) check(`reply !~ /${re}/`, !new RegExp(re, 'i').test(reply));
  if (e.noMalformedArgs) check('no malformed tool args', !steps.some((step) => step.kind === 'contract' && /invalid_tool_arguments|not valid JSON/.test(String(step.error ?? ''))));
  const modelSteps = steps.filter((step) => step.kind === 'model');
  if (e.maxSteps) check(`≤ ${e.maxSteps} model steps`, modelSteps.length <= e.maxSteps, String(modelSteps.length));
  const seconds = run.endedAt ? (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000 : null;
  if (e.maxSeconds) check(`≤ ${e.maxSeconds}s`, seconds !== null && seconds <= e.maxSeconds, String(seconds));
  const perf = modelSteps.map((step) => step.output?.telemetry).filter((t) => t && typeof t.promptTokens === 'number');
  const prompt = perf.reduce((sum, t) => sum + t.promptTokens, 0);
  const cached = perf.reduce((sum, t) => sum + (t.cachedTokens ?? 0), 0);
  return {
    id: task.id, passed: checks.every((item) => item.ok), checks, seconds, modelSteps: modelSteps.length, toolCalls: tools.length,
    tokens: { in: run.inputTokens, out: run.outputTokens }, cacheHitPct: prompt ? Math.round((cached / prompt) * 100) : null,
  };
}

async function main() {
  const tasks = loadTasks().filter((task) => (!option('task') || task.id === option('task')) && (!option('persona') || task.persona === option('persona')));
  if (flag('dry-run') || !process.env.LA_TOKEN) {
    console.log(`${tasks.length} task fixture(s) valid: ${tasks.map((task) => task.id).join(', ')}`);
    if (!flag('dry-run')) console.log('Set LA_TOKEN (owner la_ token) and LA_URL to run them.');
    return;
  }
  const base = (process.env.LA_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('Set LA_URL, e.g. http://127.0.0.1:8787 (explicit on purpose).');
  const headers = { authorization: `Bearer ${process.env.LA_TOKEN}`, 'content-type': 'application/json' };
  const api = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${method} ${url} → ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
  const { agents } = await api('GET', '/api/agents');
  const results = [];
  for (const task of tasks) {
    const agent = agents.find((item) => item.name.toLowerCase() === task.persona.toLowerCase());
    if (!agent) { results.push({ id: task.id, passed: false, skipped: `no persona named ${task.persona}` }); console.log(`- ${task.id}: skipped (no persona ${task.persona})`); continue; }
    const { session } = await api('POST', '/api/sessions', { agentId: agent.id, title: `eval: ${task.id}`, ...(task.mode ? { mode: task.mode } : {}) });
    const { run: started } = await api('POST', `/api/sessions/${session.id}/messages`, { content: task.prompt });
    const deadline = Date.now() + ((task.expect.maxSeconds ?? 300) + 60) * 1000;
    let detail;
    while (Date.now() < deadline) {
      detail = await api('GET', `/api/runs/${started.id}`);
      if (['completed', 'failed', 'stopped'].includes(detail.run.status)) break;
      if (detail.run.status === 'waiting_approval') break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    const { messages } = await api('GET', `/api/sessions/${session.id}/messages`);
    const reply = [...messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content ?? '';
    const result = score(task, detail.run, detail.steps, reply);
    results.push({ ...result, sessionId: session.id, runId: started.id });
    console.log(`${result.passed ? '✓' : '✗'} ${task.id}  ${result.modelSteps} steps, ${result.toolCalls} tools, ${result.seconds ?? '?'}s, cache ${result.cacheHitPct ?? '–'}%${result.passed ? '' : `  failed: ${result.checks.filter((item) => !item.ok).map((item) => item.name).join('; ')}`}`);
  }
  const outDir = path.join(here, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
  console.log(`${results.filter((item) => item.passed).length}/${results.length} passed. Results: ${path.relative(process.cwd(), file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
