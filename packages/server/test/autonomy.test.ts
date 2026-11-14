import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import type { ToolContext } from '../src/tools.js';
import { saveFile } from '../src/files.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-auto-')); dirs.push(dir); return dir; };
const pw = (tag: string) => ['fixture', tag, '09'].join('-');

/** Answers by role: the parent follows a script; helpers answer from `helper` (and may block until released). */
class RoleProvider implements ModelProvider {
  parent: { text?: string; toolCalls?: ToolCall[] }[] = [];
  helperTools: string[][] = [];
  gate: Promise<void> | null = null;
  helperText = 'helper result 42';
  async *complete(req: { messages: ChatMessage[]; tools?: { name: string }[]; signal?: AbortSignal }) {
    const helper = req.messages.some((message) => message.role === 'user' && /background helper|handoff_cli/.test(String(message.content)));
    if (helper) {
      this.helperTools.push((req.tools ?? []).map((tool) => tool.name));
      if (this.gate) await Promise.race([this.gate, new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))))]);
      yield { type: 'token' as const, text: this.helperText };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5 } };
      return;
    }
    const step = this.parent.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function waitFor(check: () => boolean, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
}

async function setup() {
  const dir = tmp();
  const provider = new RoleProvider();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
  const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
  const member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
  const persona = async (cookies: Record<string, string>, name: string) => (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name, systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  return { ...built, dir, provider, owner, member, persona };
}

function ctxFor(built: Awaited<ReturnType<typeof setup>>, agentId: string, sessionId: string): ToolContext {
  const agent = built.store.getAgent(agentId)!;
  return { agent, workspace: agent.workspacePath, signal: new AbortController().signal, store: built.store, depth: 0, sessionId, runId: undefined } as unknown as ToolContext;
}
const tool = (built: Awaited<ReturnType<typeof setup>>, name: string) => built.engine.autonomy.tools().find((item) => item.name === name)!;

describe('agent self-management', () => {
  it('creates a timer only after the approval card, and links it to the chat', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    built.store.updateAgent(agent.id, { modelId: 'model_rehearsal' });
    built.provider.parent = [{ toolCalls: [{ id: 't1', name: 'manage_timer', arguments: JSON.stringify({ action: 'create', name: 'Morning', cron: '0 8 * * *', prompt: 'Summarize my day' }) }] }, { text: 'Timer set.' }];
    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'remind me every morning' });
    await waitFor(() => built.store.getRun(run.id)?.status === 'awaiting_approval');
    const approval = built.store.listApprovals('pending').find((row) => row.runId === run.id)!;
    expect(approval.reason).toMatch(/Create timer “Morning” \(0 8 \* \* \*\)/);
    expect(built.store.listSchedules()).toHaveLength(0);
    built.engine.decideApproval(approval.id, 'approved');
    await waitFor(() => built.store.getRun(run.id)?.status === 'completed');
    const timers = built.engine.autonomy.timersFor(session.id);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ name: 'Morning', agentId: agent.id, createdBy: 'agent', enabled: true });
    const context = (await built.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/context`, cookies: built.owner })).json();
    expect(context.timers.map((row: { name: string }) => row.name)).toEqual(['Morning']);
    // Pause and resume need no card; delete does.
    const timer = tool(built, 'manage_timer');
    const ctx = ctxFor(built, agent.id, session.id);
    expect(timer.approval({ action: 'pause', id: timers[0]!.id }, ctx)).toBeNull();
    await timer.execute({ action: 'pause', id: timers[0]!.id }, ctx);
    expect(built.store.getSchedule(timers[0]!.id)?.enabled).toBe(false);
    await timer.execute({ action: 'resume', id: timers[0]!.id }, ctx);
    expect(built.store.getSchedule(timers[0]!.id)?.enabled).toBe(true);
    expect(timer.approval({ action: 'delete', id: timers[0]!.id }, ctx)).toMatch(/Delete timer “Morning”/);
    await expect(timer.execute({ action: 'create', name: 'x', cron: 'every day', prompt: 'p' }, ctx)).rejects.toThrow(/5-field cron/);
    await timer.execute({ action: 'delete', id: timers[0]!.id }, ctx);
    expect(built.store.listSchedules()).toHaveLength(0);
    await built.app.close();
  });

  it('keeps personas to their own timers and triggers; members get no triggers', async () => {
    const built = await setup();
    const ada = await built.persona(built.owner, 'Ada');
    const bo = await built.persona(built.owner, 'Bo');
    const mia = await built.persona(built.member, 'Mia');
    const s1 = built.store.createSession({ agentId: ada.id, ownerId: ada.ownerId });
    const s2 = built.store.createSession({ agentId: mia.id, ownerId: mia.ownerId });
    const timer = tool(built, 'manage_timer');
    await timer.execute({ action: 'create', name: 'Ada timer', cron: '0 9 * * *', prompt: 'p' }, ctxFor(built, ada.id, s1.id));
    const id = built.store.listSchedules()[0]!.id;
    await expect(timer.execute({ action: 'pause', id }, ctxFor(built, bo.id, s1.id))).rejects.toThrow(/No timer/);
    await expect(timer.execute({ action: 'delete', id }, ctxFor(built, mia.id, s2.id))).rejects.toThrow(/No timer/);
    expect(await timer.execute({ action: 'list' }, ctxFor(built, mia.id, s2.id))).toBe('No timers yet.');
    // Triggers: owner persona can create a webhook; the secret is never in the tool result.
    const trig = tool(built, 'manage_trigger');
    const made = await trig.execute({ action: 'create', name: 'CI', kind: 'webhook', prompt: 'Build: {{event}}' }, ctxFor(built, ada.id, s1.id));
    expect(made).toMatch(/\/api\/hooks\/trg_/);
    expect(built.engine.autonomy.triggersFor(s1.id)).toHaveLength(1);
    const folder = path.join(built.dir, 'users');
    fs.mkdirSync(folder, { recursive: true });
    // The member's persona never even sees manage_trigger.
    const memberTools = (built.engine as unknown as { tools: (agent: unknown) => { name: string }[] }).tools(built.store.getAgent(mia.id));
    expect(memberTools.map((row) => row.name)).not.toContain('manage_trigger');
    expect(memberTools.map((row) => row.name)).toContain('manage_timer');
    // And cannot read another account's chat context.
    expect((await built.app.inject({ method: 'GET', url: `/api/sessions/${s1.id}/context`, cookies: built.member })).statusCode).toBe(404);
    await built.app.close();
  });
});

describe('background helpers', () => {
  it('runs a helper in its own hidden chat with limits and posts the result to the parent', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    built.provider.parent = [{ toolCalls: [{ id: 'h1', name: 'spawn_agent', arguments: JSON.stringify({ task: 'Count the files', max_steps: 3, timeout_minutes: 2, tools: ['read_file', 'spawn_agent'] }) }] }, { text: 'Started a helper.' }];
    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'count in the background', wait: true });
    expect(run.status).toBe('completed');
    await waitFor(() => built.engine.autonomy.listHelpers(session.id)[0]?.status === 'done');
    const [helper] = built.engine.autonomy.listHelpers(session.id);
    expect(helper).toMatchObject({ status: 'done', result: 'helper result 42', maxSteps: 3, timeoutMs: 120_000, tools: ['read_file'] });
    // Helpers never get spawn_agent or scheduling tools, whatever was asked.
    expect(built.provider.helperTools[0]).toContain('read_file');
    for (const name of ['spawn_agent', 'helpers', 'manage_timer']) expect(built.provider.helperTools[0]).not.toContain(name);
    const childRun = built.store.getRun(helper!.childRunId!)!;
    expect(childRun.cursor).toMatchObject({ maxSteps: 3, timeoutMs: 120_000, helperId: helper!.id, background: true, depth: 1 });
    expect(built.store.listMessages(session.id).some((message) => message.content.includes('Helper finished') && message.content.includes('helper result 42'))).toBe(true);
    // The helper's chat is hidden from the chat list but opens by id.
    const listed = (await built.app.inject({ method: 'GET', url: '/api/sessions?limit=200', cookies: built.owner })).json().sessions.map((row: { id: string }) => row.id);
    expect(listed).toContain(session.id);
    expect(listed).not.toContain(helper!.childSessionId);
    expect((await built.app.inject({ method: 'GET', url: `/api/sessions/${helper!.childSessionId}`, cookies: built.owner })).statusCode).toBe(200);
    const context = (await built.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/context`, cookies: built.owner })).json();
    expect(context.helpers[0]).toMatchObject({ id: helper!.id, status: 'done' });
    await built.app.close();
  });

  it('caps helpers per chat, stops one on request, and refuses helpers of helpers', async () => {
    const built = await setup();
    let release!: () => void;
    built.provider.gate = new Promise((resolve) => { release = resolve; });
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const ctx = ctxFor(built, agent.id, session.id);
    const spawned = [];
    for (let i = 0; i < 3; i += 1) spawned.push(await built.engine.autonomy.spawn(ctx, { task: `job ${i}` }));
    await expect(built.engine.autonomy.spawn(ctx, { task: 'one too many' })).rejects.toThrow(/already has 3 helpers/);
    await expect(built.engine.autonomy.spawn({ ...ctx, depth: 1 } as ToolContext, { task: 'nested' })).rejects.toThrow(/cannot start helpers/);
    // Members cannot stop the owner's helper.
    expect((await built.app.inject({ method: 'POST', url: `/api/helpers/${spawned[0]!.id}/stop`, cookies: built.member })).statusCode).toBe(404);
    const stopped = (await built.app.inject({ method: 'POST', url: `/api/helpers/${spawned[0]!.id}/stop`, cookies: built.owner })).json().helper;
    expect(stopped.status).toBe('stopped');
    expect(built.store.listMessages(session.id).some((message) => message.content.includes('Helper stopped'))).toBe(true);
    release();
    await waitFor(() => built.engine.autonomy.listHelpers(session.id).filter((row) => row.status === 'done').length === 2);
    const waited = await tool(built, 'helpers').execute({ action: 'wait', timeout_seconds: 1 }, ctx);
    expect(waited).toMatch(/done/);
    // The stopped one is delivered once, not again when its run ends.
    expect(built.store.listMessages(session.id).filter((message) => message.content.includes('Helper stopped'))).toHaveLength(1);
    await built.app.close();
  });

  it('a member persona can only spawn its own account\'s personas and no coding CLI', async () => {
    const built = await setup();
    await built.persona(built.owner, 'Coder');
    const mia = await built.persona(built.member, 'Mia');
    const session = built.store.createSession({ agentId: mia.id, ownerId: mia.ownerId });
    const ctx = ctxFor(built, mia.id, session.id);
    await expect(built.engine.autonomy.spawn(ctx, { task: 'x', persona: 'Coder' })).rejects.toThrow(/No persona named Coder/);
    await expect(built.engine.autonomy.spawn(ctx, { task: 'x', cli: 'claude' })).rejects.toThrow(/owner/);
    await built.app.close();
  });
});

describe('chat files by direction', () => {
  it('filters files by chat and by who made them', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    saveFile(built.store, built.dir, { name: 'in.txt', bytes: Buffer.from('mine'), sessionId: session.id, source: 'upload', ownerId: agent.ownerId });
    saveFile(built.store, built.dir, { name: 'out.md', bytes: Buffer.from('made'), sessionId: session.id, source: 'agent', ownerId: agent.ownerId });
    const get = async (query: string) => (await built.app.inject({ method: 'GET', url: `/api/files?${query}`, cookies: built.owner })).json().files.map((file: { name: string }) => file.name);
    expect(await get(`sessionId=${session.id}&source=upload`)).toEqual(['in.txt']);
    expect(await get(`sessionId=${session.id}&source=agent`)).toEqual(['out.md']);
    const context = (await built.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/context`, cookies: built.owner })).json();
    expect(context.files.uploads.map((file: { name: string }) => file.name)).toEqual(['in.txt']);
    expect(context.files.produced.map((file: { name: string }) => file.name)).toEqual(['out.md']);
    expect((await built.app.inject({ method: 'GET', url: `/api/files?sessionId=${session.id}`, cookies: built.member })).statusCode).toBe(404);
    await built.app.close();
  });
});
