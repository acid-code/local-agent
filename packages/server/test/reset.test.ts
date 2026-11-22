import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { ScriptedProvider } from '../src/providers.js';
import { RESET_PHRASE } from '../src/reset.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-reset-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => new ScriptedProvider([{ text: 'hello back' }]) as unknown as ModelProvider });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '12'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  return { ...built, dir, cookies, agent };
}
const count = (built: Awaited<ReturnType<typeof setup>>, table: string) => Number((built.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe('fresh-start reset', () => {
  it('dry run counts, confirm needs the phrase, then chats and history go and the rest stays', async () => {
    const built = await setup();
    const session = built.store.createSession({ agentId: built.agent.id, ownerId: built.agent.ownerId });
    await built.engine.startTurn({ sessionId: session.id, agentId: built.agent.id, content: 'hi', wait: true });
    const agentsBefore = count(built, 'agents');
    expect(count(built, 'messages')).toBeGreaterThan(0);

    const dry = (await built.app.inject({ method: 'POST', url: '/api/admin/reset', cookies: built.cookies, payload: {} })).json();
    expect(dry.dryRun).toBe(true);
    expect(dry.counts.find((row: { table: string }) => row.table === 'chat_sessions').rows).toBe(1);
    expect(dry.total).toBeGreaterThan(2);
    expect(count(built, 'messages')).toBeGreaterThan(0);

    const wrong = await built.app.inject({ method: 'POST', url: '/api/admin/reset', cookies: built.cookies, payload: { confirm: true, phrase: 'yes' } });
    expect(wrong.statusCode).toBe(400);
    expect(count(built, 'chat_sessions')).toBe(1);

    const done = (await built.app.inject({ method: 'POST', url: '/api/admin/reset', cookies: built.cookies, payload: { confirm: true, phrase: RESET_PHRASE } })).json();
    expect(done.dryRun).toBe(false);
    expect(fs.existsSync(done.backup.file)).toBe(true);
    for (const table of ['chat_sessions', 'messages', 'runs', 'run_steps']) expect(count(built, table)).toBe(0);
    expect(count(built, 'agents')).toBe(agentsBefore);
    expect(count(built, 'models')).toBeGreaterThan(0);
    // The app still works after a reset.
    const fresh = built.store.createSession({ agentId: built.agent.id, ownerId: built.agent.ownerId });
    const run = await built.engine.startTurn({ sessionId: fresh.id, agentId: built.agent.id, content: 'hi again', wait: true });
    expect(built.store.getRun(run.id)?.status).toBe('completed');
    await built.app.close();
  });

  it('members cannot reset', async () => {
    const built = await setup();
    const anon = await built.app.inject({ method: 'POST', url: '/api/admin/reset', payload: {} });
    expect([401, 403]).toContain(anon.statusCode);
    const pw = ['fixture', 'member', '12'].join('-');
    await built.app.inject({ method: 'POST', url: '/api/members', cookies: built.cookies, payload: { username: 'noa', password: pw } });
    const login = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw } });
    const member = { la_session: login.cookies.find((item) => item.name === 'la_session')!.value };
    expect((await built.app.inject({ method: 'POST', url: '/api/admin/reset', cookies: member, payload: {} })).statusCode).toBe(403);
    expect((await built.app.inject({ method: 'POST', url: '/api/admin/reset', cookies: member, payload: { confirm: true, phrase: RESET_PHRASE } })).statusCode).toBe(403);
    await built.app.close();
  });

  it('refuses while a reply is running', async () => {
    const built = await setup();
    const session = built.store.createSession({ agentId: built.agent.id, ownerId: built.agent.ownerId });
    built.engine.busyRuns = () => 1;
    const busy = await built.app.inject({ method: 'POST', url: '/api/admin/reset', cookies: built.cookies, payload: { confirm: true, phrase: RESET_PHRASE } });
    expect(busy.statusCode).toBe(409);
    expect(built.store.getSession(session.id)).toBeTruthy();
    await built.app.close();
  });
});
