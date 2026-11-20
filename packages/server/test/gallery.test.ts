import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import type { DockerCtl } from '../src/docker.js';
import { GALLERY, gallerySystemPrompt } from '../src/gallery.js';
import { BUILTIN_CONNECTORS, sqliteTool, thinkTool, timeTool } from '../src/connectors.js';
import { listSkills } from '../src/skills.js';
import type { ToolContext } from '../src/tools.js';
import { DatabaseSync } from 'node:sqlite';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-gal-')); dirs.push(dir); return dir; };
const pw = (tag: string) => ['fixture', tag, '17'].join('-');

class CaptureProvider implements ModelProvider {
  systems: string[] = [];
  async *complete(req: { messages: ChatMessage[] }) {
    this.systems.push(String(req.messages.find((message) => message.role === 'system')?.content ?? ''));
    yield { type: 'token' as const, text: 'ok' };
    yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}
/** SearXNG answers; everything else is offline. */
const offlineFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes(':8088/search')) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('offline');
}) as typeof fetch;

async function setup(opts: { docker?: boolean } = {}) {
  const dir = tmp();
  const provider = new CaptureProvider();
  const docker = opts.docker ? ({ available: () => true, ping: async () => true, describe: () => 'stub', list: async () => [] } as unknown as DockerCtl) : undefined;
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: offlineFetch, docker, providerOverride: () => provider as unknown as ModelProvider });
  const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
  const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
  const member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
  return { ...built, dir, provider, owner, member };
}

