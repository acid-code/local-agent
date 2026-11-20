import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import type { ModelRow } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Bus } from '../src/bus.js';
import { DockerCtl } from '../src/docker.js';
import { VectorIndex } from '../src/embeddings.js';
import { Vault } from '../src/vault.js';
import { ScriptedProvider, providerFor, LLAMA_TIMEOUT_MS } from '../src/providers.js';
import { LlamaWatch, isLlamaServerProvider, isOllamaProvider, modelGiB } from '../src/coexist.js';
import { isContextOverflowError } from '@local-agent/shared';
import { clipToolOutput, toHostBindPath } from '../src/tools.js';
import { checkFinalReply, falseInability } from '../src/recovery.js';

function model(id: string, providerId: string, apiName: string, gib: number, sizeClass: 'small' | 'large'): Omit<ModelRow, 'createdAt'> & Record<string, unknown> {
  return {
    id, providerId, name: apiName, apiName, profileId: 'p', tokenizer: 'approx', contextWindow: 32768, practicalBudget: 32768,
    strategy: 'rolling', sizeClass, local: true, modalities: ['text'], strengths: ['chat', 'code'], typicalQ4GiB: gib,
    priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: null, source: 'discovered', embedding: false, freeTier: null, enabled: true,
  };
}

function setup(healthOk: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-coexist-'));
  const store = new Store(path.join(dir, 'local-agent.db'));
  store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
  store.upsertProvider({ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
  store.upsertModel(model('ollama_gpt_oss_20b', 'prov_ollama', 'gpt-oss:20b', 13.8, 'large') as never);
  store.upsertModel(model('ollama_qwen3_1_7b', 'prov_ollama', 'qwen3:1.7b', 1.4, 'small') as never);
  store.upsertModel(model('llama_qwen3_6', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large') as never);
  const health: typeof fetch = async () => new Response('{}', { status: healthOk ? 200 : 503 });
  return { dir, store, health };
}

describe('llama-server and Ollama coexistence', () => {
  it('classifies providers and sizes', () => {
    expect(isOllamaProvider({ id: 'prov_ollama', name: 'Ollama', kind: 'openai_compat', baseUrl: null })).toBe(true);
    expect(isOllamaProvider({ id: 'x', name: 'x', kind: 'openai_compat', baseUrl: 'http://host.docker.internal:11434/v1' })).toBe(true);
    expect(isOllamaProvider({ id: 'prov_llama', name: 'llama-server', kind: 'openai_compat', baseUrl: 'http://host.docker.internal:8080/v1' })).toBe(false);
    expect(isLlamaServerProvider({ id: 'prov_llama', name: 'llama-server', kind: 'openai_compat' })).toBe(true);
    expect(modelGiB({ apiName: 'gpt-oss:20b', typicalQ4GiB: null })).toBeGreaterThan(4);
    expect(modelGiB({ apiName: 'nomic-embed-text', typicalQ4GiB: 0.3 })).toBeLessThan(4);
  });

  it('blocks big Ollama models only while llama-server answers', async () => {
    for (const ok of [true, false]) {
      const { dir, store, health } = setup(ok);
      try {
        const watch = new LlamaWatch(store, health);
        await watch.refresh();
        const ollama = store.getProvider('prov_ollama')!;
        expect(watch.blocks(store.getModel('ollama_gpt_oss_20b')!, ollama)).toBe(ok);
        expect(watch.blocks(store.getModel('ollama_qwen3_1_7b')!, ollama)).toBe(false);
        expect(watch.blocks(store.getModel('llama_qwen3_6')!, store.getProvider('prov_llama')!)).toBe(false);
        expect(watch.model()?.id).toBe('llama_qwen3_6');
      } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('routes a coding turn to llama-server instead of a 20B Ollama coder', async () => {
    const { dir, store, health } = setup(true);
    try {
      const used: string[] = [];
      const engine = new Engine(store, new Bus(), new DockerCtl('/nonexistent.sock'), new VectorIndex(store.db), new Vault(store, Buffer.alloc(32, 7)), 'inst_test', health, (m) => {
        used.push(m.apiName);
        return new ScriptedProvider([{ text: 'Patched.' }]);
      });
      await engine.llama.refresh();
      const agent = store.createAgent({
        name: 'Coder', description: 'Codes', systemPrompt: 'You write code.', modelId: null,
        routing: 'auto', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir,
      });
      const session = store.createSession({ agentId: agent.id, title: 'fix' });
      await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'Please fix the bug in the parser and refactor it', wait: true });
      expect(used).toContain('qwen3.6-35b-a3b');
      expect(used).not.toContain('gpt-oss:20b');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the llama-server prompt cache on', async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    };
    const row = model('llama_qwen3_6', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large') as unknown as ModelRow;
    const provider = providerFor(row, { id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://host.docker.internal:8080/v1', apiKeyEnv: null, enabled: true, createdAt: '' }, fakeFetch);
    for await (const _ of provider.complete({ model: 'qwen3.6-35b-a3b', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    expect(body.cache_prompt).toBe(true);
  });

  it('errors instead of silently finishing when an SSE stream drops mid-reply', async () => {
    const truncated = 'data: {"choices":[{"delta":{"content":"Half an answer"}}]}\n\n';
    const fakeFetch: typeof fetch = async () => new Response(truncated, { headers: { 'content-type': 'text/event-stream' } });
    const row = model('llama_qwen3_6', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large') as unknown as ModelRow;
    const provider = providerFor(row, { id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://host.docker.internal:8080/v1', apiKeyEnv: null, enabled: true, createdAt: '' }, fakeFetch);
    const drain = async () => {
      for await (const _ of provider.complete({ model: 'qwen3.6-35b-a3b', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    };
    await expect(drain()).rejects.toThrow(/ended unexpectedly/i);
  });

  it('retries HTTP 503 from llama-server during model reload and uses a 300s default timeout', async () => {
    expect(LLAMA_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    const prev = process.env.LA_LLAMA_503_RETRY_MS;
    process.env.LA_LLAMA_503_RETRY_MS = '10';
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('{"error":"Loading model"}', { status: 503 });
      return new Response('data: {"choices":[{"delta":{"content":"Ready"},"finish_reason":"stop"}]}\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    try {
      const row = model('llama_qwen3_6', 'prov_llama', 'qwen3.6-35b-a3b', 23, 'large') as unknown as ModelRow;
      const provider = providerFor(row, { id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://host.docker.internal:8080/v1', apiKeyEnv: null, enabled: true, createdAt: '' }, fakeFetch);
      const tokens: string[] = [];
      for await (const ev of provider.complete({ model: 'qwen3.6-35b-a3b', messages: [{ role: 'user', content: 'hi' }] })) {
        if (ev.type === 'token') tokens.push(ev.text);
      }
      expect(calls).toBe(2);
      expect(tokens.join('')).toBe('Ready');
    } finally {
      if (prev === undefined) delete process.env.LA_LLAMA_503_RETRY_MS;
      else process.env.LA_LLAMA_503_RETRY_MS = prev;
    }
  });

  it('detects llama-server context overflow, maps host bind paths, clips huge tool output, and compacts/hands off sessions', async () => {
    expect(isContextOverflowError('request (35000 tokens) exceeds the available context size (32768 tokens)')).toBe(true);
    expect(isContextOverflowError('exceed_context_size_error')).toBe(true);

    const prevHostProj = process.env.LA_HOST_PROJECTS_DIR;
    const prevProj = process.env.LA_PROJECTS_DIR;
    process.env.LA_PROJECTS_DIR = '/projects';
    process.env.LA_HOST_PROJECTS_DIR = '/home/acid/projects';
    try {
      expect(toHostBindPath('/projects/local-agent')).toBe('/home/acid/projects/local-agent');
    } finally {
      if (prevHostProj === undefined) delete process.env.LA_HOST_PROJECTS_DIR; else process.env.LA_HOST_PROJECTS_DIR = prevHostProj;
      if (prevProj === undefined) delete process.env.LA_PROJECTS_DIR; else process.env.LA_PROJECTS_DIR = prevProj;
    }

    const clipped = clipToolOutput('A'.repeat(20_000), 1000);
    expect(clipped.length).toBeLessThan(1200);
    expect(clipped).toMatch(/characters omitted/);

    const { dir, store, health } = setup(true);
    try {
      const engine = new Engine(store, new Bus(), new DockerCtl('/nonexistent.sock'), new VectorIndex(store.db), new Vault(store, Buffer.alloc(32, 7)), 'inst_test', health, () => new ScriptedProvider([{ text: '- Goal: test\n- Next: verify' }, { text: '**Goal**: test\n**Next Steps**: continue' }]));
      const agent = store.createAgent({
        name: 'Coder', description: 'Codes', systemPrompt: 'You code.', modelId: null,
        routing: 'auto', strategy: 'rolling', toolAllowlist: [], memoryEnabled: false, workspacePath: dir,
      });
      const session = store.createSession({ agentId: agent.id, title: 'Big repo chat' });
      for (let i = 0; i < 8; i += 1) {
        store.insertMessage({ sessionId: session.id, role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i} ${'x'.repeat(200)}`, toolCalls: null, agentId: agent.id, runId: null, toolCallId: null, toolName: null, imageUrl: null, routingNote: null });
      }
      const compacted = await engine.compactSession(session.id);
      expect(compacted.compactedMessages).toBe(4);
      expect(compacted.summary).toContain('Goal');

      const handoff = await engine.handoffSession(session.id);
      expect(handoff.session.id).not.toBe(session.id);
      expect(handoff.session.title).toContain('(cont.)');
      const freshMsgs = store.listMessages(handoff.session.id);
      expect(freshMsgs.length).toBe(1);
      expect(freshMsgs[0]!.content).toContain('Continued from previous chat');

      // Mini-agent fast-tier selection: picks lightweight Ollama model (<= 4 GiB), never 20B Ollama or heavy llama-server.
      const fastPick = engine.autonomy.pickHelperModel('fast');
      expect(fastPick?.apiName).toBe('qwen3:1.7b');
      expect(engine.autonomy.pickHelperModel('main')).toBeUndefined();

      // Capability self-check: catches false claims of inability when built-in tools are attached.
      expect(falseInability("❌ Generate a .pptx file (I can't create PowerPoint files directly)", ['make_slides'])?.tool).toBe('make_slides');
      expect(falseInability("I cannot run OCR on images.", ['read_image_text'])?.tool).toBe('read_image_text');
      const verdict = checkFinalReply([], "I can't generate a .pptx file directly.", 0, 10, false, ['make_slides']);
      expect(verdict.action).toBe('retry');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
