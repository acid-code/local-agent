import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { splitThinking } from '../src/engine.js';
import { providerFor, type ModelProvider, type ProviderEvent } from '../src/providers.js';
import type { Store } from '../src/db.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-fix-'));
  dirs.push(dir);
  return dir;
}

export function addLocal(store: Store, id: string, name: string, size: 'small' | 'large' = 'small', budget = 4096) {
  store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
  store.upsertModel({
    id, providerId: 'prov_ollama', name, apiName: name, profileId: id, tokenizer: 'approx', contextWindow: 32768, practicalBudget: budget,
    strategy: 'rolling', sizeClass: size, local: true, modalities: ['text'], strengths: ['chat'], typicalQ4GiB: 1,
    priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: 'test', source: 'test', embedding: false, freeTier: null, enabled: true,
  });
}

function ndjson(lines: object[]) {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

async function collect(stream: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const ollamaRow = { id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: null, enabled: true, createdAt: '' };

describe('thinking models', () => {
  it('keeps Ollama thinking apart from the answer and reads tool calls from any chunk', async () => {
    const fetchImpl = async () => ndjson([
      { message: { role: 'assistant', content: '', thinking: 'Let me think.' }, done: false },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'kb_search', arguments: { query: 'heron' } } }] }, done: false },
      { message: { role: 'assistant', content: 'Answer.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 5, eval_count: 3 },
    ]);
    const model = { apiName: 'qwen3:0.6b', profileId: 'x' } as never;
    const events = await collect(providerFor(model, ollamaRow as never, fetchImpl as typeof fetch).complete({ model: 'qwen3:0.6b', messages: [{ role: 'user', content: 'hi' }] }));
    expect(events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join('')).toBe('Let me think.');
    expect(events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('')).toBe('Answer.');
    const done = events.at(-1) as Extract<ProviderEvent, { type: 'done' }>;
    expect(done.toolCalls?.[0]?.name).toBe('kb_search');
    expect(done.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it('splits inline think blocks', () => {
    expect(splitThinking('<think>hmm</think>\n\nHello')).toEqual({ answer: 'Hello', reasoning: 'hmm' });
    expect(splitThinking('<think>never closed')).toEqual({ answer: '', reasoning: 'never closed' });
    expect(splitThinking('plain')).toEqual({ answer: 'plain', reasoning: '' });
  });

  it('retries once with thinking off after an empty answer, then says so instead of a blank reply', async () => {
    const dir = tmp();
    const thinks: (boolean | undefined)[] = [];
    const noThinks: boolean[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      async *complete(req) {
        thinks.push(req.think);
        noThinks.push(Boolean(req.noThink));
        calls += 1;
        yield { type: 'thinking', text: 'thinking only' };
        if (calls === 3) yield { type: 'token', text: 'Second chat works.' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    addLocal(store, 'main', 'qwen3:0.6b', 'large');
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Think' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Please explain the workshop to a new teammate.', wait: true });
    expect(run.status).toBe('completed');
    expect(thinks[1]).toBe(false);
    expect(noThinks).toEqual([false, true]);
    const answer = store.listMessages(session.id).at(-1)!;
    expect(answer.role).toBe('assistant');
    expect(answer.content).toMatch(/only produced reasoning/);
    expect(answer.content).not.toMatch(/thinking only/);
    const steps = store.listSteps(run.id).filter((step) => step.kind === 'model');
    expect(JSON.stringify(steps.at(-1)?.output)).toMatch(/thinking only/);
    const second = store.createSession({ agentId: agent.id, title: 'Two' });
    await engine.startTurn({ sessionId: second.id, agentId: agent.id, content: 'Please explain the workshop to a new teammate.', wait: true });
    expect(store.listMessages(second.id).at(-1)?.content).toBe('Second chat works.');
    await app.close();
  });
});
