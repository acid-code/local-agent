import { estimateTokens } from './tokens.js';

export type AutoRole = 'fast' | 'main' | 'coder' | 'thinking' | 'cloud';

export interface AutoMap {
  fast: string;
  main: string;
  coder: string;
  thinking: string;
  cloud: string;
  embed: string;
}

export const DEFAULT_AUTO_MAP: AutoMap = {
  fast: 'gemma3:4b',
  main: 'qwen3.6-35b-a3b',
  coder: 'gpt-oss:20b',
  thinking: '',
  cloud: '',
  embed: 'nomic-embed-text',
};

/** fast → main → thinking → cloud. Coder sits beside main and steps up to thinking. */
const LADDER: AutoRole[] = ['fast', 'main', 'thinking', 'cloud'];

export interface AutoCandidate {
  id: string;
  name: string;
  apiName: string;
  local: boolean;
  embedding: boolean;
  sizeClass: 'small' | 'large';
  providerKind: string;
  /** Display name of the provider, e.g. Ollama or llama-server. */
  providerName?: string;
  quotaOpen?: boolean;
  practicalBudget: number;
  enabled: boolean;
}

export interface RoleResolution {
  role: AutoRole;
  wanted: string;
  modelId?: string;
  modelName?: string;
  apiName?: string;
  providerKind?: string;
  providerName?: string;
  fallback: boolean;
  available: boolean;
  note: string;
}

export interface ChatCommand {
  rest: string;
  pinName?: string;
  unpin: boolean;
  smart: boolean;
  plan?: boolean;
}

export interface AutoDecision {
  role: AutoRole | 'pinned';
  modelId: string;
  modelName: string;
  reasoning: boolean;
  switched: boolean;
  escalated: boolean;
  reason: string;
  unload: string[];
  trace: string;
}

export function readChatCommand(text: string): ChatCommand {
  let rest = text.trim();
  let pinName: string | undefined;
  let unpin = false;
  let smart = false;
  let plan = false;
  const pin = rest.match(/^\/model\s+(\S+)\s*/i);
  if (pin) {
    pinName = pin[1];
    rest = rest.slice(pin[0].length).trim();
  } else if (/^\/auto\b/i.test(rest)) {
    unpin = true;
    rest = rest.replace(/^\/auto\b\s*/i, '').trim();
  }
  while (true) {
    if (/^\/smart\b/i.test(rest)) {
      smart = true;
      rest = rest.replace(/^\/smart\b\s*/i, '').trim();
      continue;
    }
    if (/^\/plan\b/i.test(rest)) {
      plan = true;
      rest = rest.replace(/^\/plan\b\s*/i, '').trim();
      continue;
    }
    break;
  }
  if (/use the smart model/i.test(text)) smart = true;
  return { rest, pinName, unpin, smart, plan };
}

export function matchAutoModel(models: AutoCandidate[], wanted: string): AutoCandidate | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  const norm = (value: string) => value.toLowerCase().replace(/[:_.\-\s]+/g, '-');
  const normNeedle = norm(needle);
  const pool = models.filter((model) => model.enabled);
  return pool.find((model) => model.apiName.toLowerCase() === needle || model.name.toLowerCase() === needle)
    ?? pool.find((model) => model.apiName.toLowerCase().startsWith(needle) || model.name.toLowerCase().startsWith(needle))
    ?? pool.find((model) => norm(model.apiName).includes(normNeedle) || norm(model.name).includes(normNeedle));
}

function chatLocals(models: AutoCandidate[]) {
  return models.filter((model) => model.enabled && model.local && !model.embedding && model.providerKind !== 'rehearsal');
}

export function modelLabel(model: Pick<AutoCandidate, 'apiName' | 'name'>): string {
  return `${model.apiName} ${model.name}`;
}

/** llama.cpp / Ollama Qwen3.6 35B-A3B, the box's main brain. */
export function isQwenMain(model: Pick<AutoCandidate, 'apiName' | 'name'>): boolean {
  const label = modelLabel(model);
  return /qwen3\.?6/i.test(label) || (/35b/i.test(label) && /a3b/i.test(label));
}

