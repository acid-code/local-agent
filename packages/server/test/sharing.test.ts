/**
 * Flow tests for agents and helpers sharing work: where results land, caps, stop cascades, failures,
 * the RAM queue, what is shared (skills, files, memory, workspaces, rules), member isolation,
 * Founder handoffs, idempotency, timers and rollbacks under concurrent edits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import type { ToolContext } from '../src/tools.js';
import { toolsFor } from '../src/tools.js';
import { saveFile } from '../src/files.js';
import { HELPER_LIMITS } from '../src/autonomy.js';
import { writeMemoryFile, searchChats } from '../src/learning.js';
import { Scheduler } from '../src/scheduler.js';
import { GiB, MemoryBudget, type MemoryProbe } from '../src/memory.js';
import { GALLERY, gallerySystemPrompt } from '../src/gallery.js';
import { setChatWorkspaces } from '../src/chat-workspaces.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); HELPER_LIMITS.minMinutes = 1; });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-share-')); dirs.push(dir); return dir; };
const pw = (tag: string) => ['fixture', tag, '33'].join('-');

/** Parent turns follow a script; helper turns answer by task keyword (fail, slow, gate) and record what they saw. */
class SharedProvider implements ModelProvider {
  parent: { text?: string; toolCalls?: ToolCall[] }[] = [];
  helperSystems: string[] = [];
  helperTools: string[][] = [];
  parentSystems: string[] = [];
  gate: Promise<void> | null = null;
  async *complete(req: { messages: ChatMessage[]; tools?: { name: string }[]; signal?: AbortSignal }) {
    const user = req.messages.filter((message) => message.role === 'user').map((message) => String(message.content)).join('\n');
    const system = String(req.messages.find((message) => message.role === 'system')?.content ?? '');
    if (/background helper/.test(user)) {
      this.helperSystems.push(system);
      this.helperTools.push((req.tools ?? []).map((tool) => tool.name));
      if (/FAIL-NOW/.test(user)) throw new Error('model exploded');
      const abort = new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      if (/SLOW/.test(user)) await Promise.race([new Promise((resolve) => setTimeout(resolve, 5000)), abort]);
      if (this.gate && /GATED/.test(user)) await Promise.race([this.gate, abort]);
      const task = /Task:\n([\s\S]*)$/.exec(user)?.[1]?.trim() ?? 'task';
      yield { type: 'token' as const, text: `result for ${task}` };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } };
      return;
    }
    this.parentSystems.push(system);
    const step = this.parent.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
}

async function setup(dir = tmp(), first = true) {
  const provider = new SharedProvider();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
  let owner: Record<string, string> = {};
  let member: Record<string, string> = {};
  if (first) {
    owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
    member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
  }
  const persona = async (cookies: Record<string, string>, name: string, tools = ['read_file', 'write_file']) => {
    const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name, systemPrompt: `You are ${name}.`, toolAllowlist: tools, modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string; workspacePath: string };
    return built.store.getAgent(agent.id)!;
  };
  const chat = (agent: { id: string; ownerId: string }) => built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  const ctx = (agentId: string, sessionId: string, extra: Partial<ToolContext> = {}): ToolContext => {
    const agent = built.store.getAgent(agentId)!;
    return { agent, workspace: agent.workspacePath, signal: new AbortController().signal, store: built.store, depth: 0, sessionId, runId: undefined, ...extra } as unknown as ToolContext;
  };
  const helpers = (sessionId: string) => built.engine.autonomy.listHelpers(sessionId);
  const messages = (sessionId: string) => built.store.listMessages(sessionId).map((message) => message.content);
  return { ...built, dir, provider, owner, member, persona, chat, ctx, helpers, messages };
}
type Built = Awaited<ReturnType<typeof setup>>;
const done = (built: Built, sessionId: string, count = 1) => waitFor(() => built.helpers(sessionId).filter((row) => !['queued', 'running', 'waiting'].includes(row.status)).length >= count);

