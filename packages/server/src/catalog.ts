import { MODEL_REGISTRY, publicProfile } from '@local-agent/shared';
import type { Store } from './db.js';
import fs from 'node:fs';
import path from 'node:path';

export const TEMPLATES = [
  {
    id: 'operator',
    name: 'House operator',
    description: 'Runs the box: files, shell, containers, and memory.',
    systemPrompt: 'You are the house operator for a home Linux mini PC. Prefer small, reversible actions. Use the workspace for files. Shared repos are one copy every persona can see. When the user asks to change one, pull it, talk with the coder about what changed, write a plan, and let the coder implement and update the repo. Ask before anything destructive. Be concrete.',
    tools: ['list_dir', 'read_file', 'write_file', 'shell', 'remember', 'recall', 'docker_ps', 'docker_inspect'],
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Plans, edits, tests, and commits inside a granted project.',
    systemPrompt: 'You are a coding agent. Start by writing a short plan with the plan tool, then read and search before you edit. A workshop lists every project in scope; name the project when you git, shell, or edit. Apply one reviewable patch at a time. Run the tests. Commit only when the checks pass. Never ask to print secrets; request a handle instead. Do not pull or push unless the owner approved it.',
    tools: ['list_dir', 'read_file', 'grep', 'glob', 'apply_patch', 'shell', 'plan', 'git', 'request_folder', 'handoff_cli', 'request_secret', 'remember', 'recall'],
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Searches, reads, and keeps pinned notes.',
    systemPrompt: 'You are a careful researcher. Search and fetch before you claim a current fact. Pin durable findings to memory. Cite URLs you actually fetched.',
    tools: ['web_search', 'web_fetch', 'list_dir', 'read_file', 'remember', 'recall', 'consult_agent'],
  },
];

export function seedCatalog(store: Store, dataDir: string) {
  store.upsertProvider({ id: 'prov_rehearsal', kind: 'rehearsal', name: 'Rehearsal', enabled: true });
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
  if (!settings.goodModelId) {
    const lite = store.getModel('model_gemini-3.5-flash-lite');
    const rehearsal = store.getModel('model_rehearsal');
    settings.goodModelId = geminiKey && lite ? lite.id : rehearsal?.id ?? null;
    store.saveSettings(settings, 'Initial defaults', { settings });
  }
  fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'repos'), { recursive: true });
}
