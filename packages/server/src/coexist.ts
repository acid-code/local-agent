import type { ModelRow, ProviderRow, Store } from './db.js';

/**
 * llama-server ↔ Ollama coexistence on one iGPU.
 *
 * llama-server (Qwen3.6-35B-A3B + DFlash2 + 32K KV) pins ~22.5 GiB of unswappable GTT. A second big model
 * loaded by Ollama at the same time froze the host (TTM buffers cannot be reclaimed by the OOM killer).
 * While llama-server answers, it owns main/coder/thinking, and Ollama only serves small models
 * (embeddings, a 1.5B–3B router/fast model).
 */
export const OLLAMA_SIDE_MAX_GIB = Number(process.env.LA_OLLAMA_SIDE_MAX_GIB || 4);

export function isOllamaProvider(provider: Pick<ProviderRow, 'id' | 'name' | 'kind' | 'baseUrl'>): boolean {
  if (provider.kind === 'openrouter' || provider.kind === 'gemini' || provider.kind === 'rehearsal') return false;
  return provider.id === 'prov_ollama' || provider.name === 'Ollama' || /:11434(\/|$)/.test(provider.baseUrl || '');
}

export function isLlamaServerProvider(provider: Pick<ProviderRow, 'id' | 'name' | 'kind'> & { baseUrl?: string | null }): boolean {
  if (provider.kind !== 'openai_compat') return false;
  if (isUncensoredProvider({ ...provider, baseUrl: provider.baseUrl ?? null })) return false;
  return provider.id === 'prov_llama' || /llama[-_ ]?server/i.test(provider.name);
}

export function isUncensoredProvider(provider: Pick<ProviderRow, 'id' | 'name' | 'kind' | 'baseUrl'>): boolean {
  if (provider.kind !== 'openai_compat') return false;
  return provider.id === 'prov_uncensored'
    || /uncensored|unfiltered/i.test(provider.name)
    || /:8081(?:\/|$)/.test(provider.baseUrl || '');
}

/** Embedding / reranker models: they cannot chat. */
export function isEmbeddingName(name: string): boolean {
  return /embed|rerank|\bbge[-_:]|\bbge$|minilm|\be5[-_]|gte[-_]/i.test(name);
}

/**
 * True for models that cannot hold a chat turn: embeddings, rerankers, OCR, speech (TTS/ASR) and CLIP-style encoders.
 * Auto routing and helper sub-agents must never pick these (e.g. nomic-embed-text was being given chat turns).
 */
export function isNonChatModel(model: { name: string; apiName: string; embedding?: boolean }): boolean {
  if (model.embedding) return true;
  const label = `${model.name} ${model.apiName}`;
  return isEmbeddingName(label) || /(?:^|[-_:/\s])ocr(?:$|[-_:\s])|paddleocr|tesseract|\btts\b|piper|kokoro|whisper|parakeet|\bclip\b|siglip/i.test(label);
}

/** Size of a model on the GPU, from its profile or its name (e.g. "20b" → ~13 GiB). */
export function modelGiB(model: Pick<ModelRow, 'apiName' | 'typicalQ4GiB'>): number {
  if (model.typicalQ4GiB && model.typicalQ4GiB > 0) return model.typicalQ4GiB;
  const size = Number(model.apiName.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? 4);
  return size * 0.6 + 1;
}

