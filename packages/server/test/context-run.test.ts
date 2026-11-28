import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestToolOutput, planContext, type ContextSourceMessage, type ChatMessage, type ToolCall, type ToolDefinition } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const base = { strategy: 'hierarchical+retrieval' as const, contextWindow: 32768, practicalBudget: 30000, outputReserve: 2048, system: 'sys', pinned: [], summaries: [], retrieved: [], tokenizer: 'approx' as const };
const fileBody = (lines: number) => Array.from({ length: lines }, (_, i) => `${i + 1}: ${i % 25 === 0 ? `export function f${i}() {` : `  const v${i} = compute(${i});`}`).join('\n');

function history(): ContextSourceMessage[] {
  const out: ContextSourceMessage[] = [];
  for (let i = 0; i < 6; i += 1) out.push({ id: `old_u${i}`, role: 'user', content: `old question ${i}` }, { id: `old_a${i}`, role: 'assistant', content: `old answer ${i}` });
  out.push({ id: 'u', role: 'user', content: 'migrate storage to R2' });
  for (let i = 0; i < 10; i += 1) out.push({ id: `a${i}`, role: 'assistant', content: '' }, { id: `t${i}`, role: 'tool', content: i === 0 ? fileBody(400) : `result ${i}` });
  return out;
}

describe('run-aware context planning', () => {
  it('keeps every message of the current run (the old window kept only the last 14)', () => {
    const messages = history();
    const runIds = messages.slice(12).map((m) => m.id);
    const plan = planContext({ ...base, messages, run: { messageIds: runIds } });
    const ids = plan.recent.map((m) => m.id);
    for (const id of runIds) expect(ids).toContain(id);
    expect(ids.indexOf('u')).toBeLessThan(ids.indexOf('t9'));
  });

  it('keeps a long tool result of this run whole instead of cutting it at 4,000 characters', () => {
    const messages = history();
    const plan = planContext({ ...base, messages, run: { messageIds: messages.slice(12).map((m) => m.id) } });
    const t0 = plan.recent.find((m) => m.id === 't0')!;
    expect(t0.content.length).toBeGreaterThan(8000);
    expect(t0.content).toContain('400:');
  });

  it('turns the oldest tool results into digests when the run outgrows the budget, and keeps them digests', () => {
    const messages: ContextSourceMessage[] = [{ id: 'u', role: 'user', content: 'read all files' }];
    for (let i = 0; i < 6; i += 1) messages.push({ id: `a${i}`, role: 'assistant', content: '' }, { id: `t${i}`, role: 'tool', content: fileBody(300) });
    const small = { ...base, practicalBudget: 12000 };
    const first = planContext({ ...small, messages, run: { messageIds: messages.map((m) => m.id) } });
    expect(first.digestIds!.length).toBeGreaterThan(0);
    expect(first.digestIds).not.toContain('t5');
    const digested = first.recent.find((m) => m.id === first.digestIds![0])!;
    expect(digested.content).toMatch(/digest: .* not shown; outline of the hidden part/);
    expect(digested.content).toMatch(/export function f\d+/);
    expect(digested.content).toContain(`read_output message=${first.digestIds![0]}`);
    // The next step, with one more small result, renders the same earlier messages byte for byte.
    const next = planContext({ ...small, messages: [...messages, { id: 'a6', role: 'assistant', content: '' }, { id: 't6', role: 'tool', content: 'ok' }], run: { messageIds: [...messages.map((m) => m.id), 'a6', 't6'], digestIds: first.digestIds, historyFloorId: first.historyFloorId } });
    expect(next.recent.slice(0, first.recent.length)).toEqual(first.recent);
  });

  it('fixes the oldest history message for the run, so later steps do not shift the prefix', () => {
    const messages = history();
    const runIds = messages.slice(12, 14).map((m) => m.id);
    const first = planContext({ ...base, messages: messages.slice(0, 14), run: { messageIds: runIds } });
    expect(first.historyFloorId).toBe('old_u0');
    const later = planContext({ ...base, messages, run: { messageIds: messages.slice(12).map((m) => m.id), historyFloorId: first.historyFloorId } });
    expect(later.recent[0]!.id).toBe('old_u0');
    const none = planContext({ ...base, messages, run: { messageIds: messages.slice(12).map((m) => m.id), historyFloorId: '' } });
    expect(none.recent[0]!.id).toBe('u');
  });

  it('never opens the history with a tool result whose call was cut off', () => {
    const messages: ContextSourceMessage[] = [
      { id: 'a_old', role: 'assistant', content: 'x'.repeat(200_000) },
      { id: 't_old', role: 'tool', content: 'old result' },
      { id: 'u', role: 'user', content: 'next' },
    ];
    const plan = planContext({ ...base, messages, run: { messageIds: ['u'] } });
    expect(plan.recent[0]!.role).not.toBe('tool');
  });

  it('digests keep the head, an outline and the tail', () => {
    const text = fileBody(500);
    const digest = digestToolOutput(text, 'msg_1');
    expect(digest.length).toBeLessThan(5000);
    expect(digest.startsWith('1: export function f0')).toBe(true);
    expect(digest).toContain('500:');
  });
});

class Recorder implements ModelProvider {
  steps: ({ text?: string; toolCalls?: ToolCall[]; thinking?: string; onCall?: () => void } | ((callIndex: number) => { text?: string; toolCalls?: ToolCall[]; thinking?: string }))[] = [];
  calls: ChatMessage[][] = [];
  tools: string[][] = [];
  async *complete(req: { messages: ChatMessage[]; tools?: ToolDefinition[] }) {
    const idx = this.calls.length;
    this.calls.push(JSON.parse(JSON.stringify(req.messages)));
    this.tools.push((req.tools ?? []).map((t) => t.name));
    const entry = this.steps.shift();
    const step = typeof entry === 'function' ? entry(idx) : (entry ?? { text: 'ok' });
    if (typeof entry !== 'function') entry?.onCall?.();
    if (step.thinking) yield { type: 'thinking' as const, text: step.thinking };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ctx-')); dirs.push(dir);
  const provider = new Recorder();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  // Treat the scripted model like llama-server (prompt-cache friendly).
  (built.engine as unknown as { cacheFriendly: () => boolean }).cacheFriendly = () => true;
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '12'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  fs.writeFileSync(path.join(built.store.getAgent(agent.id)!.workspacePath, 'notes.txt'), 'hello');
  return { ...built, provider, agent, session };
}
async function waitFor(check: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
}

describe('append-only prompt for cache-friendly models', () => {
  it('each step only appends: earlier messages are byte-identical, notes are pinned once, reasoning goes back', async () => {
    const built = await setup();
    const read = (id: string, file: string): ToolCall => ({ id, name: 'read_file', arguments: JSON.stringify({ path: file }) });
    built.provider.steps = [
      { thinking: 'Read notes first.', toolCalls: [read('c1', 'notes.txt')] },
      { toolCalls: [read('c2', 'missing.txt')] },
      { text: 'Done! Everything worked.' },
      { text: 'I read notes.txt, but missing.txt does not exist.' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'read notes.txt and missing.txt' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    expect(built.store.getRun(row.id)!.status).toBe('completed');
    const calls = built.provider.calls;
    expect(calls.length).toBe(4);
    for (let i = 1; i < calls.length; i += 1) {
      const prev = calls[i - 1]!;
      const cur = calls[i]!;
      // Everything the previous call sent comes back unchanged, except that a pinned note may be appended to its last message.
      expect(cur.slice(0, prev.length - 1)).toEqual(prev.slice(0, -1));
      expect(cur[prev.length - 1]!.content.startsWith(prev.at(-1)!.content)).toBe(true);
    }
    const last = calls.at(-1)!;
    expect(last.filter((m) => /CHECK BEFORE ANSWERING/.test(m.content)).length).toBe(1);
    expect(last.find((m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'c1')!.reasoning).toBe('Read notes first.');
    await built.app.close();
  });

  it('preserves prefix, reasoning, and tools when mid-run steering arrives on cache-friendly models', async () => {
    const built = await setup();
    const read = (id: string, file: string): ToolCall => ({ id, name: 'read_file', arguments: JSON.stringify({ path: file }) });
    let activeRunId = '';
    let steered = false;
    built.provider.steps = [
      {
        thinking: 'Checking notes first.',
        toolCalls: [read('c1', 'notes.txt')],
        onCall: () => {
          if (steered) return;
          steered = true;
          const active = built.store.listSessionRuns(built.session.id, 4).find((r) => ['running', 'paused'].includes(r.status));
          if (active) {
            activeRunId = active.id;
            built.engine.steer(active.id, 'make a slides presentation — actually it is a mini pc');
          }
        },
      },
      { text: 'Understood, it is a mini PC.' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'check notes.txt' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    expect(built.store.getRun(row.id)!.status).toBe('completed');
    expect(activeRunId).toBe(row.id);
    expect(built.provider.calls.length).toBe(2);
    // Token-0 tools list must stay identical (no mid-run seedTools mutation).
    expect(built.provider.tools[1]).toEqual(built.provider.tools[0]);
    // Prefix from Turn 0 must remain byte-identical at the front of Turn 1.
    const prev = built.provider.calls[0]!;
    const cur = built.provider.calls[1]!;
    expect(cur.slice(0, prev.length)).toEqual(prev);
    // Prior assistant reasoning stays intact and steering arrives once via <note>, not as a mid-run user turn.
    const priorAssistant = cur.find((m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'c1')!;
    expect(priorAssistant.reasoning).toBe('Checking notes first.');
    const userMessagesInPrompt = cur.filter((m) => m.role === 'user');
    expect(userMessagesInPrompt.length).toBe(1);
    const steerNotes = cur.filter((m) => m.content.includes('actually it is a mini pc'));
    expect(steerNotes.length).toBe(1);
    expect(steerNotes[0]!.role).toBe('tool');
    expect(steerNotes[0]!.content).toContain('<note>');
    // The UI/DB still preserves the user's steering message.
    const dbSteer = built.store.listMessages(built.session.id).find((m) => m.routingNote === 'Steering');
    expect(dbSteer?.content).toBe('make a slides presentation — actually it is a mini pc');
    await built.app.close();
  });

  it('keeps summarized-chat historyFloorId pinned across Turn 0 and Turn 1', async () => {
    const built = await setup();
    const m1 = built.store.insertMessage({ sessionId: built.session.id, role: 'user', content: 'old q1', toolCallId: null, toolName: null, toolCalls: null, agentId: built.agent.id, runId: null, imageUrl: null, routingNote: null });
    const m2 = built.store.insertMessage({ sessionId: built.session.id, role: 'assistant', content: 'old a1', toolCallId: null, toolName: null, toolCalls: null, agentId: built.agent.id, runId: null, imageUrl: null, routingNote: null });
    const m3 = built.store.insertMessage({ sessionId: built.session.id, role: 'user', content: 'old q2', toolCallId: null, toolName: null, toolCalls: null, agentId: built.agent.id, runId: null, imageUrl: null, routingNote: null });
    const m4 = built.store.insertMessage({ sessionId: built.session.id, role: 'assistant', content: 'old a2', toolCallId: null, toolName: null, toolCalls: null, agentId: built.agent.id, runId: null, imageUrl: null, routingNote: null });
    const m5 = built.store.insertMessage({ sessionId: built.session.id, role: 'user', content: 'old q3', toolCallId: null, toolName: null, toolCalls: null, agentId: built.agent.id, runId: null, imageUrl: null, routingNote: null });
    built.store.insertMessage({ sessionId: built.session.id, role: 'assistant', content: 'old a3', toolCallId: null, toolName: null, toolCalls: null, agentId: built.agent.id, runId: null, imageUrl: null, routingNote: null });
    // Cover m1..m4 so Turn 0's tailStart (last 4 messages) starts inside the covered range (at m4).
    built.store.addSummary({ sessionId: built.session.id, level: 2, version: 1, content: 'Prior summary', covers: [m1.id, m2.id, m3.id, m4.id], foldedInto: null, tokenEstimate: 10 });
    void m5;
    const read = (id: string, file: string): ToolCall => ({ id, name: 'read_file', arguments: JSON.stringify({ path: file }) });
    built.provider.steps = [
      { thinking: 'Read notes.', toolCalls: [read('c1', 'notes.txt')] },
      { text: 'All done.' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'read notes again' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    expect(built.store.getRun(row.id)!.status).toBe('completed');
    expect(built.provider.calls.length).toBe(2);
    const prev = built.provider.calls[0]!;
    const cur = built.provider.calls[1]!;
    expect(cur[1]!.content).toBe(prev[1]!.content);
    expect(cur.slice(0, prev.length)).toEqual(prev);
    await built.app.close();
  });

  it('keeps the token-0 tool menu identical across consecutive runs in a cache-friendly session', async () => {
    const built = await setup();
    built.provider.steps = [{ text: 'First answer.' }, { text: 'Second answer.' }];
    const r1 = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'check prices online' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(r1.id)?.status ?? ''));
    const r2 = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'make a slides presentation with fetch_image and shell' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(r2.id)?.status ?? ''));
    expect(built.provider.tools.length).toBe(2);
    expect(built.provider.tools[1]).toEqual(built.provider.tools[0]);
    expect(built.provider.tools[0]).not.toContain('find_tools');
    expect(built.provider.tools[0]).toContain('make_slides');
    await built.app.close();
  });
});

describe('cache stats in the trace and monitor', () => {
  it('reads llama telemetry off model steps and totals the cache hit rate', async () => {
    const { cacheStats, stepPerf } = await import('../src/monitor.js');
    const steps = [
      { kind: 'model', output: { text: '', telemetry: { promptTokens: 1000, cachedTokens: 900, cacheHitPct: 90, promptEvalTokens: 100, promptEvalMs: 400, tokPerSec: 25 } } },
      { kind: 'model', output: { text: '', telemetry: { promptTokens: 1000, cachedTokens: 0, cacheHitPct: 0, promptEvalTokens: 1000, promptEvalMs: 5000 } } },
      { kind: 'tool', output: 'x' },
    ] as never[];
    expect(stepPerf(steps[0]!)).toMatchObject({ cacheHitPct: 90, promptEvalMs: 400 });
    expect(stepPerf(steps[2]!)).toBeUndefined();
    expect(cacheStats(steps)).toEqual({ steps: 2, promptTokens: 2000, cachedTokens: 900, hitPct: 45, promptEvalMs: 5400 });
  });
});
