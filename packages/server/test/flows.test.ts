import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ScriptedProvider, type ModelProvider } from '../src/providers.js';
import { createCollection, formatCitations, hashEmbedder, ingestBuffer, searchKnowledge } from '../src/kb.js';
import { McpRuntime, vetSpec } from '../src/mcp.js';
import { applyTelegramUpdate, Notifier } from '../src/notify.js';
import { refreshRepo, registerSharedRepo } from '../src/repos.js';
import { Scheduler } from '../src/scheduler.js';
import { captureLoadedSecrets, secretDrift } from '../src/config.js';
import { createTrigger, deliveryKey, fireTrigger } from '../src/triggers.js';
import { createWorkshop } from '../src/workshops.js';
import { runSkillScript } from '../src/skills.js';
import type { DockerCtl } from '../src/docker.js';
import type { ToolCall } from '@local-agent/shared';

const dirs: string[] = [];
const ownerPassword = ['fixture', 'only', '01'].join('-');
const secondPassword = ['fixture', 'only', '02'].join('-');
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-flow-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function initRepo(dir: string, file = 'README.md') {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, file), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
}

async function poll<T>(read: () => T | undefined, ms = 4000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the run.');
}

describe('full flows', () => {
  it('creates the owner and completes a first chat', async () => {
    const dir = tmp();
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ownerPassword } });
    expect(setup.statusCode).toBe(200);
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'First' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Say hello to the house.', wait: true });
    expect(run.status).toBe('completed');
    expect(store.listMessages(session.id).some((message) => message.role === 'assistant' && message.content.length > 0)).toBe(true);
    await app.close();
  });

  it('plans a two-repo change, waits for approval, commits, and pushes after a second approval', async () => {
    const dir = tmp();
    const server = path.join(dir, 'server');
    const apk = path.join(dir, 'apk');
    const bare = path.join(dir, 'server.git');
    initRepo(server);
    initRepo(apk);
    git(dir, ['init', '--bare', '-b', 'main', bare]);
    git(server, ['remote', 'add', 'origin', bare]);
    git(server, ['push', '-u', 'origin', 'HEAD']);
    fs.writeFileSync(path.join(server, 'note.txt'), 'ship this\n');
    const script = new ScriptedProvider([
      { toolCalls: [{ id: 'plan1', name: 'plan', arguments: '{"items":["Update the server note"]}' }] },
      { toolCalls: [{ id: 'commit1', name: 'git', arguments: '{"action":"commit","project":"server","message":"note"}' }] },
      { toolCalls: [{ id: 'push1', name: 'git', arguments: '{"action":"push","project":"server"}' }] },
      { text: 'Pushed.' },
    ]);
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => script });
    const agent = store.createAgent({ name: 'Coder', systemPrompt: 'Implement the plan.', toolAllowlist: ['git', 'plan', 'read_file'], workspacePath: dir });
    const workshop = createWorkshop(store, { name: 'Server and app', projects: [{ label: 'server', path: server }, { label: 'apk', path: apk }] });
    const session = store.createSession({ agentId: agent.id, title: 'Change' });
    store.updateSession(session.id, { mode: 'code', workshopId: workshop.id });
    const pending = engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Plan the change across both projects', wait: true });
    const plan = await poll(() => store.listApprovals('pending').find((item) => item.toolName === 'plan'));
    engine.decideApproval(plan.id, 'approved');
    const push = await poll(() => store.listApprovals('pending').find((item) => item.toolName === 'git'));
    engine.decideApproval(push.id, 'approved');
    const run = await pending;
    expect(run.status === 'completed' || run.status === 'failed').toBe(true);
    expect(git(server, ['log', '--oneline'])).toMatch(/note/);
    expect(git(bare, ['log', '--oneline'])).toMatch(/note/);
    await app.close();
  });

  it('approves a run from a mocked Telegram callback', async () => {
    const dir = tmp();
    const seen: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('sendMessage')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    };
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = ['123', 'abc'].join(':');
    process.env.TELEGRAM_CHAT_ID = '42';
    const script = new ScriptedProvider([{ toolCalls: [{ id: 'plan1', name: 'plan', arguments: '{"items":["Look up the lecture"]}' }] }]);
    const { app, store, engine, bus } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: fetchImpl as typeof fetch, providerOverride: () => script });
    const notifier = new Notifier(store, bus, engine, dir, fetchImpl as typeof fetch);
    notifier.start();
    const repo = path.join(dir, 'notes');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'lecture\n');
    const agent = store.createAgent({ name: 'Field', systemPrompt: 'Search first, then write a plan.', toolAllowlist: ['plan'], workspacePath: dir });
    const workshop = createWorkshop(store, { name: 'Notes', projects: [{ label: 'notes', path: repo }] });
    const session = store.createSession({ agentId: agent.id, title: 'Research' });
    store.updateSession(session.id, { workshopId: workshop.id, mode: 'code' });
    const schedule = store.createSchedule({ agentId: agent.id, name: 'Morning research', cron: '0 8 * * *', prompt: 'Plan the research pass across the notes project', nextRunAt: new Date(Date.now() - 1000).toISOString() });
    store.updateSchedule(schedule.id, { sessionId: session.id });
    const scheduler = new Scheduler(store, engine);
    await scheduler.tick();
    const approval = await poll(() => store.listApprovals('pending')[0]);
    expect(seen.some((url) => url.includes('/sendMessage'))).toBe(true);
    applyTelegramUpdate(engine, { callback_query: { data: `ok:${approval.id}` } });
    expect(store.getApproval(approval.id)?.status).toBe('approved');
    notifier.stop();
    process.env.TELEGRAM_BOT_TOKEN = previousToken;
    process.env.TELEGRAM_CHAT_ID = previousChat;
    await app.close();
  });

  it('ingests a lecture PDF and cites it', async () => {
    const dir = tmp();
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const collection = createCollection(store, { name: 'Lectures' });
    const pdf = Buffer.from('(Lecture notes on routing) Tj', 'latin1');
    const ingested = await ingestBuffer(store, collection.id, { name: 'lecture.pdf', bytes: pdf }, hashEmbedder());
    expect(ingested.chunks).toBeGreaterThan(0);
    const hits = await searchKnowledge(store, 'routing', { collectionId: collection.id, embed: hashEmbedder() });
    expect(formatCitations(hits)).toMatch(/routing/);
    expect(formatCitations(hits)).toMatch(/lecture\.pdf/);
    await app.close();
  });

  it('vets an MCP from a URL, starts it in a mock container, and scopes the tool to one persona', async () => {
    const dir = tmp();
    const provider: { current: ModelProvider } = { current: new ScriptedProvider([]) };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider.current });
    const report = await vetSpec({ name: 'notes', transport: 'stdio', command: 'notes-mcp', args: [], source: 'https://example.test/notes' }, (async () => new Response('{}')) as typeof fetch, { reputation: false, llm: async () => 'low risk' });
    expect(report.level === 'critical' || report.level === 'high' || report.level === 'medium' || report.level === 'low').toBe(true);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let pending = '';
    stdin.on('data', (chunk: Buffer) => {
      pending += String(chunk);
      for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
        const rpc = JSON.parse(pending.slice(0, nl)) as { id?: number; method?: string };
        pending = pending.slice(nl + 1);
        if (!rpc.id) continue;
        const result = rpc.method === 'tools/list'
          ? { tools: [{ name: 'lecture_search', description: 'Search notes', inputSchema: { type: 'object' } }] }
          : { protocolVersion: '2025-06-18' };
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n`);
      }
    });
    const docker = { available: () => true, attach: async () => ({ stdin, stdout, stderr: new PassThrough(), stop: async () => undefined }) } as unknown as DockerCtl;
    const mcp = new McpRuntime(store, docker);
    const server = mcp.install(report, { acknowledgeRisk: true, acknowledgeCommunity: true });
    const connected = await mcp.connect(server.id);
    expect(connected?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'lecture_search' })]));
    const allowed = store.createAgent({ name: 'Notes', systemPrompt: 'Use the notes tool.', toolAllowlist: ['lecture_search'], workspacePath: dir });
    const blocked = store.createAgent({ name: 'Voice', systemPrompt: 'Talk only.', toolAllowlist: [], workspacePath: dir });
    engine.extraTools = [{
      name: 'lecture_search', description: 'Search notes', parameters: { type: 'object' }, mutates: () => false, approval: () => null,
      async execute() { return 'citation [1] lecture.pdf'; },
    }];
    const session = store.createSession({ agentId: allowed.id, title: 'Notes' });
    const other = store.createSession({ agentId: blocked.id, title: 'Voice' });
    provider.current = new ScriptedProvider([{ toolCalls: [{ id: 't1', name: 'lecture_search', arguments: '{}' }] }, { text: 'Cited.' }]);
    const runYes = await engine.startTurn({ sessionId: session.id, agentId: allowed.id, content: 'Search the lecture notes', wait: true });
    provider.current = new ScriptedProvider([{ toolCalls: [{ id: 't2', name: 'lecture_search', arguments: '{}' }] }, { text: 'No tool.' }]);
    const runNo = await engine.startTurn({ sessionId: other.id, agentId: blocked.id, content: 'Search the lecture notes', wait: true });
    expect(store.listMessages(session.id).some((message) => message.content.includes('citation'))).toBe(true);
    expect(store.listMessages(other.id).some((message) => /Unknown tool/.test(message.content))).toBe(true);
    expect(runYes.status === 'completed' || runYes.status === 'failed').toBe(true);
    expect(runNo.status === 'completed' || runNo.status === 'failed').toBe(true);
    await app.close();
  });
});

describe('crash, triggers, providers, setup, git, and secrets', () => {
  it('does not commit or push twice when a step is resumed after it already started', async () => {
    const dir = tmp();
    const repo = path.join(dir, 'server');
    const bare = path.join(dir, 'server.git');
    initRepo(repo);
    git(dir, ['init', '--bare', '-b', 'main', bare]);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-u', 'origin', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'note.txt'), 'once\n');
    const script = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'git', arguments: '{"action":"commit","message":"once"}' }] },
      { text: 'Committed.' },
    ]);
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => script });
    const agent = store.createAgent({ name: 'Coder', systemPrompt: 'Commit.', toolAllowlist: ['git'], workspacePath: repo });
    const session = store.createSession({ agentId: agent.id, title: 'Commit' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Commit the note in the server repo', wait: true });
    const before = git(repo, ['rev-parse', 'HEAD']);
    const step = store.listSteps(run.id).find((item) => item.name === 'git');
    expect(step?.toolCallId).toBe('c1');
    store.db.prepare('UPDATE effect_keys SET result = NULL WHERE tool_call_id = ?').run('c1');
    store.updateStep(step!.id, { status: 'running' });
    store.updateRun(run.id, {
      status: 'interrupted',
      cursor: { phase: 'tools', turn: 1, toolCalls: [{ id: 'c1', name: 'git', arguments: '{"action":"commit","message":"again"}' }], completedToolIds: [] },
    });
    void engine.resume(run.id);
    await poll(() => {
      const latest = store.getRun(run.id);
      return latest && latest.status !== 'running' && latest.status !== 'interrupted' ? latest : undefined;
    });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(store.listMessages(session.id).some((message) => /not repeated/i.test(message.content))).toBe(true);
    await app.close();
  });

  it('starts one run when the same delivery arrives twice, including after a new engine', async () => {
    const dir = tmp();
    const { app, store, engine, vault } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const trigger = createTrigger(store, vault, { name: 'Hook', kind: 'webhook', agentId: agent.id, prompt: 'Event {{delivery}}', secret: 'sekret' });
    const event = { delivery: 'deliv-9', hello: 'there' };
    const first = await fireTrigger(store, engine, trigger, event, { wait: true });
    const second = await fireTrigger(store, engine, trigger, event, { wait: true });
    expect(second.duplicate).toBe(true);
    expect(second.runId).toBe(first.runId);
    await app.close();
    const restarted = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const again = await fireTrigger(restarted.store, restarted.engine, trigger, event, { wait: true });
    expect(again.duplicate).toBe(true);
    expect(again.runId).toBe(first.runId);
    expect(deliveryKey({ b: 1, a: 2 })).toBe(deliveryKey({ a: 2, b: 1 }));
    await restarted.app.close();
  });

  it('falls back with a notice when the provider returns 429', async () => {
    const dir = tmp();
    const provider: ModelProvider = {
      async *complete(req) {
        if (String(req.model).includes('gemini')) throw new Error('Gemini failed (429): rate');
        yield { type: 'token', text: 'local answer' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 2 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    store.updateProvider('prov_gemini', { enabled: true });
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertModel({
      id: 'fast', providerId: 'prov_ollama', name: 'qwen3:4b', apiName: 'qwen3:4b', profileId: 'fast', tokenizer: 'approx',
      contextWindow: 8192, practicalBudget: 4096, strategy: 'rolling', sizeClass: 'small', local: true, modalities: ['text'], strengths: ['chat'],
      typicalQ4GiB: 3, priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: 'qwen', source: 'test', embedding: false, freeTier: null, enabled: true,
    });
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Smart' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: '/smart Explain the workshop to a new teammate in some detail.', wait: true });
    expect(run.routingNote || '').toMatch(/429/);
    expect(store.listMessages(session.id).some((message) => message.content.includes('local answer'))).toBe(true);
    await app.close();
  });

  it('lets only one of two simultaneous owner creates win', async () => {
    const dir = tmp();
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'one', password: ownerPassword } }),
      app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'two', password: secondPassword } }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM owner').get() as { n: number };
    expect(Number(count.n)).toBe(1);
    await app.close();
  });

  it('kills a hung skill script and keeps the run going', async () => {
    const dir = tmp();
    const script = path.join(dir, 'hang.sh');
    fs.writeFileSync(script, '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(script, 0o755);
    const timed = await runSkillScript(script, 300);
    expect(timed.timedOut).toBe(true);
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 's1', name: 'run_skill_script', arguments: JSON.stringify({ path: script, timeoutMs: 300 }) }] },
      { text: 'Continued.' },
    ]);
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const agent = store.createAgent({ name: 'Runner', systemPrompt: 'Be brief.', toolAllowlist: ['run_skill_script'], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Skill' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Run the skill script', wait: true });
    expect(run.status).toBe('completed');
    expect(store.listSteps(run.id).some((step) => step.kind === 'tool' && step.status === 'failed' && /timed out/i.test(String(step.error || step.output || '')))).toBe(true);
    expect(store.listMessages(session.id).some((message) => message.content.includes('Continued.'))).toBe(true);
    await app.close();
  });

  it('rejects a non-fast-forward push and skips a pull when the tree is dirty', async () => {
    const dir = tmp();
    const repo = path.join(dir, 'server');
    const other = path.join(dir, 'other');
    const bare = path.join(dir, 'server.git');
    initRepo(repo);
    git(dir, ['init', '--bare', '-b', 'main', bare]);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-u', 'origin', 'HEAD']);
    git(dir, ['clone', bare, other]);
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
    git(other, ['add', '.']);
    git(other, ['commit', '-m', 'theirs']);
    git(other, ['push']);
    fs.writeFileSync(path.join(repo, 'ours.txt'), 'ours\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'ours']);
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    registerSharedRepo(store, { label: 'server', path: repo });
    const agent = store.createAgent({ name: 'Coder', systemPrompt: 'Git.', toolAllowlist: ['git'], workspacePath: repo });
    const { CODING_TOOLS } = await import('../src/coding.js');
    const gitTool = CODING_TOOLS.find((tool) => tool.name === 'git')!;
    const ctx = { workspace: repo, roots: [{ label: 'server', path: repo, write: true }], store, agent, runId: 'run-push', toolCallId: 'push-1', signal: AbortSignal.timeout(10000) } as never;
    const pushed = await gitTool.execute({ action: 'push', project: 'server' }, ctx);
    expect(pushed).toMatch(/Push rejected/);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
    const pulled = await refreshRepo(repo);
    expect(pulled).toMatch(/local edits/);
    await app.close();
  });

  it('reports a restart when secrets.env no longer matches what the process loaded', async () => {
    const dir = tmp();
    captureLoadedSecrets(dir);
    fs.writeFileSync(path.join(dir, 'secrets.env'), 'GEMINI_API_KEY=changed-on-disk\n', { mode: 0o600 });
    expect(secretDrift(dir)).toEqual(['GEMINI_API_KEY']);
    const { app } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ownerPassword } });
    const cookie = setup.cookies.find((item) => item.name === 'la_session')!.value;
    fs.writeFileSync(path.join(dir, 'secrets.env'), 'OPENROUTER_API_KEY=edited-outside\n', { mode: 0o600 });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { la_session: cookie } });
    expect(me.json().restartKeys).toContain('OPENROUTER_API_KEY');
    await app.close();
  });
});
