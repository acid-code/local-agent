import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { BudgetError, GiB, MemoryBudget, budgetConfig, type LoadedInfo, type MemoryProbe, type ModelShape } from '../src/memory.js';

/** A machine we control: Ollama's loaded models, process RSS and free RAM are plain numbers. */
function fakeMachine(init: { loaded?: LoadedInfo[]; server?: number; free?: number; shapes?: Record<string, ModelShape> } = {}) {
  const state = { loaded: [...(init.loaded ?? [])], server: init.server ?? 0.5 * GiB, free: init.free ?? 100 * GiB, pids: new Map<number, number>(), unloaded: [] as string[] };
  const probe: MemoryProbe = {
    loaded: async () => state.loaded.map((model) => ({ ...model })),
    shape: async (model) => init.shapes?.[model] ?? null,
    unload: async (model) => { state.unloaded.push(model); state.loaded = state.loaded.filter((item) => item.name !== model); },
    serverRss: () => state.server,
    pidRss: (pid) => state.pids.get(pid) ?? 0,
    systemAvailable: () => state.free,
  };
  return { state, probe };
}

const budgetOf = (probe: MemoryProbe, gib = 40, reserve = 0, file?: string) => new MemoryBudget(probe, () => ({ budgetBytes: gib * GiB, systemReserveBytes: reserve * GiB }), file, 10);
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const model = (name: string, gib: number): LoadedInfo => ({ name, sizeBytes: gib * GiB, contextLength: 8192 });