describe('results reach the right parent', () => {
  it('posts each helper result only into the chat that started it', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const [a, b] = [built.chat(ada), built.chat(ada)];
    await built.engine.autonomy.spawn(built.ctx(ada.id, a.id), { task: 'alpha job' });
    await built.engine.autonomy.spawn(built.ctx(ada.id, b.id), { task: 'beta job' });
    await done(built, a.id); await done(built, b.id);
    expect(built.messages(a.id).join('\n')).toContain('result for alpha job');
    expect(built.messages(a.id).join('\n')).not.toContain('beta job');
    expect(built.messages(b.id).join('\n')).toContain('result for beta job');
    expect(built.messages(b.id).join('\n')).not.toContain('alpha job');
    await built.app.close();
  });

  it('a helper running another persona reports back in the parent chat, as the parent persona', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    await built.persona(built.owner, 'Bo');
    const parent = built.chat(ada);
    const helper = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'bo checks', persona: 'Bo' });
    await done(built, parent.id);
    const posted = built.store.listMessages(parent.id).find((message) => message.routingNote === `helper:${helper.id}`)!;
    expect(posted.agentId).toBe(ada.id);
    expect(posted.content).toContain('Helper finished · Bo');
    expect(built.store.listMessages(helper.childSessionId).some((message) => message.content.includes('result for bo checks'))).toBe(true);
    await built.app.close();
  });

  it('a spawn_agent call inside a real turn lands its result in that turn\'s chat', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    built.provider.parent = [{ toolCalls: [{ id: 's1', name: 'spawn_agent', arguments: JSON.stringify({ task: 'gamma' }) }] }, { text: 'Started.' }];
    const run = await built.engine.startTurn({ sessionId: parent.id, agentId: ada.id, content: 'go', wait: true });
    await done(built, parent.id);
    expect(built.helpers(parent.id)[0]!.parentRunId).toBe(run.id);
    expect(built.messages(parent.id).join('\n')).toContain('result for gamma');
    await built.app.close();
  });
});

describe('nesting and caps', () => {
  it('helpers never see spawn_agent, helpers or scheduling tools, even when asked for them', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada', ['read_file', 'spawn_agent', 'manage_timer']);
    const parent = built.chat(ada);
    await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'nested try', tools: ['read_file', 'spawn_agent', 'helpers', 'manage_timer', 'manage_trigger'] });
    await done(built, parent.id);
    for (const name of ['spawn_agent', 'helpers', 'manage_timer', 'manage_trigger']) expect(built.provider.helperTools[0]).not.toContain(name);
    await expect(built.engine.autonomy.spawn(built.ctx(ada.id, parent.id, { depth: 1 }), { task: 'grandchild' })).rejects.toThrow(/cannot start helpers/);
    await built.app.close();
  });

  it('caps helpers per chat (3) and on the machine (4)', async () => {
    const built = await setup();
    let release!: () => void;
    built.provider.gate = new Promise((resolve) => { release = resolve; });
    const ada = await built.persona(built.owner, 'Ada');
    const [a, b] = [built.chat(ada), built.chat(ada)];
    for (let i = 0; i < 3; i += 1) await built.engine.autonomy.spawn(built.ctx(ada.id, a.id), { task: `GATED a${i}` });
    await expect(built.engine.autonomy.spawn(built.ctx(ada.id, a.id), { task: 'GATED a3' })).rejects.toThrow(/already has 3/);
    await built.engine.autonomy.spawn(built.ctx(ada.id, b.id), { task: 'GATED b0' });
    await expect(built.engine.autonomy.spawn(built.ctx(ada.id, b.id), { task: 'GATED b1' })).rejects.toThrow(/4 helpers are already running/);
    release();
    await done(built, a.id, 3); await done(built, b.id, 1);
    await built.app.close();
  });

  it('a helper\'s tools never exceed what its persona may use', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada', ['read_file']);
    const parent = built.chat(ada);
    await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'wants shell', tools: ['read_file', 'shell', 'docker_run'] });
    await done(built, parent.id);
    expect(built.provider.helperTools[0]).toContain('read_file');
    expect(built.provider.helperTools[0]).not.toContain('shell');
    expect(built.provider.helperTools[0]).not.toContain('docker_run');
    await built.app.close();
  });
});

