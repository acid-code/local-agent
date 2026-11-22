import { autoRoleHealth, resolveProfile, type AutoCandidate, type AutoMap, type RoleResolution } from '@local-agent/shared';
import { isEmbeddingName } from './coexist.js';
import { parseOllamaTags, parseOpenAIModels } from './discovery.js';
import type { ModelRow, ProviderRow, Store } from './db.js';
import { normalizeOllamaHost } from './ollama.js';

export type AutoRoleReport = { ok: boolean; detail: string; roles: RoleResolution[] };

function candidateFrom(model: ModelRow, provider?: ProviderRow | undefined): AutoCandidate {
  return {
    id: model.id,
    name: model.name,
    apiName: model.apiName,
    local: model.local,
    embedding: model.embedding,
    sizeClass: model.sizeClass,
    providerKind: provider?.kind || 'openai_compat',
    providerName: provider?.name,
    practicalBudget: model.practicalBudget,
    enabled: model.enabled && (provider ? provider.enabled : true),
  };
}

function liveCandidate(provider: ProviderRow, name: string): AutoCandidate {
  const profile = resolveProfile(name);
  const embedding = isEmbeddingName(name);
  return {
    id: `live_${provider.id}_${name.replace(/[^a-z0-9]+/gi, '_')}`,
    name,
    apiName: name,
    local: provider.kind !== 'gemini' && provider.kind !== 'openrouter',
    embedding,
    sizeClass: profile.sizeClass,
    providerKind: provider.kind,
    providerName: provider.name,
    practicalBudget: profile.practicalBudget,
    enabled: true,
  };
}

function sameName(a: string, b: string) {
  const norm = (value: string) => value.toLowerCase().replace(/[:_.\-\s]+/g, '-');
  return a === b || a === `${b}:latest` || b === `${a}:latest` || norm(a) === norm(b);
}

async function liveNames(fetchImpl: typeof fetch, url: string, kind: 'ollama' | 'openai'): Promise<string[] | null> {
  try {
    const base = url.replace(/\/$/, '');
    const target = kind === 'ollama' ? `${base.replace(/\/v1$/, '')}/api/tags` : `${base}/models`;
    const response = await fetchImpl(target, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const json = await response.json();
    return kind === 'ollama' ? parseOllamaTags(json).map((model) => model.name) : parseOpenAIModels(json);
  } catch {
    return null;
  }
}

function ollamaProvider(store: Store): ProviderRow {
  const existing = store.listProviders().find((provider) => provider.id === 'prov_ollama');
  const host = process.env.OLLAMA_HOST ? normalizeOllamaHost(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434';
  return existing ?? { id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: `${host}/v1`, apiKeyEnv: null, enabled: true, createdAt: '' };
}

function llamaFallbacks(store: Store): ProviderRow[] {
  const existing = store.listProviders().filter((provider) => provider.enabled && provider.kind === 'openai_compat' && provider.id !== 'prov_ollama' && provider.baseUrl);
  if (existing.length) return existing;
  const env = (process.env.LLAMA_SERVER_URL || '').trim().replace(/\/$/, '');
  const url = env ? (env.endsWith('/v1') ? env : `${env}/v1`) : 'http://127.0.0.1:8080/v1';
  return [{ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: url, apiKeyEnv: null, enabled: true, createdAt: '' }];
}

/**
 * Chat models Auto may actually call: discovered rows, intersected with a live Ollama /api/tags
 * and llama-server /v1/models listing when those endpoints answer.
 */
export async function availableAutoCandidates(store: Store, fetchImpl: typeof fetch): Promise<AutoCandidate[]> {
  const providers = new Map(store.listProviders().map((provider) => [provider.id, provider]));
  const ollama = ollamaProvider(store);
  const openAi = llamaFallbacks(store);
  const probes: { provider: ProviderRow; kind: 'ollama' | 'openai' }[] = [
    { provider: ollama, kind: 'ollama' },
    ...openAi.map((provider) => ({ provider, kind: 'openai' as const })),
  ];
  const live = await Promise.all(probes.map(async (probe) => ({
    provider: probe.provider,
    names: probe.provider.baseUrl ? await liveNames(fetchImpl, probe.provider.baseUrl, probe.kind) : null,
  })));
  const liveByProvider = new Map(live.map((row) => [row.provider.id, row.names]));

  const out: AutoCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: AutoCandidate) => {
    if (!candidate.enabled) return;
    const key = `${candidate.providerName || candidate.providerKind}:${candidate.apiName.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  for (const model of store.listModels()) {
    const provider = providers.get(model.providerId);
    if (!model.enabled || (provider && !provider.enabled)) continue;
    const names = provider ? liveByProvider.get(provider.id) : undefined;
    // A successful live list is the source of truth for that provider; a failed probe keeps the store row.
    if (names && !names.some((name) => sameName(name, model.apiName) || sameName(name, model.name))) continue;
    add(candidateFrom(model, provider));
  }
  for (const { provider, names } of live) {
    if (!names) continue;
    for (const name of names) {
      const already = out.some((candidate) => (candidate.providerName === provider.name || candidate.providerKind === provider.kind)
        && (sameName(candidate.apiName, name) || sameName(candidate.name, name)));
      if (!already) add(liveCandidate(provider, name));
    }
  }
  return out;
}

export async function autoRoleReport(store: Store, fetchImpl: typeof fetch): Promise<AutoRoleReport> {
  const models = await availableAutoCandidates(store, fetchImpl);
  return autoRoleHealth(store.getSettings().autoModels, models);
}

export type { AutoMap, RoleResolution };
