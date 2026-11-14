import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { splitThinking } from '../src/engine.js';
import { providerFor, type ModelProvider, type ProviderEvent } from '../src/providers.js';
import type { Store } from '../src/db.js';
import { spawnSync } from 'node:child_process';
import { DockerCtl, dockerTarget, tarFile } from '../src/docker.js';
import { searxngConfig } from '../src/routes.js';
import { formatSearch, searxngHealth, searxngQuery } from '../src/tools.js';
import { createCollection, embedRoleWarning, hashEmbedder, ingestBuffer } from '../src/kb.js';
import { decideAuto, foldCandidates, likelyNeedsTools, nextAutoTier, DEFAULT_AUTO_MAP } from '@local-agent/shared';
import { doctorChecks, geminiStateOf, missingRoleModels } from '../src/debug.js';

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
  it('flags Auto roles mapped to models Ollama does not have', () => {
    const map = { fast: 'smollm2:135m', main: 'qwen3', coder: '', thinking: '', cloud: 'gemini-3.6-flash', embed: 'nomic-embed-text' };
    expect(missingRoleModels(map, ['smollm2:135m', 'qwen3:0.6b'])).toEqual(['embed → nomic-embed-text']);
    expect(missingRoleModels(map, ['smollm2:135m', 'qwen3:0.6b', 'nomic-embed-text:latest'])).toEqual([]);
  });

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

