import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import type { Tool, ToolContext } from '../src/tools.js';
import { BUILTIN_TOOLS } from '../src/tools.js';
import { MEMORY_CAPS, memoryFileTool, projectRules, rollbackRun, searchChats, searchChatsTool } from '../src/learning.js';
import { listSkills, skillCatalog } from '../src/skills.js';
import { toolScript } from '../src/engine.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-learn-')); dirs.push(dir); return dir; };
const pw = (tag: string) => ['fixture', tag, '11'].join('-');

class ScriptProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  seen: { system: string; tools: string[] }[] = [];
  async *complete(req: { messages: ChatMessage[]; tools?: { name: string }[] }) {
    this.seen.push({ system: String(req.messages.find((message) => message.role === 'system')?.content ?? ''), tools: (req.tools ?? []).map((tool) => tool.name) });
    const step = this.steps.shift() ?? { text: 'ok' };
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
  const provider = new ScriptProvider();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
  const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
  const member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
  const persona = async (cookies: Record<string, string>, name: string, toolAllowlist: string[] = ['read_file']) =>
    (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name, systemPrompt: 'test', toolAllowlist, modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string; workspacePath: string };
  return { ...built, dir, provider, owner, member, persona };
}

function ctxFor(built: Awaited<ReturnType<typeof setup>>, agentId: string, sessionId: string, runId?: string): ToolContext {
  const agent = built.store.getAgent(agentId)!;
  return { agent, workspace: agent.workspacePath, signal: new AbortController().signal, store: built.store, depth: 0, sessionId, runId, libraryDir: built.dir } as unknown as ToolContext;
}
const say = (built: Awaited<ReturnType<typeof setup>>, sessionId: string, role: 'user' | 'assistant', content: string) => built.store.insertMessage({
  sessionId, role, content, toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null,
});

describe('capped memory files', () => {
  it('appends, refuses past the cap with consolidation advice, replaces, and shows in the system prompt', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const tool = memoryFileTool();
    const ctx = ctxFor(built, agent.id, session.id);
    expect(await tool.execute({ file: 'user', action: 'append', text: 'Prefers English.' }, ctx)).toMatch(/saved \(16\/1500\)/);
    const refused = await tool.execute({ file: 'user', action: 'append', text: 'x'.repeat(MEMORY_CAPS.user) }, ctx);
    expect(refused).toMatch(/Refused.*Consolidate/s);
    expect(refused).toContain('Prefers English.');
    await tool.execute({ file: 'user', action: 'replace', text: 'Prefers English. Lean token use.' }, ctx);
    expect(await tool.execute({ file: 'user', action: 'read' }, ctx)).toContain('Lean token use.');

    await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hi' });
    await waitFor(() => built.provider.seen.length > 0);
    expect(built.provider.seen[0]!.system).toContain('Prefers English. Lean token use.');
    expect(built.provider.seen[0]!.tools).toEqual(expect.arrayContaining(['memory_file', 'search_chats', 'run_tool_script']));
  });

  it('lets the owner edit memory files over HTTP, with caps, and hides them from other accounts', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const put = await built.app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/memory-files/notes`, cookies: built.owner, payload: { content: 'Build with tsc first.' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().files.find((file: { kind: string }) => file.kind === 'notes').content).toBe('Build with tsc first.');
    const tooLong = await built.app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/memory-files/user`, cookies: built.owner, payload: { content: 'y'.repeat(MEMORY_CAPS.user + 1) } });
    expect(tooLong.statusCode).toBe(400);
    expect((await built.app.inject({ method: 'GET', url: `/api/agents/${agent.id}/memory-files`, cookies: built.member })).statusCode).toBe(404);
    expect((await built.app.inject({ method: 'PUT', url: `/api/agents/${agent.id}/memory-files/notes`, cookies: built.member, payload: { content: 'x' } })).statusCode).toBe(404);
    const mine = await built.persona(built.member, 'Mine');
    expect((await built.app.inject({ method: 'GET', url: `/api/agents/${mine.id}/memory-files`, cookies: built.member })).statusCode).toBe(200);
  });
});

