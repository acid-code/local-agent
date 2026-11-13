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
  fast: 'qwen3:4b',
  main: '',
  coder: 'qwen3-coder:30b',
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
  quotaOpen?: boolean;
  practicalBudget: number;
  enabled: boolean;
}

export interface ChatCommand {
  rest: string;
  pinName?: string;
  unpin: boolean;
  smart: boolean;
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
  const pin = rest.match(/^\/model\s+(\S+)\s*/i);
  if (pin) {
    pinName = pin[1];
    rest = rest.slice(pin[0].length).trim();
  } else if (/^\/auto\b/i.test(rest)) {
    unpin = true;
    rest = rest.replace(/^\/auto\b\s*/i, '').trim();
  }
  if (/^\/smart\b/i.test(rest)) {
    smart = true;
    rest = rest.replace(/^\/smart\b\s*/i, '').trim();
  }
  if (/use the smart model/i.test(text)) smart = true;
  return { rest, pinName, unpin, smart };
}

export function matchAutoModel(models: AutoCandidate[], wanted: string): AutoCandidate | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  const pool = models.filter((model) => model.enabled);
  return pool.find((model) => model.apiName.toLowerCase() === needle || model.name.toLowerCase() === needle)
    ?? pool.find((model) => model.apiName.toLowerCase().startsWith(needle) || model.name.toLowerCase().startsWith(needle));
}

function chatLocals(models: AutoCandidate[]) {
  return models.filter((model) => model.enabled && model.local && !model.embedding && model.providerKind !== 'rehearsal');
}

export function detectMain(models: AutoCandidate[]): AutoCandidate | undefined {
  const pool = chatLocals(models);
  const label = (model: AutoCandidate) => `${model.apiName} ${model.name}`;
  const gemma = pool.find((model) => /gemma/i.test(label(model)) && /(26b|a4b)/i.test(label(model)));
  const qwen = pool.find((model) => /qwen3\.?6/i.test(label(model)) || (/35b/i.test(label(model)) && /a3b/i.test(label(model))));
  return gemma ?? qwen ?? pool.find((model) => model.sizeClass === 'large') ?? pool[0];
}

function fallbackModel(models: AutoCandidate[]): AutoCandidate {
  const model = models.find((item) => item.enabled && item.providerKind === 'rehearsal') ?? models.find((item) => item.enabled);
  if (!model) throw new Error('No models are available to route.');
  return model;
}

function resolveRole(role: AutoRole, map: AutoMap, models: AutoCandidate[]): { model: AutoCandidate; reasoning: boolean; quotaFallback: boolean } {
  const fallback = fallbackModel(models);
  const main = (map.main && matchAutoModel(models, map.main)) || detectMain(models) || fallback;
  if (role === 'fast') {
    const named = matchAutoModel(chatLocals(models), map.fast);
    const small = chatLocals(models).filter((model) => model.sizeClass === 'small').sort((a, b) => a.practicalBudget - b.practicalBudget)[0];
    return { model: named ?? small ?? main, reasoning: false, quotaFallback: false };
  }
  if (role === 'coder') {
    const named = matchAutoModel(models, map.coder) ?? chatLocals(models).find((model) => /coder/i.test(`${model.apiName} ${model.name}`));
    return { model: named ?? main, reasoning: false, quotaFallback: false };
  }
  if (role === 'thinking') {
    const named = map.thinking ? matchAutoModel(models, map.thinking) : undefined;
    return { model: named ?? main, reasoning: true, quotaFallback: false };
  }
  if (role === 'cloud') {
    const named = map.cloud ? matchAutoModel(models, map.cloud) : undefined;
    if (named && (named.local || named.quotaOpen !== false)) return { model: named, reasoning: false, quotaFallback: false };
    const gemini = models.filter((model) => model.enabled && !model.local && model.providerKind === 'gemini' && model.quotaOpen !== false)
      .sort((a, b) => b.practicalBudget - a.practicalBudget)[0];
    if (gemini) return { model: gemini, reasoning: false, quotaFallback: false };
    return { model: main, reasoning: false, quotaFallback: true };
  }
  return { model: main, reasoning: false, quotaFallback: false };
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
  const resolved = resolveRole(role, input.map, input.models);
  const switched = why !== 'task' || resolved.model.id !== main.id || resolved.reasoning;
  const escalated = why !== 'task';
  let reason = `Staying on ${resolved.model.name}.`;
  if (resolved.quotaFallback) reason = `Staying on ${resolved.model.name} — Gemini quota is used up.`;
  else if (why === 'smart') reason = `Switched to ${resolved.model.name} — you asked for the smart model.`;
  else if (why === 'think') reason = `Switched to ${resolved.model.name}${resolved.reasoning ? ' with reasoning on' : ''} — you asked to think harder.`;
  else if (why === 'failures') reason = `Switched to ${resolved.model.name} after two failed attempts.`;
  else if (why === 'overflow') reason = `Switched to ${resolved.model.name} — this turn does not fit ${baseResolved.model.name}.`;
  else if (role === 'fast' && switched) reason = `Switched to ${resolved.model.name} — a short reply stays on the fast model.`;
  else if (role === 'coder' && switched) reason = `Switched to ${resolved.model.name} — this turn changes code.`;
  else if (role === 'thinking' && switched) reason = `Switched to ${resolved.model.name} with reasoning on — this turn is a plan.`;
  if (!switched && !resolved.quotaFallback) reason = `Staying on ${resolved.model.name}.`;
  return {
    role, modelId: resolved.model.id, modelName: resolved.model.name, reasoning: resolved.reasoning,
    switched, escalated, reason, unload: unloadOf(resolved.model), trace: why === 'task' ? `auto:${role}` : `auto:${why}`,
  };
}
