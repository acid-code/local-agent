import { describe, expect, it } from 'vitest';
import { ensurePinned, isPinned, keepAliveFor, pinnedModels } from '../src/pinned.js';

const GiB = 1024 ** 3;
function fakeOllama(ps: { name: string; expires_at?: string }[], tags = [{ name: 'gemma3:4b', size: 3.3 * GiB }]) {
  const generated: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: ps }));
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: tags }));
    if (url.endsWith('/api/generate')) { generated.push(JSON.parse(String(init?.body))); return new Response('{}'); }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, generated };
}

describe('pinned Ollama models', () => {
  it('defaults to gemma3:4b, can be disabled, and sends keep_alive -1 only for pinned models', () => {
    expect(pinnedModels({})).toEqual(['gemma3:4b']);
    expect(pinnedModels({ LA_OLLAMA_PINNED: 'none' })).toEqual([]);
    expect(isPinned('gemma3:4b', {})).toBe(true);
    expect(keepAliveFor({ apiName: 'gemma3:4b', sizeClass: 'small' })).toBe(-1);
    expect(keepAliveFor({ apiName: 'gemma4:26b-a4b', sizeClass: 'large' })).toBe('30m');
    expect(keepAliveFor({ apiName: 'qwen2.5:3b', sizeClass: 'small' })).toBe('5m');
  });

  it('loads the pinned model forever when a slot and RAM are free', async () => {
    const { fetchImpl, generated } = fakeOllama([]);
    const result = await ensurePinned(fetchImpl, { env: { LA_OLLAMA_MAX_LOADED: '3' }, available: () => 20 * GiB });
    expect(result).toEqual([{ model: 'gemma3:4b', action: 'pinned' }]);
    expect(generated).toEqual([{ model: 'gemma3:4b', keep_alive: -1 }]);
  });

  it('never evicts another loaded model and backs off when RAM is low', async () => {
    const busy = fakeOllama([{ name: 'gemma4:26b-a4b', expires_at: new Date(Date.now() + 60_000).toISOString() }]);
    expect(await ensurePinned(busy.fetchImpl, { env: {}, available: () => 20 * GiB })).toEqual([{ model: 'gemma3:4b', action: 'no-slot' }]);
    expect(busy.generated).toEqual([]);
    const low = fakeOllama([]);
    expect(await ensurePinned(low.fetchImpl, { env: {}, available: () => 5 * GiB })).toEqual([{ model: 'gemma3:4b', action: 'low-ram' }]);
    expect(low.generated).toEqual([]);
  });

  it('re-pins a model a chat loaded with a short keep_alive, and leaves a pinned one alone', async () => {
    const short = fakeOllama([{ name: 'gemma3:4b', expires_at: new Date(Date.now() + 300_000).toISOString() }]);
    expect(await ensurePinned(short.fetchImpl, { env: {} })).toEqual([{ model: 'gemma3:4b', action: 'repinned' }]);
    const forever = fakeOllama([{ name: 'gemma3:4b', expires_at: '2318-01-01T00:00:00Z' }]);
    expect(await ensurePinned(forever.fetchImpl, { env: {} })).toEqual([{ model: 'gemma3:4b', action: 'already' }]);
    expect(forever.generated).toEqual([]);
    const missing = fakeOllama([], []);
    expect(await ensurePinned(missing.fetchImpl, { env: {} })).toEqual([{ model: 'gemma3:4b', action: 'missing' }]);
  });
});