describe('skill learning loop', () => {
  it('saves a proposed skill only after approval, keeps bodies out of the catalog, and is owner-only', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const body = 'SECRET-BODY-STEP: run tsc in shared first.';
    built.provider.steps = [{ toolCalls: [{ id: 's1', name: 'propose_skill', arguments: JSON.stringify({ name: 'Build monorepo', description: 'Build and typecheck the local-agent monorepo.', body }) }] }, { text: 'Saved.' }];
    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'remember how to build' });
    await waitFor(() => built.store.getRun(run.id)?.status === 'awaiting_approval');
    const approval = built.store.listApprovals('pending').find((row) => row.runId === run.id)!;
    expect(approval.reason).toMatch(/Save new skill “Build monorepo”/);
    expect(listSkills(built.store).some((skill) => skill.name === 'Build monorepo')).toBe(false);
    built.engine.decideApproval(approval.id, 'approved');
    await waitFor(() => built.store.getRun(run.id)?.status === 'completed');
    const skill = listSkills(built.store).find((item) => item.name === 'Build monorepo')!;
    expect(skill).toBeTruthy();
    const catalog = skillCatalog(built.store, agent.id, 'build the monorepo');
    expect(catalog).toContain(skill.slug);
    expect(catalog).not.toContain('SECRET-BODY-STEP');

    // Update proposals name the next version.
    const proposal = built.engine.tools(built.store.getAgent(agent.id)!, 'chat').find((tool) => tool.name === 'propose_skill')!;
    expect(proposal.approval({ name: 'Build monorepo', description: 'd', body: 'b', slug: skill.slug }, ctxFor(built, agent.id, session.id))).toMatch(/Update skill “Build monorepo” to v2/);

    const mine = await built.persona(built.member, 'Mine');
    expect(built.engine.tools(built.store.getAgent(mine.id)!, 'chat').map((tool) => tool.name)).not.toContain('propose_skill');
  });

  it('nudges toward a skill only after several steps', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const read = (id: string): ToolCall => ({ id, name: 'memory_file', arguments: JSON.stringify({ file: 'notes', action: 'read' }) });
    built.provider.steps = [{ toolCalls: [read('a')] }, { toolCalls: [read('b')] }, { toolCalls: [read('c')] }, { toolCalls: [read('d')] }, { text: 'done' }];
    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'long task' });
    await waitFor(() => built.store.getRun(run.id)?.status === 'completed');
    expect(built.provider.seen[0]!.system).not.toMatch(/call propose_skill once/);
    expect(built.provider.seen.at(-1)!.system).toMatch(/call propose_skill once/);
  });
});

describe('search past chats', () => {
  it('finds earlier chats with summary and snippets, scoped to the account, excluding the current chat', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const old = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    built.store.updateSession(old.id, { title: 'Router setup', summary: 'Configured the Mikrotik router VLANs.' });
    say(built, old.id, 'user', 'How do I set up VLAN 20 on the mikrotik?');
    say(built, old.id, 'assistant', 'Use the bridge vlan-filtering option.');
    const current = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    say(built, current.id, 'user', 'mikrotik again');
    const mine = await built.persona(built.member, 'Mine');
    const theirs = built.store.createSession({ agentId: mine.id, ownerId: mine.ownerId });
    say(built, theirs.id, 'user', 'my private mikrotik password notes');

    const hits = searchChats(built.store, { query: 'mikrotik vlan', ownerId: agent.ownerId, exclude: current.id });
    expect(hits.map((hit) => hit.sessionId)).toEqual([old.id]);
    expect(hits[0]!.summary).toContain('Mikrotik router VLANs');
    expect(hits[0]!.hits[0]!.snip).toMatch(/«/);

    // New messages are indexed incrementally; edits are re-indexed.
    const later = say(built, old.id, 'assistant', 'placeholder');
    built.store.updateMessageContent(later.id, 'Remember the trunk port ether5');
    expect(searchChats(built.store, { query: 'ether5', ownerId: agent.ownerId })).toHaveLength(1);

    const memberOut = await searchChatsTool().execute({ query: 'mikrotik' }, ctxFor(built, mine.id, 'none'));
    expect(memberOut).toContain('private «mikrotik»');
    expect(memberOut).not.toContain('VLAN 20');
  });
});