describe('knowledge base use', () => {
  it('puts matching passages and a kb_search hint in front of the model, and warns about a non-embedding embed role', async () => {
    const dir = tmp();
    let system = '';
    const provider: ModelProvider = {
      async *complete(req) {
        system = String(req.messages[0]?.content);
        yield { type: 'token', text: 'BLUE HERON [1]' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { app, store, engine } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    addLocal(store, 'main', 'qwen3:0.6b', 'large', 8192);
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const collection = createCollection(store, { name: 'Notes', agentId: null });
    await ingestBuffer(store, collection.id, { name: 'birds.txt', bytes: Buffer.from('Field notes.\n\nThe secret bird name is BLUE HERON. It nests by the lake.') }, hashEmbedder());
    const session = store.createSession({ agentId: agent.id, title: 'KB' });
    await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'What is the secret bird name?', wait: true });
    expect(system).toMatch(/call kb_search first/);
    expect(system).toMatch(/BLUE HERON/);

    const notEmbed = async () => new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
    expect(await embedRoleWarning(store, notEmbed as typeof fetch)).toMatch(/is not an embedding model.*1 collection was indexed/);
    const missing = async () => new Response('{"error":"not found"}', { status: 404 });
    expect(await embedRoleWarning(store, missing as typeof fetch)).toMatch(/not installed in Ollama/);
    await app.close();
  });
});

describe('Docker and SearXNG setup', () => {
  it('honors DOCKER_HOST', () => {
    expect(dockerTarget({ DOCKER_HOST: 'tcp://127.0.0.1:2375' })).toEqual({ host: '127.0.0.1', port: 2375, protocol: 'http' });
    expect(dockerTarget({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toEqual({ socketPath: '/run/user/1000/docker.sock' });
    expect(dockerTarget({})).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(new DockerCtl(undefined, { DOCKER_HOST: 'tcp://10.0.0.5:2375' }).available()).toBe(true);
    expect(new DockerCtl(undefined, { DOCKER_HOST: 'tcp://10.0.0.5:2375' }).describe()).toBe('http://10.0.0.5:2375');
    expect(new DockerCtl('/nope/docker.sock').available()).toBe(false);
  });

  it('writes a valid one-file tar', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.tar'), tarFile('settings.yml', Buffer.from('hello: world\n')));
    const listed = spawnSync('tar', ['-xOf', path.join(dir, 'a.tar'), 'settings.yml'], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe('hello: world\n');
  });

  it('ships settings.yml with JSON on into a writable volume and keeps the secret', async () => {
    const dir = tmp();
    const first = searxngConfig(dir);
    expect(first.yaml).toMatch(/formats:\n {4}- html\n {4}- json/);
    expect(first.yaml).toMatch(/limiter: false/);
    expect(searxngConfig(dir).secret).toBe(first.secret);
    const specs: Record<string, unknown>[] = [];
    const docker = {
      available: () => true, ping: async () => true, describe: () => 'test', pull: async () => undefined,
      startDetached: async (spec: Record<string, unknown>) => { specs.push(spec); return 'abcdef1234567890'; },
    } as unknown as DockerCtl;
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, docker });
    const cookies = await login(app);
    const run = await app.inject({ method: 'POST', url: '/api/setup/actions/start-searxng/run', cookies, payload: { confirm: true } });
    expect(run.statusCode).toBe(200);
    for (let i = 0; i < 50 && store.getJob(run.json().job.id)?.status === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getJob(run.json().job.id)?.status).toBe('completed');
    const spec = specs[0] as { replace: boolean; HostConfig: { Binds: string[] }; files: { dir: string; name: string; content: string }[] };
    expect(spec.replace).toBe(true);
    expect(spec.HostConfig.Binds).toEqual(['local-agent-searxng-config:/etc/searxng']);
    expect(spec.files[0]).toMatchObject({ dir: '/etc/searxng', name: 'settings.yml' });
    expect(spec.files[0]!.content).toMatch(/- json/);
    expect(store.getSettings().searxngUrl).toBe('http://127.0.0.1:8088');
    expect(JSON.stringify(store.getJob(run.json().job.id))).not.toContain(first.secret);
    await app.close();
  });
});

describe('web_search', () => {
  const json = (body: object, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('flags partial results, caps hits, and explains failures', async () => {
    const results = Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, url: `https://e/${i}`, content: 'c' }));
    const partial = await searxngQuery('http://s:8088/', 'ollama', json({ results, unresponsive_engines: [['google', 'CAPTCHA'], ['brave', 'timeout']] }) as typeof fetch, undefined, 3);
    expect(partial.hits).toHaveLength(3);
    expect(partial.partial).toBe(true);
    expect(formatSearch('ollama', partial)).toMatch(/^Partial results: 2 engines did not answer: google \(CAPTCHA\), brave \(timeout\)/);
    const none = await searxngQuery('http://s:8088', 'zzzz', json({ results: [] }) as typeof fetch);
    expect(formatSearch('zzzz', none)).toMatch(/No results for "zzzz"/);
    await expect(searxngQuery('http://s:8088', '   ', json({}) as typeof fetch)).rejects.toThrow(/non-empty query/);
    await expect(searxngQuery('http://s:8088', 'x', json({}, 403) as typeof fetch)).rejects.toThrow(/refused JSON \(403\)/);
    const down = async () => { throw new TypeError('fetch failed'); };
    await expect(searxngQuery('http://127.0.0.1:8088', 'x', down as typeof fetch)).rejects.toThrow('SearXNG is not reachable at http://127.0.0.1:8088. Start it from Setup.');
    await expect(searxngQuery('', 'x', down as typeof fetch)).rejects.toThrow(/not configured/);
    expect((await searxngHealth('http://s:8088', json({ results: results.slice(0, 1) }) as typeof fetch)).detail).toMatch(/answered JSON .* 1 result\./);
    expect((await searxngHealth('http://s:8088', down as typeof fetch)).ok).toBe(false);
  });

  it('runs web_search and kb_search from Debug > Health', async () => {
    const dir = tmp();
    const fetchImpl = async (input: string | URL | Request) => String(input).includes('/search?')
      ? new Response(JSON.stringify({ results: [{ title: 'Ollama v1', url: 'https://ollama.com', content: 'release' }] }), { status: 200 })
      : new Response('{}', { status: 404 });
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: fetchImpl as typeof fetch });
    const cookies = await login(app);
    store.saveSettings({ ...store.getSettings(), searxngUrl: 'http://127.0.0.1:8088' }, 'test', {});
    const collection = createCollection(store, { name: 'Notes', agentId: null });
    await ingestBuffer(store, collection.id, { name: 'n.txt', bytes: Buffer.from('The secret bird name is BLUE HERON.') }, hashEmbedder());
    const res = await app.inject({ method: 'POST', url: '/api/debug/tool-test', cookies, payload: { query: 'secret bird' } });
    const [web, kb] = res.json().results;
    expect(web).toMatchObject({ tool: 'web_search', ok: true });
    expect(web.output).toMatch(/Ollama v1/);
    expect(kb).toMatchObject({ tool: 'kb_search', ok: true });
    expect(kb.output).toMatch(/BLUE HERON/);
    const health = await app.inject({ method: 'GET', url: '/api/debug/health', cookies });
    expect(health.json().checks.find((c: { id: string }) => c.id === 'searxng').ok).toBe(true);
    await app.close();
  });
});

