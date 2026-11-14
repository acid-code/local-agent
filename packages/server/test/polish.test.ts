import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FREE_TIER_SNAPSHOT, geminiQuotaDay } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { DockerCtl, MANAGED_LABEL, ROLE_LABEL, managedRole, withManagedLabels } from '../src/docker.js';
import { usableModels } from '../src/usable-models.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-polish-')); dirs.push(dir); return dir; };
const password = ['fixture', 'only', '07'].join('-');

async function owner(options: Record<string, unknown> = {}) {
  const dir = tmp();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, ...options });
  const setup = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password } });
  const cookies = { la_session: setup.cookies.find((item) => item.name === 'la_session')!.value };
  return { ...built, cookies, dir };
}

describe('managed containers', () => {
  it('labels what the app starts and recognises older installs', () => {
    expect(withManagedLabels({ [ROLE_LABEL]: 'sandbox' })).toMatchObject({ [MANAGED_LABEL]: 'true', [ROLE_LABEL]: 'sandbox' });
    expect(managedRole({ name: 'x', labels: { [MANAGED_LABEL]: 'true', [ROLE_LABEL]: 'mcp' } })).toBe('mcp');
    expect(managedRole({ name: 'local-agent-searxng', labels: {} })).toBe('search');
    expect(managedRole({ name: 'searxng', labels: { 'com.docker.compose.project': 'local-agent', 'com.docker.compose.service': 'searxng' } })).toBe('search');
    expect(managedRole({ name: 'la-mcp-github', labels: {} })).toBe('mcp');
    expect(managedRole({ name: 'postgres', labels: {} })).toBeNull();
    expect(managedRole({ name: 'searxng', labels: { 'com.docker.compose.project': 'someone-else' } })).toBeNull();
  });

  it('lists only managed containers and refuses actions on others', async () => {
    const removed: string[] = [];
    const rows = [
      { Id: 'aaaaaaaaaaaa1', Names: ['/la-sbx-1'], Image: 'alpine', State: 'running', Status: 'Up', Labels: { [MANAGED_LABEL]: 'true', [ROLE_LABEL]: 'sandbox' } },
      { Id: 'bbbbbbbbbbbb2', Names: ['/postgres'], Image: 'postgres', State: 'running', Status: 'Up', Labels: {} },
      { Id: 'cccccccccccc3', Names: ['/local-agent'], Image: 'local-agent', State: 'running', Status: 'Up', Labels: { [MANAGED_LABEL]: 'true', [ROLE_LABEL]: 'app' } },
    ];
    const ctl = new DockerCtl('/nonexistent.sock');
    Object.assign(ctl, { api: () => ({ listContainers: async () => rows, getContainer: (id: string) => ({ remove: async () => { removed.push(id); } }) }) });
    const list = await ctl.list();
    expect(list.map((row) => [row.name, row.role])).toEqual([['la-sbx-1', 'sandbox'], ['local-agent', 'app']]);
    await expect(ctl.remove('bbbbbbbbbbbb2')).rejects.toMatchObject({ statusCode: 403 });
    await expect(ctl.remove('postgres')).rejects.toMatchObject({ statusCode: 403 });
    await expect(ctl.remove('cccccccccccc3')).rejects.toMatchObject({ statusCode: 403 });
    await ctl.remove('la-sbx-1');
    expect(removed).toEqual(['aaaaaaaaaaaa1']);
  });
});

describe('usable models', () => {
  it('hides Rehearsal in production, needs a key for Gemini, and disables a model with no quota', async () => {
    const { app, store } = await owner();
    const prod = usableModels(store, { cloudAllowed: true, env: {} });
    expect([...prod.local, ...prod.cloud, ...prod.dev].some((model) => /rehearsal/i.test(model.name))).toBe(false);
    expect(prod.cloud).toEqual([]);
    expect(prod.geminiConnected).toBe(false);
    const dev = usableModels(store, { cloudAllowed: true, env: { LA_REHEARSAL: '1' } });
    expect(dev.dev.length).toBeGreaterThan(0);
    store.updateProvider('prov_gemini', { enabled: true });
    const keyed = usableModels(store, { cloudAllowed: true, env: { GEMINI_API_KEY: 'test-only' } });
    expect(keyed.geminiConnected).toBe(true);
    expect(keyed.cloud.length).toBeGreaterThan(0);
    const closed = FREE_TIER_SNAPSHOT.find((row) => row.rpd.limit === 0 && keyed.cloud.some((model) => store.listModels().find((m) => m.id === model.id)?.apiName === row.apiName));
    if (closed) expect(keyed.cloud.find((model) => store.listModels().find((m) => m.id === model.id)?.apiName === closed.apiName)?.disabled).toBe(true);
    expect(usableModels(store, { cloudAllowed: false, env: { GEMINI_API_KEY: 'test-only' } }).cloud).toEqual([]);
    await app.close();
  });

  it('starts Gemini usage at zero and only counts real calls', async () => {
    const { app, store, cookies } = await owner();
    const before = (await app.inject({ method: 'GET', url: '/api/models', cookies })).json();
    expect(before.quota.every((row: { rpd: { used: number }; rpm: { used: number } }) => row.rpd.used === 0 && row.rpm.used === 0)).toBe(true);
    expect(before.geminiConnected).toBe(Boolean(process.env.GEMINI_API_KEY));
    const api = FREE_TIER_SNAPSHOT[0]!.apiName;
    store.bumpQuota(api, geminiQuotaDay(), new Date().toISOString().slice(0, 16), 120);
    const after = (await app.inject({ method: 'GET', url: '/api/models', cookies })).json();
    expect(after.quota.find((row: { apiName: string }) => row.apiName === api).rpd.used).toBe(1);
    await app.close();
  });
});

