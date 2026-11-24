import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ModelRow, ProviderRow } from '../src/db.js';
import { computePrefillSnapshot, providerFor, type ProviderEvent } from '../src/providers.js';
import { buildLiveSlotStatus, type LlamaRawSlot } from '../src/routes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const llamaModel = {
  id: 'llama_qwen',
  providerId: 'prov_llama',
  name: 'qwen3.6-35b-a3b',
  apiName: 'qwen3.6-35b-a3b',
  profileId: 'p',
  tokenizer: 'approx',
  contextWindow: 32768,
  practicalBudget: 32768,
  strategy: 'rolling',
  sizeClass: 'large',
  local: true,
  modalities: ['text'],
  strengths: ['chat', 'code'],
  typicalQ4GiB: 20,
  priceIn: 0,
  priceOut: 0,
  notes: '',
  parameterSize: null,
  family: null,
  source: 'discovered',
  embedding: false,
  freeTier: null,
  enabled: true,
} as unknown as ModelRow;

const llamaProvider: ProviderRow = {
  id: 'prov_llama',
  kind: 'openai_compat',
  name: 'llama-server',
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKeyEnv: null,
  enabled: true,
  createdAt: '',
} as ProviderRow;

async function waitFor(check: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('timed out');
}

describe('prefill progress accuracy', () => {
  it('sends return_progress: true and cache_prompt: true for llama-server and parses prompt_progress events without fake tokens or early done', async () => {
    let sentBody: Record<string, unknown> = {};
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":null},"finish_reason":null}],"prompt_progress":{"total":15000,"cache":12000,"processed":12000,"time_ms":0}}',
      'data: {"choices":[{"delta":{"role":"assistant","content":null},"finish_reason":null}],"prompt_progress":{"total":15000,"cache":12000,"processed":13500,"time_ms":1000}}',
      'data: {"choices":[{"delta":{"role":"assistant","content":null},"finish_reason":null}],"prompt_progress":{"total":15000,"cache":12000,"processed":15000,"time_ms":2000}}',
      'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":15000,"completion_tokens":1}}',
      'data: [DONE]',
      '',
    ].join('\n');

    const provider = providerFor(llamaModel, llamaProvider, (async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch);

    const events: ProviderEvent[] = [];
    for await (const ev of provider.complete({ model: llamaModel.apiName, messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }

    expect(sentBody.cache_prompt).toBe(true);
    expect(sentBody.return_progress).toBe(true);
    const progresses = events.filter((e): e is Extract<ProviderEvent, { type: 'progress' }> => e.type === 'progress');
    expect(progresses.map((e) => e.progress)).toEqual([
      { total: 15000, cached: 12000, processed: 12000, timeMs: 0 },
      { total: 15000, cached: 12000, processed: 13500, timeMs: 1000 },
      { total: 15000, cached: 12000, processed: 15000, timeMs: 2000 },
    ]);
    const tokens = events.filter((e): e is Extract<ProviderEvent, { type: 'token' }> => e.type === 'token');
    expect(tokens.map((t) => t.text).join('')).toBe('Done');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('computes accurate prefillPct (remaining work 0->100), constant total, and speed for warm cached and cold prompts', () => {
    const warm0 = computePrefillSnapshot({ total: 15000, cached: 12000, processed: 12000, timeMs: 0 });
    const warm50 = computePrefillSnapshot({ total: 15000, cached: 12000, processed: 13500, timeMs: 1000 });
    const warm100 = computePrefillSnapshot({ total: 15000, cached: 12000, processed: 15000, timeMs: 2000 });

    expect(warm0).toMatchObject({ total: 15000, cached: 12000, toEval: 3000, evaluated: 0, prefillPct: 0, promptPct: 80, cacheHitPct: 80, prefillTokPerSec: null, done: false });
    expect(warm50).toMatchObject({ total: 15000, cached: 12000, toEval: 3000, evaluated: 1500, prefillPct: 50, promptPct: 90, cacheHitPct: 80, prefillTokPerSec: 1500, done: false });
    expect(warm100).toMatchObject({ total: 15000, cached: 12000, toEval: 3000, evaluated: 3000, prefillPct: 100, promptPct: 100, cacheHitPct: 80, prefillTokPerSec: 1500, done: true });

    const cold1 = computePrefillSnapshot({ total: 8000, cached: 0, processed: 2048, timeMs: 2000 });
    const cold2 = computePrefillSnapshot({ total: 8000, cached: 0, processed: 4096, timeMs: 4000 });
    const cold3 = computePrefillSnapshot({ total: 8000, cached: 0, processed: 8000, timeMs: 8000 });

    expect(cold1).toMatchObject({ total: 8000, cached: 0, toEval: 8000, evaluated: 2048, prefillPct: 26, promptPct: 26, cacheHitPct: 0, prefillTokPerSec: 1024, done: false });
    expect(cold2).toMatchObject({ total: 8000, cached: 0, toEval: 8000, evaluated: 4096, prefillPct: 51, promptPct: 51, cacheHitPct: 0, prefillTokPerSec: 1024, done: false });
    expect(cold3).toMatchObject({ total: 8000, cached: 0, toEval: 8000, evaluated: 8000, prefillPct: 100, promptPct: 100, cacheHitPct: 0, prefillTokPerSec: 1000, done: true });
  });

  it('buildLiveSlotStatus handles active exact prefill, generating, raw /slots fallback without shifting ratio, and zeroed idle slots', () => {
    const snap = computePrefillSnapshot({ total: 15000, cached: 12000, processed: 13500, timeMs: 1000 });
    const active = buildLiveSlotStatus({
      is_processing: true,
      n_ctx: 32768,
      n_prompt_tokens: 13500,
      n_prompt_tokens_processed: 1500,
      n_prompt_tokens_cache: 12000,
      next_token: [{ n_decoded: 0 }],
    }, 'main', snap);
    expect(active).toMatchObject({
      isProcessing: true,
      isPrefilling: true,
      isGenerating: false,
      promptTotal: 15000,
      promptProcessed: 13500,
      promptCached: 12000,
      promptNewTotal: 3000,
      promptNewProcessed: 1500,
      prefillPct: 50,
      promptPct: 90,
      cacheHitPct: 80,
      prefillTokPerSec: 1500,
      exactProgress: true,
    });

    const gen = buildLiveSlotStatus({
      is_processing: true,
      n_ctx: 32768,
      n_prompt_tokens: 15000,
      n_prompt_tokens_processed: 3000,
      n_prompt_tokens_cache: 12000,
      next_token: [{ n_decoded: 25 }],
    }, 'main', snap);
    expect(gen).toMatchObject({
      isProcessing: true,
      isPrefilling: false,
      isGenerating: true,
      nDecoded: 25,
      promptTotal: 15000,
      promptProcessed: 15000,
      promptCached: 12000,
      prefillPct: 100,
      cacheHitPct: 80,
      exactProgress: true,
    });

    // Without activePrefill during /slots prefill (where n_prompt_tokens grows alongside processed),
    // prefillPct MUST be null rather than dividing processed / n_prompt_tokens (~70-80%).
    const rawSlot: LlamaRawSlot = {
      is_processing: true,
      n_ctx: 32768,
      n_prompt_tokens: 13500,
      n_prompt_tokens_processed: 9500,
      n_prompt_tokens_cache: 4000,
      next_token: [{ n_decoded: 0 }],
    };
    const fallback = buildLiveSlotStatus(rawSlot, 'main', null);
    expect(fallback).toMatchObject({
      isProcessing: true,
      isPrefilling: true,
      isGenerating: false,
      promptTotal: 0,
      promptProcessed: 13500,
      prefillPct: null,
      promptPct: null,
      cacheHitPct: null,
      exactProgress: false,
    });

    // Idle slot where llama.cpp zeroes processed & cache while leaving n_prompt_tokens populated
    const idleZeroed = buildLiveSlotStatus({
      is_processing: false,
      n_ctx: 32768,
      n_prompt_tokens: 14404,
      n_prompt_tokens_processed: 0,
      n_prompt_tokens_cache: 0,
      next_token: [{ n_decoded: 0 }],
    }, 'main', null);
    expect(idleZeroed).toMatchObject({
      isProcessing: false,
      isPrefilling: false,
      isGenerating: false,
      promptTotal: 14404,
      cacheHitPct: null,
    });
  });

  it('publishes monotonic prefill events on bus, exposes activePrefill during prefill, and clears it on generation', async () => {
    const prevLlamaUrl = process.env.LLAMA_SERVER_URL;
    process.env.LLAMA_SERVER_URL = 'http://127.0.0.1:8080/v1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-prefill-e2e-'));
    dirs.push(dir);
    let releaseThinking!: () => void;
    const gate = new Promise<void>((resolve) => { releaseThinking = resolve; });

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/slots')) {
        return new Response(JSON.stringify([{
          id: 0, n_ctx: 32768, is_processing: true,
          n_prompt_tokens: 12000, n_prompt_tokens_processed: 0, n_prompt_tokens_cache: 12000,
          next_token: [{ n_decoded: 0 }],
        }]), { headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/chat/completions')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const push = (line: string) => controller.enqueue(encoder.encode(`${line}\n`));
            push('data: {"choices":[{"delta":{"role":"assistant","content":null},"finish_reason":null}],"prompt_progress":{"total":15000,"cache":12000,"processed":12000,"time_ms":0}}');
            push('data: {"choices":[{"delta":{"role":"assistant","content":null},"finish_reason":null}],"prompt_progress":{"total":15000,"cache":12000,"processed":13500,"time_ms":1000}}');
            await gate;
            push('data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}');
            push('data: {"choices":[{"delta":{"content":"Final answer."},"finish_reason":"stop"}],"usage":{"prompt_tokens":15000,"completion_tokens":3}}');
            push('data: [DONE]');
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: llamaModel.apiName }] }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    };

    let built: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl });
      const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '15'].join('-') } });
      const cookies = { la_session: res.cookies.find((c) => c.name === 'la_session')!.value };
      built.store.upsertProvider(llamaProvider);
      built.store.upsertModel(llamaModel);
      const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: llamaModel.id } })).json().agent as { id: string; ownerId: string };
      const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });

      const seenPrefillPcts: number[] = [];
      const off = built.bus.subscribeAll((ev) => {
        if (ev.type === 'prefill') {
          seenPrefillPcts.push((ev.prefill as { prefillPct: number }).prefillPct);
        }
      });

      const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello' });
      await waitFor(() => seenPrefillPcts.length >= 2);
      expect(seenPrefillPcts).toEqual([0, 50]);
      expect(built.engine.activePrefill('main')?.prefillPct).toBe(50);

      const liveRes = await built.app.inject({ method: 'GET', url: '/api/llm/live', cookies });
      expect(liveRes.statusCode).toBe(200);
      expect((liveRes.json() as { slot: { prefillPct: number; promptTotal: number; exactProgress: boolean } }).slot).toMatchObject({
        prefillPct: 50,
        promptTotal: 15000,
        exactProgress: true,
      });

      releaseThinking();
      await waitFor(() => ['completed', 'failed'].includes(built!.store.getRun(run.id)?.status ?? ''));
      off();
      expect(built.engine.activePrefill('main')).toBeNull();
      expect(built.engine.getLiveStream(run.id)?.prefill ?? null).toBeNull();
    } finally {
      await built?.app.close();
      if (prevLlamaUrl === undefined) delete process.env.LLAMA_SERVER_URL;
      else process.env.LLAMA_SERVER_URL = prevLlamaUrl;
    }
  });
});