describe('persona gallery content', () => {
  const required = ['assistant', 'founder', 'researcher', 'outreach', 'sell', 'growth', 'product', 'market', 'insights', 'viz', 'coder', 'writer', 'tutor', 'planner', 'inbox', 'admin', 'artist', 'shopper', 'language', 'kitchen', 'finance'];
  it('has every required persona with a distinct colour', () => {
    expect(GALLERY.map((item) => item.id)).toEqual(expect.arrayContaining(required));
    expect(new Set(GALLERY.map((item) => item.accent)).size).toBe(GALLERY.length);
  });
  it.each(GALLERY.map((item) => [item.id, item] as const))('%s ships at least two real skills, rules and valid handoffs', (_id, item) => {
    expect(item.skills.length).toBeGreaterThanOrEqual(2);
    for (const skill of item.skills) {
      expect(skill.body.length).toBeGreaterThan(250);
      expect(skill.body).toMatch(/^\s*(\d+\.|-|\||##)/m); // steps, checklists or a template
      expect(skill.body).not.toMatch(/TODO|lorem|placeholder/i);
      expect(skill.description.length).toBeGreaterThan(30);
    }
    expect(item.rules.length).toBeGreaterThanOrEqual(2);
    const prompt = gallerySystemPrompt(item);
    expect(prompt).toContain('## Rules');
    expect(prompt).toMatch(/approves|approval/);
    for (const handoff of item.handoffs) expect(GALLERY.some((row) => row.id === handoff.to)).toBe(true);
    for (const id of item.connectors) expect(['filesystem', 'fetch', 'git', 'memory', 'time', 'search', 'thinking', 'browser', 'sqlite', 'docker', 'github', 'gmail', 'calendar', 'slack', 'notion', 'linear']).toContain(id);
  });
  it('shares skills between personas with one definition per slug', () => {
    const bodies = new Map<string, string>();
    for (const skill of GALLERY.flatMap((item) => item.skills)) {
      if (bodies.has(skill.slug)) expect(bodies.get(skill.slug)).toBe(skill.body);
      bodies.set(skill.slug, skill.body);
    }
    const shared = [...bodies.keys()].filter((slug) => GALLERY.filter((item) => item.skills.some((row) => row.slug === slug)).length > 1);
    expect(shared.length).toBeGreaterThan(3);
  });
});

describe('gallery and first login', () => {
  it('creates only the default assistant on first login, with its skills', async () => {
    const built = await setup();
    const agents = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: built.owner })).json().agents;
    const mine = agents.filter((agent: { ownerId: string }) => agent.ownerId === 'owner');
    expect(mine.map((agent: { name: string }) => agent.name)).toEqual(['Assistant']);
    expect(mine[0].templateId).toBe('assistant');
    expect(listSkills(built.store, mine[0].id).filter((skill) => skill.enabled).map((skill) => skill.slug)).toEqual(expect.arrayContaining(['summarize-doc', 'plan-steps']));
    const gallery = (await built.app.inject({ method: 'GET', url: '/api/gallery', cookies: built.owner })).json().personas;
    expect(gallery.find((row: { id: string }) => row.id === 'assistant').added).toBe(true);
    expect(gallery.find((row: { id: string }) => row.id === 'founder').added).toBe(false);
  });

  it('lists each persona with its latest message preview and gallery face, scoped to the account', async () => {
    const built = await setup();
    const [assistant] = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: built.owner })).json().agents;
    expect(assistant.avatarRef).toMatch(/^blob-\d$/);
    expect(assistant.lastMessage).toBeNull();
    const session = built.store.createSession({ agentId: assistant.id, title: 'Plans', ownerId: 'owner' });
    built.store.insertMessage({ sessionId: session.id, role: 'user', content: 'Plan my week', toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null });
    built.store.insertMessage({ sessionId: session.id, role: 'assistant', content: '**Here** is a   plan\nfor [Monday](https://example.com).', toolCallId: null, toolName: null, toolCalls: null, agentId: assistant.id, runId: null, imageUrl: null, routingNote: null });
    const after = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: built.owner })).json().agents[0];
    expect(after.lastMessage).toMatchObject({ role: 'assistant', text: 'Here is a plan for Monday.' });
    const theirs = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: built.member })).json().agents;
    expect(theirs.some((agent: { id: string }) => agent.id === assistant.id)).toBe(false);
  });

  it('adds a gallery persona in one click with skills, connector tools and rules; members get no shell or docker', async () => {
    const built = await setup();
    const coder = (await built.app.inject({ method: 'POST', url: '/api/gallery/coder', cookies: built.owner })).json().agent;
    expect(coder).toMatchObject({ name: 'Coder', templateId: 'coder', title: 'Writes and fixes code' });
    expect(coder.toolAllowlist).toEqual(expect.arrayContaining(['apply_patch', 'shell', 'git', 'list_dir', 'think']));
    expect(coder.systemPrompt).toMatch(/Project rule files .* are binding/);
    expect(listSkills(built.store, coder.id).filter((skill) => skill.enabled).map((skill) => skill.slug)).toEqual(expect.arrayContaining(['plan-edit-test', 'commit-hygiene', 'read-project-rules']));
    const second = (await built.app.inject({ method: 'POST', url: '/api/gallery/coder', cookies: built.owner })).json().agent;
    expect(second.name).toBe('Coder 2');

    const memberCoder = (await built.app.inject({ method: 'POST', url: '/api/gallery/coder', cookies: built.member })).json().agent;
    expect(memberCoder.toolAllowlist).not.toContain('shell');
    const admin = (await built.app.inject({ method: 'POST', url: '/api/gallery/admin', cookies: built.member })).json().agent;
    expect(admin.toolAllowlist.filter((tool: string) => tool.startsWith('docker') || tool === 'shell')).toEqual([]);
    const memberGallery = (await built.app.inject({ method: 'GET', url: '/api/gallery', cookies: built.member })).json().personas;
    expect(memberGallery.find((row: { id: string }) => row.id === 'admin').tools).not.toContain('shell');
    expect((await built.app.inject({ method: 'POST', url: '/api/gallery/nope', cookies: built.owner })).statusCode).toBe(404);
  });

  it('applies workspace rule files in the gallery Coder\u2019s system prompt', async () => {
    const built = await setup();
    const repo = tmp();
    fs.writeFileSync(path.join(repo, '.cursorrules'), 'GALLERY-CODER-RULE: always run pnpm lint.');
    fs.mkdirSync(path.join(repo, '.cursor/rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor/rules/style.mdc'), '---\nalwaysApply: true\n---\nGALLERY-MDC-RULE: tabs, not spaces.');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'GALLERY-CLAUDE-RULE: no default exports.');
    await built.app.inject({ method: 'POST', url: '/api/workspaces/folder', cookies: built.owner, payload: { path: repo, label: 'web' } });
    const coder = (await built.app.inject({ method: 'POST', url: '/api/gallery/coder', cookies: built.owner })).json().agent;
    built.store.updateAgent(coder.id, { modelId: 'model_rehearsal' });
    const chat = (await built.app.inject({ method: 'POST', url: '/api/sessions', cookies: built.owner, payload: { agentId: coder.id, title: 'x' } })).json().session;
    await built.app.inject({ method: 'PUT', url: `/api/sessions/${chat.id}/workspaces`, cookies: built.owner, payload: { items: [{ kind: 'root', id: 'prj:web' }] } });
    const run = await built.engine.startTurn({ sessionId: chat.id, agentId: coder.id, content: 'fix the header' });
    await new Promise((resolve) => { const t = setInterval(() => { if (['completed', 'failed'].includes(built.store.getRun(run.id)?.status || '')) { clearInterval(t); resolve(null); } }, 20); });
    const system = built.provider.systems.at(-1)!;
    expect(system).toContain('GALLERY-CODER-RULE');
    expect(system).toContain('GALLERY-MDC-RULE');
    expect(system).toContain('GALLERY-CLAUDE-RULE');
    expect(system).toContain('You are Coder');
  });
});

