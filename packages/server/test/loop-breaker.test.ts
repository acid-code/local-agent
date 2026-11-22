import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { stableJson } from '../src/engine.js';
import type { ModelProvider } from '../src/providers.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

class Scripted implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  tools: number[] = [];
  last: { role: string; content: string }[] = [];
  async *complete(req: { tools?: unknown[]; messages: { role: string; content: string }[] }) {
    this.tools.push(req.tools?.length ?? 0);
    this.last = req.messages;
    const step = this.steps.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-loop-')); dirs.push(dir);
  const provider = new Scripted();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '12'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  fs.writeFileSync(path.join(built.store.getAgent(agent.id)!.workspacePath, 'notes.txt'), 'first');
  return { ...built, provider, agent, session };
}
async function finished(built: Awaited<ReturnType<typeof setup>>, id: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const row = built.store.getRun(id);
    if (row && ['completed', 'failed', 'waiting_approval'].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

describe('loop breaker', () => {
  it('compares arguments with sorted keys at every level', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('nudges on the 3rd identical call and stops tools on the 4th, then the run answers and ends', async () => {
    const built = await setup();
    const read = (id: string) => call(id, 'read_file', { path: 'notes.txt' });
    built.provider.steps = [{ toolCalls: [read('r1')] }, { toolCalls: [read('r2')] }, { toolCalls: [read('r3')] }, { toolCalls: [read('r4')] }, { text: 'The file says first. I kept re-reading it.' }];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'what does notes.txt say' });
    const run = await finished(built, row.id);
    expect(run.status).toBe('completed');
    expect(built.store.listSteps(row.id).filter((s) => s.kind === 'tool' && s.name === 'read_file').length).toBe(1);
    const toolMessages = built.store.listMessages(built.session.id).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolMessages[1]).toMatch(/Already ran read_file/);
    expect(toolMessages[2]).toMatch(/\[loop\] This is call 3/);
    expect(toolMessages[3]).toMatch(/Stopped: this is the 4th identical read_file call/);
    expect(built.store.listSteps(row.id).some((s) => s.kind === 'contract' && s.name === 'loop')).toBe(true);
    expect(built.provider.tools.at(-1)).toBe(0);
    expect(built.provider.tools[0]).toBeGreaterThan(0);
    await built.app.close();
  });

  it('runs a repeated read again after something changed in between', async () => {
    const built = await setup();
    built.provider.steps = [
      { toolCalls: [call('a', 'read_file', { path: 'notes.txt' })] },
      { toolCalls: [call('b', 'write_file', { path: 'notes.txt', content: 'second' })] },
      { toolCalls: [call('c', 'read_file', { path: 'notes.txt' })] },
      { text: 'It now says second.' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'update notes.txt' });
    const run = await finished(built, row.id);
    expect(run.status).toBe('completed');
    const reads = built.store.listSteps(row.id).filter((s) => s.kind === 'tool' && s.name === 'read_file' && s.status === 'completed');
    expect(reads.length).toBe(2);
    expect(String(reads[1]!.output)).toContain('second');
    await built.app.close();
  });
});

describe('plan acceptance checks in a run', () => {
  it('a plan with checks blocks the first "done" until the check was looked at', async () => {
    const built = await setup();
    built.store.updateSession(built.session.id, { mode: 'code' } as never);
    built.provider.steps = [
      { toolCalls: [call('p1', 'plan', { items: ['Update notes'], checks: ['notes.txt says first'] })] },
      { text: 'All done.' },
      { toolCalls: [call('r1', 'read_file', { path: 'notes.txt' })] },
      { text: 'Done: notes.txt says first (pass).' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'check notes' });
    const run = await finished(built, row.id);
    expect(run.status).toBe('completed');
    expect(run.cursor.acceptance).toEqual(['notes.txt says first']);
    expect(built.store.listSteps(row.id).some((s) => s.kind === 'contract' && /Acceptance checks/.test(String(s.output)))).toBe(true);
    await built.app.close();
  });
});
