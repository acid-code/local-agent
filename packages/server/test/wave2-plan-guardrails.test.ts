import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readChatCommand, type ChatMessage, type ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { readPlan, runGrep } from '../src/coding.js';
import type { CompletionRequest, ModelProvider } from '../src/providers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class CaptureProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  requests: { effort?: string; think?: boolean; noThink?: boolean; toolNames: string[]; messages: ChatMessage[] }[] = [];

  async *complete(req: CompletionRequest) {
    this.requests.push({
      effort: req.effort,
      think: req.think,
      noThink: req.noThink,
      toolNames: (req.tools ?? []).map((t) => t.name),
      messages: req.messages,
    });
    const step = this.steps.shift() ?? { text: 'Done.' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield {
      type: 'done' as const,
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
      toolCalls: step.toolCalls,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-w2-'));
  dirs.push(dir);
  const provider = new CaptureProvider();
  const built = await buildApp({
    dataDir: dir,
    startScheduler: false,
    serveWeb: false,
    providerOverride: () => provider as unknown as ModelProvider,
  });
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'owner', password: ['w2', 'owner', 'pass'].join('-') },
  });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({
    method: 'POST',
    url: '/api/agents',
    cookies,
    payload: { name: 'Coder', systemPrompt: 'Work carefully.', toolAllowlist: [], modelId: 'model_rehearsal' },
  })).json().agent as { id: string; ownerId: string; workspacePath: string };
  fs.writeFileSync(path.join(agent.workspacePath, 'target.txt'), 'alpha\nbeta\ngamma\n');
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  built.store.updateSession(session.id, { mode: 'code' });
  return { ...built, provider, agent, session: built.store.getSession(session.id)!, cookies };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

