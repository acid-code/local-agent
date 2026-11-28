import fs from 'node:fs';
import { gttHeadroomBytes } from './memory.js';
import { ollamaRoot } from './ollama.js';

/**
 * Small Ollama models kept loaded permanently (keep_alive -1) for helpers and fast replies.
 * LA_OLLAMA_PINNED: comma list, default "gemma3:4b"; "none" or "" disables.
 * LA_OLLAMA_MAX_LOADED must match Ollama's OLLAMA_MAX_LOADED_MODELS: the warmer only loads a
 * pinned model into a free slot, so it never evicts a model another chat is using.
 * Pinned models still yield under RAM pressure (MemoryBudget unloads idle models, largest first);
 * the warmer re-pins them once there is room again.
 */
export function pinnedModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.LA_OLLAMA_PINNED ?? 'gemma3:4b';
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw.split(',').map((name) => name.trim()).filter(Boolean);
}

const bare = (name: string) => name.replace(/:latest$/, '');

export function isPinned(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return pinnedModels(env).some((pinned) => bare(pinned) === bare(name));
}

/** keep_alive to send for a local Ollama model: forever for pinned ones. */
export function keepAliveFor(model: { apiName: string; sizeClass: string }): string | number {
  if (isPinned(model.apiName)) return -1;
  return model.sizeClass === 'large' ? '30m' : '5m';
}

function memAvailableBytes(): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return match ? Number(match[1]) * 1024 : Number.POSITIVE_INFINITY;
  } catch { return Number.POSITIVE_INFINITY; }
}

const FOREVER_MS = 365 * 24 * 3600 * 1000;
const HEADROOM = 8 * 1024 ** 3;

export interface PinResult { model: string; action: 'pinned' | 'repinned' | 'already' | 'missing' | 'no-slot' | 'low-ram' | 'error'; detail?: string }

/** Make sure every pinned model is loaded with keep_alive -1. Safe to call often. */
export async function ensurePinned(fetchImpl: typeof fetch, opts: { env?: NodeJS.ProcessEnv; available?: () => number; gtt?: () => { usedBytes: number; totalBytes: number } | null; now?: () => number } = {}): Promise<PinResult[]> {
  const env = opts.env ?? process.env;
  const models = pinnedModels(env);
  if (!models.length) return [];
  const base = ollamaRoot();
  const maxLoaded = Math.max(1, Number(env.LA_OLLAMA_MAX_LOADED || 1));
  const available = opts.available ?? memAvailableBytes;
  const now = opts.now ?? Date.now;
  const results: PinResult[] = [];
  try {
    const [ps, tags] = await Promise.all([
      fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
    ]) as [{ models?: { name: string; expires_at?: string }[] }, { models?: { name: string; size: number }[] }];
    const loaded = ps.models ?? [];
    for (const model of models) {
      const installed = (tags.models ?? []).find((item) => bare(item.name) === bare(model));
      if (!installed) { results.push({ model, action: 'missing' }); continue; }
      const running = loaded.find((item) => bare(item.name) === bare(model));
      let action: PinResult['action'];
      if (running) {
        const expires = running.expires_at ? Date.parse(running.expires_at) : NaN;
        if (Number.isFinite(expires) && expires - now() > FOREVER_MS) { results.push({ model, action: 'already' }); continue; }
        action = 'repinned'; // loaded by a chat with a short keep_alive; extend it without reloading
      } else {
        if (loaded.length >= maxLoaded) { results.push({ model, action: 'no-slot' }); continue; }
        if (available() < installed.size + HEADROOM) { results.push({ model, action: 'low-ram' }); continue; }
        const pool = opts.gtt?.();
        if (pool && pool.totalBytes - pool.usedBytes < installed.size + Math.max(gttHeadroomBytes(), 4 * 1024 ** 3)) {
          results.push({ model, action: 'low-ram', detail: 'GTT headroom too low' });
          continue;
        }
        action = 'pinned';
      }
      const response = await fetchImpl(`${base}/api/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: installed.name, keep_alive: -1 }), signal: AbortSignal.timeout(180_000),
      });
      results.push(response.ok ? { model, action } : { model, action: 'error', detail: `HTTP ${response.status}` });
      if (action === 'pinned') loaded.push({ name: installed.name });
    }
  } catch (error) {
    results.push({ model: models.join(','), action: 'error', detail: (error as Error).message });
  }
  return results;
}
