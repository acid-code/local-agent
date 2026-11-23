import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('chat list actions', () => {
  it('deletes a chat by archiving it, and renames one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ux-'));
    dirs.push(dir);
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '02'].join('-') } });
    const cookies = { la_session: setup.cookies.find((item) => item.name === 'la_session')!.value };
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const keep = store.createSession({ agentId: agent.id, title: 'Keep' });
    const drop = store.createSession({ agentId: agent.id, title: 'Drop' });
    const renamed = await app.inject({ method: 'PATCH', url: `/api/sessions/${keep.id}`, cookies, payload: { title: 'Kept and renamed' } });
    expect(renamed.json().session.title).toBe('Kept and renamed');
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${drop.id}`, cookies });
    expect(del.statusCode).toBe(200);
    expect(store.getSession(drop.id)?.archived).toBe(true);
    const perm = store.createSession({ agentId: agent.id, title: 'Gone forever' });
    store.insertMessage({ sessionId: perm.id, role: 'user', content: 'bye', toolCallId: null, toolName: null, toolCalls: null, agentId: agent.id, runId: null, imageUrl: null, routingNote: null, thinking: null });
    const permDel = await app.inject({ method: 'DELETE', url: `/api/sessions/${perm.id}?permanent=1`, cookies });
    expect(permDel.statusCode).toBe(200);
    expect(store.getSession(perm.id)).toBeNull();
    expect(store.listMessages(perm.id)).toEqual([]);
    const list = await app.inject({ method: 'GET', url: '/api/sessions', cookies });
    expect(list.json().sessions.map((row: { id: string }) => row.id)).toEqual([keep.id]);
    const again = await app.inject({ method: 'DELETE', url: '/api/sessions/ses_missing', cookies });
    expect(again.statusCode).toBe(404);
    await app.close();
  });
});

describe('source lists', () => {
  it('reads web_search and kb_search output', async () => {
    const { parseSources, toolSummary } = await import('@local-agent/shared');
    const web = parseSources('web_search', 'Partial results: 1 engine did not answer: x.\n\n1. Ollama docs\nhttps://ollama.com/docs\nRun models locally.\n\n2. SearXNG\nhttps://searxng.org\nMeta search.');
    expect(web.map((s) => [s.n, s.title, s.url])).toEqual([[1, 'Ollama docs', 'https://ollama.com/docs'], [2, 'SearXNG', 'https://searxng.org']]);
    const kb = parseSources('kb_search', '[1] codename-kb · notes.md · Intro\nThe codename is BLUE HERON.\n\n[2] edge-kb · a.txt\nOther.');
    expect(kb[0]).toEqual({ n: 1, title: 'codename-kb · notes.md · Intro', url: null, snippet: 'The codename is BLUE HERON.' });
    expect(parseSources('shell', 'ls')).toEqual([]);
    expect(toolSummary('x'.repeat(200), 10)).toHaveLength(10);
  });
});
