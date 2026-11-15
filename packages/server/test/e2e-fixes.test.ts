/** Server-side regressions for the bugs the Playwright suite found. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); delete process.env.LA_DISK_RESERVE_BYTES; });
const pw = (tag: string) => ['fixture', 'only', tag].join('-');
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-fix-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  const owner = cookieOf(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  const agent = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: owner })).json().agents[0];
  const session = (await built.app.inject({ method: 'POST', url: '/api/sessions', cookies: owner, payload: { agentId: agent.id, title: 't' } })).json().session;
  return { ...built, owner, agent, session };
}

describe('found by e2e', () => {
  it('pages long chats: newest page first, then older pages by cursor, no gaps or repeats', async () => {
    const { app, store, owner, session } = await setup();
    for (let i = 1; i <= 230; i += 1) store.insertMessage({ sessionId: session.id, role: 'user', content: `m${i}`, toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null });
    const first = (await app.inject({ method: 'GET', url: `/api/sessions/${session.id}?limit=100`, cookies: owner })).json();
    expect(first.messages.length).toBe(100);
    expect(first.hasMore).toBe(true);
    expect(first.messages.at(-1).content).toBe('m230');
    const seen = first.messages.map((m: { content: string }) => m.content);
    let before = first.messages[0].id;
    for (;;) {
      const page = (await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/messages?before=${before}&limit=100`, cookies: owner })).json();
      seen.unshift(...page.messages.map((m: { content: string }) => m.content));
      if (!page.hasMore) break;
      before = page.messages[0].id;
    }
    expect(seen).toEqual(Array.from({ length: 230 }, (_, i) => `m${i + 1}`));
    await app.close();
  });

  it('reports a full disk as a clear 507, not "Internal error"', async () => {
    const { app, owner } = await setup();
    process.env.LA_DISK_RESERVE_BYTES = String(10 ** 16);
    const upload = await app.inject({ method: 'POST', url: '/api/files', cookies: owner, payload: { name: 'a.txt', contentBase64: 'YQ==' } });
    expect(upload.statusCode).toBe(507);
    expect(upload.json().error).toMatch(/disk|space/i);
    const backup = await app.inject({ method: 'POST', url: '/api/backups', cookies: owner, payload: {} });
    expect(backup.statusCode).toBe(507);
    await app.close();
  });

  it('tells a reopened page about the reply still running in that chat', async () => {
    const { app, store, owner, agent, session } = await setup();
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, cookies: owner })).json().activeRun).toBeNull();
    const run = store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, cookies: owner })).json().activeRun).toMatchObject({ id: run.id, status: 'running' });
    store.updateRun(run.id, { status: 'completed' });
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, cookies: owner })).json().activeRun).toBeNull();
    await app.close();
  });

  it('lets members open their persona chat, list models and their workspaces (these were 403s)', async () => {
    const { app, owner } = await setup();
    await app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', password: pw('member') } });
    const member = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
    const mine = (await app.inject({ method: 'GET', url: '/api/agents', cookies: member })).json().agents[0];
    const opened = await app.inject({ method: 'POST', url: `/api/agents/${mine.id}/open-chat`, cookies: member, payload: {} });
    expect(opened.statusCode).toBe(200);
    const sid = opened.json().session.id;
    for (const url of ['/api/models/usable', '/api/workspaces', `/api/sessions/${sid}/workspaces`]) expect((await app.inject({ method: 'GET', url, cookies: member })).statusCode, url).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/models/usable', cookies: member })).json().canManage).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/workspaces/folder', cookies: member, payload: { path: '/tmp' } })).statusCode).toBe(403);
    await app.close();
  });
});
