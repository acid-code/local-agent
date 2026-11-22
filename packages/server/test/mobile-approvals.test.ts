/** Approvals as the phone app and push notifications use them: list with chat + risk, open one, decide once. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { approvalSummary, riskFromReason } from '../src/approval-view.js';
import { shouldNotifyApproval } from '../src/notify.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pw = (tag: string) => ['fixture', 'only', tag].join('-');
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-mob-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
  const owner = cookieOf(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  const agent = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: owner })).json().agents[0];
  const session = (await built.app.inject({ method: 'POST', url: '/api/sessions', cookies: owner, payload: { agentId: agent.id, title: 'Marketplace' } })).json().session;
  const run = built.store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'model' } as never });
  built.store.updateRun(run.id, { status: 'awaiting_approval' });
  const approval = built.store.createApproval({ runId: run.id, toolCallId: 'c1', toolName: 'shell', args: { command: 'rm -rf build', apiKey: 'sk-secret-value' }, reason: '[medium risk] Shell command changes or deletes files: rm -rf build' });
  return { ...built, owner, agent, session, run, approval };
}

describe('mobile approvals', () => {
  it('lists pending approvals with chat, persona, risk and a redacted summary', async () => {
    const { app, owner, session, approval } = await setup();
    const list = (await app.inject({ method: 'GET', url: '/api/approvals', cookies: owner })).json().approvals;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: approval.id, risk: 'medium', sessionId: session.id, sessionTitle: 'Marketplace', summary: 'rm -rf build' });
    expect(JSON.stringify(list)).not.toContain('sk-secret-value');
    const one = await app.inject({ method: 'GET', url: `/api/approvals/${approval.id}`, cookies: owner });
    expect(one.statusCode).toBe(200);
    expect(one.json().approval.id).toBe(approval.id);
    await app.close();
  });

  it('refuses strangers and members who do not own the run', async () => {
    const { app, owner, approval } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/approvals' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, payload: { decision: 'approve' } })).statusCode).toBe(401);
    await app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', password: pw('member') } });
    const member = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
    const memberList = await app.inject({ method: 'GET', url: '/api/approvals', cookies: member });
    expect(memberList.statusCode === 403 || memberList.json().approvals.length === 0).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/approvals/${approval.id}`, cookies: member })).statusCode).toBeOneOf([403, 404]);
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, cookies: member, payload: { decision: 'approve' } })).statusCode).toBeOneOf([403, 404]);
    await app.close();
  });

  it('decides once; a stale second tap gets 409 and does not flip the decision', async () => {
    const { app, owner, store, approval } = await setup();
    const deny = await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, cookies: owner, payload: { decision: 'deny' } });
    expect(deny.statusCode).toBe(200);
    const late = await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, cookies: owner, payload: { decision: 'approve' } });
    expect(late.statusCode).toBe(409);
    expect(store.getApproval(approval.id)!.status).toBe('denied');
    expect((await app.inject({ method: 'GET', url: '/api/approvals', cookies: owner })).json().approvals).toEqual([]);
    await app.close();
  });

  it('reads the risk tier from the reason, unknown counts as high', () => {
    expect(riskFromReason('[low risk] x')).toBe('low');
    expect(riskFromReason('[HIGH risk] push')).toBe('high');
    expect(riskFromReason('Start coding from this plan.')).toBe('high');
    expect(approvalSummary('git', { action: 'push', token: 'ghp_x' })).toBe('push');
  });

  it('notifies once per pending approval and never for decided ones', () => {
    const seen = new Map<string, number>();
    expect(shouldNotifyApproval({ id: 'a', status: 'pending' }, seen)).toBe(true);
    expect(shouldNotifyApproval({ id: 'a', status: 'pending' }, seen)).toBe(false);
    expect(shouldNotifyApproval({ id: 'b', status: 'approved' }, seen)).toBe(false);
    expect(shouldNotifyApproval({ id: 'c', status: 'denied' }, seen)).toBe(false);
  });
});
