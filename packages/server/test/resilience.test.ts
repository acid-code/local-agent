import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { argumentsError, isTransientModelError, transientDelayMs } from '../src/engine.js';
import type { ModelProvider } from '../src/providers.js';

const dirs: string[] = [];
beforeEach(() => { process.env.LA_TRANSIENT_BASE_MS = '5'; });
afterEach(() => { delete process.env.LA_TRANSIENT_BASE_MS; for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

type Step = { text?: string; toolCalls?: ToolCall[]; fail?: string };
class Scripted implements ModelProvider {
  steps: Step[] = [];
  calls: ChatMessage[][] = [];
  async *complete(req: { messages: ChatMessage[] }) {
    this.calls.push(JSON.parse(JSON.stringify(req.messages)));
    const step = this.steps.shift() ?? { text: 'ok' };
    if (step.fail) throw new Error(step.fail);
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-res-')); dirs.push(dir);
  const provider = new Scripted();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '12'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  return { ...built, provider, agent, session };
}
async function finished(built: Awaited<ReturnType<typeof setup>>, id: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const status = built.store.getRun(id)?.status ?? '';
    if (['completed', 'failed'].includes(status)) return built.store.getRun(id)!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

describe('transient model errors', () => {
  it('classifies dropped connections and restarts, not tool-call parse errors', () => {
    for (const text of ['fetch failed', 'TypeError: terminated', 'read ECONNRESET', 'connect ECONNREFUSED 127.0.0.1:8080', 'llama-server error (503): Loading model']) expect(isTransientModelError(text)).toBe(true);
    expect(isTransientModelError('Context size has been exceeded')).toBe(false);
    expect(transientDelayMs(1)).toBe(5);
    expect(transientDelayMs(3)).toBe(20);
  });

  it('retries the step after a dropped connection and finishes the run', async () => {
    const built = await setup();
    built.provider.steps = [{ fail: 'fetch failed' }, { fail: 'terminated' }, { text: 'Back online.' }];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'hello' });
    const run = await finished(built, row.id);
    expect(run.status).toBe('completed');
    expect(run.cursor.transientRetries).toBe(2);
    expect(built.store.listMessages(built.session.id).at(-1)!.content).toContain('Back online.');
    await built.app.close();
  });

  it('gives up cleanly after the retry cap', async () => {
    process.env.LA_TRANSIENT_RETRIES = '1';
    try {
      const built = await setup();
      built.provider.steps = [{ fail: 'fetch failed' }, { fail: 'fetch failed' }, { fail: 'fetch failed' }];
      const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'hello' });
      const run = await finished(built, row.id);
      expect(run.status).toBe('failed');
      await built.app.close();
    } finally { delete process.env.LA_TRANSIENT_RETRIES; }
  });
});

describe('malformed tool-call arguments', () => {
  it('explains where the JSON broke instead of running the tool with {}', () => {
    expect(argumentsError('read_file', '{"path":"a.txt"}')).toBeNull();
    expect(argumentsError('read_file', '')).toBeNull();
    const message = argumentsError('create_file', '{"path":"a.txt","content":"say "hi""}')!;
    expect(message).toMatch(/Nothing ran: the arguments for create_file were not valid JSON \(\d+ characters/);
    expect(message).toMatch(/escape double quotes/);
    expect(argumentsError('create_file', `{"content":"${'x'.repeat(7000)}`)).toMatch(/split it/);
    expect(argumentsError('read_file', '["a"]')).toMatch(/must be a JSON object/);
  });

  it('sends the error back as the tool result and lets the model fix the call', async () => {
    const built = await setup();
    fs.writeFileSync(path.join(built.store.getAgent(built.agent.id)!.workspacePath, 'notes.txt'), 'hello');
    built.provider.steps = [
      { toolCalls: [{ id: 'b1', name: 'read_file', arguments: '{"path": "notes.txt"' }] },
      { toolCalls: [{ id: 'b2', name: 'read_file', arguments: '{"path": "notes.txt"}' }] },
      { text: 'It says hello.' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'read notes.txt' });
    const run = await finished(built, row.id);
    expect(run.status).toBe('completed');
    const second = built.provider.calls[1]!;
    const toolReply = second.find((m) => m.role === 'tool' && m.toolCallId === 'b1');
    expect(toolReply?.content).toMatch(/not valid JSON/);
    // The malformed arguments are sent back as a valid JSON string so the chat template can render them.
    const assistant = second.find((m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'b1');
    expect(assistant).toBeTruthy();
    expect(built.store.listSteps(row.id).filter((s) => s.kind === 'tool' && s.name === 'read_file').length).toBe(1);
    expect(built.store.listSteps(row.id).some((s) => s.kind === 'contract' && /not valid JSON/.test(String(s.error)))).toBe(true);
    await built.app.close();
  });
});

describe('structured bad-argument feedback with a cap', () => {
  it('carries a machine-readable block with attempts left and slide_draft advice for big decks', () => {
    const message = argumentsError('make_slides', `{"deck":{"title":"x","slides":[${'{"title":"a"},'.repeat(600)}`, 2)!;
    const info = JSON.parse(message.split('\n').at(-1)!);
    expect(info).toMatchObject({ error: 'invalid_tool_arguments', tool: 'make_slides', attempt: 2, attempts_left: 1 });
    expect(info.fix).toMatch(/slide_draft/);
  });

  it('stops tool calls after three malformed calls and lets the model answer', async () => {
    const built = await setup();
    const bad = (id: string): ToolCall => ({ id, name: 'read_file', arguments: '{"path": ' });
    built.provider.steps = [{ toolCalls: [bad('x1')] }, { toolCalls: [bad('x2')] }, { toolCalls: [bad('x3')] }, { text: 'I could not read the file.' }];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'read notes.txt' });
    const run = await finished(built, row.id);
    expect(run.status).toBe('completed');
    expect(run.cursor.badArgs).toBe(3);
    expect(run.cursor.noTools).toBe(true);
    const tools = built.store.listMessages(built.session.id).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(tools.at(-1)).toMatch(/last try/);
    await built.app.close();
  });
});
