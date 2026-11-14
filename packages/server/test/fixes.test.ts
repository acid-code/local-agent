import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { splitThinking } from '../src/engine.js';
import { providerFor, type ModelProvider, type ProviderEvent } from '../src/providers.js';
import type { Store } from '../src/db.js';
import { decideAuto, foldCandidates, likelyNeedsTools, nextAutoTier, DEFAULT_AUTO_MAP } from '@local-agent/shared';
import { doctorChecks, geminiStateOf } from '../src/debug.js';

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

describe('models without tool calls', () => {
  it('retries on the next tier once, then sends no tools to that model, and skips it when a tool is likely needed', async () => {
    const dir = tmp();
    const seen: { model: string; tools: number }[] = [];
    const provider: ModelProvider = {
      async *complete(req) {
        seen.push({ model: req.model, tools: req.tools?.length ?? 0 });
        if (req.model === 'smollm2:135m' && req.tools?.length) throw new Error('Ollama failed (400): {"error":"registry.ollama.ai/library/smollm2:135m does not support tools"}');
        yield { type: 'token', text: `from ${req.model}` };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    addLocal(store, 'fast', 'smollm2:135m', 'small', 2048);
    addLocal(store, 'main', 'qwen3:0.6b', 'large', 8192);
    store.saveSettings({ ...store.getSettings(), autoModels: { ...store.getSettings().autoModels, fast: 'smollm2:135m', main: 'qwen3:0.6b' } }, 'test', {});
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: ['web_search'], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Tools' });
    const first = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hi', wait: true });
    expect(first.status).toBe('completed');
    expect(store.listMessages(session.id).at(-1)?.content).toBe('from qwen3:0.6b');
    expect(store.getRun(first.id)?.routingNote).toMatch(/smollm2:135m cannot use tools/);
    expect(store.getSettings().toolSupport['smollm2:135m']).toBe(false);

    const second = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello', wait: true });
    expect(second.status).toBe('completed');
    expect(seen.at(-1)).toEqual({ model: 'smollm2:135m', tools: 0 });

    const third = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'search ollama', wait: true });
    expect(third.status).toBe('completed');
    expect(seen.at(-1)?.model).toBe('qwen3:0.6b');
    expect(seen.at(-1)?.tools).toBeGreaterThan(0);
    await app.close();
  });

  it('guesses when a turn needs tools', () => {
    expect(likelyNeedsTools('hi')).toBe(false);
    expect(likelyNeedsTools('thanks, that helps')).toBe(false);
    expect(likelyNeedsTools('search the web for ollama')).toBe(true);
    expect(likelyNeedsTools('read https://example.com')).toBe(true);
    expect(likelyNeedsTools('What is the secret bird name?', { kb: true })).toBe(true);
    expect(likelyNeedsTools('What is the secret bird name?')).toBe(false);
  });

  it('walks the Auto ladder for a retry', () => {
    const model = (id: string, size: 'small' | 'large', kind = 'openai_compat', local = true) => ({ id, name: id, apiName: id, local, embedding: false, sizeClass: size, providerKind: kind, practicalBudget: 4096, enabled: true });
    const models = [model('tiny', 'small'), model('big', 'large'), model('rehearsal', 'small', 'rehearsal', false)];
    const map = { ...DEFAULT_AUTO_MAP, fast: 'tiny', main: 'big' };
    expect(nextAutoTier({ role: 'fast', map, models, currentId: 'tiny' })?.id).toBe('big');
    expect(nextAutoTier({ role: 'main', map, models, currentId: 'big' })?.id).toBe('tiny');
    expect(nextAutoTier({ role: 'fast', map, models, currentId: 'tiny', exclude: new Set(['big']) })).toBeUndefined();
  });
});

describe('models removed from Ollama', () => {
  it('marks the model missing and falls back to the next tier with a note', async () => {
    const dir = tmp();
    const provider: ModelProvider = {
      async *complete(req) {
        if (req.model === 'gone:1b') throw new Error('Ollama failed (404): {"error":"model \'gone:1b\' not found"}');
        yield { type: 'token', text: `from ${req.model}` };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    addLocal(store, 'gone', 'gone:1b', 'small', 2048);
    addLocal(store, 'main', 'qwen3:0.6b', 'large', 8192);
    store.saveSettings({ ...store.getSettings(), autoModels: { ...store.getSettings().autoModels, fast: 'gone:1b', main: 'qwen3:0.6b' } }, 'test', {});
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Gone' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hi', wait: true });
    expect(run.status).toBe('completed');
    expect(store.listMessages(session.id).at(-1)?.content).toBe('from qwen3:0.6b');
    expect(store.getRun(run.id)?.routingNote).toMatch(/gone:1b is not installed anymore/);
    expect(store.getModel('gone')?.enabled).toBe(false);
    await app.close();
  });
});

async function login(app: Awaited<ReturnType<typeof buildApp>>['app']) {
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '01'].join('-') } });
  return { la_session: setup.cookies.find((item) => item.name === 'la_session')!.value };
}