export function detectMain(models: AutoCandidate[]): AutoCandidate | undefined {
  const pool = chatLocals(models);
  const gemma = pool.find((model) => /gemma/i.test(modelLabel(model)) && /(26b|a4b)/i.test(modelLabel(model)));
  const qwen = pool.find(isQwenMain);
  // Qwen3.6 on llama-server is the main brain. Preferring gemma4 here made Auto fall back to it whenever
  // the main slot was empty, which loaded 18 GB in Ollama next to llama-server.
  return qwen ?? gemma ?? pool.find((model) => model.sizeClass === 'large') ?? pool[0];
}

/** gemma3:4b first (titles, short replies), then the smallest local chat model. */
export function detectFast(models: AutoCandidate[]): AutoCandidate | undefined {
  const pool = chatLocals(models);
  const gemma4b = pool.find((model) => /gemma3/i.test(modelLabel(model)) && /4b/i.test(modelLabel(model)));
  const small = pool.filter((model) => model.sizeClass === 'small').sort((a, b) => a.practicalBudget - b.practicalBudget)[0];
  return gemma4b ?? small;
}

/** gpt-oss (or another non-Qwen coder) when present, else the llama.cpp Qwen main model. */
export function detectCoder(models: AutoCandidate[]): AutoCandidate | undefined {
  const pool = chatLocals(models);
  const label = (model: AutoCandidate) => modelLabel(model);
  return pool.find((model) => /gpt[-_.: ]?oss|devstral|codestral|deepseek[-_.: ]?coder/i.test(label(model)))
    ?? pool.find((model) => /coder/i.test(label(model)) && !/qwen/i.test(label(model)))
    ?? pool.find((model) => /coder/i.test(label(model)))
    ?? pool.find(isQwenMain);
}

function fallbackModel(models: AutoCandidate[]): AutoCandidate {
  const model = models.find((item) => item.enabled && item.providerKind === 'rehearsal') ?? models.find((item) => item.enabled);
  if (!model) throw new Error('No models are available to route.');
  return model;
}

export interface ResolvedRole {
  model: AutoCandidate;
  reasoning: boolean;
  quotaFallback: false | 'quota' | 'off';
  wanted: string;
  matched: boolean;
  fallback: boolean;
  note: string;
}

function namedOrNull(models: AutoCandidate[], wanted: string | undefined): AutoCandidate | undefined {
  return wanted ? matchAutoModel(models, wanted) : undefined;
}

function describeResolution(input: {
  role: AutoRole;
  wanted: string;
  model: AutoCandidate;
  matched: boolean;
  quotaFallback: false | 'quota' | 'off';
}): Pick<ResolvedRole, 'fallback' | 'note'> {
  const { role, wanted, model, matched, quotaFallback } = input;
  if (quotaFallback === 'quota') return { fallback: true, note: `Gemini quota is used up; using ${model.name}.` };
  if (wanted && !matched) return { fallback: true, note: `Configured "${wanted}" is not installed; using ${model.name}.` };
  if (quotaFallback === 'off' && role === 'cloud' && wanted) return { fallback: true, note: `Configured "${wanted}" is not available; using ${model.name}.` };
  return { fallback: false, note: '' };
}

