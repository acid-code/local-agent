import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_MAP, decideAuto, summaryTriggerFor, type AutoCandidate } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { toolCapabilityWarnings } from '../src/ollama.js';
import { ollamaNumCtx, providerFor, type ModelProvider } from '../src/providers.js';
import type { ModelRow } from '../src/db.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function model(partial: Partial<AutoCandidate> & Pick<AutoCandidate, 'id' | 'name' | 'apiName'>): AutoCandidate {
  return {
    local: true, embedding: false, sizeClass: 'large', providerKind: 'openai_compat', practicalBudget: 32768, enabled: true,
    ...partial,
  };
}

const fast = model({ id: 'fast', name: 'qwen3:4b', apiName: 'qwen3:4b', sizeClass: 'small', practicalBudget: 4096 });
const main = model({ id: 'main', name: 'gemma4:26b-a4b', apiName: 'gemma4:26b-a4b' });
const coder = model({ id: 'coder', name: 'qwen3-coder:30b', apiName: 'qwen3-coder:30b' });
const gemini = model({ id: 'gem', name: 'Gemini Flash', apiName: 'gemini-3.5-flash-lite', local: false, providerKind: 'gemini', quotaOpen: true, sizeClass: 'small' });
const models = [fast, main, coder, gemini];

describe('auto routing', () => {
  it('starts on main, steps up one level, and returns to main on the next decision', () => {
    const ordinary = decideAuto({ text: 'Please explain how this workshop should be described to a new teammate.', map: DEFAULT_AUTO_MAP, models });
    expect(ordinary.modelId).toBe('main');
    expect(ordinary.reasoning).toBe(false);
    expect(ordinary.reason).toMatch(/Staying on gemma4:26b-a4b/);

    const harder = decideAuto({ text: 'think harder about how this workshop should be described to a new teammate', map: DEFAULT_AUTO_MAP, models });
    expect(harder.role).toBe('thinking');
    expect(harder.reasoning).toBe(true);
    expect(harder.reason).toMatch(/think harder/);

    const again = decideAuto({ text: 'Please explain how this workshop should be described to a new teammate.', map: DEFAULT_AUTO_MAP, models });
    expect(again.modelId).toBe('main');
    expect(again.reasoning).toBe(false);

    const failed = decideAuto({ text: 'Please explain how this workshop should be described to a new teammate.', failures: 2, map: DEFAULT_AUTO_MAP, models });
    expect(failed.role).toBe('thinking');
    const overflow = decideAuto({ text: 'hi', estimatedTokens: 8000, map: DEFAULT_AUTO_MAP, models });
    expect(overflow.role).toBe('main');
    expect(overflow.reason).toMatch(/does not fit/);
    const smart = decideAuto({ text: '/smart Please explain how this workshop should be described to a new teammate.', map: DEFAULT_AUTO_MAP, models });
    expect(smart.role).toBe('cloud');
    expect(smart.modelId).toBe('gem');
    const pinned = decideAuto({ text: 'Please explain how this workshop should be described to a new teammate.', pinId: 'fast', map: DEFAULT_AUTO_MAP, models });
    expect(pinned.role).toBe('pinned');
    expect(pinned.modelId).toBe('fast');
  });

  it('picks the detected main model and keeps the coder on code changes', () => {
    expect(decideAuto({ text: 'hello', map: DEFAULT_AUTO_MAP, models }).modelId).toBe('fast');
    expect(decideAuto({ text: 'fix the typo in the server readme', map: DEFAULT_AUTO_MAP, models }).modelId).toBe('coder');
    const detected = decideAuto({ text: 'Please explain the workshop to a new teammate in some detail.', map: { ...DEFAULT_AUTO_MAP, main: '' }, models: [coder, model({ id: 'qwen', name: 'qwen3.6:35b-a3b', apiName: 'qwen3.6:35b-a3b' })] });
    expect(detected.modelId).toBe('qwen');
    const gemmaFirst = decideAuto({ text: 'Please explain the workshop to a new teammate in some detail.', map: DEFAULT_AUTO_MAP, models: [model({ id: 'qwen', name: 'qwen3.6:35b-a3b', apiName: 'qwen3.6:35b-a3b' }), main] });
    expect(gemmaFirst.modelId).toBe('main');
  });

  it('summarizes large models only after half the practical budget', () => {
    expect(summaryTriggerFor({ sizeClass: 'small', practicalBudget: 8192 })).toBe(1800);
    expect(summaryTriggerFor({ sizeClass: 'large', practicalBudget: 32768 })).toBe(16384);
  });
});

