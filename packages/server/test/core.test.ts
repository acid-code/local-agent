import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessCommand,
  cronMatches,
  decideRoute,
  foldCandidates,
  hashEmbed,
  isInside,
  nextCron,
  planContext,
  quotaAvailability,
  resolveInside,
  scoreRisk,
  topK,
  FREE_TIER_SNAPSHOT,
} from '@local-agent/shared';
import { applySearchReplace, lineDiff, replacePlan, revertBatch } from '../src/coding.js';
import { applyBackupArchive, createBackup } from '../src/ops.js';
import { encodeFrame, FrameParser, parseMcpConfig } from '../src/mcp.js';
import { mcpContainerSpec } from '../src/docker.js';
import { parseOllamaTags } from '../src/discovery.js';
import { ScriptedProvider } from '../src/providers.js';
import { findSecretCandidates } from '../src/vault.js';
import { buildApp } from '../src/app.js';
import { CrashError } from '../src/util.js';
import type { ToolCall } from '@local-agent/shared';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  dirs.push(dir);
  return dir;
}

const local = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, apiName: name, providerKind: 'openai_compat' as const, local: true, resident: false, enabled: true,
  sizeClass: 'large' as const, modalities: ['text', 'image'] as ('text' | 'image')[], strengths: ['chat', 'code', 'hard-reasoning', 'vision'] as ('chat' | 'code' | 'hard-reasoning' | 'vision')[],
  contextWindow: 262144, practicalBudget: 32768, typicalQ4GiB: 18, profileId: id, ...extra,
});

describe('routing and free tier', () => {
  const lite = { id: 'model_gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', apiName: 'gemini-3.5-flash-lite', providerKind: 'gemini' as const, local: false, resident: false, enabled: true, sizeClass: 'small' as const, modalities: ['text', 'image'] as ('text' | 'image')[], strengths: ['chat', 'code', 'research'] as ('chat' | 'code' | 'research')[], contextWindow: 1048576, practicalBudget: 65536, profileId: 'gemini-3.5-flash-lite', quotaOpen: true, rpdRemaining: 500 };
  const hydrogen = { ...lite, id: 'model_gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', apiName: 'gemini-4-hydrogen', strengths: ['hard-reasoning', 'code'] as ('hard-reasoning' | 'code')[], profileId: 'gemini-4-hydrogen', rpdRemaining: 20 };
  const argon = { ...hydrogen, id: 'model_gemini-4-argon', name: 'Gemini 4 Argon', apiName: 'gemini-4-argon', profileId: 'gemini-4-argon', quotaOpen: false, rpdRemaining: 0 };
  const gemma = local('model_gemma-4-26b-a4b', 'Gemma 4 26B-A4B', { profileId: 'gemma-4-26b-a4b', resident: true });

  it('stays on the current model for an ordinary chat', () => {
    const decision = decideRoute({ text: 'hello there', agentRouting: 'auto', sessionModelId: gemma.id, models: [gemma, lite, hydrogen], memAvailableGiB: 30 });
    expect(decision.modelId).toBe(gemma.id);
    expect(decision.switched).toBe(false);
  });

  it('sends a hard question to Hydrogen and never to Argon', () => {
    const decision = decideRoute({ text: 'Prove this architecture tradeoff formally, step by step', agentRouting: 'auto', sessionModelId: lite.id, models: [lite, hydrogen, argon], memAvailableGiB: 30 });
    expect(decision.modelId).toBe(hydrogen.id);
    expect(decision.switched).toBe(true);
    expect(decision.reason).toMatch(/Hydrogen/);
    expect(decision.reason).toMatch(/Argon/);
  });

  it('keeps ordinary work on the local model even if the session was in the cloud', () => {
    const decision = decideRoute({ text: 'hello', agentRouting: 'auto', sessionModelId: lite.id, models: [gemma, lite, hydrogen], memAvailableGiB: 30 });
    expect(decision.modelId).toBe(gemma.id);
    expect(decision.switched).toBe(true);
    expect(decision.reason).toMatch(/local|machine/i);
  });

  it('escalates a hard question and falls back when quota is closed', () => {
    const up = decideRoute({ text: 'Prove this architecture tradeoff formally, step by step', agentRouting: 'auto', sessionModelId: gemma.id, models: [gemma, lite, hydrogen, argon], memAvailableGiB: 30 });
    expect(up.modelId).toBe(hydrogen.id);
    const closed = { ...hydrogen, quotaOpen: false as const, rpdRemaining: 0 };
    const down = decideRoute({ text: 'Prove this architecture tradeoff formally, step by step', agentRouting: 'auto', sessionModelId: gemma.id, models: [gemma, closed], memAvailableGiB: 30 });
    expect(down.modelId).toBe(gemma.id);
    expect(down.reason).toMatch(/quota/i);
  });

  it('escalates after repeated local failures', () => {
    const decision = decideRoute({ text: 'hello', agentRouting: 'auto', sessionModelId: gemma.id, models: [gemma, lite], memAvailableGiB: 30, localFailures: 2 });
    expect(decision.modelId).toBe(lite.id);
    expect(decision.reason).toMatch(/failures/);
  });

  it('does not load a second large local model while one is busy', () => {
    const qwen = local('model_qwen', 'Qwen3.6 35B-A3B', { profileId: 'qwen3.6-35b-a3b', typicalQ4GiB: 23 });
    const decision = decideRoute({ text: 'hello', agentRouting: 'auto', sessionModelId: qwen.id, models: [qwen, lite], memAvailableGiB: 40, busyLocalLarge: 'Gemma 4 26B-A4B' });
    expect(decision.modelId).toBe(lite.id);
    expect(decision.reason).toMatch(/already in use/);
  });

  it('treats a closed free-tier window as unusable', () => {
    const row = FREE_TIER_SNAPSHOT.find((item) => item.id === 'gemini-4-argon')!;
    expect(quotaAvailability(row).open).toBe(false);
    const liteRow = FREE_TIER_SNAPSHOT.find((item) => item.id === 'gemini-3.5-flash-lite')!;
    expect(quotaAvailability(liteRow, { rpm: 0, tpm: 0, rpd: 0 }, Date.parse('2026-11-14T00:00:00Z')).open).toBe(true);
    expect(liteRow.rpd.limit).toBe(500);
  });
});