describe('wave 2 plan-execute guardrails & auto-effort', () => {
  it('enforces hard read-only lock in plan mode until exit_plan_mode unlocks edits and saves checks', async () => {
    const built = await setup();
    try {
      built.provider.steps = [
        { toolCalls: [call('p1', 'enter_plan_mode', { goal: 'Inspect target.txt', reason: 'Read before editing' })] },
        { toolCalls: [
          call('r1', 'read_file', { path: 'target.txt' }),
          call('w1', 'write_file', { path: 'target.txt', content: 'clobbered' }),
          call('a1', 'apply_patch', { path: 'target.txt', search: 'alpha', replace: 'ALPHA' }),
          call('g1', 'git', { action: 'commit', message: 'nope' }),
        ] },
        { toolCalls: [call('x1', 'exit_plan_mode', { steps: ['Read target', 'Update target'], checks: ['`echo ok` passes'], summary: 'Safe edit' })] },
        { toolCalls: [call('w2', 'apply_patch', { path: 'target.txt', search: 'alpha', replace: 'ALPHA' })] },
        { text: 'Updated target.txt cleanly.' },
      ];
      const run = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Plan and update target.txt',
        wait: true,
      });
      expect(run.status).toBe('completed');
      // During Turn 1 (in plan mode), editing tools were stripped from offered menu
      const planTurnTools = built.provider.requests[1]!.toolNames;
      expect(planTurnTools).not.toContain('write_file');
      expect(planTurnTools).not.toContain('apply_patch');
      expect(planTurnTools).not.toContain('tasks'); // deduplicated against plan tool
      // Attempted mutating calls were mechanically blocked, read_file succeeded
      const toolMsgs = built.store.listMessages(built.session.id).filter((m) => m.role === 'tool');
      expect(toolMsgs.find((m) => m.toolCallId === 'r1')?.content).toContain('alpha');
      expect(toolMsgs.find((m) => m.toolCallId === 'w1')?.content).toMatch(/Blocked by plan mode \(read-only\)/);
      expect(toolMsgs.find((m) => m.toolCallId === 'a1')?.content).toMatch(/Blocked by plan mode \(read-only\)/);
      expect(toolMsgs.find((m) => m.toolCallId === 'g1')?.content).toMatch(/Blocked by plan mode \(read-only\)/);
      // Turn 3 (after exit_plan_mode) offered edits and applied patch
      expect(built.provider.requests[3]!.toolNames).toContain('apply_patch');
      expect(fs.readFileSync(path.join(built.agent.workspacePath, 'target.txt'), 'utf8')).toContain('ALPHA');
      const savedPlan = readPlan(built.store, built.session.id);
      expect(savedPlan?.items.map((i) => i.text)).toEqual(['Read target', 'Update target']);
      const finalRun = built.store.getRun(run.id)!;
      expect(finalRun.cursor.stage).toBe('implement');
      expect(finalRun.cursor.acceptance).toEqual(['`echo ok` passes']);
    } finally {
      await built.app.close();
    }
  });

  it('applies stage-aware auto-effort (high in plan, medium in implement) and honors explicit session.effort', async () => {
    const built = await setup();
    try {
      built.provider.steps = [
        { toolCalls: [call('p1', 'enter_plan_mode', { goal: 'Plan work' })] },
        { toolCalls: [call('x1', 'exit_plan_mode', { steps: ['Step one'] })] },
        { text: 'All done.' },
      ];
      await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Plan and run',
        wait: true,
      });
      // Request 0: normal turn=0 -> undefined; Request 1: plan stage -> high; Request 2: implement & turn>0 -> medium
      expect(built.provider.requests[0]!.effort).toBeUndefined();
      expect(built.provider.requests[1]!.effort).toBe('high');
      expect(built.provider.requests[1]!.think).toBe(true);
      expect(built.provider.requests[2]!.effort).toBe('medium');

      // Now explicitly pin session effort = 'low'
      built.store.updateSession(built.session.id, { effort: 'low' });
      built.provider.requests = [];
      built.provider.steps = [
        { toolCalls: [call('p2', 'enter_plan_mode', { goal: 'Check override' })] },
        { text: 'Checked with explicit effort.' },
      ];
      await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Enter plan mode with low override',
        wait: true,
      });
      expect(built.provider.requests[1]!.effort).toBe('low');
    } finally {
      await built.app.close();
    }
  });

  it('breaks repeated-failure thrash loops with varying args and resets on success', async () => {
    const built = await setup();
    try {
      // Vary `search` each time so exact-args loop breaker doesn't trigger, only failStreak does.
      built.provider.steps = [
        { toolCalls: [call('f1', 'apply_patch', { path: 'target.txt', search: 'missing_1', replace: 'x' })] },
        { toolCalls: [call('f2', 'apply_patch', { path: 'target.txt', search: 'missing_2', replace: 'x' })] },
        { toolCalls: [call('f3', 'apply_patch', { path: 'target.txt', search: 'missing_3', replace: 'x' })] },
        { toolCalls: [call('f4', 'apply_patch', { path: 'target.txt', search: 'missing_4', replace: 'x' })] },
        { text: 'Stopped after thrashing on target.txt.' },
      ];
      const run = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Patch target.txt',
        wait: true,
      });
      expect(run.status).toBe('completed');
      const toolMsgs = built.store.listMessages(built.session.id).filter((m) => m.role === 'tool' && m.runId === run.id);
      expect(toolMsgs.find((m) => m.toolCallId === 'f2')?.content).toMatch(/\[thrash\] Failed twice/);
      expect(toolMsgs.find((m) => m.toolCallId === 'f3')?.content).toMatch(/\[thrash\] Re-plan stop/);
      expect(toolMsgs.find((m) => m.toolCallId === 'f4')?.content).toMatch(/\[thrash\] Re-plan stop: apply_patch failed 3 times/);
      // Next model turn was toolless (noTools = true)
      expect(built.provider.requests[4]!.toolNames).toEqual([]);

      // Also verify failStreak resets when a tool succeeds
      built.provider.requests = [];
      built.provider.steps = [
        { toolCalls: [call('s1', 'apply_patch', { path: 'target.txt', search: 'missing_a', replace: 'x' })] },
        { toolCalls: [call('s2', 'apply_patch', { path: 'target.txt', search: 'alpha', replace: 'ALPHA' })] },
        { toolCalls: [call('s3', 'apply_patch', { path: 'target.txt', search: 'missing_b', replace: 'x' })] },
        { text: 'Recovered.' },
      ];
      const run2 = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Reset on success',
        wait: true,
      });
      const msgs2 = built.store.listMessages(built.session.id).filter((m) => m.role === 'tool' && m.runId === run2.id);
      // s3 is count 1 again (not count 2), so no [thrash] nudge
      expect(msgs2.find((m) => m.toolCallId === 's3')?.content).not.toMatch(/\[thrash\]/);
    } finally {
      await built.app.close();
    }
  });

  it('parses /plan commands and rejects bare /plan without calling the model', async () => {
    expect(readChatCommand('/plan audit routing')).toEqual({
      rest: 'audit routing',
      pinName: undefined,
      unpin: false,
      smart: false,
      plan: true,
    });
    expect(readChatCommand('/smart /plan check engine')).toMatchObject({ smart: true, plan: true, rest: 'check engine' });
    expect(readChatCommand('/plan')).toMatchObject({ plan: true, rest: '' });

    const built = await setup();
    try {
      const before = built.provider.requests.length;
      const run = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: '/plan',
        wait: true,
      });
      expect(run.status).toBe('completed');
      expect(built.provider.requests.length).toBe(before);
      expect(built.store.listMessages(built.session.id).at(-1)?.content).toMatch(/Add your task after \/plan/i);
    } finally {
      await built.app.close();
    }
  });

  it('starts locked in read-only Plan mode from Turn 0 with planFirst HTTP flag, unlocks on exit_plan_mode, and updates 1-based plan items', async () => {
    const built = await setup();
    const chatSession = built.store.createSession({ agentId: built.agent.id, ownerId: built.agent.ownerId });
    try {
      built.provider.steps = [
        { toolCalls: [call('b1', 'write_file', { path: 'target.txt', content: 'early write' })] },
        { toolCalls: [call('ex1', 'exit_plan_mode', { steps: ['Inspect target', 'Apply patch'], checks: ['`npm test` passes'], summary: 'Safe change' })] },
        { toolCalls: [call('p1', 'plan', { itemId: '1', status: 'done', evidence: 'Inspected target.txt' })] },
        { toolCalls: [call('p_bad', 'plan', { itemId: '99', status: 'done', evidence: 'Invalid index' })] },
        { toolCalls: [call('p2', 'plan', { itemId: '2', status: 'done', evidence: 'Applied patch cleanly' })] },
        { text: 'Plan executed and verified.' },
      ];

      const postRes = await built.app.inject({
        method: 'POST',
        url: `/api/sessions/${chatSession.id}/messages`,
        cookies: built.cookies,
        payload: { content: 'Audit target.txt and plan the fix', planFirst: true },
      });
      expect(postRes.statusCode).toBe(200);
      const postedRun = (postRes.json() as { run: { id: string } }).run;

      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const cur = built.store.getRun(postedRun.id);
        if (cur && ['completed', 'failed'].includes(cur.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Turn 0 ran in read-only Plan mode at high effort, with exit_plan_mode offered and write_file blocked.
      expect(built.provider.requests[0]!.effort).toBe('high');
      expect(built.provider.requests[0]!.think).toBe(true);
      expect(built.provider.requests[0]!.toolNames).toContain('exit_plan_mode');
      expect(built.provider.requests[0]!.toolNames).not.toContain('write_file');

      const toolMsgs = built.store.listMessages(chatSession.id).filter((m) => m.role === 'tool' && m.runId === postedRun.id);
      expect(toolMsgs.find((m) => m.toolCallId === 'b1')?.content).toMatch(/Blocked by plan mode \(read-only\)/);
      expect(toolMsgs.find((m) => m.toolCallId === 'p1')?.content).toMatch(/1\. \[done\] Inspect target \(Inspected target\.txt\)/);
      expect(toolMsgs.find((m) => m.toolCallId === 'p_bad')?.content).toMatch(/No plan item "99"/);

      const finalPlan = readPlan(built.store, chatSession.id);
      expect(finalPlan?.items.map((i) => i.status)).toEqual(['done', 'done']);
      expect(finalPlan?.items[0]?.note).toBe('Inspected target.txt');
    } finally {
      await built.app.close();
    }
  });

  it('starts locked in read-only Plan mode on Turn 0 when prefixed with /plan', async () => {
    const built = await setup();
    const chatSession = built.store.createSession({ agentId: built.agent.id, ownerId: built.agent.ownerId });
    try {
      built.provider.steps = [
        { toolCalls: [call('b2', 'apply_patch', { path: 'target.txt', search: 'alpha', replace: 'ALPHA' })] },
        { toolCalls: [call('ex2', 'exit_plan_mode', { steps: ['Patch target.txt'], summary: 'Patch safely' })] },
        { toolCalls: [call('ok2', 'apply_patch', { path: 'target.txt', search: 'alpha', replace: 'ALPHA' }), call('pd2', 'plan', { itemId: '1', status: 'done', evidence: 'Patched alpha -> ALPHA' })] },
        { text: 'Patched after /plan.' },
      ];
      const run = await built.engine.startTurn({
        sessionId: chatSession.id,
        agentId: built.agent.id,
        content: '/plan Refactor target.txt carefully',
        wait: true,
      });
      expect(run.status).toBe('completed');
      expect(built.provider.requests[0]!.toolNames).toContain('exit_plan_mode');
      expect(built.provider.requests[0]!.toolNames).not.toContain('apply_patch');
      const toolMsgs = built.store.listMessages(chatSession.id).filter((m) => m.role === 'tool' && m.runId === run.id);
      expect(toolMsgs.find((m) => m.toolCallId === 'b2')?.content).toMatch(/Blocked by plan mode \(read-only\)/);
      expect(fs.readFileSync(path.join(built.agent.workspacePath, 'target.txt'), 'utf8')).toContain('ALPHA');
    } finally {
      await built.app.close();
    }
  });

  it('gives planning/implement/code missions at least 28 steps even with old maxSteps=12, preserves implement stage on continue, and greps single files', async () => {
    const built = await setup();
    const chatSession = built.store.createSession({ agentId: built.agent.id, ownerId: built.agent.ownerId });
    try {
      built.store.saveSettings({ ...built.store.getSettings(), maxSteps: 12 }, 'simulate old default', { maxSteps: 12 });
      expect((built.engine as any).stepCap({ stage: 'plan' }, 'chat')).toBeGreaterThanOrEqual(28);
      expect((built.engine as any).stepCap({ stage: 'implement' }, 'chat')).toBeGreaterThanOrEqual(28);
      expect((built.engine as any).stepCap({}, 'code')).toBeGreaterThanOrEqual(28);
      expect((built.engine as any).stepCap({ longTask: true }, 'chat')).toBeGreaterThanOrEqual(40);
      expect((built.engine as any).stepCap({}, 'chat')).toBeGreaterThanOrEqual(16);
      expect((built.engine as any).stepCap({ maxSteps: 8 }, 'chat')).toBe(8);

      const grepOut = await runGrep(path.join(built.agent.workspacePath, 'target.txt'), 'beta');
      expect(grepOut).toContain('target.txt:2: beta');

      built.provider.steps = [
        { toolCalls: [call('p1', 'enter_plan_mode', { goal: 'Plan two-step change' })] },
        { toolCalls: [call('x1', 'exit_plan_mode', { steps: ['Step one', 'Step two'], summary: 'Ready to implement' })] },
        { text: 'Reached limit before finishing step 1.' },
      ];
      const run1 = await built.engine.startTurn({
        sessionId: chatSession.id,
        agentId: built.agent.id,
        content: '/plan Implement change',
        wait: true,
      });
      expect(run1.cursor.stage).toBe('implement');

      built.provider.requests = [];
      built.provider.steps = [
        { toolCalls: [call('ap1', 'apply_patch', { path: 'target.txt', search: 'beta', replace: 'BETA' })] },
        { text: 'Continued and patched.' },
      ];
      const run2 = await built.engine.startTurn({
        sessionId: chatSession.id,
        agentId: built.agent.id,
        content: 'continue',
        wait: true,
      });
      expect(run2.status).toBe('completed');
      expect(built.provider.requests[0]!.toolNames).toContain('apply_patch');
      expect(fs.readFileSync(path.join(built.agent.workspacePath, 'target.txt'), 'utf8')).toContain('BETA');
    } finally {
      await built.app.close();
    }
  });
});
