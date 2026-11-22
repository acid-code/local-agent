import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_MAP, autoRoleHealth, decideAuto, describeAutoRoles, detectCoder, detectFast, matchAutoModel, summaryTriggerFor, type AutoCandidate, type AutoMap } from '@local-agent/shared';
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
    // Qwen3.6 is the main brain: with both present (and an empty saved main slot), Auto picks Qwen, never gemma4.
    const qwenFirst = decideAuto({ text: 'Please explain the workshop to a new teammate in some detail.', map: { ...DEFAULT_AUTO_MAP, main: '' }, models: [main, model({ id: 'qwen', name: 'qwen3.6:35b-a3b', apiName: 'qwen3.6:35b-a3b' })] });
    expect(qwenFirst.modelId).toBe('qwen');
    expect(DEFAULT_AUTO_MAP.main).toBe('qwen3.6-35b-a3b');
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

    // Sticky chat model: a code-ish follow-up stays on the chat's model; /auto re-routes it to the coder.
    const sticky = await route('fix the typo in the server readme');
    expect(sticky?.name).toBe('gemma4:26b-a4b');
    expect(JSON.stringify(sticky?.output)).toMatch(/this chat's model/);
    const code = await route('/auto fix the typo in the server readme');
    expect(code?.name).toBe('qwen3-coder:30b');
    const smart = await route('/smart Please explain how this workshop should be described to a new teammate.');
    expect(String(smart?.name)).toMatch(/Gemini|gemini|Flash/);
    expect(JSON.stringify(smart?.output)).toMatch(/smart model/);
    await app.close();
  });
});


const staleMap: AutoMap = { fast: 'qwen3:4b', main: 'qwen3.6-35b-a3b', coder: 'qwen3-coder:30b', thinking: '', cloud: '', embed: 'nomic-embed-text' };

describe('auto role availability', () => {
  it('resolves stale Ollama names to gemma3:4b and the llama.cpp Qwen model', () => {
    const gemma = model({ id: 'gemma', name: 'gemma3:4b', apiName: 'gemma3:4b', sizeClass: 'small', practicalBudget: 8192, providerName: 'Ollama' });
    const qwen = model({ id: 'qwen', name: 'Qwen3.6-35B-A3B-Q4_K_M', apiName: 'Qwen3.6-35B-A3B-Q4_K_M', providerName: 'llama-server' });
    expect(matchAutoModel([qwen], 'qwen3.6-35b-a3b')?.id).toBe('qwen');
    const health = autoRoleHealth(staleMap, [gemma, qwen]);
    expect(health.ok).toBe(true);
    const byRole = Object.fromEntries(health.roles.map((row) => [row.role, row]));
    expect(byRole.fast?.modelId).toBe('gemma');
    expect(byRole.fast?.fallback).toBe(true);
    expect(byRole.fast?.note).toMatch(/qwen3:4b/);
    expect(byRole.main?.modelId).toBe('qwen');
    expect(byRole.main?.fallback).toBe(false);
    expect(byRole.coder?.modelId).toBe('qwen');
    expect(byRole.coder?.fallback).toBe(true);
    expect(byRole.coder?.note).toMatch(/qwen3-coder:30b/);
    expect(detectFast([gemma, qwen])?.id).toBe('gemma');
    expect(decideAuto({ text: 'hello', map: staleMap, models: [gemma, qwen] }).modelId).toBe('gemma');
    expect(decideAuto({ text: 'Please explain how this workshop should be described to a new teammate.', map: staleMap, models: [gemma, qwen] }).modelId).toBe('qwen');
  });

  it('prefers gpt-oss for coder when it is installed, otherwise the Qwen main model', () => {
    const qwen = model({ id: 'qwen', name: 'Qwen3.6-35B-A3B-Q4_K_M', apiName: 'Qwen3.6-35B-A3B-Q4_K_M', providerName: 'llama-server' });
    const oss = model({ id: 'oss', name: 'gpt-oss-20b', apiName: 'gpt-oss-20b', providerName: 'llama-server' });
    expect(detectCoder([qwen, oss])?.id).toBe('oss');
    expect(detectCoder([qwen])?.id).toBe('qwen');
    expect(autoRoleHealth({ ...DEFAULT_AUTO_MAP, coder: 'gpt-oss:20b' }, [qwen, oss]).roles.find((row) => row.role === 'coder')?.modelId).toBe('oss');
  });

  it('stays green when only gemma3:4b is installed, and goes red when no chat model exists', () => {
    const gemma = model({ id: 'gemma', name: 'gemma3:4b', apiName: 'gemma3:4b', sizeClass: 'small', practicalBudget: 8192, providerName: 'Ollama' });
    const onlyFast = autoRoleHealth(staleMap, [gemma]);
    expect(onlyFast.ok).toBe(true);
    expect(onlyFast.roles.every((row) => row.available && row.modelId === 'gemma')).toBe(true);
    const embed = model({ id: 'emb', name: 'nomic-embed-text', apiName: 'nomic-embed-text', embedding: true });
    const empty = autoRoleHealth(staleMap, [embed]);
    expect(empty.ok).toBe(false);
    expect(empty.detail).toMatch(/No usable model/);
    expect(describeAutoRoles(staleMap, []).every((row) => !row.available)).toBe(true);
  });
});

