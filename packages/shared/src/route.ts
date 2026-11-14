import { classifyRequest, type Classification } from './classify.js';
import type { Modality, ProviderKind, RequestKind, SizeClass } from './types.js';

export interface RouteCandidate {
  id: string;
  name: string;
  apiName: string;
  providerKind: ProviderKind;
  local: boolean;
  resident: boolean;
  enabled: boolean;
  sizeClass: SizeClass;
  modalities: Modality[];
  strengths: RequestKind[];
  contextWindow: number;
  practicalBudget: number;
  typicalQ4GiB?: number;
  profileId: string;
  /** Closed free-tier models are not selectable. Local models omit this. */
  quotaOpen?: boolean;
  rpdRemaining?: number | null;
}

export interface RouteInput {
  text: string;
  hasImage?: boolean;
  agentRouting: 'auto' | 'pinned';
  agentModelId?: string | null;
  messageModelId?: string | null;
  sessionModelId?: string | null;
  goodModelId?: string | null;
  models: RouteCandidate[];
  memAvailableGiB: number;
  /** Name of a large local model currently inside another run. */
  busyLocalLarge?: string | null;
  /** Names of large local models loaded but idle. */
  residentLarge?: string[];
  /** Recent failed runs on a local model. Two or more is a reason to escalate. */
  localFailures?: number;
  /** A workshop or coding session should use a model that can write code. */
  preferCode?: boolean;
  /** A smart model should pull, search, and write the plan before a coder edits. */
  preferPlanner?: boolean;
  /** The plan is already written and a coder should implement it. */
  implementing?: boolean;
}

export interface RouteDecision {
  kind: RequestKind;
  confidence: number;
  signals: string[];
  modelId: string;
  modelName: string;
  switched: boolean;
  reason: string;
  unload: string[];
  trace: string;
  reasoning?: boolean;
  role?: string;
  escalated?: boolean;
}

function byId(models: RouteCandidate[], id?: string | null) {
  if (!id) return undefined;
  return models.find((model) => model.id === id && model.enabled);
}

function ramOk(model: RouteCandidate, input: RouteInput): boolean {
  if (!model.local || model.sizeClass !== 'large' || model.resident) return true;
  if (input.busyLocalLarge && input.busyLocalLarge !== model.name) return false;
  const need = (model.typicalQ4GiB ?? 16) + 6;
  return input.memAvailableGiB >= need;
}

function usable(model: RouteCandidate, kind: RequestKind, input: RouteInput): boolean {
  if (!model.enabled) return false;
  if (model.quotaOpen === false) return false;
  if (kind === 'vision' && !model.modalities.includes('image')) return false;
  if (!ramOk(model, input)) return false;
  return true;
}

function unloadFor(model: RouteCandidate, input: RouteInput): string[] {
  if (!model.local || model.sizeClass !== 'large' || model.resident) return [];
  return (input.residentLarge ?? []).filter((name) => name !== model.name);
}

function localRank(model: RouteCandidate): number {
  if (model.providerKind === 'rehearsal') return -100;
  return (model.local ? 8 : 0) + (model.resident ? 20 : 0) + (model.sizeClass === 'large' ? 4 : 1);
}

function cloudRank(model: RouteCandidate, classified: Classification): number {
  if (classified.kind === 'hard-reasoning') {
    if (model.profileId === 'gemini-4-hydrogen') return 100;
    return model.strengths.includes('hard-reasoning') ? 40 : 1;
  }
  if (classified.kind === 'long-context') return model.practicalBudget;
  return (model.profileId === 'gemini-3.5-flash-lite' ? 50 : 0) + Math.min(model.rpdRemaining ?? 0, 500) / 50;
}

function shouldEscalate(classified: Classification, localPick: RouteCandidate | undefined, failures: number): boolean {
  if (failures >= 2) return true;
  if (classified.kind === 'hard-reasoning' && classified.confidence >= 0.7) return true;
  if (classified.kind === 'vision' && !localPick) return true;
  if (classified.kind === 'long-context') {
    const budget = localPick?.practicalBudget ?? 0;
    return classified.estimatedTokens > budget * 0.85;
  }
  return false;
}