describe('context, cron, guard, embeddings', () => {
  it('keeps the newest turn and names what was dropped', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, role: 'user' as const, content: `turn ${index} `.repeat(80) }));
    const plan = planContext({ strategy: 'rolling', contextWindow: 800, practicalBudget: 800, outputReserve: 100, system: 'sys', pinned: ['the box has 48 GB'], summaries: [{ id: 's', level: 2, content: 'Earlier we decided to sandbox.', covers: [] }], retrieved: [], messages, tokenizer: 'approx' });
    expect(plan.recent.at(-1)?.id).toBe('m11');
    expect(plan.droppedIds.length).toBeGreaterThan(0);
    expect(plan.preamble).toMatch(/48 GB/);
  });

  it('folds older uncovered messages once they pass the trigger', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, role: 'user' as const, content: 'word '.repeat(200) }));
    const ids = foldCandidates(messages, new Set(), 'approx', 100);
    expect(ids?.length).toBe(4);
  });

  it('matches cron and finds the next minute', () => {
    const date = new Date('2026-11-13T09:00:00');
    expect(cronMatches('0 9 * * *', date)).toBe(true);
    expect(nextCron('*/15 * * * *', new Date('2026-11-13T09:01:00')).getMinutes()).toBe(15);
  });

  it('jails paths and classifies commands', () => {
    expect(resolveInside('/work', '../etc/passwd')).toBeNull();
    expect(isInside('/work', '/work/src/a.ts')).toBe(true);
    expect(assessCommand('rm -rf /')).toBe('mutating');
    expect(assessCommand('mkfs.ext4 /dev/sda')).toBe('blocked');
    expect(assessCommand('ls')).toBe('ok');
  });

  it('does not flag read-only commands with harmless redirects as destructive', () => {
    for (const command of [
      'ls -la; echo ---; ls node_modules 2>/dev/null | head -5; echo ---; git log --oneline -5 2>/dev/null',
      'ls -la; echo ---; git status --short 2>/dev/null; echo ---; find . -maxdepth 2 -name ".env*" -o -maxdepth 2 -name "*.json"',
      'git diff --stat 2>&1 | tail -3',
      'git log -3 &>/dev/null',
      'cat package.json >/dev/null && echo ok',
      'ls -la /projects/fb-marketplace-scraper; ls /projects/fb-marketplace-scraper/node_modules 2>/dev/null | head -',
      'node -e "const m = html.match(/<script>/);"',
    ]) expect(assessCommand(command), command).toBe('ok');
    for (const command of [
      'echo hi > notes.txt',
      'ls 2>/dev/null > out.txt',
      'cat a >> b',
      'git push origin main',
      'find . -name "*.tmp" -delete',
      'rm -rf build 2>/dev/null',
      'ls > /dev/sda',
    ]) expect(assessCommand(command), command).not.toBe('ok');
  });

  it('retrieves the closer note', () => {
    const docs = [
      { id: 'a', text: 'docker sandbox network policy for containers' },
      { id: 'b', text: 'banana bread recipe with sugar' },
    ];
    const query = hashEmbed('sandbox network containers');
    const hits = topK(docs, (item) => hashEmbed(item.text), query, 1);
    expect(hits[0]?.item.id).toBe('a');
  });

  it('scores install scripts as higher risk', () => {
    const calm = scoreRisk([{ severity: 'info', code: 'x', detail: 'ok' }]);
    const scary = scoreRisk([{ severity: 'critical', code: 'script', detail: 'curl | sh' }, { severity: 'high', code: 'postinstall', detail: 'postinstall' }]);
    expect(scary.score).toBeGreaterThan(calm.score);
    expect(scary.level === 'high' || scary.level === 'critical').toBe(true);
  });
});