describe('voice without Whisper', () => {
  it('answers 503 with a setup hint instead of an internal error', async () => {
    const offline = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const { app, cookies } = await owner({ fetchImpl: offline });
    const res = await app.inject({ method: 'POST', url: '/api/voice/transcribe', cookies, headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('fake audio bytes') });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'no_stt' });
    expect(res.json().hint).toMatch(/Whisper/);
    const empty = await app.inject({ method: 'POST', url: '/api/voice/transcribe', cookies, headers: { 'content-type': 'audio/webm' }, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBeLessThan(500);
    await app.close();
  });
});

describe('workspaces', () => {
  it('adds a folder, saves a set, and attaches it to a chat and a persona switch', async () => {
    const { app, store, cookies, dir } = await owner();
    const folder = path.join(dir, 'notes'); fs.mkdirSync(folder);
    const added = await app.inject({ method: 'POST', url: '/api/workspaces/folder', cookies, payload: { path: folder, label: 'notes' } });
    expect(added.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/workspaces/folder', cookies, payload: { path: 42 } });
    expect(bad.statusCode).toBe(400);
    const list = (await app.inject({ method: 'GET', url: '/api/workspaces', cookies })).json();
    expect(list.workspaces.find((row: { label: string }) => row.label === 'notes')).toMatchObject({ kind: 'folder' });
    const set = (await app.inject({ method: 'POST', url: '/api/workspaces/sets', cookies, payload: { name: 'Notes set', labels: ['notes'] } })).json();
    const setId = set.workshop?.id || set.set?.id || set.id;
    expect(setId).toBeTruthy();
    const a = store.createAgent({ name: 'A', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const b = store.createAgent({ name: 'B', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: a.id, title: 'Chat' });
    const patched = await app.inject({ method: 'PATCH', url: `/api/sessions/${session.id}`, cookies, payload: { agentId: b.id, workshopId: setId } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().session).toMatchObject({ agentId: b.id, workshopId: setId, mode: 'code' });
    const detached = await app.inject({ method: 'PATCH', url: `/api/sessions/${session.id}`, cookies, payload: { workshopId: null } });
    expect(detached.json().session.workshopId).toBeNull();
    await app.close();
  });
});

describe('chat workspaces', () => {
  it('stores workspaces per chat, pre-fills from the persona, briefs the agent, and saves files', async () => {
    const { execFileSync } = await import('node:child_process');
    const { chatWorkspaceBrief } = await import('../src/chat-workspaces.js');
    const { app, store, cookies, dir } = await owner();
    const repo = path.join(dir, 'api'); fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first commit'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'todo.md'), 'draft\n');
    expect((await app.inject({ method: 'POST', url: '/api/workspaces/folder', cookies, payload: { path: repo, label: 'api' } })).statusCode).toBe(200);
    const set = (await app.inject({ method: 'POST', url: '/api/workspaces/sets', cookies, payload: { name: 'API', labels: ['api'] } })).json();
    const setId = set.workshop?.id || set.set?.id || set.id;
    const agent = store.createAgent({ name: 'Coder', systemPrompt: 'Code.', toolAllowlist: [], workspacePath: dir });
    store.updateAgent(agent.id, { workshopIds: [setId] });

    // A new chat starts with the persona's default set.
    const chat = (await app.inject({ method: 'POST', url: '/api/sessions', cookies, payload: { agentId: agent.id } })).json().session;
    const prefilled = (await app.inject({ method: 'GET', url: `/api/sessions/${chat.id}/workspaces`, cookies })).json();
    expect(prefilled.items).toEqual([{ kind: 'set', id: setId }]);
    expect(prefilled.roots[0]).toMatchObject({ id: 'prj:api', label: 'api', branch: 'main', isRepo: true, dirty: 1, via: 'API' });

    // Edit the list: a root on its own, then check another chat is unaffected.
    const put = await app.inject({ method: 'PUT', url: `/api/sessions/${chat.id}/workspaces`, cookies, payload: { items: [{ kind: 'root', id: 'prj:api' }] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().items).toEqual([{ kind: 'root', id: 'prj:api' }]);
    expect(put.json().session.mode).toBe('code');
    const other = store.createSession({ agentId: agent.id, title: 'Other', ownerId: 'owner' });
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${other.id}/workspaces`, cookies })).json().roots).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `/api/sessions/${chat.id}/workspaces`, cookies, payload: { items: [{ kind: 'root', id: 'prj:nope' }] } })).statusCode).toBe(404);

    // The agent is told exactly this chat's workspaces.
    const brief = await chatWorkspaceBrief(store, chat.id, 'owner');
    expect(brief).toContain(`api: ${repo}`);
    expect(brief).toContain('branch main');
    expect(brief).toContain('todo.md');
    expect(brief).toContain('first commit');
    expect(await chatWorkspaceBrief(store, other.id, 'owner')).toBe('');

    // Inline editor saves inside the workspace only; the diff shows it.
    const saved = await app.inject({ method: 'PUT', url: '/api/git/prj:api/file', cookies, payload: { path: 'todo.md', content: 'done\n' } });
    expect(saved.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(repo, 'todo.md'), 'utf8')).toBe('done\n');
    expect((await app.inject({ method: 'PUT', url: '/api/git/prj:api/file', cookies, payload: { path: '../escape.txt', content: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/git/prj:api/file', cookies, payload: { path: '.git/config', content: 'x' } })).statusCode).toBe(400);
    const diff = (await app.inject({ method: 'GET', url: '/api/git/prj:api/diff?path=todo.md', cookies })).json().diff;
    expect(diff).toContain('+done');
    await app.close();
  });
});
