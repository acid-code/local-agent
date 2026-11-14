import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isAbort, latestOnly } from '../../web/src/lib/latest.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const password = ['fixture', 'only', '08'].join('-');

async function owner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-switch-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  const setup = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password } });
  const cookies = { la_session: setup.cookies.find((item) => item.name === 'la_session')!.value };
  return { ...built, cookies };
}

describe('rapid persona switching', () => {
  it('open-chat finds or creates atomically: rapid clicks never duplicate chats', async () => {
    const { app, cookies } = await owner();
    const a = (await app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'x', toolAllowlist: [] } })).json().agent.id as string;
    const b = (await app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Bo', systemPrompt: 'x', toolAllowlist: [] } })).json().agent.id as string;
    const count = async (agentId: string) => (await app.inject({ method: 'GET', url: '/api/sessions?limit=200', cookies })).json().sessions.filter((s: { agentId: string }) => s.agentId === agentId).length;
    const before = { a: await count(a), b: await count(b) };
    // A, B, A, B … fired together, like a user hammering the sidebar.
    const clicks = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject({ method: 'POST', url: `/api/agents/${i % 2 ? b : a}/open-chat`, cookies, payload: {} })));
    const ids = clicks.map((res) => { expect(res.statusCode).toBe(200); return res.json().session.id as string; });
    expect(new Set(ids.filter((_, i) => i % 2 === 0)).size).toBe(1);
    expect(new Set(ids.filter((_, i) => i % 2 === 1)).size).toBe(1);
    expect(ids[0]).not.toBe(ids[1]);
    expect(await count(a)).toBe(Math.max(before.a, 1));
    expect(await count(b)).toBe(Math.max(before.b, 1));
    // It reopens the most recently active chat, and never another persona's.
    const newer = (await app.inject({ method: 'POST', url: '/api/sessions', cookies, payload: { agentId: a, title: 'Second' } })).json().session.id;
    const again = (await app.inject({ method: 'POST', url: `/api/agents/${a}/open-chat`, cookies, payload: {} })).json();
    expect(again).toMatchObject({ created: false, session: { id: newer, agentId: a } });
    expect((await app.inject({ method: 'POST', url: '/api/agents/nope/open-chat', cookies, payload: {} })).statusCode).toBe(404);
    await app.close();
  });

  it('latest click wins: stale responses are dropped and their requests aborted', async () => {
    const gate = latestOnly();
    const applied: string[] = [];
    const delays: Record<string, number> = { A: 40, B: 5, C: 20 };
    async function open(name: string) {
      const token = gate.begin();
      const result = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(name), delays[name]);
        token.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      }).catch((error) => { expect(isAbort(error)).toBe(true); return null; });
      if (result && token.current()) applied.push(result);
    }
    await Promise.all([open('A'), open('B'), open('C')]);
    expect(applied).toEqual(['C']);
    const first = gate.begin(); const second = gate.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
    gate.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(second.current()).toBe(false);
  });
});