describe('stop cascades', () => {
  it('stopping the parent reply stops the helpers it started', async () => {
    const built = await setup();
    built.provider.gate = new Promise(() => undefined);
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const parentRun = built.store.createRun({ sessionId: parent.id, agentId: ada.id, parentRunId: null, configVersion: 1, cursor: { phase: 'model', turn: 0, depth: 0 } as never });
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id, { runId: parentRun.id }), { task: 'GATED long' });
    built.engine.stop(parentRun.id);
    await waitFor(() => built.engine.autonomy.getHelper(h.id)!.status === 'stopped');
    expect(built.messages(parent.id).filter((text) => text.includes('Helper stopped'))).toHaveLength(1);
    await built.app.close();
  });

  it('deleting a chat stops its helpers', async () => {
    const built = await setup();
    built.provider.gate = new Promise(() => undefined);
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'GATED orphan' });
    expect((await built.app.inject({ method: 'DELETE', url: `/api/sessions/${parent.id}`, cookies: built.owner })).statusCode).toBe(200);
    await waitFor(() => built.engine.autonomy.getHelper(h.id)!.status === 'stopped');
    expect(built.store.getRun(built.engine.autonomy.getHelper(h.id)!.childRunId!)!.status).toBe('stopped');
    await built.app.close();
  });

  it('stopping one helper leaves its siblings and the parent alone', async () => {
    const built = await setup();
    let release!: () => void;
    built.provider.gate = new Promise((resolve) => { release = resolve; });
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const one = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'GATED one' });
    const two = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'GATED two' });
    built.engine.autonomy.stop(one.id);
    release();
    await waitFor(() => built.engine.autonomy.getHelper(two.id)!.status === 'done');
    expect(built.engine.autonomy.getHelper(one.id)!.status).toBe('stopped');
    await built.app.close();
  });
});

describe('failures and timeouts', () => {
  it('a helper whose model fails is reported as failed with the reason', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'FAIL-NOW please' });
    await done(built, parent.id);
    const row = built.engine.autonomy.getHelper(h.id)!;
    expect(row.status).toBe('failed');
    expect(built.messages(parent.id).join('\n')).toMatch(/Helper failed · Ada[\s\S]*/);
    await built.app.close();
  });

  it('a helper that runs out of time fails with "Ran out of time", not a silent stop', async () => {
    const built = await setup();
    HELPER_LIMITS.minMinutes = 0.002; // ~120 ms, for the test only
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'SLOW job', timeoutMinutes: 0.002 });
    await done(built, parent.id);
    const row = built.engine.autonomy.getHelper(h.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/Ran out of time/);
    await built.app.close();
  });

  it('a bad spawn (unknown persona, empty task) leaves nothing running', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    await expect(built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'x', persona: 'Nobody' })).rejects.toThrow(/No persona named Nobody/);
    await expect(built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: '   ' })).rejects.toThrow(/Describe the task/);
    expect(built.helpers(parent.id)).toHaveLength(0);
    await built.app.close();
  });
});

describe('RAM queue', () => {
  const probe = (): MemoryProbe => ({ loaded: async () => [], shape: async () => null, unload: async () => undefined, serverRss: () => 0, pidRss: () => 0, systemAvailable: () => 100 * GiB });
  it('helper runs are queued in the background lane', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'lane check' });
    await done(built, parent.id);
    expect(built.store.getRun(built.engine.autonomy.getHelper(h.id)!.childRunId!)!.cursor.background).toBe(true);
    await built.app.close();
  });

  it('when memory frees up, a waiting chat reply goes before a waiting helper', async () => {
    const budget = new MemoryBudget(probe(), () => ({ budgetBytes: 10 * GiB, systemReserveBytes: 0 }), undefined, 10);
    const big = await budget.admit({ kind: 'chat', label: 'first', bytes: 8 * GiB });
    const order: string[] = [];
    const helper = budget.admit({ kind: 'background', label: 'helper', bytes: 6 * GiB }).then((lease) => { order.push('helper'); return lease; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reply = budget.admit({ kind: 'chat', label: 'reply', bytes: 6 * GiB }).then((lease) => { order.push('reply'); return lease; });
    big.release();
    const first = await Promise.race([reply, helper]);
    first.release();
    (await (first === (await reply) ? helper : reply)).release();
    expect(order[0]).toBe('reply');
  });
});

