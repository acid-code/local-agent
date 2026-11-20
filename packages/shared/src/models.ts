import type { Modality, ProviderKind, RequestKind, SizeClass, StrategyName, TokenizerId } from './types.js';

export interface ModelProfile {
  id: string;
  match: RegExp;
  displayName: string;
  apiName: string;
  family: string;
  tokenizer: TokenizerId;
  contextWindow: number;
  extendedContext?: number;
  practicalBudget: number;
  strategy: StrategyName;
  modalities: Modality[];
  sizeClass: SizeClass;
  local: boolean;
  typicalQ4GiB?: number;
  strengths: RequestKind[];
  priceIn?: number;
  priceOut?: number;
  priceNote?: string;
  notes: string;
  providerKind: ProviderKind;
  embedding?: boolean;
  /** When false, the owner's free-tier key cannot call it. Undefined means not a Gemini catalog model. */
  freeTier?: boolean;
}

export interface ResolvedProfile {
  id: string;
  displayName: string;
  apiName: string;
  family: string;
  tokenizer: TokenizerId;
  contextWindow: number;
  extendedContext?: number;
  practicalBudget: number;
  strategy: StrategyName;
  modalities: Modality[];
  sizeClass: SizeClass;
  local: boolean;
  typicalQ4GiB?: number;
  strengths: RequestKind[];
  priceIn?: number;
  priceOut?: number;
  priceNote?: string;
  notes: string;
  providerKind: ProviderKind;
  embedding?: boolean;
  freeTier?: boolean;
  known: boolean;
}

/**
 * Context windows and prices are from the public model cards and the Gemini
 * pricing page as checked on 13 Nov 2026. Practical budgets are ours: on a
 * 48 GB shared-memory box the KV cache, not the theoretical window, is the
 * limit for a resident MoE.
 */
