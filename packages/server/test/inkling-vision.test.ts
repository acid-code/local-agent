import { describe, expect, it } from 'vitest';
import { isLlamaServerProvider, isUncensoredProvider } from '../src/coexist.js';
import { GiB } from '../src/memory.js';
import { hasEnoughGttForVision, liveRunners } from '../src/ocr.js';

describe('uncensored provider isolation & GTT-guarded Inkling vision', () => {
  it('never matches llama-server (uncensored) as the main llama-server provider', () => {
    const uncensored = { id: 'prov_uncensored', name: 'llama-server (uncensored)', kind: 'openai_compat' as const, baseUrl: 'http://127.0.0.1:8081/v1' };
    const mainLlama = { id: 'prov_llama', name: 'llama-server', kind: 'openai_compat' as const, baseUrl: 'http://127.0.0.1:8080/v1' };
    expect(isUncensoredProvider(uncensored)).toBe(true);
    expect(isLlamaServerProvider(uncensored)).toBe(false);
    expect(isLlamaServerProvider(mainLlama)).toBe(true);
  });

  it('gates Inkling vision on free GTT headroom (>= 4 GiB)', () => {
    expect(hasEnoughGttForVision({ usedBytes: 25 * GiB, totalBytes: 40 * GiB })).toBe(true);
    expect(hasEnoughGttForVision({ usedBytes: 37 * GiB, totalBytes: 40 * GiB })).toBe(false);
    expect(hasEnoughGttForVision(null)).toBe(false);
  });

  it('uses Inkling mmproj vision when GTT allows & healthy, and falls back to Ollama when GTT is low', async () => {
    const fakeFetch = (async (url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }), { status: 200 });
      }
      if (s.includes(':8081/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (s.includes(':8081/v1/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Inkling saw a red button' } }] }), { status: 200 });
      }
      if (s.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: 'Ollama saw a red button' } }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    // Plenty of GTT (15 GiB free) -> uses Inkling
    const withGtt = await liveRunners({
      fetchImpl: fakeFetch,
      ollamaRoot: 'http://127.0.0.1:11434',
      cloudAllowed: false,
      inklingVisionUrl: 'http://127.0.0.1:8081/v1',
      gtt: { usedBytes: 25 * GiB, totalBytes: 40 * GiB },
    });
    const res1 = await withGtt.vision!(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'describe');
    expect(res1.model).toBe('qwen3.6-35b-a3b-uncensored');
    expect(res1.text).toBe('Inkling saw a red button');

    // Tight GTT (2 GiB free) -> skips Inkling and uses Ollama fallback
    const lowGtt = await liveRunners({
      fetchImpl: fakeFetch,
      ollamaRoot: 'http://127.0.0.1:11434',
      cloudAllowed: false,
      inklingVisionUrl: 'http://127.0.0.1:8081/v1',
      gtt: { usedBytes: 38 * GiB, totalBytes: 40 * GiB },
    });
    const res2 = await lowGtt.vision!(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'describe');
    expect(res2.model).toBe('gemma3:4b');
    expect(res2.text).toBe('Ollama saw a red button');
  });
});