export function decideRoute(input: RouteInput): RouteDecision {
  const raw = classifyRequest(input.text, !!input.hasImage);
  const classified = input.preferPlanner && (raw.kind === 'chat' || raw.kind === 'code')
    ? { ...raw, kind: 'research' as const, confidence: Math.max(raw.confidence, 0.72), signals: [...raw.signals, 'planner'] }
    : input.preferCode && raw.kind === 'chat'
      ? { ...raw, kind: 'code' as const, confidence: Math.max(raw.confidence, 0.7), signals: [...raw.signals, 'workshop'] }
      : raw;
  const models = input.models.filter((model) => model.enabled);
  const fallback = models.find((model) => model.providerKind === 'rehearsal') ?? models[0];
  if (!fallback) {
    throw new Error('No models are available to route.');
  }

  const override = byId(models, input.messageModelId);
  if (override) {
    return decision(override, classified, true, `You pinned this turn to ${override.name}.`, unloadFor(override, input), 'message override');
  }

  const agent = byId(models, input.agentModelId);
  if (input.agentRouting === 'pinned' && agent) {
    if (classified.kind === 'vision' && !agent.modalities.includes('image')) {
      const vision = [...models].filter((model) => usable(model, 'vision', input)).sort((a, b) => localRank(b) - localRank(a) || cloudRank(b, classified) - cloudRank(a, classified))[0];
      if (vision && vision.id !== agent.id) {
        return decision(vision, classified, true, `Switched to ${vision.name} — ${agent.name} can't see images.`, unloadFor(vision, input), 'pinned model lacks vision');
      }
    }
    return decision(agent, classified, false, `Staying on ${agent.name}.`, unloadFor(agent, input), 'persona is pinned');
  }

  const session = byId(models, input.sessionModelId);
  const baseline = session ?? agent ?? byId(models, input.goodModelId);
  const rank = input.preferPlanner
    ? (model: RouteCandidate) => ((model.strengths.includes('research') || model.strengths.includes('hard-reasoning')) ? 40 : 0) + localRank(model)
    : classified.kind === 'code'
      ? (model: RouteCandidate) => (model.strengths.includes('code') ? 40 : 0) + localRank(model)
      : localRank;
  const locals = models
    .filter((model) => model.local && model.providerKind !== 'rehearsal' && usable(model, classified.kind, input))
    .sort((a, b) => rank(b) - rank(a));
  const clouds = models
    .filter((model) => !model.local && model.providerKind !== 'rehearsal' && usable(model, classified.kind, input))
    .sort((a, b) => cloudRank(b, classified) - cloudRank(a, classified));
  const localPick = locals[0];
  const escalate = shouldEscalate(classified, localPick, input.localFailures ?? 0);
  const cloudPick = clouds[0];

  let pick = localPick ?? cloudPick ?? fallback;
  let trace = 'local by default';
  let reason = `Staying on ${pick.name}.`;

  if (escalate && cloudPick) {
    pick = cloudPick;
    trace = 'escalate';
    if ((input.localFailures ?? 0) >= 2) reason = `Switched to ${pick.name} after repeated local failures.`;
    else if (classified.kind === 'long-context') reason = `Switched to ${pick.name} — this synthesis does not fit the local practical budget.`;
    else if (classified.kind === 'vision') reason = `Switched to ${pick.name} — no local model can see images.`;
    else reason = `Switched to ${pick.name} for hard reasoning. Argon isn't on this free tier.`;
  } else if (escalate && localPick) {
    pick = localPick;
    trace = 'quota fallback';
    reason = models.some((model) => !model.local && model.providerKind === 'gemini')
      ? `Staying on ${localPick.name} — Gemini quota is used up.`
      : `Staying on ${localPick.name} — Gemini is off or has no API key.`;
  } else if (!localPick && cloudPick) {
    pick = cloudPick;
    trace = input.busyLocalLarge ? 'single large local' : 'no local candidate';
    reason = input.busyLocalLarge
      ? `Switched to ${cloudPick.name} — another large local model is already in use.`
      : `Switched to ${cloudPick.name} — no local model can take this turn.`;
  } else if (localPick && baseline && !baseline.local) {
    pick = localPick;
    trace = 'prefer local';
    reason = `Switched to ${localPick.name} — ordinary turns stay on this machine.`;
  }

  if (input.preferCode && pick.strengths.includes('code') && baseline && pick.id !== baseline.id && trace === 'local by default') {
    trace = 'workshop code';
    reason = input.implementing
      ? `Plan is set. Switched to ${pick.name} to implement it.`
      : `Switched to ${pick.name} — this turn changes a project.`;
  }
  if (input.preferPlanner && baseline && pick.id !== baseline.id && trace === 'local by default') {
    trace = 'workshop plan';
    reason = `Planning on ${pick.name}. It will pull the repo, look at what changed, and write a plan. A coder model then implements it.`;
  }

  const switched = baseline ? pick.id !== baseline.id : false;
  if (!switched && trace !== 'quota fallback') reason = `Staying on ${pick.name}.`;
  return decision(pick, classified, switched, reason, unloadFor(pick, input), trace);
}

function decision(
  model: RouteCandidate,
  classified: Classification,
  switched: boolean,
  reason: string,
  unload: string[],
  trace: string,
): RouteDecision {
  return {
    kind: classified.kind,
    confidence: classified.confidence,
    signals: classified.signals,
    modelId: model.id,
    modelName: model.name,
    switched,
    reason,
    unload,
    trace,
  };
}