export function resolveRole(role: AutoRole, map: AutoMap, models: AutoCandidate[]): ResolvedRole {
  const fallback = fallbackModel(models);
  const wantedMain = (map.main || '').trim();
  const matchedMain = namedOrNull(models, wantedMain);
  const main = matchedMain || detectMain(models) || fallback;
  const wrap = (wanted: string, model: AutoCandidate, matched: boolean, reasoning: boolean, quotaFallback: false | 'quota' | 'off' = false): ResolvedRole => ({
    model, reasoning, quotaFallback, wanted, matched, ...describeResolution({ role, wanted, model, matched, quotaFallback }),
  });
  if (role === 'fast') {
    const wanted = (map.fast || '').trim();
    const named = namedOrNull(chatLocals(models), wanted);
    return wrap(wanted, named ?? detectFast(models) ?? main, Boolean(named), false);
  }
  if (role === 'coder') {
    const wanted = (map.coder || '').trim();
    const named = namedOrNull(models, wanted);
    return wrap(wanted, named ?? detectCoder(models) ?? main, Boolean(named), false);
  }
  if (role === 'thinking') {
    const wanted = (map.thinking || '').trim();
    const named = namedOrNull(models, wanted);
    return wrap(wanted, named ?? main, Boolean(named), true);
  }
  if (role === 'cloud') {
    const wanted = (map.cloud || '').trim();
    const named = namedOrNull(models, wanted);
    if (named && (named.local || named.quotaOpen !== false)) return wrap(wanted, named, true, false);
    const gemini = models.filter((model) => model.enabled && !model.local && model.providerKind === 'gemini' && model.quotaOpen !== false)
      .sort((a, b) => b.practicalBudget - a.practicalBudget)[0];
    if (gemini) return wrap(wanted, gemini, Boolean(named), false);
    const anyGemini = models.some((model) => model.enabled && !model.local && model.providerKind === 'gemini');
    return wrap(wanted, main, Boolean(named), false, wanted || anyGemini ? (anyGemini ? 'quota' : 'off') : false);
  }
  return wrap(wantedMain, main, Boolean(matchedMain), false);
}

function isUsable(model: AutoCandidate | undefined): model is AutoCandidate {
  return Boolean(model && model.enabled && model.providerKind !== 'rehearsal');
}

/** How each Auto role resolves against the models that are actually present. */
export function describeAutoRoles(map: AutoMap, models: AutoCandidate[]): RoleResolution[] {
  const roles: AutoRole[] = ['fast', 'main', 'coder', 'thinking', 'cloud'];
  const real = models.filter((model) => model.enabled && !model.embedding);
  const hasReal = real.some(isUsable);
  return roles.map((role) => {
    const wanted = (map[role] || '').trim();
    if (!hasReal) {
      return {
        role, wanted, fallback: Boolean(wanted), available: false,
        note: wanted ? `Configured "${wanted}" is not installed, and no other model is available.` : 'No usable model is installed.',
      };
    }
    const resolved = resolveRole(role, map, models);
    const available = isUsable(resolved.model);
    return {
      role, wanted, fallback: resolved.fallback, available,
      modelId: resolved.model.id, modelName: resolved.model.name, apiName: resolved.model.apiName,
      providerKind: resolved.model.providerKind, providerName: resolved.model.providerName,
      note: available ? resolved.note : (resolved.note || 'No usable model is installed.'),
    };
  });
}

export function autoRoleHealth(map: AutoMap, models: AutoCandidate[]): { ok: boolean; detail: string; roles: RoleResolution[] } {
  const roles = describeAutoRoles(map, models);
  const missing = roles.filter((row) => !row.available);
  const line = (row: RoleResolution) => {
    if (!row.available) return `${row.role}: no usable model` + (row.wanted ? ` (wanted ${row.wanted})` : '');
    const who = row.providerName ? `${row.modelName} (${row.providerName})` : row.modelName!;
    return row.note ? `${row.role} → ${who} — ${row.note}` : `${row.role} → ${who}`;
  };
  const detail = missing.length
    ? `No usable model for ${missing.map((row) => row.role).join(', ')}. ${roles.map(line).join('; ')}`
    : `Auto roles: ${roles.map(line).join('; ')}`;
  return { ok: missing.length === 0, detail, roles };
}

export function hebrewScore(model: Pick<AutoCandidate, 'apiName' | 'name' | 'local' | 'providerKind'>): number {
  const label = `${model.apiName} ${model.name}`.toLowerCase();
  if (!model.local && model.providerKind === 'gemini') return 100;
  if (/smollm|tinyllama|phi|nomic|embed/.test(label)) return 0;
  const size = Number(label.match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? (label.includes('e4b') ? 4 : label.includes('e2b') ? 2 : 3));
  const family = /gemma|aya|command-r|dicta/.test(label) ? 1 : /qwen/.test(label) ? 0.85 : /llama|mistral/.test(label) ? 0.6 : 0.5;
  return Math.min(95, Math.round((10 + Math.log2(1 + size) * 15) * family));
}