describe('sharing skills, files, memory, workspaces and rules', () => {
  it('a helper of the same persona gets the same skills and memory; another persona does not get that memory', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    await built.persona(built.owner, 'Bo');
    built.store.updateAgent(ada.id, { memoryEnabled: true });
    writeMemoryFile(built.store, ada.id, 'notes', 'ADA-NOTE: the release branch is rel/0.9');
    const parent = built.chat(ada);
    await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'same persona' });
    await done(built, parent.id, 1);
    await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'other persona', persona: 'Bo' });
    await done(built, parent.id, 2);
    const [own, other] = built.provider.helperSystems;
    expect(own).toContain('ADA-NOTE');
    expect(other).not.toContain('ADA-NOTE');
    // The shared skill catalog is in both prompts.
    expect(own).toMatch(/load_skill|skills/i);
    await built.app.close();
  });

  it('files a helper makes show up as "from agents" in the parent chat\'s context', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'make a file' });
    await done(built, parent.id);
    saveFile(built.store, built.dir, { name: 'helper-report.md', bytes: Buffer.from('# report'), sessionId: h.childSessionId, source: 'agent', ownerId: ada.ownerId });
    const context = (await built.app.inject({ method: 'GET', url: `/api/sessions/${parent.id}/context`, cookies: built.owner })).json();
    expect(context.files.produced.map((file: { name: string }) => file.name)).toContain('helper-report.md');
    await built.app.close();
  });

  it('helpers work in the parent chat\'s workspaces and follow its rule files and rule switches', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    fs.mkdirSync(ada.workspacePath, { recursive: true });
    fs.writeFileSync(path.join(ada.workspacePath, 'AGENTS.md'), 'HELPER-RULE: run the tests before reporting.');
    fs.writeFileSync(path.join(ada.workspacePath, '.cursorrules'), 'OFF-RULE: this one is switched off.');
    const parent = built.chat(ada);
    setChatWorkspaces(built.store, parent.id, [{ kind: 'root', id: `ws:${ada.id}` }]);
    const rules = (await built.app.inject({ method: 'GET', url: `/api/sessions/${parent.id}/rules`, cookies: built.owner })).json().rules as { file: string; key: string }[];
    await built.app.inject({ method: 'PUT', url: `/api/sessions/${parent.id}/rules`, cookies: built.owner, payload: { key: rules.find((rule) => rule.file === '.cursorrules')!.key, enabled: false } });
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'check rules' });
    await done(built, parent.id);
    expect((await built.app.inject({ method: 'GET', url: `/api/sessions/${h.childSessionId}/workspaces`, cookies: built.owner })).json().items).toEqual([{ kind: 'root', id: `ws:${ada.id}` }]);
    expect(built.provider.helperSystems[0]).toContain('HELPER-RULE');
    expect(built.provider.helperSystems[0]).not.toContain('OFF-RULE');
    await built.app.close();
  });
});

describe('member isolation across helpers', () => {
  it('members cannot read, stop or inspect the owner\'s helpers', async () => {
    const built = await setup();
    built.provider.gate = new Promise(() => undefined);
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'GATED secret plan' });
    for (const [method, url] of [['GET', `/api/sessions/${h.childSessionId}`], ['GET', `/api/sessions/${parent.id}/context`], ['POST', `/api/helpers/${h.id}/stop`], ['GET', `/api/sessions/${h.childSessionId}/messages`]] as const) {
      expect((await built.app.inject({ method, url, cookies: built.member })).statusCode).toBeGreaterThanOrEqual(403);
    }
    expect(built.engine.autonomy.getHelper(h.id)!.status).not.toBe('stopped');
    built.engine.autonomy.stop(h.id);
    await built.app.close();
  });

  it('a member persona\'s helper uses only that member\'s personas and never gets owner-only tools', async () => {
    const built = await setup();
    await built.persona(built.owner, 'Ada');
    const mia = await built.persona(built.member, 'Mia', ['read_file', 'shell']);
    const parent = built.chat(mia);
    await expect(built.engine.autonomy.spawn(built.ctx(mia.id, parent.id), { task: 'x', persona: 'Ada' })).rejects.toThrow(/No persona named Ada/);
    await built.engine.autonomy.spawn(built.ctx(mia.id, parent.id), { task: 'member job', tools: ['read_file', 'shell', 'request_secret', 'manage_trigger'] });
    await done(built, parent.id);
    for (const name of ['shell', 'request_secret', 'manage_trigger']) expect(built.provider.helperTools[0]).not.toContain(name);
    await built.app.close();
  });

  it('chat search, memory files and rollback stay inside each account', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const mia = await built.persona(built.member, 'Mia');
    const parent = built.chat(ada);
    await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'ZEBRA-OWNER-ONLY research' });
    await done(built, parent.id);
    expect(searchChats(built.store, { query: 'ZEBRA', ownerId: ada.ownerId }).length).toBeGreaterThan(0);
    expect(searchChats(built.store, { query: 'ZEBRA', ownerId: mia.ownerId })).toHaveLength(0);
    expect((await built.app.inject({ method: 'GET', url: `/api/agents/${ada.id}/memory-files`, cookies: built.member })).statusCode).toBe(404);
    const childRun = built.engine.autonomy.listHelpers(parent.id)[0]!.childRunId!;
    expect((await built.app.inject({ method: 'POST', url: `/api/runs/${childRun}/rollback`, cookies: built.member })).statusCode).toBe(404);
    await built.app.close();
  });
});

