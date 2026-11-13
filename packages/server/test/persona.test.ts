import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_MAX_BYTES, sniffImage } from '../src/avatars.js';
import { buildApp } from '../src/app.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('personas', () => {
  it('creates, updates, reorders, and hides a persona', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-persona-'));
    dirs.push(dir);
    const { app } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '01'].join('-') } });
    const cookie = setup.cookies.find((item) => item.name === 'la_session')!.value;
    const created = await app.inject({
      method: 'POST', url: '/api/agents', cookies: { la_session: cookie },
      payload: { name: 'Iris', description: 'Researcher', systemPrompt: 'Be careful.', toolAllowlist: ['read_file'] },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().agent.id as string;
    const patched = await app.inject({
      method: 'PATCH', url: `/api/agents/${id}`, cookies: { la_session: cookie },
      payload: { title: 'Research lead', accent: '#9ec0e0', emoji: '🔭', avatarKind: 'builtin', avatarRef: 'iris', pinned: true, hidden: true },
    });
    expect(patched.statusCode).toBe(200);
    const agent = patched.json().agent;
    expect(agent.title).toBe('Research lead');
    expect(agent.accent).toBe('#9ec0e0');
    expect(agent.emoji).toBe('🔭');
    expect(agent.avatarKind).toBe('builtin');
    expect(agent.pinned).toBe(true);
    expect(agent.hidden).toBe(true);
    const bad = await app.inject({
      method: 'PATCH', url: `/api/agents/${id}`, cookies: { la_session: cookie },
      payload: { accent: 'blue' },
    });
    expect(bad.statusCode).toBe(400);
    const second = await app.inject({
      method: 'POST', url: '/api/agents', cookies: { la_session: cookie },
      payload: { name: 'Oak', systemPrompt: 'Operate.', toolAllowlist: [] },
    });
    await app.inject({ method: 'PATCH', url: `/api/agents/${id}`, cookies: { la_session: cookie }, payload: { pinned: false } });
    const order = await app.inject({
      method: 'POST', url: '/api/agents/reorder', cookies: { la_session: cookie },
      payload: { ids: [second.json().agent.id, id] },
    });
    const names = order.json().agents.map((item: { name: string }) => item.name).filter((name: string) => name === 'Oak' || name === 'Iris');
    expect(names[0]).toBe('Oak');
    await app.close();
  });

  it('accepts a small PNG and rejects the wrong type or an oversized file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-avatar-'));
    dirs.push(dir);
    const { app } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '01'].join('-') } });
    const cookie = setup.cookies.find((item) => item.name === 'la_session')!.value;
    const created = await app.inject({
      method: 'POST', url: '/api/agents', cookies: { la_session: cookie },
      payload: { name: 'Luma', systemPrompt: 'Hi.', toolAllowlist: [] },
    });
    const id = created.json().agent.id as string;
    expect(sniffImage(PNG)).toBe('png');
    const ok = await app.inject({
      method: 'POST', url: `/api/agents/${id}/avatar`, cookies: { la_session: cookie },
      payload: { contentBase64: PNG.toString('base64') },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().agent.avatarKind).toBe('upload');
    const fetched = await app.inject({ method: 'GET', url: `/api/agents/${id}/avatar`, cookies: { la_session: cookie } });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toMatch(/png/);
    const wrong = await app.inject({
      method: 'POST', url: `/api/agents/${id}/avatar`, cookies: { la_session: cookie },
      payload: { contentBase64: Buffer.from('not an image').toString('base64') },
    });
    expect(wrong.statusCode).toBe(400);
    const huge = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(AVATAR_MAX_BYTES)]);
    const oversized = await app.inject({
      method: 'POST', url: `/api/agents/${id}/avatar`, cookies: { la_session: cookie },
      payload: { contentBase64: huge.toString('base64') },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error).toMatch(/512 KB/);
    await app.close();
  });
});
