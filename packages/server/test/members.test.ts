import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { findContextTool } from '../src/files.js';
import { foreignPath } from '../src/accounts.js';
import type { ToolContext } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-mem-')); dirs.push(dir); return dir; }
const pw = (tag: string) => ['fixture', 'only', tag].join('-');
type Cookies = Record<string, string>;
const cookieOf = (res: { cookies: { name: string; value: string }[] }): Cookies => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });

async function setup() {
  const dir = tmp();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  const owner = cookieOf(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  const created = await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
  expect(created.statusCode).toBe(200);
  const memberId = created.json().member.id as string;
  const login = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } });
  expect(login.statusCode).toBe(200);
  return { ...built, dir, owner, member: cookieOf(login), memberId };
}

/** Owner and member each make a persona, a chat with a message, an upload, a KB collection, a note and a routine. */
async function seed(app: Awaited<ReturnType<typeof setup>>['app'], store: Awaited<ReturnType<typeof setup>>['store'], cookies: Cookies, tag: string) {
  const agent = (await app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: `${tag} helper`, systemPrompt: 'x', toolAllowlist: ['read_file', 'shell', 'docker_run', 'web_search'] } })).json().agent;
  const session = (await app.inject({ method: 'POST', url: '/api/sessions', cookies, payload: { agentId: agent.id, title: `${tag} secrets` } })).json().session;
  const message = store.insertMessage({ sessionId: session.id, role: 'user', content: `The ${tag} password hint is ZEBRA-${tag}`, toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null });
  const file = (await app.inject({ method: 'POST', url: '/api/files', cookies, payload: { name: `${tag}.txt`, contentBase64: Buffer.from(`private ${tag} file ZEBRA-${tag}`).toString('base64'), sessionId: session.id } })).json().file;
  const collection = (await app.inject({ method: 'POST', url: '/api/kb/collections', cookies, payload: { name: `${tag} kb` } })).json().collection;
  const note = (await app.inject({ method: 'POST', url: '/api/memory', cookies, payload: { agentId: agent.id, content: `${tag} likes tea` } })).json().note;
  const schedule = (await app.inject({ method: 'POST', url: '/api/schedules', cookies, payload: { agentId: agent.id, name: `${tag} daily`, cron: '0 9 * * *', prompt: 'hi' } })).json().schedule;
  const run = store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'done' } as never });
  return { agent, session, message, file, collection, note, schedule, run };
}

async function expectBlind(app: Awaited<ReturnType<typeof setup>>['app'], cookies: Cookies, other: Awaited<ReturnType<typeof seed>>) {
  const get = (url: string) => app.inject({ method: 'GET', url, cookies });
  // Lists never include the other account's rows.
  expect((await get('/api/agents')).json().agents.map((a: { id: string }) => a.id)).not.toContain(other.agent.id);
  expect((await get('/api/sessions')).json().sessions.map((s: { id: string }) => s.id)).not.toContain(other.session.id);
  expect((await get('/api/files')).json().files.map((f: { id: string }) => f.id)).not.toContain(other.file.id);
  expect((await get('/api/kb/collections')).json().collections.map((c: { id: string }) => c.id)).not.toContain(other.collection.id);
  expect((await get('/api/schedules')).json().schedules.map((s: { id: string }) => s.id)).not.toContain(other.schedule.id);
  expect((await get('/api/runs')).json().runs.map((r: { id: string }) => r.id)).not.toContain(other.run.id);
  expect((await get('/api/git/roots')).json().roots.map((r: { id: string }) => r.id)).not.toContain(`ws:${other.agent.id}`);
  const search = (await get('/api/context/search?q=ZEBRA')).json();
  expect(JSON.stringify(search)).not.toContain(other.message.id);
  expect(JSON.stringify(search)).not.toContain(other.file.id);
  // Direct reads by id are 404, the same as a missing row.
  for (const url of [
    `/api/agents/${other.agent.id}`, `/api/sessions/${other.session.id}`, `/api/files/${other.file.id}`, `/api/files/${other.file.id}/raw`,
    `/api/messages/${other.message.id}`, `/api/memory?agentId=${other.agent.id}`, `/api/runs/${other.run.id}`, `/api/kb/collections/${other.collection.id}/files`,
    `/api/agents/${other.agent.id}/files`, `/api/git/ws:${other.agent.id}/status`, `/api/sessions/${other.session.id}/plan`,
  ]) expect((await get(url)).statusCode, url).toBe(404);
  // Writes too.
  const write = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, cookies, payload });
  expect((await write('POST', `/api/sessions/${other.session.id}/messages`, { content: 'hi' })).statusCode).toBe(404);
  expect((await write('POST', '/api/sessions', { agentId: other.agent.id })).statusCode).toBe(404);
  expect((await write('PATCH', `/api/agents/${other.agent.id}`, { name: 'mine now' })).statusCode).toBe(404);
  expect((await write('DELETE', `/api/agents/${other.agent.id}`)).statusCode).toBe(404);
  expect((await write('DELETE', `/api/files/${other.file.id}`)).statusCode).toBe(404);
  expect((await write('DELETE', `/api/kb/collections/${other.collection.id}`)).statusCode).toBe(404);
  expect((await write('DELETE', `/api/memory/${other.note.id}`)).statusCode).toBe(404);
  expect((await write('DELETE', `/api/schedules/${other.schedule.id}`)).statusCode).toBe(404);
  expect((await write('POST', `/api/memory`, { agentId: other.agent.id, content: 'x' })).statusCode).toBe(404);
  expect((await write('POST', `/api/runs/${other.run.id}/control`, { action: 'stop' })).statusCode).toBe(404);
  expect((await write('POST', `/api/files`, { name: 'a.txt', contentBase64: 'YQ==', sessionId: other.session.id })).statusCode).toBe(404);
}

