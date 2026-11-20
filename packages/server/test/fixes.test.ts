import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_MAP, MACHINE_PROFILES, decideAuto, planContext, roleContextBudget } from '@local-agent/shared';
import { Store } from '../src/db.js';
import { MemoryBudget, GiB, type MemoryProbe } from '../src/memory.js';
import { normalizeOllamaHost } from '../src/ollama.js';
import { guardEmptyDataDir } from '../src/ops.js';
import { parseSemgrepJson } from '../src/semgrep.js';
import { falseSuccess } from '../src/monitor.js';
import { providerFor } from '../src/providers.js';
import { Engine } from '../src/engine.js';
import { Bus } from '../src/bus.js';
import { DockerCtl } from '../src/docker.js';
import { VectorIndex } from '../src/embeddings.js';
import { Vault } from '../src/vault.js';
import { ScriptedProvider } from '../src/providers.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'la-fixes-'));
}

describe('persistence, networking, models, memory, and agent fixes', () => {
  it('refuses to start on an empty data folder when an existing install is found', async () => {
    const existing = tmpDir();
    const empty = tmpDir();
    fs.writeFileSync(path.join(existing, 'local-agent.db'), 'sqlite');
    const prevNodeEnv = process.env.NODE_ENV;
    const prevExisting = process.env.LA_EXISTING_DATA_DIRS;
    const prevAllow = process.env.LA_ALLOW_EMPTY_DATA;
    try {
      process.env.NODE_ENV = 'production';
      process.env.LA_EXISTING_DATA_DIRS = existing;
      delete process.env.LA_ALLOW_EMPTY_DATA;
      await expect(guardEmptyDataDir(empty)).rejects.toThrow(/Refusing to start on empty data folder/);
      process.env.LA_ALLOW_EMPTY_DATA = '1';
      await expect(guardEmptyDataDir(empty)).resolves.toBeUndefined();
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevExisting === undefined) delete process.env.LA_EXISTING_DATA_DIRS;
      else process.env.LA_EXISTING_DATA_DIRS = prevExisting;
      if (prevAllow === undefined) delete process.env.LA_ALLOW_EMPTY_DATA;
      else process.env.LA_ALLOW_EMPTY_DATA = prevAllow;
      fs.rmSync(existing, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('normalizes OLLAMA_HOST bare hostnames and 0.0.0.0', () => {
    expect(normalizeOllamaHost('host.docker.internal')).toBe('http://host.docker.internal:11434');
    expect(normalizeOllamaHost('0.0.0.0:11434')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaHost('http://host.docker.internal:11434/v1')).toBe('http://host.docker.internal:11434');
  });

  it('supports forceAdmit and cancelWait on MemoryBudget', async () => {
    let available = 2 * GiB;
    const probe: MemoryProbe = {
      loaded: async () => [],
      shape: async () => null,
      unload: async () => {},
      serverRss: () => 200 * 1024 * 1024,
      pidRss: () => 0,
      systemAvailable: () => available,
    };
    const budget = new MemoryBudget(probe, () => ({ budgetBytes: 40 * GiB, systemReserveBytes: 1.5 * GiB }), undefined, 50);
    const waitPromise = budget.admit({ kind: 'chat', runId: 'run_force_1', label: 'test', bytes: 10 * GiB });
    await new Promise((r) => setTimeout(r, 20));
    expect(budget.snapshotQueue().length).toBe(1);
    expect(budget.forceAdmit('run_force_1')).toBe(true);
    const lease = await waitPromise;
    expect(lease.bytes).toBe(10 * GiB);
    lease.release();

    const cancelPromise = budget.admit({ kind: 'chat', runId: 'run_cancel_1', label: 'test2', bytes: 10 * GiB });
    await new Promise((r) => setTimeout(r, 20));
    expect(budget.cancelWait('run_cancel_1')).toBe(true);
    await expect(cancelPromise).rejects.toThrow(/Cancelled while waiting for memory/);
    void available;
  });

  it('uses per-role context lengths (16-32K default, 64-128K for coder on repo tasks) and non-Qwen coder default', () => {
    expect(DEFAULT_AUTO_MAP.coder).toBe('gpt-oss:20b');
    const ryzen = MACHINE_PROFILES.find((p) => p.id === 'ryzen-780m-48g')!;
    expect(ryzen.roles.find((r) => r.role === 'coder')?.model).toBe('gpt-oss:20b');
    expect(ryzen.runtime.host.join('\n')).toContain('Ubuntu Server 26.04 LTS');

    const model = { local: true, contextWindow: 131_072, practicalBudget: 32_768, sizeClass: 'large' as const };
    expect(roleContextBudget('fast', model)).toBe(16_384);
    expect(roleContextBudget('main', model)).toBe(32_768);
    expect(roleContextBudget('coder', model, { repoTask: false })).toBe(32_768);
    expect(roleContextBudget('coder', model, { repoTask: true })).toBe(65_536);
    expect(roleContextBudget('coder', model, { repoTask: true, extended: true })).toBe(131_072);

    const decision = decideAuto({
      text: 'fix the bug in auth.ts',
      map: DEFAULT_AUTO_MAP,
      models: [
        { id: 'm_main', name: 'gemma4:26b-a4b', apiName: 'gemma4:26b-a4b', local: true, embedding: false, sizeClass: 'large', providerKind: 'openai_compat', practicalBudget: 32_768, enabled: true },
        { id: 'm_coder', name: 'gpt-oss-20b-Q4_K_M.gguf', apiName: 'gpt-oss-20b-Q4_K_M.gguf', local: true, embedding: false, sizeClass: 'large', providerKind: 'openai_compat', practicalBudget: 32_768, enabled: true },
      ],
    });
    expect(decision.modelId).toBe('m_coder');
  });

  it('parses offline Semgrep JSON output', () => {
    const sample = JSON.stringify({
      results: [{
        check_id: 'la.security.js-eval',
        path: '/src/app.ts',
        start: { line: 42 },
        extra: { severity: 'ERROR', message: 'Avoid eval()' },
      }],
    });
    const findings = parseSemgrepJson(sample);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: 'la.security.js-eval', path: 'app.ts', line: 42, severity: 'ERROR' });
  });

  it('persists thinking on messages and voiceReply on agents, and computes ContextBreakdown', () => {
    const dir = tmpDir();
    try {
      const store = new Store(path.join(dir, 'local-agent.db'));
      const agent = store.createAgent({
        name: 'VoiceBot', description: 'Speaks', systemPrompt: 'Hi', modelId: null,
        routing: 'auto', strategy: null, toolAllowlist: [], memoryEnabled: true, workspacePath: dir,
      });
      const updated = store.updateAgent(agent.id, { voiceReply: true, voiceName: 'Kore' })!;
      expect(updated.voiceReply).toBe(true);
      expect(updated.voiceName).toBe('Kore');

      const session = store.createSession({ agentId: agent.id, title: 'Test' });
      const msg = store.insertMessage({
        sessionId: session.id, role: 'assistant', content: 'Answer here', toolCallId: null,
        toolName: null, toolCalls: null, agentId: agent.id, runId: null, imageUrl: null,
        routingNote: null, thinking: 'Step 1: analyze carefully.',
      });
      expect(store.getMessage(msg.id)?.thinking).toBe('Step 1: analyze carefully.');

      const plan = planContext({
        strategy: 'rolling',
        contextWindow: 32768,
        practicalBudget: 16384,
        outputReserve: 2048,
        system: 'You are helpful.',
        pinned: ['User likes tea'],
        summaries: [],
        retrieved: [],
        tokenizer: 'approx',
        messages: [{ id: 'm1', role: 'user', content: 'Hello!' }],
        breakdownHints: { systemPrompt: 20, personaAndTools: 150, memory: 40, files: 10 },
      });
      expect(plan.breakdown.budget).toBe(14336);
      expect(plan.breakdown.personaAndTools).toBe(150);
      expect(plan.breakdown.remaining).toBeGreaterThan(13000);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows Planner contract persona to call manage_trigger', async () => {
    const dir = tmpDir();
    try {
      const store = new Store(path.join(dir, 'local-agent.db'));
      const bus = new Bus();
      const docker = new DockerCtl('/nonexistent.sock');
      const vectors = new VectorIndex(store.db);
      const vault = new Vault(store, Buffer.alloc(32, 7));
      const scripted = new ScriptedProvider([
        { toolCalls: [{ id: 'tc_1', name: 'manage_trigger', arguments: JSON.stringify({ action: 'list' }) }] },
        { text: 'Checked your triggers.' },
      ]);
      const engine = new Engine(store, bus, docker, vectors, vault, 'inst_test', fetch, () => scripted);
      const planner = store.createAgent({
        name: 'Planner', description: 'Plans', systemPrompt: 'You are a planner.', modelId: null,
        routing: 'auto', strategy: 'rolling', toolAllowlist: ['read_file', 'manage_trigger'], memoryEnabled: false, workspacePath: dir,
      });
      const prov = store.upsertProvider({ id: 'prov_test', kind: 'openai_compat', name: 'Test', baseUrl: 'http://127.0.0.1:9999/v1', enabled: true });
      store.upsertModel({
        id: 'm_test', providerId: prov.id, name: 'test-model', apiName: 'test-model', profileId: 'p', tokenizer: 'approx',
        contextWindow: 16384, practicalBudget: 16384, strategy: 'rolling', sizeClass: 'small', local: true, modalities: ['text'],
        strengths: ['chat'], typicalQ4GiB: 2, priceIn: 0, priceOut: 0, notes: '', parameterSize: '4B', family: 'test',
        source: 'discovered', embedding: false, freeTier: null, enabled: true,
      });
      const session = store.createSession({ agentId: planner.id, title: 'Triggers test' });
      const run = await engine.startTurn({ sessionId: session.id, agentId: planner.id, content: 'List my triggers', wait: true });
      const steps = store.listSteps(run.id);
      const contractFail = steps.find((s) => s.kind === 'contract' && s.status === 'failed' && s.name === 'manage_trigger');
      expect(contractFail).toBeUndefined();
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams reasoning_content as thinking events from llama-server (OpenAIProvider)', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}',
      'data: {"choices":[{"delta":{"content":"42"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    const fakeFetch: typeof fetch = async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    const provider = providerFor(
      { id: 'llama_qwen', providerId: 'prov_llama', name: 'Qwen', apiName: 'Qwen', profileId: 'p', tokenizer: 'approx', contextWindow: 32768, practicalBudget: 32768, strategy: 'rolling', sizeClass: 'large', local: true, modalities: ['text'], strengths: ['code'], typicalQ4GiB: 20, priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: null, source: 'discovered', embedding: false, freeTier: null, enabled: true },
      { id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: null, enabled: true, createdAt: '' },
      fakeFetch,
    );
    const events = [];
    for await (const ev of provider.complete({ model: 'Qwen', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev);
    expect(events.some((e) => e.type === 'thinking' && e.text === 'Let me think')).toBe(true);
    expect(events.some((e) => e.type === 'token' && e.text === '42')).toBe(true);
  });

  it('flags non-zero shell exit outputs in falseSuccess stronger checks', () => {
    const verdict = falseSuccess(
      [{ kind: 'tool', name: 'shell', status: 'completed', error: null, index: 1, output: 'exit 1\nnpm test failed' }],
      'All tests succeeded and everything is fixed!',
      'completed',
    );
    expect(verdict.flagged).toBe(true);
    expect(verdict.failedTools).toContain('shell');
  });
});