describe('checkpoints and rollback', () => {
  it('records a checkpoint before write_file and rolls the whole reply back; members cannot roll back others', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada', ['read_file', 'write_file']);
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    fs.mkdirSync(agent.workspacePath, { recursive: true });
    fs.writeFileSync(path.join(agent.workspacePath, 'notes.txt'), 'original\n');
    built.provider.steps = [
      { toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: 'changed\n' }) }] },
      { toolCalls: [{ id: 'w2', name: 'write_file', arguments: JSON.stringify({ path: 'new.txt', content: 'fresh\n' }) }] },
      { text: 'Edited.' },
    ];
    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'edit files' });
    const decided = new Set<string>();
    const nextApproval = () => built.store.listApprovals('pending').find((row) => row.runId === run.id && !decided.has(row.id));
    for (let i = 0; i < 2; i++) {
      await waitFor(() => Boolean(nextApproval()));
      const approval = nextApproval()!;
      decided.add(approval.id);
      built.engine.decideApproval(approval.id, 'approved');
    }
    await waitFor(() => built.store.getRun(run.id)?.status === 'completed');
    expect(fs.readFileSync(path.join(agent.workspacePath, 'notes.txt'), 'utf8')).toBe('changed\n');
    const context = (await built.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/context`, cookies: built.owner })).json();
    expect(context.checkpoints).toEqual([expect.objectContaining({ runId: run.id, edits: 2 })]);

    expect((await built.app.inject({ method: 'POST', url: `/api/runs/${run.id}/rollback`, cookies: built.member })).statusCode).toBe(404);
    const res = await built.app.inject({ method: 'POST', url: `/api/runs/${run.id}/rollback`, cookies: built.owner });
    expect(res.json()).toEqual({ reverted: 2 });
    expect(fs.readFileSync(path.join(agent.workspacePath, 'notes.txt'), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(agent.workspacePath, 'new.txt'))).toBe(false);
    expect(await rollbackRun(built.store, run.id)).toBe(0);
    const after = (await built.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/context`, cookies: built.owner })).json();
    expect(after.checkpoints).toEqual([]);
  });
});

describe('context panel controls', () => {
  it('pauses and resumes a trigger for the owner only', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada');
    const created = (await built.app.inject({ method: 'POST', url: '/api/triggers', cookies: built.owner, payload: { name: 'Hook', kind: 'webhook', agentId: agent.id, prompt: 'Handle {{event}}' } })).json().trigger as { id: string };
    expect((await built.app.inject({ method: 'PATCH', url: `/api/triggers/${created.id}`, cookies: built.member, payload: { enabled: false } })).statusCode).toBeGreaterThanOrEqual(403);
    const paused = await built.app.inject({ method: 'PATCH', url: `/api/triggers/${created.id}`, cookies: built.owner, payload: { enabled: false } });
    expect(paused.json().trigger).toEqual({ id: created.id, enabled: false });
    const resumed = await built.app.inject({ method: 'PATCH', url: `/api/triggers/${created.id}`, cookies: built.owner, payload: { enabled: true } });
    expect(resumed.json().trigger.enabled).toBe(true);
  });
});