describe('ollama context', () => {
  it('sends num_ctx for the practical budget on the native chat endpoint', async () => {
    expect(ollamaNumCtx(32768, 2048, 262144)).toBe(32768);
    let url = '';
    let body: { options?: { num_ctx?: number }; keep_alive?: string } = {};
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 4, eval_count: 1 }), { headers: { 'content-type': 'application/json' } });
    };
    const row = {
      id: 'm', providerId: 'prov_ollama', name: 'gemma4:26b-a4b', apiName: 'gemma4:26b-a4b', profileId: 'gemma', tokenizer: 'gemma4',
      contextWindow: 262144, practicalBudget: 32768, strategy: 'hierarchical', sizeClass: 'large', local: true, modalities: ['text'], strengths: ['chat'],
      typicalQ4GiB: 18, priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: 'gemma', source: 'test', embedding: false, freeTier: null, enabled: true,
    } as ModelRow;
    const provider = providerFor(row, { id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: null, enabled: true, createdAt: '' }, fetchImpl as typeof fetch);
    const events = [];
    for await (const event of provider.complete({ model: row.apiName, messages: [{ role: 'user', content: 'hi' }], numCtx: ollamaNumCtx(row.practicalBudget, 2048, row.contextWindow), keepAlive: '30m' })) events.push(event);
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body.options?.num_ctx).toBe(32768);
    expect(body.keep_alive).toBe('30m');
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });

  it('warns when Ollama says a chat model has no tools', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
    const warnings = await toolCapabilityWarnings(fetchImpl as typeof fetch, [{ name: 'old', apiName: 'old:7b', local: true, embedding: false }]);
    expect(warnings.join('\n')).toMatch(/does not support tool calls/);
  });
});

describe('auto runs the mapped model', () => {
  it('routes, pins, drops back, and loads one large model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-auto-'));
    dirs.push(dir);
    const seen: { model?: string; numCtx?: number; think?: boolean }[] = [];
    const unloaded: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { model?: string; keep_alive?: number } : {};
      if (String(input).includes('/api/generate') && body.keep_alive === 0 && body.model) unloaded.push(body.model);
      return new Response('{}', { status: 200 });
    };
    const recorder: ModelProvider = {
      async *complete(req) {
        seen.push({ model: req.model, numCtx: req.numCtx, think: req.think });
        yield { type: 'token', text: 'ok' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: fetchImpl as typeof fetch, providerOverride: () => recorder });
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    const add = (id: string, name: string, size: 'small' | 'large', budget: number) => store.upsertModel({
      id, providerId: 'prov_ollama', name, apiName: name, profileId: id, tokenizer: 'approx', contextWindow: 262144, practicalBudget: budget,
      strategy: 'rolling', sizeClass: size, local: true, modalities: ['text'], strengths: ['chat', 'code'], typicalQ4GiB: size === 'large' ? 18 : 3,
      priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: 'test', source: 'test', embedding: false, freeTier: null, enabled: true,
    });
    add('fast', 'qwen3:4b', 'small', 4096);
    add('main', 'gemma4:26b-a4b', 'large', 32768);
    add('coder', 'qwen3-coder:30b', 'large', 32768);
    store.updateProvider('prov_gemini', { enabled: true });
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    engine.residentLarge = ['other-big'];

    const turn = async (content: string) => engine.startTurn({ sessionId: session.id, agentId: agent.id, content, wait: true });
    const route = async (content: string) => {
      const run = await turn(content);
      return store.listSteps(run.id).find((step) => step.kind === 'routing');
    };

    const hello = await route('hello');
    expect(hello?.name).toBe('qwen3:4b');
    expect(JSON.stringify(hello?.output)).toMatch(/fast model/);

    const stay = await route('Please explain how this workshop should be described to a new teammate.');
    expect(stay?.name).toBe('gemma4:26b-a4b');
    expect(unloaded).toContain('other-big');
    expect(store.listSteps((await store.listRuns(5))[0]!.id).some((step) => step.kind === 'loading')).toBe(true);
    expect(seen.at(-1)?.numCtx).toBe(32768);
    expect(seen.at(-1)?.think).toBe(false);

    const harder = await route('think harder about how this workshop should be described to a new teammate');
    expect(harder?.name).toBe('gemma4:26b-a4b');
    expect(seen.at(-1)?.think).toBe(true);
    const back = await route('Please explain how this workshop should be described to a new teammate.');
    expect(back?.name).toBe('gemma4:26b-a4b');
    expect(seen.at(-1)?.think).toBe(false);

    const before = seen.length;
    const pinned = await turn('/model qwen3:4b');
    expect(pinned.status).toBe('completed');
    expect(seen.length).toBe(before);
    expect(store.listMessages(session.id).at(-1)?.content).toMatch(/Pinned to qwen3:4b/);
    const held = await route('Please explain how this workshop should be described to a new teammate.');
    expect(held?.name).toBe('qwen3:4b');
    await turn('/auto');
    const unpinned = await route('Please explain how this workshop should be described to a new teammate.');
    expect(unpinned?.name).toBe('gemma4:26b-a4b');

    const code = await route('fix the typo in the server readme');
    expect(code?.name).toBe('qwen3-coder:30b');
    const smart = await route('/smart Please explain how this workshop should be described to a new teammate.');
    expect(String(smart?.name)).toMatch(/Gemini|gemini|Flash/);
    expect(JSON.stringify(smart?.output)).toMatch(/smart model/);
    await app.close();
  });
});