describe('knowledge base uploads', () => {
  it('answers 400 with the reason for bad files, and deletes files and collections with their chunks', async () => {
    const dir = tmp();
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch });
    const cookies = await login(app);
    const created = await app.inject({ method: 'POST', url: '/api/kb/collections', cookies, payload: { name: 'Notes' } });
    const id = created.json().collection.id;
    const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64');
    const blank = await app.inject({ method: 'POST', url: `/api/kb/collections/${id}/files`, cookies, payload: { files: [{ name: 'blank.txt', contentBase64: b64('   \n\t  ') }] } });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toMatch(/blank.txt has no text to index/);
    const png = await app.inject({ method: 'POST', url: `/api/kb/collections/${id}/files`, cookies, payload: { files: [{ name: 'pic.png', contentBase64: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1])) }] } });
    expect(png.statusCode).toBe(400);
    expect(png.json().error).toMatch(/binary file|Unsupported file type \.png/);
    const mixed = await app.inject({ method: 'POST', url: `/api/kb/collections/${id}/files`, cookies, payload: { files: [{ name: 'ok.txt', contentBase64: b64('The secret bird name is BLUE HERON.') }, { name: 'pic.png', contentBase64: b64('x') }] } });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().results[1].error).toMatch(/Unsupported file type \.png/);
    const missing = await app.inject({ method: 'POST', url: '/api/kb/collections/nope/files', cookies, payload: { files: [{ name: 'a.txt', contentBase64: b64('hi') }] } });
    expect(missing.statusCode).toBe(404);

    const files = (await app.inject({ method: 'GET', url: `/api/kb/collections/${id}/files`, cookies })).json().files;
    expect(files.map((f: { name: string }) => f.name)).toEqual(['ok.txt']);
    const chunks = () => Number((store.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as { n: number }).n);
    expect(chunks()).toBeGreaterThan(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/kb/collections/${id}/files/${files[0].id}`, cookies })).statusCode).toBe(200);
    expect(chunks()).toBe(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/kb/collections/${id}/files/${files[0].id}`, cookies })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: `/api/kb/collections/${id}/files`, cookies, payload: { files: [{ name: 'ok.txt', contentBase64: b64('Again BLUE HERON.') }] } });
    expect((await app.inject({ method: 'DELETE', url: `/api/kb/collections/${id}`, cookies })).statusCode).toBe(200);
    expect(chunks()).toBe(0);
    expect(Number((store.db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get() as { n: number }).n)).toBe(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/kb/collections/${id}`, cookies })).statusCode).toBe(404);
    await app.close();
  });
});

describe('chat list paging', () => {
  it('pages GET /api/sessions with limit and cursor past 200 chats', async () => {
    const dir = tmp();
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const cookies = await login(app);
    for (let i = 0; i < 230; i += 1) store.createSession({ title: `Chat ${i}` });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await app.inject({ method: 'GET', url: `/api/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, cookies });
      expect(res.statusCode).toBe(200);
      for (const session of res.json().sessions) seen.add(session.id);
      cursor = res.json().nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen.size).toBe(230);
    expect((await app.inject({ method: 'GET', url: '/api/sessions?limit=0', cookies })).statusCode).toBe(400);
    await app.close();
  });
});