describe('project rule files', () => {
  it('loads AGENTS.md, CLAUDE.md and .cursorrules from each workspace, capped', () => {
    const a = tmp();
    const b = tmp();
    fs.writeFileSync(path.join(a, 'AGENTS.md'), 'Run npm test before commits.');
    fs.writeFileSync(path.join(a, '.cursorrules'), 'z'.repeat(5000));
    fs.writeFileSync(path.join(b, 'CLAUDE.md'), 'Never push to main.');
    const text = projectRules([{ label: 'app', path: a }, { label: 'infra', path: b }]);
    expect(text).toContain('### app/AGENTS.md\nRun npm test before commits.');
    expect(text).toContain('### infra/CLAUDE.md\nNever push to main.');
    expect(text).toMatch(/2000 more characters in \.cursorrules/);
    expect(projectRules([{ label: 'empty', path: tmp() }])).toBe('');
  });
});

describe('tool scripts', () => {
  const fake = (name: string, approval: string | null, out: (args: Record<string, unknown>) => string): Tool => ({
    name, description: name, parameters: { type: 'object', properties: {} }, mutates: () => Boolean(approval), approval: () => approval, execute: async (args) => out(args),
  });

  it('runs allowed tools in order with {{name}} interpolation and refuses denied or unknown tools', async () => {
    const script = toolScript([fake('lookup', null, (args) => `id-${args.q}`), fake('fetch', null, (args) => `got ${args.id}`), fake('spawn_agent', null, () => 'nope')]);
    const ctx = { signal: new AbortController().signal } as unknown as ToolContext;
    const out = await script.execute({ steps: [{ tool: 'lookup', args: { q: 7 }, save_as: 'ref' }, { tool: 'fetch', args: { id: '{{ref}}' } }] }, ctx);
    expect(out).toContain('got id-7');
    await expect(script.execute({ steps: [{ tool: 'spawn_agent', args: {} }] }, ctx)).rejects.toThrow(/not allowed/);
    await expect(script.execute({ steps: [{ tool: 'shell', args: {} }] }, ctx)).rejects.toThrow(/not allowed/);
    await expect(script.execute({ steps: Array.from({ length: 11 }, () => ({ tool: 'lookup' })) }, ctx)).rejects.toThrow(/At most 10/);
    expect(script.approval({ steps: [{ tool: 'lookup' }] }, ctx)).toBeNull();
  });

  it('asks once for the whole script when a step needs approval, and only offers the persona’s own tools', async () => {
    const built = await setup();
    const agent = await built.persona(built.owner, 'Ada', ['read_file', 'write_file']);
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    fs.mkdirSync(agent.workspacePath, { recursive: true });
    fs.writeFileSync(path.join(agent.workspacePath, 'a.txt'), 'alpha');
    built.provider.steps = [
      { toolCalls: [{ id: 'x1', name: 'run_tool_script', arguments: JSON.stringify({ steps: [{ tool: 'read_file', args: { path: 'a.txt' }, save_as: 'a' }, { tool: 'write_file', args: { path: 'b.txt', content: 'copy: {{a}}' } }] }) }] },
      { text: 'Copied.' },
    ];
    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'copy a to b' });
    await waitFor(() => built.store.getRun(run.id)?.status === 'awaiting_approval');
    const approval = built.store.listApprovals('pending').find((row) => row.runId === run.id)!;
    expect(approval.reason).toMatch(/2-step tool script: read_file → write_file.*Write b\.txt/);
    built.engine.decideApproval(approval.id, 'approved');
    await waitFor(() => built.store.getRun(run.id)?.status === 'completed');
    expect(fs.readFileSync(path.join(agent.workspacePath, 'b.txt'), 'utf8')).toContain('copy: alpha');

    const mine = await built.persona(built.member, 'Mine', ['read_file', 'shell']);
    const memberScript = built.engine.tools(built.store.getAgent(mine.id)!, 'chat').find((tool) => tool.name === 'run_tool_script')!;
    await expect(memberScript.execute({ steps: [{ tool: 'shell', args: { command: 'id' } }] }, ctxFor(built, mine.id, 'none'))).rejects.toThrow(/not allowed/);
    expect(BUILTIN_TOOLS.some((tool) => tool.name === 'run_tool_script')).toBe(false);
  });
});