/** The strongest Hebrew writer among usable chat models: Gemini when its quota is open, else the best local that fits. */
export function pickHebrewModel(models: AutoCandidate[], fits?: (model: AutoCandidate) => boolean): AutoCandidate | undefined {
  const pool = models.filter((model) => model.enabled && !model.embedding && model.providerKind !== 'rehearsal' && (model.local ? (fits ? fits(model) : true) : model.providerKind === 'gemini' && model.quotaOpen !== false));
  return pool.map((model) => ({ model, score: hebrewScore(model) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score)[0]?.model;
}

function taskRole(text: string, stage?: 'plan' | 'implement'): AutoRole {
  if (stage === 'implement') return 'coder';
  if (stage === 'plan') return 'thinking';
  if (/\b(typo|fix|implement|refactor|bug|edit|commit|patch)\b/i.test(text)) return 'coder';
  if (/\b(plan|design)\b/i.test(text)) return 'thinking';
  if (/\b(summarize|summary|one line|classify)\b/i.test(text) || text.trim().length < 24) return 'fast';
  return 'main';
}

function stepUp(role: AutoRole): AutoRole {
  const current = role === 'coder' ? 'main' : role;
  const index = LADDER.indexOf(current);
  return LADDER[Math.min(Math.max(index, 0) + 1, LADDER.length - 1)] ?? 'cloud';
}

export function decideAuto(input: {
  text: string;
  stage?: 'plan' | 'implement';
  failures?: number;
  estimatedTokens?: number;
  map: AutoMap;
  models: AutoCandidate[];
  pinId?: string | null;
  residentLarge?: string[];
  /** The member reads Hebrew or the message is Hebrew: prefer the strongest Hebrew writer (except for code turns). */
  hebrew?: boolean;
  /** Local models that fit the RAM budget right now; Hebrew routing skips the rest. */
  fits?: (model: AutoCandidate) => boolean;
}): AutoDecision {
  const command = readChatCommand(input.text);
  const body = command.rest || input.text;
  const pinned = input.pinId ? input.models.find((model) => model.id === input.pinId && model.enabled) : undefined;
  const main = resolveRole('main', input.map, input.models).model;
  const unloadOf = (model: AutoCandidate) => (input.residentLarge ?? []).filter((name) => name !== model.name && name !== model.apiName);
  if (pinned) {
    const switched = pinned.id !== main.id;
    return {
      role: 'pinned', modelId: pinned.id, modelName: pinned.name, reasoning: false, switched, escalated: false,
      reason: switched ? `Pinned to ${pinned.name}.` : `Staying on ${pinned.name}.`,
      unload: unloadOf(pinned), trace: 'pinned',
    };
  }
  const base = taskRole(body, input.stage);
  const baseResolved = resolveRole(base, input.map, input.models);
  const tokens = input.estimatedTokens ?? estimateTokens(body, 'approx');
  const tooLong = tokens > baseResolved.model.practicalBudget * 0.85;
  const failures = input.failures ?? 0;
  const think = /think harder/i.test(input.text);
  let role = base;
  let why: 'task' | 'smart' | 'think' | 'failures' | 'overflow' = 'task';
  if (command.smart) {
    role = 'cloud';
    why = 'smart';
  } else if (failures >= 2 || think || tooLong) {
    role = stepUp(base);
    why = failures >= 2 ? 'failures' : think ? 'think' : 'overflow';
  }
  let resolved = resolveRole(role, input.map, input.models);
  if (input.hebrew && role !== 'coder' && why !== 'smart') {
    const hebrew = pickHebrewModel(input.models, input.fits);
    if (hebrew && hebrewScore(hebrew) > hebrewScore(resolved.model) && (hebrew.local || why !== 'task' || hebrewScore(resolved.model) < 60)) {
      resolved = { ...resolved, model: hebrew, quotaFallback: false, fallback: true, matched: false, note: `Switched to ${hebrew.name} for Hebrew.` };
      const decision = {
        role, modelId: hebrew.id, modelName: hebrew.name, reasoning: resolved.reasoning, switched: hebrew.id !== main.id, escalated: why !== 'task',
        reason: `Switched to ${hebrew.name} — it writes the best Hebrew of the models that fit.`, unload: unloadOf(hebrew), trace: `auto:hebrew:${role}`,
      };
      return decision;
    }
  }
  const switched = why !== 'task' || resolved.model.id !== main.id || resolved.reasoning;
  const escalated = why !== 'task';
  let reason = `Staying on ${resolved.model.name}.`;
  if (resolved.quotaFallback === 'quota') reason = `Staying on ${resolved.model.name} — Gemini quota is used up.`;
  else if (resolved.quotaFallback === 'off') reason = `Staying on ${resolved.model.name} — Gemini is off or has no API key.`;
  else if (why === 'smart') reason = `Switched to ${resolved.model.name} — you asked for the smart model.`;
  else if (why === 'think') reason = `Switched to ${resolved.model.name}${resolved.reasoning ? ' with reasoning on' : ''} — you asked to think harder.`;
  else if (why === 'failures') reason = `Switched to ${resolved.model.name} after two failed attempts.`;
  else if (why === 'overflow') reason = `Switched to ${resolved.model.name} — this turn does not fit ${baseResolved.model.name}.`;
  else if (role === 'fast' && switched) reason = `Switched to ${resolved.model.name} — a short reply stays on the fast model.`;
  else if (role === 'coder' && switched) reason = `Switched to ${resolved.model.name} — this turn changes code.`;
  else if (role === 'thinking' && switched) reason = `Switched to ${resolved.model.name} with reasoning on — this turn is a plan.`;
  if (!switched && !resolved.quotaFallback) reason = `Staying on ${resolved.model.name}.`;
  if (resolved.fallback && resolved.note && !resolved.quotaFallback && !reason.includes(resolved.note)) reason = `${reason} ${resolved.note}`;
  return {
    role, modelId: resolved.model.id, modelName: resolved.model.name, reasoning: resolved.reasoning,
    switched, escalated, reason, unload: unloadOf(resolved.model), trace: why === 'task' ? `auto:${role}` : `auto:${why}`,
  };
}

/** True when a message probably needs a tool: the web, files, the shell, memory, or the knowledge base. */
export function likelyNeedsTools(text: string, opts: { kb?: boolean; code?: boolean } = {}): boolean {
  const body = readChatCommand(text).rest || text;
  if (opts.code) return true;
  if (/https?:\/\/|www\.|(^|\s)[~.]?\/[\w.-]+\//i.test(body)) return true;
  if (/\b(search|google|look\s?up|browse|latest|news|today|tonight|current(ly)?|weather|price|stock|web(site)?|url|link|download|fetch|file|files|folder|directory|read|open|list|run|execute|shell|terminal|command|docker|containers?|install|kb|knowledge|documents?|docs|pdf|remember|recall|notes?|schedule|remind)\b/i.test(body)) return true;
  if (opts.kb && body.trim().length >= 12 && /\?|\b(what|which|who|where|when|how|why|according|explain|summari[sz]e|find)\b/i.test(body)) return true;
  return false;
}

/**
 * The next model up the Auto ladder after `currentId`, skipping `exclude`.
 * fast → main → thinking → cloud. Coder steps to thinking. A pin or unknown role starts at main.
 */
export function nextAutoTier(input: { role?: string; map: AutoMap; models: AutoCandidate[]; currentId: string; exclude?: Set<string> }): AutoCandidate | undefined {
  const pool = input.models.filter((model) => model.enabled && model.id !== input.currentId && !input.exclude?.has(model.id) && !model.embedding);
  const real = pool.filter((model) => model.providerKind !== 'rehearsal');
  if (!real.length) return undefined;
  const known = (['fast', 'main', 'coder', 'thinking', 'cloud'] as string[]).includes(input.role || '');
  const role = input.role as AutoRole;
  const startIndex = !known ? 1 : (role === 'coder' ? LADDER.indexOf('main') : LADDER.indexOf(role)) + 1;
  for (const next of LADDER.slice(startIndex)) {
    const resolved = resolveRole(next, input.map, real).model;
    if (resolved && resolved.id !== input.currentId && resolved.providerKind !== 'rehearsal' && (next !== 'cloud' || resolved.local || resolved.quotaOpen !== false)) return resolved;
  }
  return real.find((model) => model.local) ?? real[0];
}