describe('built-in connectors', () => {
  it('are all present, enabled and healthy on a fresh install, with Docker for the owner only', async () => {
    const built = await setup({ docker: true });
    const report = (await built.app.inject({ method: 'GET', url: '/api/connectors', cookies: built.owner })).json();
    expect(report.builtIn.map((row: { id: string }) => row.id).sort()).toEqual(['browser', 'docker', 'fetch', 'filesystem', 'git', 'memory', 'search', 'sqlite', 'thinking', 'time', 'vercel']);
    for (const row of report.builtIn) expect({ id: row.id, enabled: row.enabled, builtIn: row.builtIn, status: row.status }).toEqual({ id: row.id, enabled: true, builtIn: true, status: 'healthy' });
    expect(report.recommended.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(['github', 'gmail', 'calendar']));
    expect(report.recommended.every((row: { connected: boolean }) => row.connected === false)).toBe(true);
    const memberReport = (await built.app.inject({ method: 'GET', url: '/api/connectors', cookies: built.member })).json();
    expect(memberReport.builtIn.map((row: { id: string }) => row.id)).not.toContain('docker');
    expect((await built.app.inject({ method: 'PATCH', url: '/api/connectors/time', cookies: built.member, payload: { enabled: false } })).statusCode).toBe(403);
  });

  it('switching a connector off removes its tools from every persona', async () => {
    const built = await setup();
    const agent = built.store.listAgents('owner')[0]!;
    expect(built.engine.tools(agent, 'chat').map((tool) => tool.name)).toEqual(expect.arrayContaining(['time_now', 'think', 'web_search']));
    await built.app.inject({ method: 'PATCH', url: '/api/connectors/time', cookies: built.owner, payload: { enabled: false } });
    await built.app.inject({ method: 'PATCH', url: '/api/connectors/search', cookies: built.owner, payload: { enabled: false } });
    const names = built.engine.tools(built.store.getAgent(agent.id)!, 'chat').map((tool) => tool.name);
    expect(names).not.toContain('time_now');
    expect(names).not.toContain('web_search');
    const report = (await built.app.inject({ method: 'GET', url: '/api/connectors', cookies: built.owner })).json();
    expect(report.builtIn.find((row: { id: string }) => row.id === 'time')).toMatchObject({ enabled: false, status: 'off' });
  });

  it('time, thinking and read-only SQLite tools work offline', async () => {
    const dir = tmp();
    const ctx = { workspace: dir, roots: [], signal: new AbortController().signal, runId: 'r1' } as unknown as ToolContext;
    expect(await timeTool().execute({ zones: ['Asia/Jerusalem'], at: '2026-11-15T10:00:00Z' }, ctx)).toMatch(/Asia\/Jerusalem: .*12:00:00/);
    await thinkTool().execute({ thought: 'list options', thought_number: 1, total_thoughts: 2 }, ctx);
    expect(await thinkTool().execute({ thought: 'pick B', thought_number: 2, total_thoughts: 2, done: true }, ctx)).toMatch(/1\. list options\n2\. pick B/);
    const db = new DatabaseSync(path.join(dir, 'shop.db'));
    db.exec("CREATE TABLE items (name TEXT, price REAL); INSERT INTO items VALUES ('tea', 3.5), ('cake', 7)");
    db.close();
    expect(await sqliteTool().execute({ path: 'shop.db', sql: 'SELECT name FROM items ORDER BY price DESC' }, ctx)).toBe('name\ncake\ntea');
    expect(await sqliteTool().execute({ path: 'shop.db', sql: 'tables' }, ctx)).toContain('items');
    await expect(sqliteTool().execute({ path: 'shop.db', sql: 'DELETE FROM items' }, ctx)).rejects.toThrow(/Read-only/);
    await expect(sqliteTool().execute({ path: 'shop.db', sql: 'SELECT 1; DROP TABLE items' }, ctx)).rejects.toThrow(/Read-only/);
    await expect(sqliteTool().execute({ path: '../../etc/x.db', sql: 'SELECT 1' }, ctx)).rejects.toThrow();
    expect(BUILTIN_CONNECTORS.find((row) => row.id === 'docker')!.ownerOnly).toBe(true);
  });
});