export const MODEL_REGISTRY: ModelProfile[] = [
  {
    id: 'gemma-4-26b-a4b',
    match: /gemma[-_. ]?4.*(26b).*(a4b)|gemma[-_. ]?4.*a4b/i,
    displayName: 'Gemma 4 26B-A4B',
    apiName: 'gemma4:26b-a4b',
    family: 'gemma4',
    tokenizer: 'gemma4',
    contextWindow: 262_144,
    practicalBudget: 32_768,
    strategy: 'hierarchical',
    modalities: ['text', 'image'],
    sizeClass: 'large',
    local: true,
    typicalQ4GiB: 18,
    strengths: ['chat', 'code', 'vision', 'long-context', 'hard-reasoning'],
    notes: '256K theoretical context, 1024-token sliding window, about 25.2B total / 3.8B active, vision. Default practical budget is 32K so the KV cache fits beside the weights on 48 GB.',
    providerKind: 'openai_compat',
  },
  {
    id: 'gemma-4-e4b',
    match: /gemma[-_. ]?4.*(e4b|4b)/i,
    displayName: 'Gemma 4 E4B',
    apiName: 'gemma4:e4b',
    family: 'gemma4',
    tokenizer: 'gemma4',
    contextWindow: 131_072,
    practicalBudget: 16_384,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: true,
    typicalQ4GiB: 4,
    strengths: ['chat', 'code', 'vision'],
    notes: 'Small multimodal Gemma 4. 128K theoretical context. Preferred cold-start local model when a 26B/35B MoE is not already resident.',
    providerKind: 'openai_compat',
  },
  {
    id: 'gpt-oss-20b',
    match: /gpt[-_. ]?oss[-_: ]?20b/i,
    displayName: 'GPT-OSS 20B',
    apiName: 'gpt-oss:20b',
    family: 'gpt-oss',
    tokenizer: 'approx',
    contextWindow: 131_072,
    practicalBudget: 32_768,
    strategy: 'hierarchical',
    modalities: ['text'],
    sizeClass: 'large',
    local: true,
    typicalQ4GiB: 13.8,
    strengths: ['code', 'hard-reasoning', 'chat', 'long-context'],
    notes: 'Default non-Qwen local coder (~13.8 GB Q4). 128K context window; uses 32K by default and expands to 64K-128K on repository tasks.',
    providerKind: 'openai_compat',
  },
  {
    id: 'qwen3.6-35b-a3b',
    match: /qwen3\.?6.*35b|qwen3\.?6.*a3b/i,
    displayName: 'Qwen3.6 35B-A3B',
    apiName: 'qwen3.6:35b',
    family: 'qwen3',
    tokenizer: 'qwen3',
    contextWindow: 262_144,
    extendedContext: 1_010_000,
    practicalBudget: 32_768,
    strategy: 'hierarchical',
    modalities: ['text', 'image'],
    sizeClass: 'large',
    local: true,
    typicalQ4GiB: 23,
    strengths: ['code', 'hard-reasoning', 'vision', 'long-context', 'chat'],
    notes: '262,144 native context, extensible toward 1,010,000 with YaRN. Ollama Q4 builds are about 23 GB. Qwen recommends 128K for full thinking quality; 32K is the RAM-safe default here.',
    providerKind: 'openai_compat',
  },
  {
    id: 'qwen3.6-27b',
    match: /qwen3\.?6.*27b/i,
    displayName: 'Qwen3.6 27B',
    apiName: 'qwen3.6:27b',
    family: 'qwen3',
    tokenizer: 'qwen3',
    contextWindow: 262_144,
    practicalBudget: 32_768,
    strategy: 'hierarchical',
    modalities: ['text', 'image'],
    sizeClass: 'large',
    local: true,
    typicalQ4GiB: 18,
    strengths: ['code', 'chat', 'vision', 'long-context'],
    notes: 'Dense 27B sibling. Same 256K native window. Treated as a large local model, so it will not sit in memory next to another large model.',
    providerKind: 'openai_compat',
  },
  {
    id: 'gemini-3.5-flash-lite',
    match: /gemini-3\.5-flash-lite/i,
    displayName: 'Gemini 3.5 Flash Lite',
    apiName: 'gemini-3.5-flash-lite',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 65_536,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['chat', 'research', 'code'],
    priceIn: 0.3,
    priceOut: 2.5,
    priceNote: 'Standard text rate. Documented free-tier limits: 15 RPM, 250K TPM, 500 RPD.',
    notes: 'Default cloud model. Widest free-tier daily cap on the owner key (500 requests/day).',
    providerKind: 'gemini',
    freeTier: true,
  },
  {
    id: 'gemini-3.1-flash-lite',
    match: /gemini-3\.1-flash-lite(?!-image)/i,
    displayName: 'Gemini 3.1 Flash Lite',
    apiName: 'gemini-3.1-flash-lite',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 65_536,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['chat', 'research', 'code'],
    priceIn: 0.25,
    priceOut: 1.5,
    priceNote: 'Standard text rate. Free tier: 15 RPM, 250K TPM, 500 RPD.',
    notes: 'Alternate lite model with the same roomy free-tier caps.',
    providerKind: 'gemini',
    freeTier: true,
  },
  {
    id: 'gemini-3.6-flash',
    match: /gemini-3\.6-flash/i,
    displayName: 'Gemini 3.6 Flash',
    apiName: 'gemini-3.6-flash',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 65_536,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['chat', 'code', 'research', 'vision'],
    priceIn: 0.75,
    priceOut: 3.75,
    priceNote: 'Standard text rate through 31 Dec 2026. Free tier: 5 RPM, 250K TPM, 20 RPD.',
    notes: 'Tight daily free-tier cap. Not the default.',
    providerKind: 'gemini',
    freeTier: true,
  },
  {
    id: 'gemini-3.8-flash',
    match: /gemini-3\.8-flash(?!-lite|-tts)/i,
    displayName: 'Gemini 3.8 Flash',
    apiName: 'gemini-3.8-flash',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 131_072,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['code', 'research', 'vision', 'long-context', 'hard-reasoning'],
    priceIn: 0.75,
    priceOut: 3.75,
    priceNote: 'Standard text rate through 31 Dec 2026, then listed to rise. Free tier: 5 RPM, 250K TPM, 20 RPD.',
    notes: 'Strongest Flash on the key, and the one the 13 Nov reading showed hottest (110.6K TPM that minute). Kept in reserve.',
    providerKind: 'gemini',
    freeTier: true,
  },
  {
    id: 'gemini-2.5-flash',
    match: /gemini-2\.5-flash$/i,
    displayName: 'Gemini 2.5 Flash',
    apiName: 'gemini-2.5-flash',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 65_536,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['chat', 'code', 'vision'],
    priceIn: 0.3,
    priceOut: 2.5,
    priceNote: 'Standard text rate. Free tier: 5 RPM, 250K TPM, 20 RPD.',
    notes: 'Older Flash with a documented free-tier allotment.',
    providerKind: 'gemini',
    freeTier: true,
  },
  {
    id: 'gemini-4-hydrogen',
    match: /gemini-4-hydrogen/i,
    displayName: 'Gemini 4 Hydrogen',
    apiName: 'gemini-4-hydrogen',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 131_072,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['hard-reasoning', 'code', 'long-context'],
    priceNote: 'Documented free-tier limits: 5 RPM, 250K TPM, 20 RPD. Paid price was not on the local snapshot.',
    notes: 'Free-tier reasoning model. Gemini 4 Argon and Carbon have no free-tier quota (documented limit 0), so hard questions come here instead.',
    providerKind: 'gemini',
    freeTier: true,
  },
  {
    id: 'gemini-4-argon',
    match: /gemini-4-argon/i,
    displayName: 'Gemini 4 Argon',
    apiName: 'gemini-4-argon',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 131_072,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['hard-reasoning', 'code', 'long-context'],
    priceIn: 2,
    priceOut: 10,
    priceNote: 'Standard rate through 30 Nov 2026 ($2 / $10 per 1M), then listed to double. Not on this free tier (0/0/0).',
    notes: 'Flagship reasoning model. Catalogued so a paid key can enable it. The router will not pick it while the free-tier quota is closed.',
    providerKind: 'gemini',
    freeTier: false,
  },
  {
    id: 'gemini-2.5-pro',
    match: /gemini-2\.5-pro/i,
    displayName: 'Gemini 2.5 Pro',
    apiName: 'gemini-2.5-pro',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 1_048_576,
    practicalBudget: 131_072,
    strategy: 'rolling',
    modalities: ['text', 'image'],
    sizeClass: 'small',
    local: false,
    strengths: ['hard-reasoning', 'code', 'long-context'],
    priceIn: 1.25,
    priceOut: 10,
    priceNote: 'Standard rate for prompts up to 200K tokens. Not present on the free-tier reading.',
    notes: 'Kept for a paid key. Not auto-selected on the current free tier.',
    providerKind: 'gemini',
    freeTier: false,
  },
  {
    id: 'gemini-embedding-2',
    match: /gemini-embedding-2/i,
    displayName: 'Gemini Embedding 2',
    apiName: 'gemini-embedding-2',
    family: 'gemini',
    tokenizer: 'gemini',
    contextWindow: 2048,
    practicalBudget: 2048,
    strategy: 'retrieval',
    modalities: ['text'],
    sizeClass: 'small',
    local: false,
    strengths: [],
    notes: 'Retrieval embeddings. Free tier: 100 RPM, 30K TPM, 1K RPD. Hash embeddings take over when this cap is close.',
    providerKind: 'gemini',
    embedding: true,
    freeTier: true,
  },
  {
    id: 'rehearsal',
    match: /^rehearsal$/i,
    displayName: 'Rehearsal',
    apiName: 'rehearsal',
    family: 'rehearsal',
    tokenizer: 'approx',
    contextWindow: 8192,
    practicalBudget: 4096,
    strategy: 'rolling',
    modalities: ['text'],
    sizeClass: 'small',
    local: true,
    strengths: ['chat'],
    notes: 'On-box deterministic model used to exercise streaming, tools, and traces before a real model is connected. Not a language model.',
    providerKind: 'rehearsal',
  },
];