describe('members', () => {
  it('signs a member in with their own role, starter persona and folder', async () => {
    const { app, store, member, memberId, dir } = await setup();
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', cookies: member })).json();
    expect(me).toMatchObject({ authenticated: true, role: 'member', username: 'noa', displayName: 'Noa' });
    const agents = store.listAgents(memberId);
    expect(agents.map((agent) => agent.name)).toEqual(['Buddy']);
    expect(agents[0]!.workspacePath.startsWith(path.join(dir, 'users', memberId))).toBe(true);
  });

  it('keeps member data away from the owner and owner data away from the member', async () => {
    const ctx = await setup();
    const ownerData = await seed(ctx.app, ctx.store, ctx.owner, 'owner');
    const memberData = await seed(ctx.app, ctx.store, ctx.member, 'member');
    await expectBlind(ctx.app, ctx.member, ownerData);
    await expectBlind(ctx.app, ctx.owner, memberData);
    // Each still sees their own.
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${memberData.session.id}`, cookies: ctx.member })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/files/${ownerData.file.id}/raw`, cookies: ctx.owner })).body).toContain('ZEBRA-owner');
    // Member files and workspaces live in the member's own folder.
    const memberFile = path.join(ctx.dir, 'users', ctx.memberId, 'files', memberData.file.id, 'member.txt');
    expect(fs.readFileSync(memberFile, 'utf8')).toContain('ZEBRA-member');
    expect(memberData.agent.workspacePath.startsWith(path.join(ctx.dir, 'users', ctx.memberId, 'workspaces'))).toBe(true);
    expect(ownerData.agent.workspacePath.startsWith(path.join(ctx.dir, 'users'))).toBe(false);
    // A member's persona never gets host or Docker tools, even when asked for.
    expect(memberData.agent.toolAllowlist).toEqual(['read_file', 'web_search']);
    expect(ownerData.agent.toolAllowlist).toContain('shell');
  });

  it('blocks admin pages, keys and setup for members', async () => {
    const { app, member } = await setup();
    for (const [method, url] of [
      ['GET', '/api/settings'], ['GET', '/api/vault'], ['GET', '/api/tokens'], ['GET', '/api/mcp'], ['GET', '/api/containers'], ['GET', '/api/debug/health'],
      ['GET', '/api/logs'], ['GET', '/api/members'], ['GET', '/api/discovery'], ['GET', '/api/backups'], ['GET', '/api/resources'], ['GET', '/api/workshops'],
      ['POST', '/api/secrets'], ['POST', '/api/models/scan'], ['POST', '/api/mcp/install'], ['POST', '/api/containers/sandbox'], ['POST', '/api/git/clone'],
      ['PATCH', '/api/settings'], ['POST', '/api/members'], ['GET', '/api/triggers'], ['POST', '/api/control/kill'],
    ] as const) {
      const res = await app.inject({ method, url, cookies: member, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // The shared quota is readable.
    const quota = await app.inject({ method: 'GET', url: '/api/me/quota', cookies: member });
    expect(quota.statusCode).toBe(200);
    expect(quota.json()).toHaveProperty('cloudAllowed', true);
  });

  it('scopes the lookup tool to the persona owner', async () => {
    const ctx = await setup();
    const ownerData = await seed(ctx.app, ctx.store, ctx.owner, 'owner');
    const memberData = await seed(ctx.app, ctx.store, ctx.member, 'member');
    const tool = findContextTool();
    const toolCtx = (agentId: string, sessionId: string) => ({ store: ctx.store, agent: ctx.store.getAgent(agentId)!, sessionId, workspace: '' } as unknown as ToolContext);
    const asMember = toolCtx(memberData.agent.id, memberData.session.id);
    const found = await tool.execute({ query: 'ZEBRA', scope: 'all' }, asMember);
    expect(found).toContain(memberData.message.id);
    expect(found).not.toContain(ownerData.message.id);
    expect(found).not.toContain(ownerData.file.id);
    expect(await tool.execute({ id: ownerData.message.id }, asMember)).toMatch(/^No message/);
    expect(await tool.execute({ id: `[file:${ownerData.file.id}]` }, asMember)).toMatch(/^No file/);
    const asOwner = toolCtx(ownerData.agent.id, ownerData.session.id);
    expect(await tool.execute({ id: memberData.message.id }, asOwner)).toMatch(/^No message/);
    expect(await tool.execute({ query: 'ZEBRA-member', scope: 'all' }, asOwner)).toMatch(/^Nothing earlier/);
    // Engine tool lists: no host tools for members, no shared repos either.
    const engineTools = (ctx.engine as unknown as { tools(agent: unknown, mode?: string): { name: string }[] }).tools.bind(ctx.engine);
    const raw = ctx.store.updateAgent(memberData.agent.id, { toolAllowlist: ['shell', 'docker_run', 'read_file'] })!;
    const names = engineTools(raw, 'code').map((tool) => tool.name);
    expect(names).toContain('read_file');
    for (const banned of ['shell', 'docker_run', 'request_folder', 'handoff_cli', 'request_secret', 'run_skill_script']) expect(names).not.toContain(banned);
  });

  it('refuses paths in another account folder', () => {
    const data = '/srv/la';
    expect(foreignPath(data, 'owner', '/srv/la/users/usr_abc/workspaces/x')).toBe(true);
    expect(foreignPath(data, 'owner', '/srv/la/workspaces/coder')).toBe(false);
    expect(foreignPath(data, 'usr_abc', '/srv/la/users/usr_abc/workspaces/x')).toBe(false);
    expect(foreignPath(data, 'usr_abc', '/srv/la/users/usr_def/files')).toBe(true);
    expect(foreignPath(data, 'usr_abc', '/srv/la/workspaces/coder')).toBe(true);
    expect(foreignPath(data, 'usr_abc', '/etc')).toBe(true);
  });

  it('keeps themes per account, applies limits, and signs out disabled members', async () => {
    const { app, store, engine, owner, member, memberId, dir } = await setup();
    await app.inject({ method: 'PUT', url: '/api/me/theme', cookies: member, payload: { preset: 'sakura', decor: true } });
    await app.inject({ method: 'PUT', url: '/api/me/theme', cookies: owner, payload: { preset: 'dark' } });
    expect((await app.inject({ method: 'GET', url: '/api/me/theme', cookies: member })).json().theme).toEqual({ preset: 'sakura', decor: true });
    expect((await app.inject({ method: 'GET', url: '/api/me/theme', cookies: owner })).json().theme).toEqual({ preset: 'dark' });
    expect((await app.inject({ method: 'PUT', url: '/api/me/theme', cookies: member, payload: { preset: 'x', evil: '<script>' } })).statusCode).toBe(400);
    // Cloud off: the member's personas see local models only.
    await app.inject({ method: 'PATCH', url: `/api/members/${memberId}`, cookies: owner, payload: { limits: { cloud: false } } });
    const buddy = store.listAgents(memberId)[0]!;
    const candidates = (engine as unknown as { candidates(settings: unknown, agentId?: string): { local: boolean }[] }).candidates.bind(engine);
    expect(candidates(store.getSettings(), buddy.id).every((model) => model.local)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/me/quota', cookies: member })).json().cloudAllowed).toBe(false);
    // A member cannot change their own limits.
    expect((await app.inject({ method: 'PATCH', url: `/api/members/${memberId}`, cookies: member, payload: { limits: { cloud: true } } })).statusCode).toBe(403);
    // Disable signs them out; delete removes their folder.
    await app.inject({ method: 'PATCH', url: `/api/members/${memberId}`, cookies: owner, payload: { disabled: true } });
    expect((await app.inject({ method: 'GET', url: '/api/sessions', cookies: member })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } })).statusCode).toBe(401);
    expect(fs.existsSync(path.join(dir, 'users', memberId))).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/members/${memberId}`, cookies: owner })).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'users', memberId))).toBe(false);
    expect(store.listAgents(memberId)).toEqual([]);
  });
});