describe('RAM budget admission', () => {
  it('runs jobs concurrently while they fit', async () => {
    const { probe } = fakeMachine();
    const budget = budgetOf(probe);
    const a = await budget.admit({ kind: 'chat', label: 'a', model: 'a', bytes: 15 * GiB });
    const b = await budget.admit({ kind: 'image', label: 'img', bytes: 10 * GiB });
    expect(budget.snapshotActive()).toHaveLength(2);
    a.release(); b.release();
    expect(budget.snapshotActive()).toHaveLength(0);
  });

  it('queues a job that would pass the cap, reports its place, and starts it when memory frees', async () => {
    const { probe } = fakeMachine();
    const budget = budgetOf(probe);
    const first = await budget.admit({ kind: 'chat', label: 'big', model: 'big', bytes: 30 * GiB });
    const waits: number[] = [];
    let started = false;
    const second = budget.admit({ kind: 'chat', label: 'other', model: 'other', bytes: 20 * GiB, onWait: (ahead) => waits.push(ahead) }).then((lease) => { started = true; return lease; });
    await tick();
    expect(started).toBe(false);
    expect(waits).toContain(0);
    const usage = await budget.usage();
    expect(usage.usedBytes).toBeLessThanOrEqual(40 * GiB);
    first.release();
    (await second).release();
    expect(started).toBe(true);
  });

  it('keeps FIFO within a priority and puts chat before images before background', async () => {
    const { probe } = fakeMachine();
    const budget = budgetOf(probe, 10, 0);
    const blocker = await budget.admit({ kind: 'chat', label: 'blocker', bytes: 9 * GiB });
    const order: string[] = [];
    const ahead: Record<string, number[]> = { bg: [], img: [], chat1: [], chat2: [] };
    const jobs = (['bg', 'img', 'chat1', 'chat2'] as const).map((label) => budget.admit({
      kind: label === 'bg' ? 'background' : label === 'img' ? 'image' : 'chat', label, bytes: 6 * GiB, onWait: (n) => ahead[label]!.push(n),
    }).then((lease) => { order.push(label); lease.release(); }));
    await tick();
    expect(budget.snapshotQueue().map((item) => item.label)).toEqual(['chat1', 'chat2', 'img', 'bg']);
    expect(ahead.bg!.at(-1)).toBe(3);
    blocker.release();
    await Promise.all(jobs);
    expect(order).toEqual(['chat1', 'chat2', 'img', 'bg']);
  });

  it('unloads idle Ollama models before making anyone wait', async () => {
    const { state, probe } = fakeMachine({ loaded: [model('old-small', 4), model('old-big', 20)] });
    const budget = budgetOf(probe);
    const lease = await budget.admit({ kind: 'chat', label: 'new', model: 'new', bytes: 18 * GiB });
    expect(state.unloaded).toEqual(['old-big']);
    lease.release();
  });

  it('never unloads a model a running job is using', async () => {
    const { state, probe } = fakeMachine({ loaded: [model('busy', 25)] });
    const budget = budgetOf(probe);
    const busy = await budget.admit({ kind: 'chat', label: 'busy', model: 'busy', bytes: 25 * GiB });
    let started = false;
    const next = budget.admit({ kind: 'image', label: 'img', bytes: 20 * GiB }).then((lease) => { started = true; return lease; });
    await tick();
    expect(state.unloaded).toEqual([]);
    expect(started).toBe(false);
    busy.release();
    // Now idle: unloaded to make room.
    (await next).release();
    expect(state.unloaded).toEqual(['busy']);
  });

  it('counts a model shared by concurrent chats once', async () => {
    const { state, probe } = fakeMachine();
    const budget = budgetOf(probe, 20);
    const a = await budget.admit({ kind: 'chat', label: 'a', model: 'qwen', bytes: 15 * GiB });
    state.loaded = [model('qwen', 15)];
    const b = await budget.admit({ kind: 'chat', label: 'b', model: 'qwen', bytes: 15 * GiB });
    expect((await budget.usage()).models).toBe(15 * GiB);
    a.release(); b.release();
  });

  it('uses the larger of measured and reserved memory', async () => {
    const { state, probe } = fakeMachine({ loaded: [model('qwen', 12)] });
    const budget = budgetOf(probe);
    const lease = await budget.admit({ kind: 'image', label: 'img', bytes: 3 * GiB });
    lease.setPid(42);
    state.pids.set(42, 5 * GiB);
    const usage = await budget.usage();
    expect(usage.images).toBe(5 * GiB);
    expect(usage.usedBytes).toBe(12 * GiB + 5 * GiB + 0.5 * GiB);
    expect(budget.peakOf(lease)).toBe(5 * GiB);
    lease.release();
  });

  it('fails fast when a job can never fit the cap', async () => {
    const { probe } = fakeMachine();
    const budget = budgetOf(probe);
    await expect(budget.admit({ kind: 'chat', label: 'huge', model: 'huge', bytes: 45 * GiB })).rejects.toMatchObject({ neverFits: true });
    await expect(budget.admit({ kind: 'chat', label: 'huge', bytes: 45 * GiB })).rejects.toBeInstanceOf(BudgetError);
  });

  it('also waits when the machine itself is short on free RAM', async () => {
    const { state, probe } = fakeMachine({ free: 6 * GiB });
    const budget = budgetOf(probe, 40, 2);
    let started = false;
    const job = budget.admit({ kind: 'chat', label: 'mid', bytes: 8 * GiB }).then((lease) => { started = true; return lease; });
    await tick();
    expect(started).toBe(false);
    state.free = 16 * GiB;
    (await job).release();
    expect(started).toBe(true);
  });

  it('drops a waiting job when its run is stopped', async () => {
    const { probe } = fakeMachine();
    const budget = budgetOf(probe, 10);
    const blocker = await budget.admit({ kind: 'chat', label: 'blocker', bytes: 9 * GiB });
    const controller = new AbortController();
    const waiting = budget.admit({ kind: 'chat', label: 'w', bytes: 5 * GiB, signal: controller.signal });
    await tick();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ neverFits: false });
    expect(budget.snapshotQueue()).toHaveLength(0);
    blocker.release();
  });

  it('never goes over the cap under a burst of mixed jobs', async () => {
    const { probe } = fakeMachine();
    const budget = budgetOf(probe);
    let peak = 0;
    const jobs = Array.from({ length: 12 }, (_, index) => budget.admit({ kind: (['chat', 'image', 'background'] as const)[index % 3], label: `j${index}`, model: `m${index}`, bytes: (5 + (index % 4) * 4) * GiB })
      .then(async (lease) => {
        peak = Math.max(peak, (await budget.usage()).usedBytes);
        await tick();
        lease.release();
      }));
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(40 * GiB);
  });
});

