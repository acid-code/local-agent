import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { falseSuccess, scrub, sinceOf } from '../src/monitor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); delete process.env.LA_MONITOR_TOKEN; delete process.env.LA_MONITOR_MEMBER_CONTENT; });
const pw = (tag: string) => ['fixture', tag, '11'].join('-');
const step = (index: number, name: string, status: string, error: string | null = null) => ({ kind: 'tool', name, status, error, index });

describe('false-success detection', () => {
  it('flags a success claim after an unrecovered tool error', () => {
    expect(falseSuccess([step(1, 'shell', 'failed', 'exit 1')], 'Done! The backup was created.', 'completed').flagged).toBe(true);
    expect(falseSuccess([step(1, 'write_file', 'failed', 'EACCES')], 'הקובץ נשמר בהצלחה', 'completed').flagged).toBe(true);
  });
  it('does not flag honest replies, recovered failures, or failed runs', () => {
    expect(falseSuccess([step(1, 'shell', 'failed', 'exit 1')], 'The command failed with exit 1; I could not create the backup.', 'completed').flagged).toBe(false);
    expect(falseSuccess([step(1, 'shell', 'failed', 'exit 1'), step(2, 'shell', 'completed')], 'Done, the backup was created.', 'completed').flagged).toBe(false);
    expect(falseSuccess([step(1, 'shell', 'failed', 'exit 1')], 'Done.', 'failed').flagged).toBe(false);
    expect(falseSuccess([step(1, 'shell', 'completed')], 'Done.', 'completed').flagged).toBe(false);
  });
  it('parses since as relative or absolute time', () => {
    expect(Date.parse(sinceOf('2h'))).toBeGreaterThan(Date.now() - 2 * 3_600_000 - 5000);
    expect(sinceOf('2026-11-01T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(Date.parse(sinceOf('junk'))).toBeLessThan(Date.now() - 23 * 3_600_000);
  });
  it('scrubs token shapes', () => {
    const text = scrub(`ghp_${'a'.repeat(36)} xoxb-1234567890-abcdef Bearer abcdefghijklmnop lam_${'b'.repeat(20)}`);
    expect(text).not.toMatch(/a{36}|1234567890-abcdef|abcdefghijklmnop|b{20}/);
  });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-mon-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
  const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
  const member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
  return { ...built, owner, member };
}
function fakeRun(built: Awaited<ReturnType<typeof setup>>, ownerId: string | null, opts: { reply: string; toolError?: string; args?: unknown }) {
  const agent = ownerId ? built.store.listAgents().find((row) => row.ownerId === ownerId)! : built.store.listAgents()[0]!;
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  const run = built.store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { turn: 0, phase: 'done' } as never });
  built.store.addStep({ runId: run.id, kind: 'model', name: 'qwen3:4b', status: 'completed', input: { budget: 8000, estimated: 1200 }, output: null, toolCallId: null, turn: 0, tokensIn: 1200, tokensOut: 80, latencyMs: 900, costUsd: 0, error: null, startedAt: new Date().toISOString() });
  built.store.addStep({ runId: run.id, kind: 'tool', name: 'shell', status: opts.toolError ? 'failed' : 'completed', input: opts.args ?? { command: 'ls' }, output: opts.toolError ?? 'ok', toolCallId: 'c1', turn: 0, tokensIn: 0, tokensOut: 0, latencyMs: 40, costUsd: 0, error: opts.toolError ?? null, startedAt: new Date().toISOString() });
  built.store.insertMessage({ sessionId: session.id, role: 'user', content: 'private question about my health', toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: run.id, imageUrl: null, routingNote: null });
  built.store.insertMessage({ sessionId: session.id, role: 'assistant', content: opts.reply, toolCallId: null, toolName: null, toolCalls: null, agentId: agent.id, runId: run.id, imageUrl: null, routingNote: null });
  built.store.updateRun(run.id, { status: 'completed', endedAt: new Date(Date.now() + 1500).toISOString() });
  return { run, agent };
}

describe('remote monitoring API', () => {
  it('needs a token (or the owner session), is read-only, and tokens are owner-managed', async () => {
    const built = await setup();
    expect((await built.app.inject({ method: 'GET', url: '/api/monitor/summary' })).statusCode).toBe(401);
    expect((await built.app.inject({ method: 'GET', url: '/api/monitor/summary', headers: { authorization: 'Bearer lam_wrongwrongwrongwrong' } })).statusCode).toBe(401);
    expect((await built.app.inject({ method: 'POST', url: '/api/monitor-tokens', cookies: built.member, payload: {} })).statusCode).toBe(403);
    expect((await built.app.inject({ method: 'GET', url: '/api/monitor/summary', cookies: built.member })).statusCode).toBe(403);
    const { token, id } = (await built.app.inject({ method: 'POST', url: '/api/monitor-tokens', cookies: built.owner, payload: { label: 'phone' } })).json() as { token: string; id: string };
    const auth = { authorization: `Bearer ${token}` };
    expect((await built.app.inject({ method: 'GET', url: '/api/monitor/summary', headers: auth })).statusCode).toBe(200);
    expect((await built.app.inject({ method: 'POST', url: '/api/monitor/summary', headers: auth })).statusCode).toBe(405);
    // A monitor token is not a session: the rest of the API stays closed.
    expect((await built.app.inject({ method: 'GET', url: '/api/agents', headers: auth })).statusCode).toBe(401);
    const listed = (await built.app.inject({ method: 'GET', url: '/api/monitor-tokens', cookies: built.owner })).json().tokens as { id: string; lastUsedAt: string | null }[];
    expect(listed[0]).toMatchObject({ id });
    expect(JSON.stringify(listed)).not.toContain(token);
    await built.app.inject({ method: 'DELETE', url: `/api/monitor-tokens/${id}`, cookies: built.owner });
    expect((await built.app.inject({ method: 'GET', url: '/api/monitor/summary', headers: auth })).statusCode).toBe(401);
    process.env.LA_MONITOR_TOKEN = 'env-monitor-token-0123456789';
    expect((await built.app.inject({ method: 'GET', url: '/api/monitor/health', headers: { authorization: 'Bearer env-monitor-token-0123456789' } })).statusCode).toBe(200);
    await built.app.close();
  });

  it('traces runs with tool calls and flags false success; secrets are redacted', async () => {
    const built = await setup();
    process.env.LA_MONITOR_TOKEN = 'env-monitor-token-0123456789';
    const auth = { authorization: 'Bearer env-monitor-token-0123456789' };
    const secret = `ghp_${'Z'.repeat(36)}`;
    const { run } = fakeRun(built, null, { reply: 'Done! Backup created.', toolError: `permission denied using ${secret}`, args: { command: 'backup', api_key: 'sk-live-123456789abc' } });
    const trace = (await built.app.inject({ method: 'GET', url: `/api/monitor/runs/${run.id}/trace`, headers: auth })).json();
    expect(trace.falseSuccess.flagged).toBe(true);
    expect(trace.run).toMatchObject({ status: 'completed', toolErrors: 1, falseSuccess: true, account: 'owner' });
    expect(trace.steps.map((row: { kind: string }) => row.kind)).toEqual(['model', 'tool']);
    expect(trace.steps[0].prompt).toMatchObject({ estimated: 1200 });
    const body = JSON.stringify(trace);
    expect(body).not.toContain('Z'.repeat(36));
    expect(body).not.toContain('sk-live-123456789abc');
    const runs = (await built.app.inject({ method: 'GET', url: '/api/monitor/runs?flagged=1', headers: auth })).json().runs as { id: string }[];
    expect(runs.map((row) => row.id)).toContain(run.id);
    const summary = (await built.app.inject({ method: 'GET', url: '/api/monitor/summary?since=1h', headers: auth })).json();
    expect(summary.runs).toBe(1);
    expect(summary.falseSuccess).toHaveLength(1);
    expect(summary.toolFailures).toEqual({ shell: 1 });
    const errors = (await built.app.inject({ method: 'GET', url: '/api/monitor/errors?since=1h', headers: auth })).json();
    expect(errors.toolErrors[0]).toMatchObject({ tool: 'shell' });
    expect(JSON.stringify(errors)).not.toContain('Z'.repeat(36));
    const health = (await built.app.inject({ method: 'GET', url: '/api/monitor/health', headers: auth })).json();
    expect(Array.isArray(health.checks)).toBe(true);
    expect(health).toHaveProperty('memory');
    expect(health).toHaveProperty('activeRuns');
    await built.app.close();
  });

  it('hides member chat content, tool args and results by default', async () => {
    const built = await setup();
    process.env.LA_MONITOR_TOKEN = 'env-monitor-token-0123456789';
    const auth = { authorization: 'Bearer env-monitor-token-0123456789' };
    const memberId = built.store.listAgents().find((row) => row.ownerId !== 'owner')!.ownerId;
    const { run } = fakeRun(built, memberId, { reply: 'Here is my private advice about your health', args: { command: 'cat diary.txt' } });
    const trace = (await built.app.inject({ method: 'GET', url: `/api/monitor/runs/${run.id}/trace`, headers: auth })).json();
    expect(trace.memberContentHidden).toBe(true);
    expect(trace.run.account).toBe('member');
    const body = JSON.stringify(trace);
    expect(body).not.toContain('private advice');
    expect(body).not.toContain('diary.txt');
    process.env.LA_MONITOR_MEMBER_CONTENT = '1';
    expect(JSON.stringify((await built.app.inject({ method: 'GET', url: `/api/monitor/runs/${run.id}/trace`, headers: auth })).json())).toContain('diary.txt');
    await built.app.close();
  });
});