describe('chat API guards', () => {
  it('refuses an unknown model id with the valid list, and maps an API name to its id', async () => {
    const dir = tmp();
    const provider: ModelProvider = {
      async *complete(req) {
        yield { type: 'token', text: `from ${req.model}` };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const cookies = await login(app);
    addLocal(store, 'main', 'qwen3:0.6b', 'large');
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Guard' });
    const bad = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies, payload: { content: 'hi', modelId: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Unknown or disabled model "nope".*main \(qwen3:0\.6b\)/);
    expect(store.listMessages(session.id)).toHaveLength(0);
    const pin = await app.inject({ method: 'PATCH', url: `/api/sessions/${session.id}`, cookies, payload: { modelPin: 'missing:7b' } });
    expect(pin.statusCode).toBe(400);
    const named = await app.inject({ method: 'PATCH', url: `/api/sessions/${session.id}`, cookies, payload: { modelPin: 'qwen3:0.6b' } });
    expect(named.json().session.modelPin).toBe('main');
    const blank = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies, payload: { content: '   ' } });
    expect(blank.statusCode).toBe(400);
    await app.close();
  });

  it('refuses a second message while a reply is running, and binds each run to its own message', async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: string[] = [];
    const provider: ModelProvider = {
      async *complete(req) {
        prompts.push(String(req.messages.filter((m) => m.role === 'user').at(-1)?.content));
        await gate;
        yield { type: 'token', text: `answer to ${prompts.at(-1)}` };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const cookies = await login(app);
    addLocal(store, 'main', 'qwen3:0.6b', 'large');
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Race' });
    const [one, two] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies, payload: { content: 'first question about the workshop' } }),
      app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies, payload: { content: 'second question about the workshop' } }),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    const winner = one.statusCode === 200 ? one : two;
    expect(store.getRun(winner.json().run.id)?.cursor.userMessageId).toBeTruthy();
    release();
    for (let i = 0; i < 50 && engine.sessionBusy(session.id); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies, payload: { content: 'third question about the workshop' } });
    expect(after.statusCode).toBe(200);
    for (let i = 0; i < 50 && engine.sessionBusy(session.id); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const answers = store.listMessages(session.id).filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(answers.at(-1)).toBe('answer to third question about the workshop');
    expect(store.listMessages(session.id).filter((m) => m.role === 'user')).toHaveLength(2);
    await app.close();
  });
});

describe('Gemini off', () => {
  it('says Gemini is off instead of out of quota, in routing and health', () => {
    const local = { id: 'big', name: 'big', apiName: 'big', local: true, embedding: false, sizeClass: 'large' as const, providerKind: 'openai_compat', practicalBudget: 8192, enabled: true };
    const off = decideAuto({ text: '/smart explain the plan in detail please', map: { ...DEFAULT_AUTO_MAP, main: 'big' }, models: [local] });
    expect(off.reason).toMatch(/Gemini is off or has no API key/);
    const gemini = { ...local, id: 'g', name: 'Gemini Flash', apiName: 'gemini-flash', local: false, providerKind: 'gemini', quotaOpen: false };
    const spent = decideAuto({ text: '/smart explain the plan in detail please', map: { ...DEFAULT_AUTO_MAP, main: 'big' }, models: [local, gemini] });
    expect(spent.reason).toMatch(/quota is used up/);
    expect(geminiStateOf({ enabled: true, apiKeyEnv: 'GEMINI_API_KEY' }, {})).toBe('off');
    expect(geminiStateOf({ enabled: false, apiKeyEnv: 'GEMINI_API_KEY' }, { GEMINI_API_KEY: 'x' })).toBe('off');
    expect(geminiStateOf({ enabled: true, apiKeyEnv: 'GEMINI_API_KEY' }, { GEMINI_API_KEY: 'x' })).toBe('open');
    const base = { ollamaOk: true, loaded: [], dockerOk: true, mcpErrors: 0, mcpCount: 0, searxngOk: true, tailscaleOk: true, telegramQueued: 0, dbBytes: 1, diskFreeBytes: 10 * 1024 ** 3, memAvailableGiB: 8, geminiOpen: null, lastBackupAt: null };
    const check = doctorChecks({ ...base, geminiState: 'off' }).find((item) => item.id === 'gemini')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/Gemini is off/);
    expect(doctorChecks({ ...base, geminiOpen: false }).find((item) => item.id === 'gemini')!.detail).toMatch(/quota/);
  });
});

describe('long messages', () => {
  it('says what was cut from a long message, and folds early near the budget', async () => {
    const dir = tmp();
    const provider: ModelProvider = {
      async *complete() {
        yield { type: 'token', text: 'read it' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    addLocal(store, 'main', 'qwen3:0.6b', 'large', 32768);
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Long' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: `Please review this. ${'lorem ipsum '.repeat(2500)}`, wait: true });
    expect(run.status).toBe('completed');
    const answer = store.listMessages(session.id).at(-1)!;
    expect(answer.routingNote).toMatch(/Cut [\d,]+ characters from the middle of a long message/);
    expect(store.listSteps(run.id).some((step) => step.kind === 'context' && step.name === 'excerpt')).toBe(true);
    await app.close();

    const big = 'x '.repeat(2000);
    const messages = [{ id: 'a', role: 'user' as const, content: big }, { id: 'b', role: 'assistant' as const, content: big }, { id: 'c', role: 'user' as const, content: big }];
    expect(foldCandidates(messages, new Set(), 'approx', 1800)).toBeNull();
    expect(foldCandidates(messages, new Set(), 'approx', 1800, 2000)).toEqual(['a']);
  });
});
