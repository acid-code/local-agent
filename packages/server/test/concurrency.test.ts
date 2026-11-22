import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitStateOf } from '@local-agent/shared';
import { Store } from '../src/db.js';
import type { ModelRow } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Bus } from '../src/bus.js';
import type { LiveEvent } from '../src/bus.js';
import { DockerCtl } from '../src/docker.js';
import { VectorIndex } from '../src/embeddings.js';
import { Vault } from '../src/vault.js';
import { ScriptedProvider, llamaFirstTokenTimeoutMs, LLAMA_TIMEOUT_MS } from '../src/providers.js';
import type { ModelProvider } from '../src/providers.js';
import { LlamaWatch, isNonChatModel } from '../src/coexist.js';
import { MemoryBudget, GiB } from '../src/memory.js';
import type { MemoryProbe } from '../src/memory.js';
import { scanMachine } from '../src/discovery.js';

function model(id: string, providerId: string, apiName: string, gib: number, sizeClass: 'small' | 'large', extra: Partial<ModelRow> = {}) {
  return {
    id, providerId, name: apiName, apiName, profileId: 'p', tokenizer: 'approx', contextWindow: 32768, practicalBudget: 32768,
    strategy: 'rolling', sizeClass, local: true, modalities: ['text'], strengths: ['chat', 'code'], typicalQ4GiB: gib,
    priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: null, source: 'discovered', embedding: false, freeTier: null, enabled: true,
    ...extra,
  } as never;
}

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-conc-'));
  const store = new Store(path.join(dir, 'local-agent.db'));
  cleanup.push(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

/** Qwen llama-server is stopped (503) and the uncensored one on :8081 is up, like after a refusal fallback. */
const uncensoredUp: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes(':8080')) return new Response('{}', { status: 503 });
  return new Response('{"ok":true}', { status: 200 });
};

function engineWith(store: Store, fetchImpl: typeof fetch, provider: (m: ModelRow) => ModelProvider, bus = new Bus()) {
  return new Engine(store, bus, new DockerCtl('/nonexistent.sock'), new VectorIndex(store.db), new Vault(store, Buffer.alloc(32, 7)), 'inst_test', fetchImpl, provider);
}

function agentIn(store: Store, dir: string) {
  return store.createAgent({ name: 'House', description: '', systemPrompt: 'Be brief.', modelId: null, routing: 'auto', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir });
}