describe('auto role health against live providers', () => {
  it('reports the resolved mapping and stays green when Ollama lacks the configured models', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-roles-'));
    dirs.push(dir);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }));
      if (url.includes('/api/ps')) return new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }));
      if (url.replace(/\/$/, '').endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'Qwen3.6-35B-A3B-Q4_K_M' }] }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '11'].join('-') } });
    const cookies = { la_session: setup.cookies.find((item) => item.name === 'la_session')!.value };
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    store.upsertProvider({ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
    const add = (id: string, providerId: string, name: string, size: 'small' | 'large') => store.upsertModel({
      id, providerId, name, apiName: name, profileId: id, tokenizer: 'approx', contextWindow: 32768, practicalBudget: size === 'small' ? 8192 : 32768,
      strategy: 'rolling', sizeClass: size, local: true, modalities: ['text'], strengths: ['chat'], typicalQ4GiB: size === 'large' ? 22 : 3,
      priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: 'test', source: 'discovered', embedding: false, freeTier: null, enabled: true,
    });
    add('gemma', 'prov_ollama', 'gemma3:4b', 'small');
    add('qwen', 'prov_llama', 'Qwen3.6-35B-A3B-Q4_K_M', 'large');
    store.saveSettings({ ...store.getSettings(), autoModels: staleMap }, 'stale roles', {});
    const health = await app.inject({ method: 'GET', url: '/api/debug/health', cookies });
    expect(health.statusCode).toBe(200);
    const roles = (health.json() as { checks: { id: string; ok: boolean; detail: string; roles?: { role: string; modelName?: string; fallback: boolean }[] }[] }).checks.find((check) => check.id === 'roles');
    expect(roles?.ok).toBe(true);
    expect(roles?.detail).toMatch(/gemma3:4b/);
    expect(roles?.detail).toMatch(/Qwen3\.6-35B-A3B-Q4_K_M|qwen3/i);
    expect(roles?.detail).not.toMatch(/Ollama does not have/);
    const models = await app.inject({ method: 'GET', url: '/api/models', cookies });
    const report = models.json() as { autoRoles?: { ok: boolean; roles: { role: string; modelName?: string; fallback: boolean }[] } };
    expect(report.autoRoles?.ok).toBe(true);
    const coder = report.autoRoles?.roles.find((row) => row.role === 'coder');
    expect(coder?.modelName).toMatch(/Qwen3\.6-35B-A3B/i);
    expect(coder?.fallback).toBe(true);
    await app.close();
  });
});