describe('RAM estimates', () => {
  const shape: ModelShape = { fileBytes: 5 * GiB, layers: 36, kvHeads: 8, headDim: 128 };

  it('adds the KV cache for the context size', async () => {
    const { probe } = fakeMachine({ shapes: { qwen: shape } });
    const budget = budgetOf(probe);
    const small = await budget.estimateModel('qwen', 4096);
    const large = await budget.estimateModel('qwen', 32768);
    const kv = (ctx: number) => 2 * 36 * ctx * 8 * 128 * 2;
    expect(large - small).toBeCloseTo((kv(32768) - kv(4096)) * 1.1, -3);
    expect(await budget.estimateModel('unknown', 4096)).toBe(0);
  });

  it('grows image memory with resolution and learns from measured runs', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-mem-')), 'cal.json');
    const { probe } = fakeMachine();
    const budget = budgetOf(probe, 40, 0, file);
    const base = budget.estimateImage('sd', 2 * GiB, 512, 512);
    expect(budget.estimateImage('sd', 2 * GiB, 1024, 1024)).toBeGreaterThan(base);
    budget.calibrate('image:sd', base, base * 2);
    expect(budget.factor('image:sd')).toBe(1.5);
    const reloaded = budgetOf(probe, 40, 0, file);
    expect(reloaded.estimateImage('sd', 2 * GiB, 512, 512)).toBe(Math.round(base * 1.5));
  });

  it('defaults to a 40 GB budget', () => {
    expect(budgetConfig({}).budgetBytes).toBe(40 * GiB);
    expect(budgetConfig({ ramBudgetGiB: 24 }).budgetBytes).toBe(24 * GiB);
  });
});

describe('RAM budget in the engine', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  async function setup(models: [string, number][]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ram-'));
    dirs.push(dir);
    const shapes = Object.fromEntries(models.map(([name, gib]) => [name, { fileBytes: gib * GiB, layers: 2, kvHeads: 1, headDim: 8 }]));
    const machine = fakeMachine({ shapes });
    const seen: string[] = [];
    const recorder: ModelProvider = {
      async *complete(req) {
        seen.push(req.model);
        yield { type: 'token', text: 'ok' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } };
      },
    };
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl, providerOverride: () => recorder, memoryProbe: machine.probe });
    const { store } = built;
    store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
    for (const [name] of models) store.upsertModel({
      id: name, providerId: 'prov_ollama', name, apiName: name, profileId: name, tokenizer: 'approx', contextWindow: 32768, practicalBudget: 8192,
      strategy: 'rolling', sizeClass: 'small', local: true, modalities: ['text'], strengths: ['chat'], typicalQ4GiB: 3,
      priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: 'test', source: 'test', embedding: false, freeTier: null, enabled: true,
    });
    const agent = store.createAgent({ name: 'House', systemPrompt: 'Be brief.', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Chat' });
    return { ...built, machine, seen, agent, session };
  }

  it('shows "waiting for memory" in chat and starts the reply once memory frees', async () => {
    const { app, engine, bus, store, agent, session, seen } = await setup([['small:4b', 3]]);
    const blocker = await engine.memory!.admit({ kind: 'image', label: 'image', bytes: 38 * GiB });
    const notes: string[] = [];
    bus.subscribeAll((event) => { if (event.type === 'status' && event.status === 'waiting') notes.push(String(event.detail)); });
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello there', modelId: 'small:4b' });
    await tick(); await tick();
    expect(notes.some((note) => /Waiting for memory/.test(note))).toBe(true);
    expect(seen).toHaveLength(0);
    blocker.release();
    for (let i = 0; i < 100 && store.getRun(run.id)?.status !== 'completed'; i += 1) await tick();
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(seen).toEqual(['small:4b']);
    await app.close();
  });

  it('falls back to a smaller local model when the chosen one can never fit', async () => {
    const { app, engine, store, agent, session, seen } = await setup([['huge:400b', 60], ['small:4b', 3]]);
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello there', modelId: 'huge:400b', wait: true });
    expect(run.status).toBe('completed');
    expect(seen).toEqual(['small:4b']);
    expect(store.getRun(run.id)?.routingNote).toMatch(/RAM budget/);
    await app.close();
  });

  it('fails with a clear message when nothing fits', async () => {
    const { app, engine, agent, session, seen } = await setup([['huge:400b', 60]]);
    const run = await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello there', modelId: 'huge:400b', wait: true });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/RAM|budget/);
    expect(seen).toHaveLength(0);
    await app.close();
  });
});