describe('GPU coexistence with the uncensored llama-server', () => {
  it('blocks big Ollama models while only the uncensored server is up', async () => {
    const { store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
    store.upsertProvider({ id: 'prov_uncensored', kind: 'openai_compat', name: 'llama-server (uncensored)', baseUrl: 'http://127.0.0.1:8081/v1', enabled: true });
    store.upsertModel(model('ollama_gemma4', 'prov_ollama', 'gemma4:26b-a4b', 18, 'large'));
    store.upsertModel(model('llama_qwen', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large'));
    store.upsertModel(model('unc_inkling', 'prov_uncensored', 'inkling-2-mini-uncensored', 8, 'large'));
    const watch = new LlamaWatch(store, uncensoredUp);
    await watch.refresh();
    expect(watch.blocks(store.getModel('ollama_gemma4')!, store.getProvider('prov_ollama')!)).toBe(true);
  });
});

describe('sticky chat model', () => {
  it('uses the uncensored model for one step after a refusal, then the chat goes back to its model', async () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_uncensored', kind: 'openai_compat', name: 'llama-server (uncensored)', baseUrl: 'http://127.0.0.1:8081/v1', enabled: true });
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    store.upsertModel(model('unc_inkling', 'prov_uncensored', 'inkling-2-mini-uncensored', 8, 'large'));
    const used: string[] = [];
    const engine = engineWith(store, uncensoredUp, (m) => {
      used.push(m.apiName);
      return m.apiName.includes('inkling')
        ? new ScriptedProvider([{ text: 'Searched the listings and saved them to notes.md.' }])
        : new ScriptedProvider([{ text: "I'm sorry, I can't assist with that request because it violates the terms of service." }]);
    });
    await engine.llama.refresh();
    const agent = store.createAgent({ name: 'House', description: '', systemPrompt: 'Be brief.', modelId: 'ollama_gemma3', routing: 'pinned', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    const first = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Please search the marketplace listings for a used bike and save them', wait: true });
    expect(store.getRun(first.id)?.modelId).toBe('unc_inkling');
    expect(used).toContain('inkling-2-mini-uncensored');
    // The chat keeps the model it was on, not the fallback.
    expect(store.getSession(session.id)?.activeModelId).toBe('ollama_gemma3');

    // An explicit /auto still re-routes.
    await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: '/auto', wait: true });
    expect(store.getSession(session.id)?.activeModelId).toBeNull();
  });

  it('returns to the original model for the step after the fallback answered', async () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_uncensored', kind: 'openai_compat', name: 'llama-server (uncensored)', baseUrl: 'http://127.0.0.1:8081/v1', enabled: true });
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    store.upsertModel(model('unc_inkling', 'prov_uncensored', 'inkling-2-mini-uncensored', 8, 'large'));
    const used: string[] = [];
    const gemma = new ScriptedProvider([
      { text: "I'm sorry, I can't assist with that request because it violates the terms of service." },
      { text: 'Here is the summary of the listings.' },
    ]);
    const inkling = new ScriptedProvider([{ toolCalls: [{ id: 't1', name: 'time_now', arguments: '{}' }] }]);
    const engine = engineWith(store, uncensoredUp, (m) => { used.push(m.apiName); return m.apiName.includes('inkling') ? inkling : gemma; });
    await engine.llama.refresh();
    const agent = store.createAgent({ name: 'House', description: '', systemPrompt: 'Be brief.', modelId: 'ollama_gemma3', routing: 'pinned', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Please search the marketplace listings for a used bike and save them', wait: true });
    expect(used).toEqual(['gemma3:4b', 'inkling-2-mini-uncensored', 'gemma3:4b']);
    expect(store.getRun(run.id)?.modelId).toBe('ollama_gemma3');
    expect(store.getRun(run.id)?.status).toBe('completed');
  });
});

describe('big-model queue', () => {
  it('runs one big model at a time and shows who the second chat waits for', async () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertModel(model('ollama_gemma4', 'prov_ollama', 'gemma4:26b-a4b', 18, 'large'));
    store.upsertModel(model('ollama_gptoss', 'prov_ollama', 'gpt-oss:20b', 13, 'large'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const slow: ModelProvider = {
      async *complete() {
        order.push('gemma:start');
        await gate;
        order.push('gemma:end');
        yield { type: 'token', text: 'done' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const fast: ModelProvider = {
      async *complete() {
        order.push('gptoss:start');
        yield { type: 'token', text: 'done' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const bus = new Bus();
    const events: LiveEvent[] = [];
    bus.subscribeAll((event) => events.push(event));
    const ok: typeof fetch = async () => new Response('{}', { status: 200 });
    const engine = engineWith(store, ok, (m) => (m.apiName.startsWith('gemma') ? slow : fast), bus);
    const agent = agentIn(store, dir);
    const a = store.createSession({ agentId: agent.id, title: 'A' });
    const b = store.createSession({ agentId: agent.id, title: 'B' });
    const runA = await engine.startTurn({ sessionId: a.id, agentId: agent.id, content: 'Explain how this works in detail please', modelId: 'ollama_gemma4' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runB = await engine.startTurn({ sessionId: b.id, agentId: agent.id, content: 'Explain how that works in detail please', modelId: 'ollama_gptoss' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(order).toEqual(['gemma:start']);
    const waiting = events.find((event) => event.runId === runB.id && event.type === 'status' && event.status === 'waiting');
    expect(String(waiting?.detail)).toMatch(/Waiting for gemma4:26b-a4b to finish \(queued/);
    // The queue says what it waits behind, so the UI shows "Queued behind …" and no Force run.
    expect((waiting as { waitInfo?: unknown }).waitInfo).toMatchObject({ kind: 'queue', behind: 'gemma4:26b-a4b', ahead: 1 });
    const state = waitStateOf(String(waiting?.detail), (waiting as { waitInfo?: unknown }).waitInfo);
    expect(state).toMatchObject({ kind: 'queue', title: 'Queued behind gemma4:26b-a4b', canForce: false });
    expect((engine.getLiveStream(runB.id) as { waitInfo?: { kind?: string } } | null)?.waitInfo?.kind).toBe('queue');
    release();
    for (let i = 0; i < 50 && !['completed', 'failed'].includes(store.getRun(runB.id)!.status); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getRun(runA.id)?.status).toBe('completed');
    expect(store.getRun(runB.id)?.status).toBe('completed');
    expect(order).toEqual(['gemma:start', 'gemma:end', 'gptoss:start']);
  });
});

describe('helpers and non-chat models', () => {
  it('never gives helpers or Auto an embedding/OCR/TTS model, and shares the parent big model', () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
    // Discovered from Ollama with embedding=false, as discovery used to store it.
    store.upsertModel(model('ollama_nomic', 'prov_ollama', 'nomic-embed-text:latest', 0.3, 'small'));
    store.upsertModel(model('ollama_glm_ocr', 'prov_ollama', 'glm-ocr:latest', 1, 'small'));
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    store.upsertModel(model('ollama_gemma4', 'prov_ollama', 'gemma4:26b-a4b', 18, 'large'));
    store.upsertModel(model('llama_qwen', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large'));
    expect(isNonChatModel({ name: 'nomic-embed-text:latest', apiName: 'nomic-embed-text:latest' })).toBe(true);
    expect(isNonChatModel({ name: 'glm-ocr', apiName: 'glm-ocr:latest' })).toBe(true);
    expect(isNonChatModel({ name: 'piper-tts', apiName: 'piper' })).toBe(true);
    expect(isNonChatModel({ name: 'gemma3:4b', apiName: 'gemma3:4b' })).toBe(false);
    expect(isNonChatModel({ name: 'qwen3.6-35b-a3b', apiName: 'qwen3.6-35b-a3b' })).toBe(false);
    const engine = engineWith(store, async () => new Response('{}', { status: 200 }), () => new ScriptedProvider([{ text: 'ok' }]));
    void dir;
    expect(engine.autonomy.pickHelperModel('fast')?.apiName).toBe('gemma3:4b');
    expect(engine.autonomy.pickHelperModel('fast', 'nomic-embed-text')?.apiName).not.toMatch(/embed/);
    // Parent on Qwen asks for gemma4 (a second big model): the helper shares Qwen instead.
    expect(engine.autonomy.pickHelperModel('main', 'gemma4', 'llama_qwen')?.id).toBe('llama_qwen');
    expect(engine.autonomy.pickHelperModel('main', undefined, 'llama_qwen')?.id).toBe('llama_qwen');
    expect(engine.autonomy.pickHelperModel('main')).toBeUndefined();
  });
});

describe('stalls and waits fail clearly and keep the chat', () => {
  it('scales the llama-server first-token timeout with the prompt', () => {
    expect(llamaFirstTokenTimeoutMs(100)).toBe(LLAMA_TIMEOUT_MS);
    // ~16K tokens at the 25 t/s floor: well past 300 s (Inkling needed 386 s).
    expect(llamaFirstTokenTimeoutMs(16_000 * 3.2)).toBeGreaterThan(386_000);
  });

  it('gives up waiting for memory after maxWaitMs with a clear message', async () => {
    const probe: MemoryProbe = {
      loaded: async () => [], shape: async () => null, unload: async () => {}, serverRss: () => 0, pidRss: () => 0,
      systemAvailable: () => 2 * GiB,
    };
    const budget = new MemoryBudget(probe, () => ({ budgetBytes: 40 * GiB, systemReserveBytes: 1 * GiB }), undefined, 20);
    await expect(budget.admit({ kind: 'chat', label: 'gemma4:26b-a4b', model: 'gemma4:26b-a4b', bytes: 18 * GiB, maxWaitMs: 100 }))
      .rejects.toThrow(/Gave up after .* waiting for memory for gemma4:26b-a4b/);
    expect(budget.snapshotQueue()).toEqual([]);
  });

  it('leaves a note with the error and finished steps in the chat when a reply fails', async () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    const broken: ModelProvider = {
      // eslint-disable-next-line require-yield
      async *complete() { throw new Error('llama-server gave no first token after 300s'); },
    };
    const engine = engineWith(store, async () => new Response('{}', { status: 200 }), () => broken);
    const agent = agentIn(store, dir);
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    store.insertMessage({ sessionId: session.id, role: 'user', content: 'Earlier question', toolCalls: null, agentId: agent.id, runId: null, toolCallId: null, toolName: null, imageUrl: null, routingNote: null });
    store.insertMessage({ sessionId: session.id, role: 'assistant', content: 'Earlier answer', toolCalls: null, agentId: agent.id, runId: null, toolCallId: null, toolName: null, imageUrl: null, routingNote: null });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Now do the thing', wait: true });
    expect(store.getRun(run.id)?.status).toBe('failed');
    const messages = store.listMessages(session.id).map((message) => message.content);
    expect(messages.slice(0, 3)).toEqual(['Earlier question', 'Earlier answer', 'Now do the thing']);
    expect(messages.at(-1)).toMatch(/This reply stopped before finishing.*gave no first token/);
    expect(messages.at(-1)).toMatch(/chat history is kept/);
  });
});

describe('llama-server context size', () => {
  it('uses the server -c (32K) for an unknown model like Inkling instead of the 8K default profile', async () => {
    const { store } = newStore();
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes(':8081') && url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'inkling-2-mini-uncensored' }] }), { status: 200 });
      if (url.includes(':8081') && url.endsWith('/props')) return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }), { status: 200 });
      throw new Error('offline');
    };
    const docker = new DockerCtl('/nonexistent.sock');
    await scanMachine(fakeFetch, docker, store).catch(() => null);
    const inkling = store.listModels().find((m) => m.apiName === 'inkling-2-mini-uncensored');
    expect(inkling?.contextWindow).toBe(32768);
    expect(inkling?.practicalBudget).toBe(32768);
  });
});

describe('fallback-control auth', () => {
  it('sends the shared token header to the host switch service when configured', async () => {
    const seen: { url: string; token: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), token: new Headers(init?.headers).get('x-fallback-token') });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const watch = new LlamaWatch({} as never, fetchImpl);
    const prevUrl = process.env.LLAMA_FALLBACK_CONTROL_URL;
    const prevToken = process.env.LLAMA_FALLBACK_TOKEN;
    cleanup.push(() => {
      if (prevUrl === undefined) delete process.env.LLAMA_FALLBACK_CONTROL_URL; else process.env.LLAMA_FALLBACK_CONTROL_URL = prevUrl;
      if (prevToken === undefined) delete process.env.LLAMA_FALLBACK_TOKEN; else process.env.LLAMA_FALLBACK_TOKEN = prevToken;
    });
    process.env.LLAMA_FALLBACK_CONTROL_URL = 'http://ctl:8082/';
    process.env.LLAMA_FALLBACK_TOKEN = 'tok-1';
    expect(await watch.switchToQwen()).toBe(true);
    delete process.env.LLAMA_FALLBACK_TOKEN;
    expect(await watch.switchToUncensored()).toBe(true);
    expect(seen).toEqual([
      { url: 'http://ctl:8082/switch-qwen', token: 'tok-1' },
      { url: 'http://ctl:8082/switch-uncensored', token: null },
    ]);
  });
});

describe('side work off the llama-server slot', () => {
  it('summaries go to gemma3:4b when the chat model is on llama-server, and fall back to it on failure', async () => {
    const { store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    store.upsertModel(model('llama_qwen', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large'));
    const used: string[] = [];
    let gemmaDown = false;
    const engine = engineWith(store, uncensoredUp, (m) => {
      used.push(m.apiName);
      if (m.apiName === 'gemma3:4b' && gemmaDown) return { async *complete() { throw new Error('fetch failed'); } } as unknown as ModelProvider;
      return new ScriptedProvider([{ text: `summary by ${m.apiName}` }]);
    });
    const internals = engine as unknown as { sideModel: (m: ModelRow) => ModelRow; trySummarize: (m: ModelRow, p: string) => Promise<string | null> };
    const qwen = store.getModel('llama_qwen')!;
    expect(internals.sideModel(qwen).apiName).toBe('gemma3:4b');
    expect(internals.sideModel(store.getModel('ollama_gemma3')!).apiName).toBe('gemma3:4b');
    expect(await internals.trySummarize(qwen, 'user: hi')).toBe('summary by gemma3:4b');
    gemmaDown = true;
    used.length = 0;
    expect(await internals.trySummarize(qwen, 'user: hi')).toBe('summary by qwen3.6-35b-a3b');
    expect(used).toEqual(['gemma3:4b', 'qwen3.6-35b-a3b']);
    process.env.LA_SIDE_MODEL = 'off';
    try { expect(internals.sideModel(qwen).id).toBe('llama_qwen'); } finally { delete process.env.LA_SIDE_MODEL; }
  });
});

describe('tool-capable routing', () => {
  it('moves a tool-needing turn off a model that cannot call tools, to the main model', async () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertModel(model('ollama_phi', 'prov_ollama', 'phi3:mini', 2.2, 'small'));
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    const settings = store.getSettings();
    store.saveSettings({ ...settings, toolSupport: { ...settings.toolSupport, 'phi3:mini': false }, autoModels: { ...settings.autoModels, main: 'gemma3:4b' } }, 'test', {});
    const used: string[] = [];
    const engine = engineWith(store, uncensoredUp, (m) => { used.push(m.apiName); return new ScriptedProvider([{ text: 'Here is what I found.' }]); });
    const agent = store.createAgent({ name: 'House', description: '', systemPrompt: 'Be brief.', modelId: 'ollama_phi', routing: 'pinned', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Search the web for the latest Node.js release and read the changelog', wait: true });
    expect(used).toEqual(['gemma3:4b']);
    expect(store.getRun(run.id)?.routingNote).toMatch(/cannot call tools/);

    used.length = 0;
    const chat = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hi', wait: true });
    expect(store.getRun(chat.id)?.cursor.toolFallback).toBeFalsy();
  });
});

describe('llama-server slot waits', () => {
  it('a run that went to the uncensored model under the old rule (no uncensoredFrom) also comes back', async () => {
    const { dir, store } = newStore();
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_uncensored', kind: 'openai_compat', name: 'llama-server (uncensored)', baseUrl: 'http://127.0.0.1:8081/v1', enabled: true });
    store.upsertModel(model('ollama_gemma3', 'prov_ollama', 'gemma3:4b', 3.4, 'small'));
    store.upsertModel(model('unc_inkling', 'prov_uncensored', 'inkling-2-mini-uncensored', 8, 'large'));
    const settings = store.getSettings();
    store.saveSettings({ ...settings, autoModels: { ...settings.autoModels, main: 'gemma3:4b' } }, 'test', {});
    // Simulate a run saved by the old code: the switch never recorded where it came from.
    const update = store.updateRun.bind(store);
    store.updateRun = ((id: string, patch: { cursor?: Record<string, unknown>; modelId?: string }) => {
      if (patch.cursor?.uncensoredFrom && patch.modelId === 'unc_inkling') patch = { ...patch, cursor: { ...patch.cursor, uncensoredFrom: undefined, uncensoredAt: undefined } };
      return update(id, patch as never);
    }) as typeof store.updateRun;
    const used: string[] = [];
    const gemma = new ScriptedProvider([
      { text: "I'm sorry, I can't assist with that request because it violates the terms of service." },
      { text: 'Done with the listings.' },
    ]);
    const inkling = new ScriptedProvider([{ toolCalls: [{ id: 't1', name: 'time_now', arguments: '{}' }] }, { text: 'still here' }]);
    const engine = engineWith(store, uncensoredUp, (m) => { used.push(m.apiName); return m.apiName.includes('inkling') ? inkling : gemma; });
    await engine.llama.refresh();
    const agent = store.createAgent({ name: 'House', description: '', systemPrompt: 'Be brief.', modelId: 'ollama_gemma3', routing: 'pinned', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Please search the marketplace listings for a used bike and save them', wait: true });
    expect(used).toEqual(['gemma3:4b', 'inkling-2-mini-uncensored', 'gemma3:4b']);
    expect(store.getRun(run.id)?.modelId).toBe('ollama_gemma3');
  });

  it('waits about 2 minutes (not 15) for the other llama-server model, with a way out in the message', async () => {
    process.env.LA_LLAMA_WAIT_MS = '300';
    try {
      const { store } = newStore();
      const engine = engineWith(store, uncensoredUp, () => new ScriptedProvider([]));
      const internals = engine as unknown as { llamaLeases: Map<string, string>; acquireLlamaLease: (id: string, kind: string, signal: AbortSignal) => Promise<void> };
      internals.llamaLeases.set('run_other', 'uncensored');
      const started = Date.now();
      await expect(internals.acquireLlamaLease('run_me', 'qwen', new AbortController().signal)).rejects.toThrow(/pick another model/);
      expect(Date.now() - started).toBeLessThan(3000);
      internals.llamaLeases.delete('run_other');
      await internals.acquireLlamaLease('run_me', 'qwen', new AbortController().signal);
      expect(internals.llamaLeases.get('run_me')).toBe('qwen');
    } finally { delete process.env.LA_LLAMA_WAIT_MS; }
  });
});
