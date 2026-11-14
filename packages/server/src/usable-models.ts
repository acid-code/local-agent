import { freeTierByApiName, geminiQuotaDay, quotaAvailability } from '@local-agent/shared';
import type { Store } from './db.js';

/** Rehearsal is a fake model for tests and development. Users never see it unless LA_REHEARSAL=1. */
export function rehearsalAllowed(env: NodeJS.ProcessEnv = process.env) {
  return env.LA_REHEARSAL === '1' || Boolean(env.VITEST);
}

export const NO_MODEL_MESSAGE = 'No model yet. Set one up: install Ollama and pull a model (Setup → Models → Scan), or add a GEMINI_API_KEY in Settings → Secrets.';

export interface UsableModel { id: string; name: string; local: boolean; disabled?: boolean; reason?: string }
export interface UsableModels { local: UsableModel[]; cloud: UsableModel[]; dev: UsableModel[]; empty: boolean; geminiConnected: boolean; cloudAllowed: boolean }

/**
 * Models someone can actually pick right now: installed local models, cloud models only when their key is set and the
 * account may use cloud, and Rehearsal only in dev. Cloud models out of quota are listed but disabled with the reason.
 */
export function usableModels(store: Store, opts: { cloudAllowed: boolean; env?: NodeJS.ProcessEnv }): UsableModels {
  const env = opts.env ?? process.env;
  const providers = new Map(store.listProviders().map((provider) => [provider.id, provider]));
  const settings = store.getSettings();
  const minute = new Date().toISOString().slice(0, 16);
  const day = geminiQuotaDay();
  const out: UsableModels = { local: [], cloud: [], dev: [], empty: true, geminiConnected: Boolean(env.GEMINI_API_KEY), cloudAllowed: opts.cloudAllowed };
  for (const model of store.listModels()) {
    if (!model.enabled || model.embedding) continue;
    const provider = providers.get(model.providerId);
    if (!provider) continue;
    if (provider.kind === 'rehearsal' || model.profileId === 'rehearsal') {
      if (rehearsalAllowed(env)) out.dev.push({ id: model.id, name: model.name, local: true });
      continue;
    }
    if (!provider.enabled) continue;
    if (model.local) { out.local.push({ id: model.id, name: model.name, local: true }); continue; }
    if (!opts.cloudAllowed) continue;
    if (provider.apiKeyEnv && !env[provider.apiKeyEnv]) continue;
    let disabled = false;
    let reason: string | undefined;
    if (provider.kind === 'gemini' && settings.geminiTier !== 'paid') {
      const row = freeTierByApiName(model.apiName);
      if (row) {
        const used = store.quotaUse(model.apiName, day);
        const view = quotaAvailability(row, { rpm: used.rpmWindow === minute ? used.rpm : 0, tpm: used.tpmWindow === minute ? used.tpm : 0, rpd: used.rpd });
        if (!view.open) { disabled = true; reason = view.reason; }
      }
    }
    out.cloud.push({ id: model.id, name: model.name, local: false, ...(disabled ? { disabled, reason } : {}) });
  }
  const byName = (a: UsableModel, b: UsableModel) => a.name.localeCompare(b.name);
  out.local.sort(byName);
  out.cloud.sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) || byName(a, b));
  out.empty = out.local.length + out.cloud.filter((model) => !model.disabled).length + out.dev.length === 0;
  return out;
}