describe('coding checkpoints and vault redaction', () => {
  it('applies one unique replacement and can revert the checkpoint', async () => {
    expect(applySearchReplace('alpha beta', 'beta', 'gamma')).toBe('alpha gamma');
    expect(() => applySearchReplace('a a', 'a', 'b')).toThrow(/more than once/);
    const diff = lineDiff('a.ts', 'one\ntwo', 'one\nthree');
    expect(diff).toMatch(/-two/);
    expect(diff).toMatch(/\+three/);
    const dir = tmp();
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'hello world');
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const agent = store.createAgent({ name: 'Coder', systemPrompt: 'code', toolAllowlist: ['apply_patch'], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'edit' });
    const { CODING_TOOLS } = await import('../src/coding.js');
    const tool = CODING_TOOLS.find((item) => item.name === 'apply_patch')!;
    const output = await tool.execute({ path: 'note.txt', search: 'hello', replace: 'goodbye' }, {
      agent, workspace: dir, signal: new AbortController().signal, docker: { available: () => false } as never, fetchImpl: fetch,
      searxngUrl: '', sandbox: 'host', store, depth: 0, sessionId: session.id, runId: 'run', codeApproval: 'sandbox-auto',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('goodbye world');
    expect(output).toMatch(/Checkpoint/);
    const batch = store.db.prepare('SELECT id FROM edit_batches').get() as { id: string };
    await revertBatch(store, batch.id);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello world');
    const plan = replacePlan(store, session.id, ['read the file', 'edit it', 'run tests']);
    expect(plan?.items).toHaveLength(3);
    await app.close();
  });

  it('encrypts a secret, redacts it, and detects a pasted key', async () => {
    const dir = tmp();
    const { app, vault } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const googleKey = ['AIza', 'SyFixtureKeyValue123456789'].join('');
    const openaiKey = ['sk', '-live-', 'fixturealphabetvalue12345'].join('');
    const secret = vault.put({ name: 'GEMINI_API_KEY', value: googleKey, actor: 'test' });
    expect(secret.handle).toBe('secret:GEMINI_API_KEY');
    expect(vault.list()[0]?.name).toBe('GEMINI_API_KEY');
    expect(vault.redact(`the key is ${googleKey}`)).toBe('the key is [redacted]');
    expect(vault.reveal(secret.id, 'owner')).toBe(googleKey);
    expect(vault.auditLog()[0]?.action).toBe('reveal');
    const offers = vault.capture('m1', `please save ${openaiKey}`);
    expect(offers[0]?.kind).toBe('openai');
    expect(findSecretCandidates(googleKey)[0]?.kind).toBe('google');
    vault.revoke(secret.id, 'owner');
    expect(vault.envFor('agent', 'run:1').GEMINI_API_KEY).toBeUndefined();
    const note = path.join(dir, 'workspaces', 'keep.txt');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, 'hello');
    const backup = await createBackup(dir);
    fs.writeFileSync(note, 'bye');
    await app.close();
    applyBackupArchive(dir, backup.file);
    expect(fs.readFileSync(note, 'utf8')).toBe('hello');
  });
});

