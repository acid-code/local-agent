/** The open chat's live feed: runs started anywhere show up, helpers and other chats stay out, reconnects resync. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { sessionEventFilter } from '../src/session-events.js';

const dirs: string[] = [];
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pw = (tag: string) => ['fixture', 'only', tag].join('-');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-sync-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  apps.push(built.app);
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } });
  const cookie = res.cookies.find((item) => item.name === 'la_session')!.value;
  const owner = { la_session: cookie };
  const agent = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: owner })).json().agents[0];
  const mk = async (title: string) => (await built.app.inject({ method: 'POST', url: '/api/sessions', cookies: owner, payload: { agentId: agent.id, title } })).json().session;
  const chat = await mk('Open chat');
  const other = await mk('Other chat');
  return { ...built, owner, cookie, agent, chat, other };
}

/** Reads SSE data events from a live HTTP response until `count` arrive (or the timeout). */
async function readEvents(res: Response, count: number, timeoutMs = 3000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) events.push(JSON.parse(data));
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

describe('chat live feed', () => {
  it('filters to this chat, keeps helper runs and tokens out unless asked', async () => {
    const { store, agent, chat, other } = await setup();
    const top = store.createRun({ sessionId: chat.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    const helper = store.createRun({ sessionId: chat.id, agentId: agent.id, parentRunId: top.id, configVersion: 1, cursor: { phase: 'model' } as never });
    const elsewhere = store.createRun({ sessionId: other.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    const web = sessionEventFilter(store, chat.id, { tokens: false });
    expect(web({ type: 'status', runId: top.id, status: 'running' })).toMatchObject({ sessionId: chat.id, status: 'running' });
    expect(web({ type: 'status', runId: helper.id, status: 'running' })).toBeNull();
    expect(web({ type: 'status', runId: elsewhere.id, status: 'running' })).toBeNull();
    expect(web({ type: 'token', runId: top.id, text: 'hi' })).toBeNull();
    expect(web({ type: 'context', sessionId: chat.id })).not.toBeNull();
    expect(web({ type: 'context', sessionId: other.id })).toBeNull();
    // A run created after the first lookup is still found (no negative caching of missing runs).
    expect(web({ type: 'status', runId: 'run_not_yet', status: 'running' })).toBeNull();
    const phone = sessionEventFilter(store, chat.id, { tokens: true });
    expect(phone({ type: 'token', runId: top.id, text: 'hi' })).toMatchObject({ text: 'hi' });
  });

  it('streams a snapshot, then a run started elsewhere, its message and done, within a second', async () => {
    const { app, store, bus, cookie, agent, chat, other } = await setup();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/sessions/${chat.id}/events`, { headers: { cookie: `la_session=${cookie}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const started = Date.now();
    const reading = readEvents(res, 4);
    await new Promise((r) => setTimeout(r, 100));
    const run = store.createRun({ sessionId: chat.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    const otherRun = store.createRun({ sessionId: other.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    bus.publish({ type: 'status', runId: otherRun.id, status: 'running' });
    bus.publish({ type: 'status', runId: run.id, status: 'running', sessionId: chat.id });
    bus.publish({ type: 'token', runId: run.id, text: 'streamed on the run stream only' });
    const message = store.insertMessage({ sessionId: chat.id, role: 'assistant', content: 'Hello from the phone', toolCallId: null, toolName: null, toolCalls: null, agentId: agent.id, runId: run.id, imageUrl: null, routingNote: null } as never);
    bus.publish({ type: 'message', runId: run.id, message });
    bus.publish({ type: 'done', runId: run.id, run: { ...run, status: 'completed' } });
    const events = await reading;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'status', 'message', 'done']);
    expect(events[0]).toMatchObject({ sessionId: chat.id, activeRun: null, messages: [] });
    expect(events[1]).toMatchObject({ runId: run.id, sessionId: chat.id });
    expect((events[2].message as { content: string }).content).toBe('Hello from the phone');
  });

  it('resyncs on reconnect: the new snapshot has the active run and the messages missed while away', async () => {
    const { app, store, cookie, agent, chat } = await setup();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const run = store.createRun({ sessionId: chat.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    store.updateRun(run.id, { status: 'running' });
    store.insertMessage({ sessionId: chat.id, role: 'user', content: 'sent while this laptop slept', toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null } as never);
    const res = await fetch(`${address}/api/sessions/${chat.id}/events`, { headers: { cookie: `la_session=${cookie}` } });
    const [snap] = await readEvents(res, 1);
    expect(snap).toMatchObject({ type: 'snapshot', activeRun: { id: run.id, status: 'running' } });
    expect((snap.messages as { content: string }[]).map((m) => m.content)).toContain('sent while this laptop slept');
  });

  it('refuses other accounts and unknown chats', async () => {
    const { app, chat } = await setup();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    expect((await fetch(`${address}/api/sessions/${chat.id}/events`)).status).toBe(401);
    const { cookie } = { cookie: 'nope' };
    expect([401, 404]).toContain((await fetch(`${address}/api/sessions/ses_missing/events`, { headers: { cookie: `la_session=${cookie}` } })).status);
  });
});