/** Keeps a cached view of whether llama-server is up. Reads are synchronous; refreshes run in the background. */
export class LlamaWatch {
  private active: boolean | null = null;
  private checkedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch,
    private readonly ttlMs = 15_000,
    private readonly swapControlEnabled?: boolean,
  ) {}

  hasSwapControl(): boolean {
    return this.swapControlEnabled ?? Boolean(process.env.LLAMA_FALLBACK_CONTROL_URL?.trim());
  }

  markActive(active: boolean): void {
    this.active = active;
    this.checkedAt = Date.now();
  }

  /** The enabled llama-server provider that has at least one enabled chat model. */
  provider(): ProviderRow | undefined {
    const models = this.store.listModels();
    return this.store.listProviders().find((p) => p.enabled && isLlamaServerProvider(p)
      && models.some((m) => m.providerId === p.id && m.enabled && !m.embedding));
  }

  /** The llama-server chat model to route main/coder/thinking to. */
  model(): ModelRow | undefined {
    const provider = this.provider();
    if (!provider) return undefined;
    return this.store.listModels().find((m) => m.providerId === provider.id && m.enabled && !m.embedding);
  }

  uncensoredModel(): ModelRow | undefined {
    const provider = this.store.listProviders().find((p) =>
      p.enabled && isUncensoredProvider(p)
      && this.store.listModels().some((m) => m.providerId === p.id && m.enabled && !m.embedding),
    );
    if (!provider) return undefined;
    return this.store.listModels().find((m) => m.providerId === provider.id && m.enabled && !m.embedding);
  }

  async switchToUncensored(): Promise<boolean> {
    const ok = await this.callFallbackControl('/switch-uncensored');
    if (ok) this.markActive(true);
    return ok;
  }

  async switchToQwen(): Promise<boolean> {
    const ok = await this.callFallbackControl('/switch-qwen');
    if (ok) this.markActive(true);
    return ok;
  }

  async stopAll(): Promise<boolean> {
    const ok = await this.callFallbackControl('/stop-llama', (body) => body?.ok === true && body?.stopped === true);
    if (ok) this.markActive(false);
    return ok;
  }

  /** POST to the host's llama fallback-control service, sending the shared token when one is configured. */
  private async callFallbackControl(path: string, validate?: (body: Record<string, unknown> | null) => boolean): Promise<boolean> {
    const configured = process.env.LLAMA_FALLBACK_CONTROL_URL?.trim();
    const url = (configured || 'http://host.docker.internal:8082').replace(/\/$/, '');
    const token = process.env.LLAMA_FALLBACK_TOKEN?.trim();
    try {
      const response = await this.fetchImpl(`${url}${path}`, {
        method: 'POST',
        headers: token ? { 'X-Fallback-Token': token } : undefined,
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) return false;
      if (!validate) return true;
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      return validate(body);
    } catch {
      return false;
    }
  }

  private uncensoredProvider(): ProviderRow | undefined {
    const models = this.store.listModels();
    return this.store.listProviders().find((p) => p.enabled && isUncensoredProvider(p)
      && models.some((m) => m.providerId === p.id && m.enabled && !m.embedding));
  }

  /**
   * True while either llama-server model holds the GPU: Qwen (:8080) or the uncensored model (:8081).
   * Only Qwen used to count, so while the uncensored model was loaded (Qwen stopped) Auto happily loaded
   * gemma4 (~18 GB) in Ollama next to it, and the chat sat on "waiting for memory" or the host froze.
   * Before the first health check it assumes "up" when a provider is configured: blocking a big Ollama
   * load for one turn is cheap, a frozen host is not.
   */
  isActive(): boolean {
    if (!this.provider() && !this.uncensoredProvider()) return false;
    if (Date.now() - this.checkedAt > this.ttlMs) void this.refresh();
    return this.active ?? true;
  }

  async refresh(): Promise<boolean> {
    const bases = [this.provider(), this.uncensoredProvider()].map((p) => p?.baseUrl).filter((url): url is string => Boolean(url));
    if (!bases.length) {
      this.active = false;
      return false;
    }
    if (!this.pending) {
      this.checkedAt = Date.now();
      const ping = (base: string) => {
        const root = base.replace(/\/$/, '').replace(/\/v1$/, '');
        return this.fetchImpl(`${root}/health`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
      };
      this.pending = Promise.all(bases.map(ping))
        .then((states) => { this.active = states.some(Boolean); })
        .finally(() => { this.pending = null; });
    }
    await this.pending;
    return Boolean(this.active);
  }

  /** A heavy Ollama model that must not load while llama-server holds the GPU. */
  blocks(model: Pick<ModelRow, 'apiName' | 'typicalQ4GiB' | 'embedding'>, provider: Pick<ProviderRow, 'id' | 'name' | 'kind' | 'baseUrl'> | undefined): boolean {
    if (!provider || model.embedding || !isOllamaProvider(provider)) return false;
    if (modelGiB(model) <= OLLAMA_SIDE_MAX_GIB) return false;
    return this.isActive();
  }
}
