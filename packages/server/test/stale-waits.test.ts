/** "Secret request waiting" / approval notices clear when nobody can answer them any more. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SECRET_REQUEST_TTL_MS } from '../src/engine.js';

const dirs: string[] = [];
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pw = (tag: string) => ['fixture', 'only', tag].join('-');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-stale-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  apps.push(built.app);
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } });
  const owner = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: owner })).json().agents[0];
  const chat = async (title: string) => (await built.app.inject({ method: 'POST', url: '/api/sessions', cookies: owner, payload: { agentId: agent.id, title } })).json().session;
  const run = (sessionId: string, status: string) => {
    const row = built.store.createRun({ sessionId, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
    built.store.updateRun(row.id, { status });
    return row;
  };
  const ask = (runId: string, name: string) => built.vault.createRequest({ runId, name, scope: 'agent', scopeId: agent.id, reason: 'test' });
  const pendingNames = async () => (await built.app.inject({ method: 'GET', url: '/api/vault', cookies: owner })).json().requests.map((r: { name: string }) => r.name).sort();
  return { ...built, owner, agent, chat, run, ask, pendingNames };
}

describe('stale secret requests and approvals', () => {
  it('keeps only requests a live run is waiting on; ended, failed, stopped, missing runs and deleted chats expire', async () => {
    const { chat, run, ask, pendingNames, store, app, owner } = await setup();
    const open = await chat('Open');
    const gone = await chat('Deleted');
    ask(run(open.id, 'awaiting_secret').id, 'LIVE_KEY');
    for (const status of ['stopped', 'failed', 'cancelled', 'interrupted', 'completed']) ask(run(open.id, status).id, `${status.toUpperCase()}_KEY`);
    ask('run_that_no_longer_exists', 'MISSING_KEY');
    ask(run(gone.id, 'awaiting_secret').id, 'ARCHIVED_KEY');
    store.updateSession(gone.id, { archived: true });
    expect(await pendingNames()).toEqual(['LIVE_KEY']);
    // Expired rows are kept for the record, marked expired (not deleted, not "denied by the owner").
    const statuses = store.db.prepare("SELECT status, COUNT(*) AS n FROM secret_requests GROUP BY status").all() as { status: string; n: number }[];
    expect(Object.fromEntries(statuses.map((row) => [row.status, row.n]))).toEqual({ pending: 1, expired: 7 });
    void app; void owner;
  });

  it('a request older than a day is denied, so the waiting run carries on and the notice clears', async () => {
    const { chat, run, ask, pendingNames, store } = await setup();
    const open = await chat('Open');
    const request = ask(run(open.id, 'awaiting_secret').id, 'OLD_KEY');
    store.db.prepare('UPDATE secret_requests SET created_at = ? WHERE id = ?').run(new Date(Date.now() - SECRET_REQUEST_TTL_MS - 60_000).toISOString(), request.id);
    expect(await pendingNames()).toEqual([]);
    expect((store.db.prepare('SELECT status FROM secret_requests WHERE id = ?').get(request.id) as { status: string }).status).toBe('denied');
  });

  it('stopping a run clears its request at once and tells open clients', async () => {
    const { chat, run, ask, engine, bus, vault } = await setup();
    const open = await chat('Open');
    const waiting = run(open.id, 'awaiting_secret');
    const request = ask(waiting.id, 'STOP_KEY');
    const seen: unknown[] = [];
    bus.subscribeAll((event) => { if (event.type === 'secret') seen.push(event); });
    engine.stop(waiting.id);
    expect(vault.getRequest(request.id)?.status).toBe('expired');
    expect(seen).toContainEqual(expect.objectContaining({ requestId: request.id, status: 'expired' }));
  });

  it('dismissing from the notice denies it once; a second tap is harmless; unknown ids are 404', async () => {
    const { app, owner, chat, run, ask, vault } = await setup();
    const open = await chat('Open');
    const request = ask(run(open.id, 'awaiting_secret').id, 'DISMISS_KEY');
    const first = await app.inject({ method: 'POST', url: `/api/secret-requests/${request.id}`, cookies: owner, payload: { deny: true } });
    expect(first.json()).toMatchObject({ ok: true, status: 'denied' });
    expect(vault.getRequest(request.id)?.status).toBe('denied');
    const again = await app.inject({ method: 'POST', url: `/api/secret-requests/${request.id}`, cookies: owner, payload: { deny: true } });
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/secret-requests/srq_nope', cookies: owner, payload: { deny: true } })).statusCode).toBe(404);
  });

  it('approvals of a stopped run leave the approvals list (phone tab and badge)', async () => {
    const { app, owner, chat, run, store } = await setup();
    const open = await chat('Open');
    const stopped = run(open.id, 'stopped');
    const live = run(open.id, 'awaiting_approval');
    const stale = store.createApproval({ runId: stopped.id, toolCallId: 'c1', toolName: 'create_file', args: { path: 'a.txt' }, reason: '[low risk] create a file' });
    const fresh = store.createApproval({ runId: live.id, toolCallId: 'c2', toolName: 'shell', args: { command: 'ls' }, reason: '[low risk] list' });
    const ids = (await app.inject({ method: 'GET', url: '/api/approvals', cookies: owner })).json().approvals.map((a: { id: string }) => a.id);
    expect(ids).toEqual([fresh.id]);
    expect(store.getApproval(stale.id)?.status).toBe('expired');
  });
});
