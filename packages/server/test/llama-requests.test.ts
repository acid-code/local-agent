import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRow, ProviderRow } from '../src/db.js';
import { maxTokensFor, providerFor, samplingFor, type ProviderEvent } from '../src/providers.js';

const model = { id: 'llama_qwen', providerId: 'prov_llama', name: 'qwen3.6-35b-a3b', apiName: 'qwen3.6-35b-a3b', profileId: 'p', tokenizer: 'approx', contextWindow: 32768, practicalBudget: 32768, strategy: 'rolling', sizeClass: 'large', local: true, modalities: ['text'], strengths: ['code'], typicalQ4GiB: 20, priceIn: 0, priceOut: 0, notes: '', parameterSize: null, family: null, source: 'discovered', embedding: false, freeTier: null, enabled: true } as unknown as ModelRow;
const llama: ProviderRow = { id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: null, enabled: true, createdAt: '' } as ProviderRow;

function capture(sse: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response([...sse, ''].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, provider: providerFor(model, llama, fetchImpl) };
}
async function drain(iter: AsyncIterable<ProviderEvent>) { const out: ProviderEvent[] = []; for await (const ev of iter) out.push(ev); return out; }

afterEach(() => { delete process.env.LA_SAMPLING; });

describe('llama-server requests', () => {
  it('sends thinking off, model-card sampling, a max_tokens cap, and asks for usage in the stream', async () => {
    const { bodies, provider } = capture(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}', 'data: [DONE]']);
    await drain(provider.complete({ model: 'qwen3.6-35b-a3b', messages: [{ role: 'user', content: 'hi' }], noThink: true, sampling: samplingFor('qwen3.6-35b-a3b', { thinking: false, task: 'general' }), maxTokens: 512 }));
    const body = bodies[0]!;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).toMatchObject({ temperature: 0.6, top_p: 0.85, top_k: 20, min_p: 0.05, presence_penalty: 0.3, repeat_penalty: 1.08, max_tokens: 512, cache_prompt: true });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('uses the Qwen sampling values per mode and task, and nothing for unknown models', () => {
    expect(samplingFor('qwen3.6-35b-a3b', { thinking: true, task: 'code' })).toMatchObject({ temperature: 0.6, top_p: 0.9, top_k: 20, min_p: 0.05, presence_penalty: 0.2, repeat_penalty: 1.06 });
    expect(samplingFor('qwen3.6-35b-a3b', { thinking: true, task: 'general' })).toMatchObject({ temperature: 0.7, top_p: 0.9, min_p: 0.05, presence_penalty: 0.4, repeat_penalty: 1.08 });
    expect(samplingFor('gpt-oss-20b', { thinking: true, task: 'general' })).toEqual({ temperature: 1.0, top_p: 1.0 });
    expect(samplingFor('Inkling 2 Mini', { thinking: true, task: 'general' })).toBeUndefined();
    process.env.LA_SAMPLING = 'off';
    expect(samplingFor('qwen3.6-35b-a3b', { thinking: true, task: 'code' })).toBeUndefined();
    expect(maxTokensFor({ thinking: true })).toBeGreaterThan(maxTokensFor({ thinking: false }));
  });

  it('leaves thinking to the model by default and turns it on when asked', async () => {
    const { bodies, provider } = capture(['data: [DONE]']);
    await drain(provider.complete({ model: 'q', messages: [{ role: 'user', content: 'hi' }] }));
    await drain(provider.complete({ model: 'q', messages: [{ role: 'user', content: 'hi' }], think: true }));
    expect(bodies[0]!.chat_template_kwargs).toBeUndefined();
    expect(bodies[1]!.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('reports tokens out from the usage chunk (this was 0 on every Qwen run)', async () => {
    const { provider } = capture([
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":57},"timings":{"prompt_n":200,"cache_n":1000,"prompt_ms":800,"prompt_per_second":250,"predicted_n":57,"predicted_ms":2000}}',
      'data: [DONE]',
    ]);
    const done = (await drain(provider.complete({ model: 'q', messages: [{ role: 'user', content: 'hi' }] }))).find((ev) => ev.type === 'done') as Extract<ProviderEvent, { type: 'done' }>;
    expect(done.usage).toEqual({ inputTokens: 1200, outputTokens: 57 });
    expect(done.telemetry).toMatchObject({ cacheHitPct: 83, cachedTokens: 1000, promptEvalTokens: 200, promptEvalMs: 800, promptTokPerSec: 250, predictedTokens: 57 });
  });

  it('falls back to llama timings when the stream has no usage block', async () => {
    const { provider } = capture([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"timings":{"prompt_n":10,"cache_n":90,"predicted_n":42,"predicted_ms":1000}}',
      'data: [DONE]',
    ]);
    const done = (await drain(provider.complete({ model: 'q', messages: [{ role: 'user', content: 'hi' }] }))).find((ev) => ev.type === 'done') as Extract<ProviderEvent, { type: 'done' }>;
    expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  it("sends the assistant's own reasoning back so the prompt matches llama-server's cache", async () => {
    const { bodies, provider } = capture(['data: [DONE]']);
    await drain(provider.complete({ model: 'q', messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', reasoning: 'I should list the dir.', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: '{}' }] },
      { role: 'tool', content: 'a.ts', toolCallId: 'c1' },
    ] }));
    const sent = (bodies[0]!.messages as Record<string, unknown>[])[1]!;
    expect(sent.reasoning_content).toBe('I should list the dir.');
  });
});