describe('agent loop', () => {
  it('runs a tool and resumes without repeating a finished step', async () => {
    const dir = tmp();
    const calls: string[] = [];
    const script = new ScriptedProvider([
      { toolCalls: [{ id: 'a', name: 'echo', arguments: '{"text":"A"}' }, { id: 'b', name: 'echo', arguments: '{"text":"B"}' }] },
      { text: 'both done' },
    ]);
    const { app, store, engine } = await buildApp({
      dataDir: dir, startScheduler: false, serveWeb: false,
      providerOverride: () => script,
    });
    engine.extraTools = [{
      name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } },
      mutates: () => false, approval: () => null,
      async execute(args) {
        calls.push(String(args.text));
        if (args.text === 'B' && calls.filter((item) => item === 'B').length === 1) throw new CrashError('died');
        return `echo ${args.text}`;
      },
    }];
    const agent = store.createAgent({ name: 'Tester', systemPrompt: 'test', toolAllowlist: ['echo'], workspacePath: dir, modelId: 'model_rehearsal' });
    const session = store.createSession({ agentId: agent.id });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'go', wait: true });
    expect(run.status).toBe('failed');
    expect(calls).toEqual(['A', 'B']);
    const resumed = await engine.resume(run.id);
    expect(resumed?.status === 'running' || resumed?.status === 'failed' || resumed?.status === 'completed').toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalRun = store.getRun(run.id);
    expect(finalRun?.status).toBe('completed');
    expect(calls.filter((item) => item === 'A')).toHaveLength(1);
    expect(store.listMessages(session.id).some((message) => message.content.includes('both done'))).toBe(true);
    await app.close();
  });

  it('pauses for a secret and never stores the value', async () => {
    const dir = tmp();
    const script = new ScriptedProvider([
      { toolCalls: [{ id: 's', name: 'request_secret', arguments: '{"name":"OPENAI_API_KEY","reason":"search"}' }] as ToolCall[] },
      { text: 'using the handle only' },
    ]);
    const { app, store, engine, vault } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => script });
    const agent = store.createAgent({ name: 'Needs key', systemPrompt: 'test', toolAllowlist: [], workspacePath: dir, modelId: 'model_rehearsal' });
    const session = store.createSession({ agentId: agent.id });
    const pending = engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'need a key', wait: false });
    await pending;
    await waitFor(() => store.listRuns()[0]?.status === 'awaiting_secret');
    const request = vault.listRequests('pending')[0];
    expect(request?.name).toBe('OPENAI_API_KEY');
    const pasted = ['sk', '-live-', 'fixturevalue1234567890'].join('');
    engine.provideSecret(request!.id, pasted);
    await waitFor(() => store.getRun(store.listRuns()[0]!.id)?.status === 'completed');
    const blob = JSON.stringify(store.listMessages(session.id));
    expect(blob).not.toContain(pasted);
    expect(blob).toContain('secret:OPENAI_API_KEY');
    await app.close();
  });

  it('refuses new runs while the kill switch is on', async () => {
    const dir = tmp();
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    store.saveSettings({ ...store.getSettings(), killed: true }, 'kill', {});
    const agent = store.createAgent({ name: 'Stopped', systemPrompt: 'test', toolAllowlist: [], workspacePath: dir, modelId: 'model_rehearsal' });
    const session = store.createSession({ agentId: agent.id });
    await expect(engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'no' })).rejects.toThrow(/Kill switch/);
    await app.close();
  });

  it('requires login before any other route', async () => {
    const dir = tmp();
    const { app } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const closed = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(closed.statusCode).toBe(401);
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '01'].join('-') } });
    expect(setup.statusCode).toBe(200);
    const cookie = setup.cookies.find((item) => item.name === 'la_session');
    const agents = await app.inject({ method: 'GET', url: '/api/agents', cookies: { la_session: cookie!.value } });
    expect(agents.statusCode).toBe(200);
    await app.close();
  });
});

describe('mcp framing and discovery parsers', () => {
  it('round-trips a framed message and parses cursor config', () => {
    const parser = new FrameParser();
    const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(parser.push(encodeFrame(payload))).toEqual([payload]);
    const imported = parseMcpConfig(JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } } }), 'cursor');
    expect(imported[0]?.name).toBe('files');
    const spec = mcpContainerSpec({ id: 'mcp_test', image: 'node:22-alpine', cmd: ['npx', '-y', 'pkg'], env: {}, network: 'none', mounts: [] });
    expect(spec.HostConfig?.NetworkMode).toBe('none');
    expect(spec.HostConfig?.CapDrop).toContain('ALL');
    expect(spec.HostConfig?.Binds).toEqual([]);
  });

  it('parses ollama tags', () => {
    const models = parseOllamaTags({ models: [{ name: 'gemma4:26b-a4b', details: { parameter_size: '26B', family: 'gemma4' } }] });
    expect(models[0]?.parameterSize).toBe('26B');
  });
});

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}