describe('Founder handoffs', () => {
  it('the Founder knows its teammates and every handoff points at a real gallery persona', () => {
    const founder = GALLERY.find((item) => item.id === 'founder')!;
    const prompt = gallerySystemPrompt(founder);
    expect(prompt).toContain('## Teammates');
    expect(founder.handoffs.length).toBeGreaterThanOrEqual(3);
    for (const handoff of founder.handoffs) expect(prompt).toContain(GALLERY.find((item) => item.id === handoff.to)!.name);
  });

  it('a Founder hands work to an added teammate and gets the result in its chat', async () => {
    const built = await setup();
    const founder = (await built.app.inject({ method: 'POST', url: '/api/gallery/founder', cookies: built.owner })).json().agent;
    const sell = (await built.app.inject({ method: 'POST', url: '/api/gallery/sell', cookies: built.owner })).json().agent;
    const parent = built.store.createSession({ agentId: founder.id, ownerId: founder.ownerId });
    const h = await built.engine.autonomy.spawn(built.ctx(founder.id, parent.id), { task: 'Build a 20-row lead list for Israeli dental clinics', persona: sell.name });
    await done(built, parent.id);
    expect(h.agentId).toBe(sell.id);
    expect(built.messages(parent.id).join('\n')).toContain(`Helper finished · ${sell.name}`);
    await built.app.close();
  });

  it('a handoff to a teammate that was never added fails with a clear message', async () => {
    const built = await setup();
    const founder = (await built.app.inject({ method: 'POST', url: '/api/gallery/founder', cookies: built.owner })).json().agent;
    const parent = built.store.createSession({ agentId: founder.id, ownerId: founder.ownerId });
    await expect(built.engine.autonomy.spawn(built.ctx(founder.id, parent.id), { task: 'outreach', persona: 'Outreach' })).rejects.toThrow(/No persona named Outreach/);
    await built.app.close();
  });
});

describe('idempotency and restarts', () => {
  it('delivers a result once, however many times delivery runs', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const parent = built.chat(ada);
    const h = await built.engine.autonomy.spawn(built.ctx(ada.id, parent.id), { task: 'once only' });
    await done(built, parent.id);
    const run = built.store.getRun(built.engine.autonomy.getHelper(h.id)!.childRunId!)!;
    built.engine.autonomy.deliver(run); built.engine.autonomy.deliver(run); built.engine.autonomy.sweep();
    built.engine.autonomy.listHelpers(parent.id);
    expect(built.messages(parent.id).filter((text) => text.includes('Helper finished'))).toHaveLength(1);
    await built.app.close();
  });

  it('a result that finished while the server was down is delivered on the next start, once', async () => {
    const dir = tmp();
    const first = await setup(dir);
    const ada = await first.persona(first.owner, 'Ada');
    const parent = first.chat(ada);
    const h = await first.engine.autonomy.spawn(first.ctx(ada.id, parent.id), { task: 'survives restart' });
    await done(first, parent.id);
    // Pretend the result was never handed over (the process died right after the run ended).
    first.store.db.prepare("UPDATE helpers SET delivered = 0, status = 'running', result = NULL WHERE id = ?").run(h.id);
    first.store.db.prepare("DELETE FROM messages WHERE session_id = ? AND routing_note = ?").run(parent.id, `helper:${h.id}`);
    await first.app.close();
    const second = await setup(dir, false);
    expect(second.messages(parent.id).filter((text) => text.includes('result for survives restart'))).toHaveLength(1);
    await second.app.close();
    const third = await setup(dir, false);
    expect(third.messages(parent.id).filter((text) => text.includes('result for survives restart'))).toHaveLength(1);
    await third.app.close();
  });

  it('a helper interrupted by a restart is reported as failed instead of hanging', async () => {
    const dir = tmp();
    const first = await setup(dir);
    first.provider.gate = new Promise(() => undefined);
    const ada = await first.persona(first.owner, 'Ada');
    const parent = first.chat(ada);
    const h = await first.engine.autonomy.spawn(first.ctx(ada.id, parent.id), { task: 'GATED interrupted' });
    const runId = first.engine.autonomy.getHelper(h.id)!.childRunId!;
    await first.app.close();
    // A crash leaves the run "running" with an old heartbeat and nobody holding it.
    const stale = new Date(Date.now() - 120_000).toISOString();
    const reopen = await setup(dir, false);
    reopen.store.db.prepare("UPDATE helpers SET delivered = 0, status = 'running' WHERE id = ?").run(h.id);
    reopen.store.db.prepare("DELETE FROM messages WHERE session_id = ? AND routing_note = ?").run(parent.id, `helper:${h.id}`);
    reopen.store.updateRun(runId, { status: 'running', endedAt: null, leaseOwner: 'dead-process', heartbeatAt: stale } as never);
    reopen.store.saveSettings({ ...reopen.store.getSettings(), autoResume: false }, 'test', null);
    await reopen.app.close();
    const after = await setup(dir, false);
    await waitFor(() => after.engine.autonomy.getHelper(h.id)!.status === 'failed');
    expect(after.messages(parent.id).filter((text) => text.includes('Helper failed'))).toHaveLength(1);
    await after.app.close();
  });
});

