import { MODEL_REGISTRY, publicProfile } from '@local-agent/shared';
import type { Store } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { personaTemplate } from './contracts.js';
import { rehearsalAllowed } from './usable-models.js';

export const TEMPLATES = ['general', 'coder', 'planner', 'researcher', 'voice'].map((slug) => personaTemplate(slug));

export function seedCatalog(store: Store, dataDir: string) {
  // The fake Rehearsal model is for tests and development only (LA_REHEARSAL=1). It is never a fallback for users.
  store.upsertProvider({ id: 'prov_rehearsal', kind: 'rehearsal', name: 'Rehearsal', enabled: rehearsalAllowed() });
  const geminiKey = Boolean(process.env.GEMINI_API_KEY);
  store.upsertProvider({ id: 'prov_gemini', kind: 'gemini', name: 'Gemini', apiKeyEnv: 'GEMINI_API_KEY', enabled: geminiKey });
  store.upsertProvider({ id: 'prov_openrouter', kind: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', enabled: Boolean(process.env.OPENROUTER_API_KEY) });
  for (const profile of MODEL_REGISTRY) {
    const plain = publicProfile(profile);
    const providerId = profile.providerKind === 'gemini' ? 'prov_gemini' : profile.providerKind === 'rehearsal' ? 'prov_rehearsal' : null;
    if (!providerId) continue;
    if (store.getModel(`model_${profile.id}`)) continue;
    store.upsertModel({
      id: `model_${profile.id}`, providerId, name: plain.displayName, apiName: plain.apiName, profileId: plain.id,
      tokenizer: plain.tokenizer, contextWindow: plain.contextWindow, practicalBudget: plain.practicalBudget, strategy: plain.strategy,
      sizeClass: plain.sizeClass, local: plain.local, modalities: plain.modalities, strengths: plain.strengths,
      typicalQ4GiB: plain.typicalQ4GiB ?? null, priceIn: plain.priceIn ?? null, priceOut: plain.priceOut ?? null, notes: plain.notes,
      parameterSize: null, family: plain.family, source: 'catalog', embedding: Boolean(plain.embedding), freeTier: plain.freeTier ?? null, enabled: true,
    });
  }
  const settings = store.getSettings();
  if (settings.goodModelId === 'model_rehearsal' && !rehearsalAllowed()) {
    settings.goodModelId = null;
    store.saveSettings(settings, 'Rehearsal is dev-only', { goodModelId: null });
  }
  if (!settings.goodModelId) {
    const lite = store.getModel('model_gemini-3.5-flash-lite');
    const rehearsal = rehearsalAllowed() ? store.getModel('model_rehearsal') : null;
    const next = geminiKey && lite ? lite.id : rehearsal?.id ?? null;
    if (next) { settings.goodModelId = next; store.saveSettings(settings, 'Initial defaults', { settings }); }
  }
  fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'repos'), { recursive: true });
}
