import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { checkFinalReply, recoveryHint } from '../src/recovery.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

class ScriptProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  seen: { system: string; last: string }[] = [];
  async *complete(req: { messages: ChatMessage[] }) {
    this.seen.push({ system: String(req.messages.find((m) => m.role === 'system')?.content ?? ''), last: String(req.messages[req.messages.length - 1]?.content ?? '') });
    const step = this.steps.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}
async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
}
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-rec-')); dirs.push(dir);
  const provider = new ScriptProvider();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '11'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  const run = async (steps: ScriptProvider['steps']) => {
    provider.steps = steps;
    const row = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'read notes.txt and summarize it' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    const reply = built.store.listMessages(session.id).filter((m) => m.role === 'assistant' && m.runId === row.id && m.content).pop()?.content ?? '';
    return { reply, steps: built.store.listSteps(row.id) };
  };
  fs.writeFileSync(path.join(built.store.getAgent(agent.id)!.workspacePath, 'notes.txt'), 'hello');
  return { ...built, provider, run };
}
const missing: ToolCall = { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'missing-notes.txt' }) };

describe('recovery hints', () => {
  it('gives an error-specific route and never says retry for refusals', () => {
    expect(recoveryHint('read_file', 'ENOENT: no such file')).toMatch(/check the path/);
    expect(recoveryHint('web_fetch', 'fetch failed: ETIMEDOUT')).toMatch(/retry once/);
    expect(recoveryHint('write_file', 'EACCES: permission denied')).toMatch(/not allowed/);
    expect(recoveryHint('shell', 'Blocked by guardrails.')).toMatch(/Do not retry/);
    expect(recoveryHint('x', 'weird')).toMatch(/Do not tell the user it worked/);
  });
  it('sends a false success back, then adds a note when rounds run out', () => {
    const steps = [{ kind: 'tool', name: 'write_file', status: 'failed', error: 'EACCES', index: 1, output: null }] as never[];
    expect(checkFinalReply(steps, 'Done, saved.', 0, 5).action).toBe('retry');
    expect(checkFinalReply(steps, 'Done, saved.', 2, 5).action).toBe('footer');
    expect(checkFinalReply(steps, 'Done, saved.', 0, 1).action).toBe('footer');
    expect(checkFinalReply(steps, 'I could not save it: permission denied.', 0, 5).action).toBe('ok');
    const he = checkFinalReply(steps, 'הקובץ נשמר בהצלחה', 2, 5, true);
    expect(he.action === 'footer' && he.footer).toMatch(/נכשל/);
  });
});

describe('engine never claims success after a tool error', () => {
  it('sends the false claim back and keeps the honest answer', async () => {
    const built = await setup();
    const out = await built.run([{ toolCalls: [missing] }, { text: 'Done! I read the file and summarized it.' }, { text: 'I could not read missing-notes.txt: the file does not exist.' }]);
    expect(out.reply).toBe('I could not read missing-notes.txt: the file does not exist.');
    expect(out.steps.some((step) => step.name === 'verify')).toBe(true);
    expect(built.provider.seen[1]!.last).toMatch(/\[recovery\] read_file failed/);
    expect(built.provider.seen[2]!.system).toMatch(/CHECK BEFORE ANSWERING/);
    await built.app.close();
  });
  it('adds a visible note when the model keeps claiming success', async () => {
    const built = await setup();
    const out = await built.run([{ toolCalls: [missing] }, { text: 'Done!' }, { text: 'Done!' }, { text: 'Done!' }]);
    expect(out.reply).toMatch(/^Done!\n\n⚠️ Note: read_file failed/);
    expect(out.steps.filter((step) => step.name === 'verify')).toHaveLength(2);
    await built.app.close();
  });
  it('does nothing when a retry fixed it', async () => {
    const built = await setup();
    const out = await built.run([{ toolCalls: [missing] }, { toolCalls: [{ id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) }] }, { text: 'Done, summarized.' }]);
    expect(out.reply).toBe('Done, summarized.');
    await built.app.close();
  });
});

const tasks = (id: string, args: Record<string, unknown>): ToolCall => ({ id, name: 'tasks', arguments: JSON.stringify(args) });
describe('long tasks: task list and verify-before-done', () => {
  it('refuses done without evidence, sends an early finish back, and finishes when every item is closed', async () => {
    const built = await setup();
    const out = await built.run([
      { toolCalls: [tasks('t1', { action: 'set', items: ['Read notes', 'Summarize', 'Save summary'] })] },
      { toolCalls: [tasks('t2', { action: 'update', item: 1, status: 'done' })] },
      { toolCalls: [tasks('t3', { action: 'update', item: 1, status: 'done', evidence: 'read_file returned hello' })] },
      { text: 'All finished.' },
      { toolCalls: [tasks('t4', { action: 'update', item: 2, status: 'done', evidence: 'summary is: hello' }), tasks('t5', { action: 'update', item: 3, status: 'blocked', note: 'no write access' })] },
      { text: 'Summary: hello. Could not save it: no write access.' },
    ]);
    expect(out.reply).toBe('Summary: hello. Could not save it: no write access.');
    const toolOut = built.store.listSteps(out.steps[0]!.runId).filter((step) => step.name === 'tasks');
    expect(toolOut[1]!.error).toMatch(/needs evidence/);
    expect(out.steps.filter((step) => step.name === 'verify')).toHaveLength(1);
    expect(built.provider.seen[4]!.system).toMatch(/CHECK BEFORE FINISHING[\s\S]*2\. \[pending\] Summarize/);
    expect(built.store.getRun(out.steps[0]!.runId)!.cursor.longTask).toBe(true);
    await built.app.close();
  });
});