describe('helper results survive restarts', () => {
  it('a helper run cut off by a restart resumes on the next start and still reports to its parent', async () => {
    const dir = tmp();
    const first = await setup(dir);
    first.provider.gate = new Promise(() => undefined);
    const ada = await first.persona(first.owner, 'Ada');
    const parent = first.chat(ada);
    const h = await first.engine.autonomy.spawn(first.ctx(ada.id, parent.id), { task: 'GATED resumes' });
    const runId = first.engine.autonomy.getHelper(h.id)!.childRunId!;
    await first.app.close();
    const reopen = await setup(dir, false);
    reopen.store.db.prepare("UPDATE helpers SET delivered = 0, status = 'running' WHERE id = ?").run(h.id);
    reopen.store.db.prepare("DELETE FROM messages WHERE session_id = ? AND routing_note = ?").run(parent.id, `helper:${h.id}`);
    reopen.store.updateRun(runId, { status: 'running', endedAt: null, error: null, leaseOwner: 'dead-process', heartbeatAt: new Date(Date.now() - 120_000).toISOString(), cursor: { ...reopen.store.getRun(runId)!.cursor, phase: 'route' } } as never);
    await reopen.app.close();
    const after = await setup(dir, false); // autoResume is on by default; no in-memory callback exists in this process
    await waitFor(() => after.engine.autonomy.getHelper(h.id)!.status === 'done');
    expect(after.messages(parent.id).filter((text) => text.includes('Helper finished'))).toHaveLength(1);
    await after.app.close();
  });
});