export function publicProfile(profile: ModelProfile | ResolvedProfile) {
  const { match, ...rest } = profile as ModelProfile;
  void match;
  return rest;
}

function parseBillions(parameterSize?: string, name?: string): number | null {
  const source = `${parameterSize ?? ''} ${name ?? ''}`;
  const match = source.match(/(\d+(?:\.\d+)?)\s*b/i);
  if (!match) return null;
  return Number(match[1]);
}

export function resolveProfile(name: string, hints?: { parameterSize?: string; contextLength?: number; family?: string }): ResolvedProfile {
  const found = MODEL_REGISTRY.find((profile) => profile.match.test(name));
  if (found) {
    const contextWindow = hints?.contextLength
      ? Math.min(found.contextWindow, hints.contextLength) || found.contextWindow
      : found.contextWindow;
    const practicalBudget = Math.min(found.practicalBudget, contextWindow);
    return { ...publicProfile(found), contextWindow: found.contextWindow, practicalBudget, known: true, apiName: found.apiName };
  }
  const billions = parseBillions(hints?.parameterSize, name);
  const moe = /a\d+b|moe/i.test(name);
  const sizeClass: SizeClass = moe || (billions != null && billions >= 13) ? 'large' : 'small';
  const contextWindow = hints?.contextLength && hints.contextLength > 0 ? hints.contextLength : 8192;
  return {
    id: `unknown:${name}`,
    displayName: name,
    apiName: name,
    family: hints?.family || 'unknown',
    tokenizer: 'approx',
    contextWindow,
    practicalBudget: Math.min(contextWindow, sizeClass === 'large' ? 32_768 : 16_384),
    strategy: sizeClass === 'large' ? 'hierarchical' : 'rolling',
    modalities: ['text'],
    sizeClass,
    local: true,
    strengths: ['chat'],
    notes: 'Unrecognized model. Context defaults to the server-reported window, or 8192 when the server did not say. Tokenizer is the approximate counter.',
    providerKind: 'openai_compat',
    known: false,
  };
}

export function catalogProfiles(): ResolvedProfile[] {
  return MODEL_REGISTRY.map((profile) => ({ ...publicProfile(profile), known: true }));
}

/**
 * Per-role context budget for local models:
 * - Default roles: 16K–32K (fast/voice 16K, main/researcher/planner/thinking 24K–32K).
 * - Coder on repository tasks: 64K–128K (capped to the model's contextWindow).
 */
export function roleContextBudget(
  role: string | undefined,
  model: { local: boolean; contextWindow: number; practicalBudget: number; sizeClass?: SizeClass },
  opts: { repoTask?: boolean; extended?: boolean } = {},
): number {
  if (!model.local) return Math.min(model.contextWindow, model.practicalBudget);
  const r = (role || 'main').toLowerCase();
  if (r === 'coder' && opts.repoTask) {
    const target = opts.extended ? 131_072 : 65_536;
    return Math.min(model.contextWindow, Math.max(model.practicalBudget, target));
  }
  if (r === 'fast' || r === 'voice' || model.sizeClass === 'small') {
    return Math.min(model.contextWindow, Math.min(model.practicalBudget, 16_384));
  }
  return Math.min(model.contextWindow, Math.max(16_384, Math.min(model.practicalBudget, 32_768)));
}