describe('timers fire in the right chat', () => {
  it('a timer a persona creates from a chat runs in that same chat', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const origin = built.chat(ada);
    const timer = built.engine.autonomy.tools().find((tool) => tool.name === 'manage_timer')!;
    await timer.execute({ action: 'create', name: 'Ping', cron: '* * * * *', prompt: 'TIMER-PROMPT check' }, built.ctx(ada.id, origin.id));
    const row = built.store.listSchedules()[0]!;
    built.store.updateSchedule(row.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await new Scheduler(built.store, built.engine).tick();
    await waitFor(() => built.messages(origin.id).some((text) => text.includes('TIMER-PROMPT')));
    expect(built.store.listSessions(ada.ownerId).filter((session) => session.agentId === ada.id)).toHaveLength(1);
    await built.app.close();
  });

  it('a timer due while its chat is mid-reply waits a minute instead of being skipped', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const origin = built.chat(ada);
    const row = built.store.createSchedule({ agentId: ada.id, name: 'Busy', cron: '0 9 * * *', prompt: 'busy prompt', nextRunAt: new Date(Date.now() - 1000).toISOString() });
    built.store.updateSchedule(row.id, { sessionId: origin.id });
    const busy = built.engine.sessionBusy;
    built.engine.sessionBusy = (id: string) => id === origin.id;
    await new Scheduler(built.store, built.engine).tick();
    built.engine.sessionBusy = busy;
    const after = built.store.getSchedule(row.id)!;
    expect(new Date(after.nextRunAt!).getTime() - Date.now()).toBeLessThan(70_000);
    expect(after.lastStatus).toMatch(/Waiting for the chat/);
    await built.app.close();
  });

  it('a timer whose chat was deleted opens a fresh chat for the same account', async () => {
    const built = await setup();
    const mia = await built.persona(built.member, 'Mia');
    const origin = built.chat(mia);
    const row = built.store.createSchedule({ agentId: mia.id, name: 'Orphan', cron: '0 9 * * *', prompt: 'ORPHAN-PROMPT', nextRunAt: new Date(Date.now() - 1000).toISOString() });
    built.store.updateSchedule(row.id, { sessionId: origin.id });
    built.store.updateSession(origin.id, { archived: true });
    await new Scheduler(built.store, built.engine).tick();
    const fresh = built.store.getSchedule(row.id)!.sessionId!;
    expect(fresh).not.toBe(origin.id);
    expect(built.store.getSession(fresh)!.ownerId).toBe(mia.ownerId);
    await built.app.close();
  });
});

describe('checkpoints and rollback under concurrent edits', () => {
  async function edits() {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    fs.mkdirSync(ada.workspacePath, { recursive: true });
    const file = path.join(ada.workspacePath, 'notes.txt');
    fs.writeFileSync(file, 'original\n');
    const chat = built.chat(ada);
    const write = toolsFor(['write_file'])[0]!;
    const runA = built.store.createRun({ sessionId: chat.id, agentId: ada.id, parentRunId: null, configVersion: 1, cursor: { phase: 'done', turn: 0 } as never });
    const runB = built.store.createRun({ sessionId: chat.id, agentId: ada.id, parentRunId: null, configVersion: 1, cursor: { phase: 'done', turn: 0 } as never });
    const by = (runId: string) => built.ctx(ada.id, chat.id, { runId });
    return { built, file, write, runA, runB, by };
  }
  const rollback = (built: Built, runId: string) => built.app.inject({ method: 'POST', url: `/api/runs/${runId}/rollback`, cookies: built.owner });

  it('refuses to roll back an edit that a later run changed again, and keeps the later work', async () => {
    const { built, file, write, runA, runB, by } = await edits();
    await write.execute({ path: 'notes.txt', content: 'from A\n' }, by(runA.id));
    await write.execute({ path: 'notes.txt', content: 'from B\n' }, by(runB.id));
    const res = await rollback(built, runA.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error ?? res.json().message).toMatch(/changed after this edit/);
    expect(fs.readFileSync(file, 'utf8')).toBe('from B\n');
    await built.app.close();
  });

  it('rolling back newest first restores the original', async () => {
    const { built, file, write, runA, runB, by } = await edits();
    await write.execute({ path: 'notes.txt', content: 'from A\n' }, by(runA.id));
    await write.execute({ path: 'notes.txt', content: 'from B\n' }, by(runB.id));
    expect((await rollback(built, runB.id)).statusCode).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe('from A\n');
    expect((await rollback(built, runA.id)).statusCode).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe('original\n');
    await built.app.close();
  });

  it('several edits in one reply roll back together, and a hand edit afterwards blocks the rollback', async () => {
    const { built, file, write, runA, runB, by } = await edits();
    await write.execute({ path: 'notes.txt', content: 'A1\n' }, by(runA.id));
    await write.execute({ path: 'notes.txt', content: 'A2\n' }, by(runA.id));
    await write.execute({ path: 'new.txt', content: 'brand new\n' }, by(runA.id));
    expect((await rollback(built, runA.id)).json().reverted).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(path.dirname(file), 'new.txt'))).toBe(false);
    await write.execute({ path: 'notes.txt', content: 'B\n' }, by(runB.id));
    fs.writeFileSync(file, 'my own fix\n');
    expect((await rollback(built, runB.id)).statusCode).toBe(409);
    expect(fs.readFileSync(file, 'utf8')).toBe('my own fix\n');
    await built.app.close();
  });
});
