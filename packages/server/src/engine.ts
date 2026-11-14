import fs from 'node:fs';
import {
  decideAuto,
  decideRoute,
  estimateTokens,
  foldCandidates,
  freeTierByApiName,
  geminiQuotaDay,
  isContextOverflowError,
  likelyNeedsTools,
  nextAutoTier,
  planContext,
  shrinkBudget,
  quotaAvailability,
  readChatCommand,
  summaryTriggerFor,
  type AutoCandidate,
  type ChatMessage,
  type RouteCandidate,
  type RouteDecision,
  type RunCursor,
  type ToolCall,
} from '@local-agent/shared';
import { Bus } from './bus.js';
import type { Agent, ModelRow, RunRow, Store } from './db.js';
import type { DockerCtl } from './docker.js';
import { indexText, retrieve, type VectorIndex } from './embeddings.js';
import { countGeminiTokens, ollamaNumCtx, providerFor, type ModelProvider } from './providers.js';
import type { Settings } from './settings.js';
import { CODING_TOOLS } from './coding.js';
import { kbSearchTool, loadSkillTool, toolsFor, type Tool, type ToolContext } from './tools.js';
import { runSkillScript, skillCatalog } from './skills.js';
import { getWorkshop, workshopBrief } from './workshops.js';
import { checkOrRepair, contractForAgent, pickAutoRole, toolArgumentsSchema, toolParameters } from './contracts.js';
import { addProjectNote, changesSince, ensureTaskBranch, isSmallEdit, listSharedRepos, matchRepos, refreshRepo, releaseRepoLocks, repoSyncTool, sharedRepoBrief, taskBranchName, tryLockRepo, type GitIdentity } from './repos.js';
import { isMissingModelError, isToolUnsupportedError, ollamaCapabilities } from './ollama.js';
import { scanMachine } from './discovery.js';
import { CrashError, InterruptedToolError, StopError, clampText, now } from './util.js';
import type { Vault } from './vault.js';

export class Engine {
  private readonly inflight = new Map<string, { abort: AbortController; paused: boolean; resumePause: () => void }>();
  private readonly approvalWaiters = new Map<string, (status: 'approved' | 'denied') => void>();
  private readonly secretWaiters = new Map<string, (status: 'provided' | 'denied') => void>();
  private readonly heldLarge = new Map<string, string>();
  private readonly dwell = new Map<string, { modelId: string; previousId: string | null; until: number; explicit: boolean }>();
  residentLarge: string[] = [];
  extraTools: Tool[] = [];
  libraryDir = '';

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly docker: DockerCtl,
    private readonly vectors: VectorIndex,
    private readonly vault: Vault,
    private readonly instanceId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly providerOverride?: (model: ModelRow) => ModelProvider,
  ) {}

  async startTurn(input: { sessionId: string; agentId: string; content?: string; imageUrl?: string; modelId?: string; parentRunId?: string | null; depth?: number; wait?: boolean }) {
    const session = this.store.getSession(input.sessionId);
    const agent = this.store.getAgent(input.agentId);
    if (!session || !agent) throw new Error('Chat or persona is missing.');
    const settings = this.store.getSettings();
    if (settings.killed) throw new Error('Kill switch is on. New runs are stopped until you clear it.');
    this.assertWithinLimits(agent.id);
    if (input.content && !input.parentRunId && this.sessionBusy(session.id)) {
      // Two turns at once on one chat read each other's messages. Refuse the second one.
      throw Object.assign(new Error('A reply is still running in this chat. Wait for it or press Stop, then send again.'), { statusCode: 409 });
    }
    const command = input.content ? readChatCommand(input.content) : null;
    let commandAck: string | undefined;
    let pinMiss: string | undefined;
    if (command?.unpin) this.store.updateSession(session.id, { modelPin: null });
    if (command?.pinName) {
      const match = this.store.listModels().find((model) => model.enabled && (model.apiName === command.pinName || model.name === command.pinName || model.apiName.startsWith(command.pinName!) || model.name.startsWith(command.pinName!)));
      if (match) {
        this.store.updateSession(session.id, { modelPin: match.id });
        if (!command.rest) commandAck = `Pinned to ${match.name}.`;
      } else if (!command.rest) commandAck = `No model named ${command.pinName}.`;
      else pinMiss = command.pinName;
    }
    if (command?.unpin && !command.rest) commandAck = 'Back on Auto.';
    if (command?.smart && !command.rest && !command.pinName) commandAck = 'Add the question after /smart. The next ordinary message goes back to the main model.';
    let userMessageId: string | undefined;
    if (input.content) {
      const message = this.store.insertMessage({
        sessionId: session.id, role: 'user', content: input.content, toolCallId: null, toolName: null, toolCalls: null,
        agentId: agent.id, runId: null, imageUrl: input.imageUrl ?? null, routingNote: null,
      });
      if (session.title === 'New chat') {
        this.store.updateSession(session.id, { title: input.content.slice(0, 72) });
      }
      userMessageId = message.id;
    }
    const cursor: RunCursor = { phase: 'route', turn: 0, userMessageId, messageModelId: input.modelId, depth: input.depth ?? 0, configVersion: this.store.getSettings().version, agentUpdatedAt: agent.updatedAt, commandAck, pinMiss };
    const run = this.store.createRun({ sessionId: session.id, agentId: agent.id, parentRunId: input.parentRunId, configVersion: cursor.configVersion ?? 1, cursor });
    const task = this.execute(run.id);
    if (input.wait) await task;
    else void task;
    return this.store.getRun(run.id)!;
  }

  async execute(runId: string) {
    if (this.inflight.has(runId)) return;
    const abort = new AbortController();
    const state = { abort, paused: false, resumePause: () => {} };
    const runForLimit = this.store.getRun(runId);
    const limitMs = runForLimit ? this.runLimitMs(runForLimit.agentId) : null;
    const limitTimer = limitMs ? setTimeout(() => abort.abort(), limitMs) : null;
    this.inflight.set(runId, state);
    this.touch(runId);
    const beat = setInterval(() => this.touch(runId), 5000);
    try {
      this.store.updateRun(runId, { status: 'running', error: null, endedAt: null, leaseOwner: this.instanceId });
      this.bus.publish({ type: 'status', runId, status: 'running' });
      while (true) {
        const run = this.store.getRun(runId);
        if (!run || run.cursor.phase === 'done' || run.status === 'stopped') break;
        await this.waitIfPaused(runId, abort.signal);
        if (abort.signal.aborted) throw new StopError();
        if (run.cursor.phase === 'route') await this.stepRoute(run);
        else if (run.cursor.phase === 'context') await this.stepContext(run);
        else if (run.cursor.phase === 'model') await this.stepModel(run, abort.signal);
        else if (run.cursor.phase === 'tools') await this.stepTools(run, abort.signal);
        else if (run.cursor.phase === 'summarize') await this.stepSummarize(run);
        else break;
      }
      const latest = this.store.getRun(runId);
      if (latest && (latest.status === 'running' || latest.status === 'interrupted')) {
        this.store.updateRun(runId, { status: 'completed', endedAt: now(), cursor: { ...latest.cursor, phase: 'done' } });
      }
    } catch (error) {
      const status = error instanceof StopError ? 'stopped' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      const latest = this.store.getRun(runId);
      if (latest && latest.status !== 'stopped') {
        this.store.updateRun(runId, { status, error: message, endedAt: now() });
      }
      this.bus.publish({ type: 'error', runId, message });
    } finally {
      clearInterval(beat);
      if (limitTimer) clearTimeout(limitTimer);
      releaseRepoLocks(this.store, runId);
      this.heldLarge.delete(runId);
      this.inflight.delete(runId);
      this.bus.publish({ type: 'done', runId, run: this.store.getRun(runId) });
    }
  }

  /** True while a run on this chat is in flight in this process. */
  sessionBusy(sessionId: string): boolean {
    for (const runId of this.inflight.keys()) {
      if (this.store.getRun(runId)?.sessionId === sessionId) return true;
    }
    return false;
  }

  pause(runId: string) {
    const state = this.inflight.get(runId);
    if (!state) return this.store.getRun(runId);
    state.paused = true;
    this.store.updateRun(runId, { status: 'paused' });
    this.bus.publish({ type: 'status', runId, status: 'paused' });
    return this.store.getRun(runId);
  }

  async resume(runId: string) {
    const state = this.inflight.get(runId);
    if (state?.paused) {
      state.paused = false;
      state.resumePause();
      this.store.updateRun(runId, { status: 'running' });
      return this.store.getRun(runId);
    }
    const run = this.store.getRun(runId);
    if (!run || run.status === 'completed' || this.inflight.has(runId)) return run;
    void this.execute(runId);
    return this.store.getRun(runId);
  }

  stopAll() {
    for (const id of [...this.inflight.keys()]) this.stop(id);
  }

  stop(runId: string) {
    const state = this.inflight.get(runId);
    state?.abort.abort();
    if (state?.paused) state.resumePause();
    this.store.updateRun(runId, { status: 'stopped', endedAt: now(), error: 'Stopped.' });
    this.bus.publish({ type: 'status', runId, status: 'stopped' });
    return this.store.getRun(runId);
  }

  provideSecret(id: string, value: string | null) {
    const request = this.vault.listRequests().find((item) => item.id === id);
    if (!request || request.status !== 'pending') throw new Error('That secret request is not pending.');
    if (value) {
      this.vault.put({ name: request.name, value, scope: request.scope, scopeId: request.scopeId, actor: `run:${request.runId}` });
      this.vault.resolveRequest(id, 'provided');
    } else {
      this.vault.resolveRequest(id, 'denied');
    }
    const waiter = this.secretWaiters.get(id);
    if (waiter) waiter(value ? 'provided' : 'denied');
    else if (value) void this.resume(request.runId);
    this.bus.publish({ type: 'secret', runId: request.runId, requestId: id, status: value ? 'provided' : 'denied' });
  }

  decideApproval(id: string, status: 'approved' | 'denied') {
    const approval = this.store.resolveApproval(id, status);
    const waiter = this.approvalWaiters.get(id);
    if (waiter) waiter(status);
    else if (approval && status === 'approved') void this.resume(approval.runId);
    this.bus.publish({ type: 'approval', runId: approval?.runId, approval: this.store.getApproval(id) });
    return this.store.getApproval(id);
  }

  async retryFrom(runId: string, checkpointId: string) {
    const checkpoint = this.store.getCheckpoint(checkpointId);
    const run = this.store.getRun(runId);
    if (!checkpoint || !run || checkpoint.runId !== runId) throw new Error('Checkpoint not found.');
    if (this.inflight.has(runId)) this.stop(runId);
    if (checkpoint.lastMessageId) this.store.archiveMessagesAfter(run.sessionId, checkpoint.lastMessageId);
    this.store.updateRun(runId, { status: 'running', error: null, endedAt: null, cursor: checkpoint.cursor });
    void this.execute(runId);
    return { run: this.store.getRun(runId), warning: 'External side effects, such as files and containers, are not rolled back.' };
  }

  recover() {
    const staleBefore = new Date(Date.now() - 20_000).toISOString();
    const settings = this.store.getSettings();
    for (const run of this.store.staleRuns(this.instanceId, staleBefore)) {
      if (run.status === 'paused' || run.status === 'awaiting_approval') continue;
      if (settings.autoResume && run.cursor.phase !== 'done') {
        this.store.updateRun(run.id, { status: 'interrupted', error: 'Resuming after the process restarted.' });
        void this.resume(run.id);
      } else {
        this.store.updateRun(run.id, { status: 'interrupted', error: 'The process stopped before this run finished. Resume to continue from the last checkpoint.', endedAt: now(), leaseOwner: null });
      }
    }
  }

  private async stepRoute(run: RunRow) {
    if (run.cursor.commandAck) {
      const agent = this.store.getAgent(run.agentId);
      const assistant = this.store.insertMessage({
        sessionId: run.sessionId, role: 'assistant', content: run.cursor.commandAck, toolCalls: null,
        agentId: agent?.id ?? null, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: run.cursor.commandAck,
      });
      const cursor = { ...run.cursor, phase: 'done' as const };
      this.store.updateRun(run.id, { cursor, status: 'completed', endedAt: now(), routingNote: run.cursor.commandAck, switched: false });
      this.bus.publish({ type: 'message', runId: run.id, message: assistant });
      return;
    }
    const agent = this.store.getAgent(run.agentId);
    if (!agent) throw new Error('Persona disappeared.');
    const stage = stageFor(this.store, run);
    const prepared = await prepareRepos(this.store, run, stage);
    const staged = { ...run, cursor: { ...run.cursor, stage: prepared.stage, syncNote: prepared.syncNote, branched: prepared.branched } };
    await this.probeToolSupport();
    const decision = this.choose(agent, staged);
    let reason = prepared.lockedOut || decision.reason;
    let switched = prepared.lockedOut ? true : decision.switched;
    if (prepared.stage === 'implement' && this.store.getSession(run.sessionId)?.mode !== 'code' && !decision.escalated) {
      reason = `Switched to coder mode on ${prepared.labels || 'this project'} — you asked to change it.`;
      switched = true;
    }
    if (run.cursor.pinMiss) {
      reason = `No model named ${run.cursor.pinMiss}. ${reason}`;
      switched = true;
    }
    const cursor: RunCursor = {
      ...run.cursor,
      phase: 'context',
      modelId: decision.modelId,
      routingReason: reason,
      switched,
      reasoning: Boolean(decision.reasoning),
      autoRole: decision.role,
      stage: prepared.stage,
      syncNote: prepared.syncNote,
      branched: prepared.branched,
      agentUpdatedAt: agent.updatedAt,
      configVersion: this.store.getSettings().version,
      weightNote: decision.unload.length ? `Unload ${decision.unload.join(', ')} before loading ${decision.modelName}.` : undefined,
    };
    this.store.updateRun(run.id, { cursor, modelId: decision.modelId, routingNote: reason, switched, configVersion: cursor.configVersion });
    this.store.addStep({
      runId: run.id, kind: 'routing', name: decision.modelName, status: 'completed', input: { kind: decision.kind, signals: decision.signals },
      output: { reason, switched, trace: decision.trace, unload: decision.unload, autoRole: decision.role || pickAutoRole(([...this.store.listMessages(run.sessionId)].reverse().find((message) => message.role === 'user')?.content) || '').role, reasoning: Boolean(decision.reasoning) },
      toolCallId: null, turn: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
    });
    this.checkpoint(run.id, cursor, 'Routed');
    this.rememberLarge(run.id, decision.modelId);
    if (decision.unload.length) await this.unload(decision.unload);
    this.bus.publish({ type: 'step', runId: run.id, routing: decision });
  }

  private async stepContext(run: RunRow) {
    const agent = this.store.getAgent(run.agentId);
    const model = run.cursor.modelId ? this.store.getModel(run.cursor.modelId) : null;
    if (agent && model) await this.maybeFold(run.sessionId, agent, model);
    const cursor = { ...run.cursor, phase: 'model' as const };
    this.store.updateRun(run.id, { cursor });
    this.checkpoint(run.id, cursor, 'Context ready');
  }

  private async stepModel(run: RunRow, signal: AbortSignal) {
    await this.waitIfPaused(run.id, signal);
    const settings = this.store.getSettings();
    const sessionMode = this.store.getSession(run.sessionId)?.mode;
    const maxSteps = sessionMode === 'code' || run.cursor.stage ? Math.max(settings.maxSteps, 24) : settings.maxSteps;
    let current = this.store.getRun(run.id)!;
    if (current.cursor.turn >= maxSteps) {
      this.store.updateRun(run.id, { cursor: { ...current.cursor, phase: 'summarize' } });
      return;
    }
    const agent = this.store.getAgent(run.agentId);
    if (!agent) throw new Error('Persona disappeared.');
    if (agent.updatedAt !== current.cursor.agentUpdatedAt || settings.version !== current.cursor.configVersion) {
      this.store.addStep({
        runId: run.id, kind: 'config', name: 'config', status: 'completed', input: { from: current.cursor.configVersion, to: settings.version },
        output: 'Applied the new config between steps.', toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
      });
      current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: undefined, agentUpdatedAt: agent.updatedAt, configVersion: settings.version } })!;
    }
    if (!current.cursor.modelId) {
      const decision = this.choose(agent, current);
      current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: decision.modelId, routingReason: decision.reason, switched: decision.switched, reasoning: Boolean(decision.reasoning) }, modelId: decision.modelId, routingNote: decision.reason, switched: decision.switched })!;
      if (decision.unload.length) await this.unload(decision.unload);
    }
    let model = this.store.getModel(current.cursor.modelId!);
    if (!model) throw new Error('Selected model is gone.');
    let built = await this.buildMessages(current, agent, model);
    if (!this.reserveGemini(model, built.plan.estimatedTokens)) {
      const fallback = this.candidates(settings).find((item) => item.local && item.providerKind !== 'rehearsal');
      if (!fallback) throw new Error('Gemini quota is used up and no local model is available.');
      model = this.store.getModel(fallback.id)!;
      current = this.store.updateRun(run.id, {
        modelId: model.id,
        routingNote: `Staying on ${model.name} — Gemini quota is used up.`,
        switched: true,
        cursor: { ...current.cursor, modelId: model.id, switched: true, routingReason: `Staying on ${model.name} — Gemini quota is used up.` },
      })!;
      built = await this.buildMessages(current, agent, model);
      this.bus.publish({ type: 'quota', runId: run.id, exhausted: true });
    }
    const provider = this.provider(model);
    const toolless = Boolean(current.cursor.noTools) || this.toolSupportOf(model) === false;
    const tools = toolless ? [] : this.tools(agent, this.store.getSession(run.sessionId)?.mode, current.cursor.stage).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    if (model.local && model.sizeClass === 'large') {
      await this.waitForLarge(run.id, model.name);
      await this.loadLarge(run.id, model);
    }
    const step = this.store.addStep({
      runId: run.id, kind: 'model', name: model.name, status: 'running', input: { turn: current.cursor.turn, budget: built.plan.budgetTokens, estimated: built.plan.estimatedTokens, notes: built.plan.notes },
      output: null, toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
    });
    this.bus.publish({ type: 'step', runId: run.id, step });
    const started = Date.now();
    let text = '';
    let reasoningText = '';
    let toolCalls: ToolCall[] | undefined;
    let usage = { inputTokens: built.plan.estimatedTokens, outputTokens: 0 };
    try {
      for await (const event of provider.complete({
        model: model.apiName, messages: built.messages, tools, signal,
        paceMs: model.profileId === 'rehearsal' && process.env.NODE_ENV !== 'test' ? 10 : 0,
        numCtx: model.local ? ollamaNumCtx(current.cursor.budgetOverride || model.practicalBudget, settings.outputReserveTokens, model.contextWindow) : undefined,
        keepAlive: model.local ? (model.sizeClass === 'large' ? '30m' : '5m') : undefined,
        think: Boolean(current.cursor.reasoning) && !current.cursor.noThink,
        noThink: Boolean(current.cursor.noThink),
      })) {
        if (signal.aborted) throw new StopError();
        if (event.type === 'token') {
          text += event.text;
          this.bus.publish({ type: 'token', runId: run.id, text: event.text });
        } else if (event.type === 'thinking') {
          reasoningText += event.text;
          this.bus.publish({ type: 'thinking', runId: run.id, text: event.text });
        } else {
          toolCalls = event.toolCalls;
          if (event.usage) usage = event.usage;
        }
      }
    } catch (error) {
      if (error instanceof StopError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (isToolUnsupportedError(message)) {
        this.recordToolSupport(model.apiName, false);
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        const version = this.store.getSettings().version;
        const next = current.cursor.toolRetry ? undefined : this.nextTier(current, model, true);
        if (next) {
          const reason = `Switched to ${next.name} — ${model.name} cannot use tools.`;
          this.store.addLog('warn', reason, undefined, 'router');
          this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: next.id, toolRetry: true, phase: 'model', switched: true, routingReason: reason, configVersion: version }, modelId: next.id, switched: true, routingNote: reason });
          return;
        }
        if (!current.cursor.noTools) {
          this.store.addLog('warn', `${model.name} cannot use tools. Retrying without tools.`, undefined, 'router');
          this.store.updateRun(run.id, { cursor: { ...current.cursor, noTools: true, toolRetry: true, phase: 'model', configVersion: version } });
          return;
        }
      }
      if (model.local && isMissingModelError(message)) {
        this.store.updateModel(model.id, { enabled: false });
        this.store.addLog('warn', `${model.name} is not installed in Ollama anymore. Marked it missing.`, undefined, 'router');
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        void this.refreshModels();
        const next = current.cursor.missingRetry ? undefined : this.nextTier(current, model, false);
        if (next) {
          const reason = `Switched to ${next.name} — ${model.name} is not installed anymore.`;
          this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: next.id, missingRetry: true, phase: 'model', switched: true, routingReason: reason }, modelId: next.id, switched: true, routingNote: reason });
          return;
        }
        throw new Error(`${model.name} is not installed in Ollama. Pull it again or choose another model in Setup.`);
      }
      if (isContextOverflowError(message) && !current.cursor.budgetOverride) {
        const shrunk = shrinkBudget(model.practicalBudget);
        this.store.addLog('warn', `Context overflow from ${model.name}. Retrying at ${shrunk} tokens.`, undefined, 'context');
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        current = this.store.updateRun(run.id, { cursor: { ...current.cursor, budgetOverride: shrunk, phase: 'model' } })!;
        return;
      }
      if (isContextOverflowError(message) && current.cursor.budgetOverride && !current.cursor.contextEscalated) {
        const bigger = this.candidates(this.store.getSettings()).filter((item) => item.practicalBudget > model.practicalBudget).sort((a, b) => b.practicalBudget - a.practicalBudget)[0];
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        if (bigger) {
          this.store.addLog('warn', `Still over budget. Escalating to ${bigger.name}.`, undefined, 'router');
          current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: bigger.id, budgetOverride: undefined, contextEscalated: true, phase: 'model', switched: true, routingReason: `Switched to ${bigger.name} — the previous model ran out of context.` }, modelId: bigger.id, switched: true, routingNote: `Switched to ${bigger.name} — the previous model ran out of context.` })!;
          return;
        }
      }
      if (isProviderOutage(message) && !current.cursor.providerFallback) {
        const local = this.candidates(this.store.getSettings()).find((item) => item.local && item.id !== model.id);
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        if (local) {
          const reason = `Switched to ${local.name} — ${model.name} returned ${message.match(/429|5\d\d/)?.[0] || 'an error'}.`;
          this.store.addLog('warn', reason, undefined, 'providers');
          this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: local.id, providerFallback: true, phase: 'model', switched: true, routingReason: reason }, modelId: local.id, switched: true, routingNote: reason });
          return;
        }
      }
      this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
      throw error;
    }
    const split = splitThinking(text);
    text = split.answer;
    reasoningText = [reasoningText, split.reasoning].filter(Boolean).join('\n');
    if (!text.trim() && !toolCalls?.length) {
      if (!current.cursor.emptyRetry) {
        const why = reasoningText ? `${model.name} thought but gave no answer. Retrying once with thinking off.` : `${model.name} returned an empty answer. Retrying once.`;
        this.store.updateStep(step.id, { status: 'failed', error: why, output: reasoningText ? { reasoning: reasoningText.slice(0, 4000) } : null, endedAt: now(), latencyMs: Date.now() - started });
        this.store.addLog('warn', why, undefined, 'providers');
        this.store.updateRun(run.id, { cursor: { ...current.cursor, emptyRetry: true, noThink: true, phase: 'model' } });
        return;
      }
      text = reasoningText
        ? `${model.name} only produced reasoning and no answer, twice. Try again, rephrase, or pick a bigger model.`
        : `${model.name} returned an empty answer twice. Try again or pick another model.`;
    }
    const cost = ((usage.inputTokens * (model.priceIn ?? 0)) + (usage.outputTokens * (model.priceOut ?? 0))) / 1_000_000;
    const note = [current.cursor.switched ? current.cursor.routingReason : '', built.cutNote].filter(Boolean).join(' ') || null;
    text = this.vault.redact(text);
    const assistant = this.store.insertMessage({
      sessionId: run.sessionId, role: 'assistant', content: text, toolCalls: toolCalls?.length ? toolCalls : null,
      agentId: agent.id, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: note,
    });
    const cursor: RunCursor = toolCalls?.length
      ? { ...current.cursor, phase: 'tools', toolCalls, completedToolIds: [], approvalId: undefined }
      : { ...current.cursor, phase: 'summarize', toolCalls: undefined };
    this.store.updateStep(step.id, { status: 'completed', output: { text, toolCalls, ...(reasoningText ? { reasoning: reasoningText.slice(0, 4000) } : {}) }, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: cost, latencyMs: Date.now() - started, endedAt: now() });
    const fresh = this.store.getRun(run.id)!;
    this.store.updateRun(run.id, {
      cursor,
      inputTokens: fresh.inputTokens + usage.inputTokens,
      outputTokens: fresh.outputTokens + usage.outputTokens,
      costUsd: fresh.costUsd + cost,
    });
    this.checkpoint(run.id, cursor, toolCalls?.length ? 'Model requested tools' : 'Model answered');
    this.bus.publish({ type: 'message', runId: run.id, message: assistant });
  }

  private async stepTools(run: RunRow, signal: AbortSignal) {
    const calls = run.cursor.toolCalls ?? [];
    const completed = new Set(run.cursor.completedToolIds ?? []);
    let handoff = false;
    for (const call of calls) {
      if (completed.has(call.id)) continue;
      await this.waitIfPaused(run.id, signal);
      if (signal.aborted) throw new StopError();
      const tools = this.tools(this.store.getAgent(run.agentId)!, this.store.getSession(run.sessionId)?.mode, run.cursor.stage);
      const tool = tools.find((item) => item.name === call.name);
      let args = parseArgs(call.arguments);
      const speaker = this.store.getAgent(run.agentId);
      const contract = speaker ? contractForAgent(speaker.name) : null;
      if (contract && contract.tools.length && !contract.tools.includes(call.name) && !['request_secret', 'kb_search', 'load_skill'].includes(call.name)) {
        const message = `${contract.name} is not allowed to call ${call.name}.`;
        this.store.addStep({ runId: run.id, kind: 'contract', name: call.name, status: 'failed', input: args, output: message, toolCallId: call.id, turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: message, startedAt: now() });
        this.persistTool(run, call, message, 'failed');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      const modelForRepair = run.modelId ? this.store.getModel(run.modelId) : null;
      const checked = await checkOrRepair(toolArgumentsSchema(call.name), args, async (error) => {
        if (!modelForRepair) throw new Error(error);
        const text = await this.completeText(modelForRepair, `The tool call does not match its contract. ${error}\nOriginal: ${call.arguments}\nReply with one JSON object and nothing else.`);
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('Repair did not return JSON.');
        return JSON.parse(text.slice(start, end + 1));
      });
      if (!checked.ok) {
        this.store.addStep({ runId: run.id, kind: 'contract', name: call.name, status: 'failed', input: args, output: checked.error, toolCallId: call.id, turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: checked.error, startedAt: now() });
        this.persistTool(run, call, checked.error, 'failed');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      args = checked.value as Record<string, unknown>;
      const existing = this.store.findToolStep(run.id, call.id);
      if (existing?.status === 'completed') {
        completed.add(call.id);
        continue;
      }
      if (existing?.status === 'running' && tool?.mutates(args)) {
        const prior = this.store.lookupEffect(`${run.id}:${call.id}:${String(args.action || call.name)}`);
        if (prior?.result) {
          this.store.updateStep(existing.id, { status: 'completed', output: prior.result, endedAt: now() });
          this.persistTool(run, call, prior.result, 'completed', false);
          completed.add(call.id);
          this.bumpTools(run.id, completed);
          continue;
        }
        const note = prior
          ? `${call.name} already started. It was not repeated.`
          : `Tool ${call.name} was interrupted after it started. It was not repeated. Retry that step explicitly if the side effect should happen again.`;
        this.persistTool(run, call, note, 'failed');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      if (!tool) {
        this.persistTool(run, call, `Unknown tool ${call.name}.`, 'failed');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      if (call.name === 'shell' && String(args.command || '') && (await import('@local-agent/shared')).assessCommand(String(args.command)) === 'blocked') {
        this.persistTool(run, call, 'Blocked by guardrails.', 'failed');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      const settings = this.store.getSettings();
      if (call.name === 'request_secret') {
        const handled = await this.askSecret(run, call, args, signal, completed);
        if (handled) {
          completed.add(call.id);
          this.bumpTools(run.id, completed);
          continue;
        }
      }
      const toolContext = this.contextFor(run, signal);
      const limits = this.limitsFor(run.agentId);
      if ((limits.readOnly || this.store.getSettings().readOnly) && tool.mutates(args)) {
        this.persistTool(run, call, 'Blocked. This persona is in read-only mode.', 'skipped');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      let reason = tool.approval(args, toolContext);
      if (!settings.approvalForDestructive && ['shell', 'write_file', 'docker_run', 'docker_rm'].includes(tool.name)) reason = null;
      if (reason) {
        let approval = run.cursor.approvalId ? this.store.getApproval(run.cursor.approvalId) : null;
        if (!approval || approval.toolCallId !== call.id || approval.status === 'denied') {
          approval = this.store.createApproval({ runId: run.id, toolCallId: call.id, toolName: call.name, args, reason });
        }
        const waiting = { ...this.store.getRun(run.id)!.cursor, approvalId: approval.id, completedToolIds: [...completed] };
        this.store.updateRun(run.id, { status: 'awaiting_approval', cursor: waiting });
        this.checkpoint(run.id, waiting, 'Waiting for approval');
        this.bus.publish({ type: 'approval', runId: run.id, approval });
        if (approval.status === 'pending') await this.waitApproval(approval.id, run.id, signal);
        approval = this.store.getApproval(approval.id)!;
        this.store.updateRun(run.id, { status: 'running' });
        if (approval.status !== 'approved') {
          this.persistTool(run, call, 'Denied by the owner.', 'skipped');
          completed.add(call.id);
          this.bumpTools(run.id, completed);
          continue;
        }
      }
      const step = existing?.status === 'running' ? existing : this.store.addStep({
        runId: run.id, kind: 'tool', name: call.name, status: 'running', input: args, output: null, toolCallId: call.id,
        turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
      });
      const started = Date.now();
      try {
        const output = this.vault.redact(clampText(await tool.execute(args, { ...this.contextFor(run, signal), toolCallId: call.id }), 200_000));
        this.store.updateStep(step.id, { status: 'completed', output, latencyMs: Date.now() - started, endedAt: now() });
        this.persistTool(run, call, output, 'completed', false);
        this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
      } catch (error) {
        if (error instanceof CrashError || error instanceof StopError || error instanceof InterruptedToolError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        this.persistTool(run, call, `Error: ${message}`, 'failed', false);
      }
      if (call.name === 'plan' && Array.isArray(args.items) && args.items.length && run.cursor.stage === 'plan') handoff = true;
      completed.add(call.id);
      this.bumpTools(run.id, completed);
    }
    const latest = this.store.getRun(run.id)!;
    const turn = latest.cursor.turn + 1;
    let next: RunCursor = { ...latest.cursor, phase: turn >= this.store.getSettings().maxSteps ? 'summarize' : 'model', turn, toolCalls: undefined, completedToolIds: [], approvalId: undefined };
    if (handoff) {
      const approval = this.store.createApproval({ runId: run.id, toolCallId: 'plan', toolName: 'plan', args: { stage: 'plan' }, reason: 'Start coding from this plan. Edit the plan first if you want to change it.' });
      const waiting = { ...latest.cursor, phase: 'tools' as const, stage: 'plan' as const, approvalId: approval.id };
      this.store.updateRun(run.id, { status: 'awaiting_approval', cursor: waiting });
      this.checkpoint(run.id, waiting, 'Waiting for the plan');
      this.bus.publish({ type: 'approval', runId: run.id, approval });
      await this.waitApproval(approval.id, run.id, signal);
      const decided = this.store.getApproval(approval.id);
      next = decided?.status === 'approved'
        ? { ...latest.cursor, phase: 'route', stage: 'implement', modelId: undefined, turn, toolCalls: undefined, completedToolIds: [], approvalId: undefined }
        : { ...latest.cursor, phase: 'summarize', stage: 'plan', turn, toolCalls: undefined, completedToolIds: [], approvalId: undefined };
    }
    this.store.updateRun(run.id, { cursor: next, status: 'running' });
    this.checkpoint(run.id, next, handoff ? 'Plan decision' : 'Tools finished');
  }

  private async stepSummarize(run: RunRow) {
    const agent = this.store.getAgent(run.agentId);
    const model = run.modelId ? this.store.getModel(run.modelId) : null;
    if (agent && model) await this.maybeFold(run.sessionId, agent, model).catch(() => undefined);
    if (agent && run.cursor.stage === 'implement') {
      const labels = turnRoots(this.store, run).map((root) => root.label);
      for (const label of labels) addProjectNote(this.store, { label, agentId: agent.id, kind: 'change', body: `${agent.name} finished a change on ${label}.` });
    }
    const cursor = { ...this.store.getRun(run.id)!.cursor, phase: 'done' as const };
    this.store.updateRun(run.id, { cursor, status: 'completed', endedAt: now() });
    this.checkpoint(run.id, cursor, 'Finished');
  }

  private choose(agent: Agent, run: RunRow): RouteDecision {
    const settings = this.store.getSettings();
    const session = this.store.getSession(run.sessionId);
    const messages = this.store.listMessages(run.sessionId);
    const user = (run.cursor.userMessageId && messages.find((message) => message.id === run.cursor.userMessageId))
      || [...messages].reverse().find((message) => message.role === 'user');
    const text = user?.content ?? '';
    const pinnedPersona = agent.routing === 'pinned' && agent.modelId && !session?.modelPin && !run.cursor.messageModelId;
    const decision = pinnedPersona
      ? decideRoute({
        text,
        hasImage: Boolean(user?.imageUrl),
        agentRouting: agent.routing,
        agentModelId: agent.modelId,
        messageModelId: run.cursor.messageModelId,
        sessionModelId: session?.activeModelId,
        goodModelId: settings.goodModelId,
        models: this.candidates(settings),
        memAvailableGiB: memAvailableGiB(),
        busyLocalLarge: [...this.heldLarge.entries()].find(([id]) => id !== run.id)?.[1] ?? null,
        residentLarge: this.residentLarge,
        localFailures: this.localFailureCount(agent.id),
        preferPlanner: run.cursor.stage === 'plan',
        preferCode: run.cursor.stage === 'implement' || (session?.mode === 'code' && run.cursor.stage !== 'plan'),
        implementing: run.cursor.stage === 'implement',
      })
      : this.autoDecision(text, run, settings);
    let picked = decision;
    if (session?.modelPin && !this.store.getModel(session.modelPin)?.enabled) {
      this.store.updateSession(session.id, { modelPin: null });
      picked = { ...picked, switched: true, reason: `The pinned model is gone. ${picked.reason}` };
    }
    const explicit = Boolean(session?.modelPin || run.cursor.messageModelId || /^\/(auto|model|smart)\b/i.test(text));
    const held = session ? this.dwell.get(session.id) : undefined;
    if (session && held && !held.explicit && !explicit && !picked.escalated && held.until > Date.now() && held.previousId === picked.modelId && held.modelId !== picked.modelId) {
      const stay = this.store.getModel(held.modelId);
      if (stay?.enabled) picked = { ...picked, modelId: stay.id, modelName: stay.name, switched: false, reason: `Staying on ${stay.name}. Waiting before another model load.` };
    }
    if (session && picked.modelId !== held?.modelId) {
      this.dwell.set(session.id, { modelId: picked.modelId, previousId: held?.modelId ?? session.activeModelId, until: Date.now() + 45_000, explicit });
    }
    if (session && session.activeModelId !== picked.modelId) this.store.updateSession(session.id, { activeModelId: picked.modelId });
    return picked;
  }

  private autoCandidates(settings: Settings): AutoCandidate[] {
    return this.candidates(settings).map((model) => ({
      id: model.id, name: model.name, apiName: model.apiName, local: model.local, embedding: false,
      sizeClass: model.sizeClass, providerKind: model.providerKind, quotaOpen: model.quotaOpen,
      practicalBudget: model.practicalBudget, enabled: model.enabled,
    }));
  }

  private autoDecision(text: string, run: RunRow, settings: Settings): RouteDecision {
    const session = this.store.getSession(run.sessionId);
    const models = this.autoCandidates(settings);
    const unsupported = new Set(Object.entries(settings.toolSupport).filter(([, ok]) => ok === false).map(([name]) => name));
    // A model without tool calls still answers chat. Skip it only when this turn probably needs a tool.
    const needsTools = likelyNeedsTools(text, { kb: this.hasKnowledge(run.agentId), code: session?.mode === 'code' || Boolean(run.cursor.stage) });
    const capable = needsTools ? models.filter((model) => !unsupported.has(model.apiName) && !unsupported.has(model.name)) : models;
    const pool = capable.length ? capable : models;
    const auto = decideAuto({
      text, stage: run.cursor.stage, failures: this.localFailureCount(run.agentId), map: settings.autoModels, models: pool,
      pinId: session?.modelPin || run.cursor.messageModelId || null,
      residentLarge: [...new Set([...this.residentLarge, ...this.heldLarge.values()])],
    });
    return {
      kind: auto.role === 'coder' ? 'code' : auto.role === 'thinking' || auto.role === 'cloud' ? 'hard-reasoning' : 'chat',
      confidence: 0.8, signals: [auto.role], modelId: auto.modelId, modelName: auto.modelName,
      switched: auto.switched, reason: auto.reason, unload: auto.unload, trace: auto.trace,
      reasoning: auto.reasoning, role: auto.role, escalated: auto.escalated,
    };
  }

  private candidates(settings: Settings): RouteCandidate[] {
    const providers = new Map(this.store.listProviders().map((provider) => [provider.id, provider]));
    const minute = new Date().toISOString().slice(0, 16);
    const day = quotaDay();
    return this.store.listModels().filter((model) => model.enabled && !model.embedding).flatMap((model) => {
      const provider = providers.get(model.providerId);
      if (!provider?.enabled) return [];
      // Gemini without a key is off, not out of quota.
      if (provider.kind === 'gemini' && !this.providerOverride && !process.env[provider.apiKeyEnv || 'GEMINI_API_KEY']) return [];
      let quotaOpen: boolean | undefined;
      let rpdRemaining: number | null | undefined;
      if (provider.kind === 'gemini') {
        const row = freeTierByApiName(model.apiName);
        const configured = settings.quotaLimits[model.apiName];
        if (settings.geminiTier === 'paid' && !configured) {
          quotaOpen = model.freeTier !== false || Boolean(configured);
        } else if (row || configured) {
          const basis = row ?? { ...freeTierByApiName('gemini-3.5-flash-lite')!, apiName: model.apiName, id: model.apiName, rpm: { used: 0, limit: 5 }, rpd: { used: 0, limit: 20 }, tpm: { used: 0, limit: 250_000 } };
          const limited = {
            ...basis,
            rpm: { ...basis.rpm, limit: configured?.rpm ?? basis.rpm.limit },
            rpd: { ...basis.rpd, limit: configured?.rpd ?? basis.rpd.limit },
          };
          const used = this.store.quotaUse(model.apiName, day);
          const view = quotaAvailability(limited, { rpm: used.rpmWindow === minute ? used.rpm : 0, tpm: used.tpmWindow === minute ? used.tpm : 0, rpd: used.rpd });
          quotaOpen = view.open;
          rpdRemaining = view.rpdRemaining;
        } else if (model.freeTier === false) quotaOpen = false;
      }
      const resident = this.residentLarge.includes(model.name) || this.residentLarge.includes(model.apiName);
      return [{
        id: model.id, name: model.name, apiName: model.apiName, providerKind: provider.kind as RouteCandidate['providerKind'],
        local: model.local, resident, enabled: true, sizeClass: model.sizeClass, modalities: model.modalities as RouteCandidate['modalities'],
        strengths: model.strengths as RouteCandidate['strengths'], contextWindow: model.contextWindow, practicalBudget: model.practicalBudget,
        typicalQ4GiB: model.typicalQ4GiB ?? undefined, profileId: model.profileId, quotaOpen, rpdRemaining,
      }];
    });
  }

  private async buildMessages(run: RunRow, agent: Agent, model: ModelRow) {
    const settings = this.store.getSettings();
    const strategy = strategyFor(agent, model, run.cursor.autoRole);
    const notes = agent.memoryEnabled ? this.store.listNotes(agent.id) : [];
    const summaries = this.store.listSummaries(run.sessionId).map((summary) => ({
      id: summary.id, level: summary.level, content: summary.content, covers: summary.covers, foldedInto: summary.foldedInto,
    }));
    const messages = this.store.listMessages(run.sessionId);
    const user = [...messages].reverse().find((message) => message.role === 'user');
    const retrieved = strategy === 'retrieval' || strategy === 'hierarchical+retrieval' ? retrieve(this.store, this.vectors, run.sessionId, user?.content ?? '', 4) : [];
    let budget = Math.min(model.contextWindow, model.practicalBudget);
    const session = this.store.getSession(run.sessionId);
    const workshopNote = session?.workshopId ? workshopBrief(this.store, session.workshopId) : '';
    const stageNote = run.cursor.syncNote ? `\n\nWhat changed since you last looked:\n${run.cursor.syncNote}` : '';
    const roleNote = run.cursor.stage === 'plan'
      ? '\n\nYou are planning a change to a shared repo. Pull it with repo_sync, summarize what changed, and consult the coder persona with that summary if one exists. Search the web when the task depends on current facts. Save the plan with the plan tool. Do not edit files yet.'
      : run.cursor.stage === 'implement'
        ? '\n\nThe plan is saved. Implement it in the shared repos. Commit when the checks pass. Push only after the owner approves.'
        : '';
    const skillNote = skillCatalog(this.store, agent.id, user?.content ?? '');
    const system = `${agent.systemPrompt}${sharedRepoBrief(this.store)}${stageNote}${roleNote}`;
    const preambleGuess = `${system}\n${notes.map((note) => note.content).join('\n')}`;
    if (model.providerId === 'prov_gemini' && estimateTokens(preambleGuess, 'gemini') > budget * 0.75) {
      const key = process.env.GEMINI_API_KEY;
      if (key) {
        const counted = await countGeminiTokens(key, model.apiName, preambleGuess, this.fetchImpl);
        if (counted && counted > budget) budget = Math.min(model.contextWindow, counted + settings.outputReserveTokens);
      }
    }
    const plan = planContext({
      strategy, contextWindow: model.contextWindow, practicalBudget: run.cursor.budgetOverride || budget, outputReserve: settings.outputReserveTokens,
      system, optional: [{ label: 'workshop brief', text: workshopNote }, { label: 'skills catalog', text: skillNote }].filter((part) => part.text.trim()),
      pinned: notes.filter((note) => note.pinned).map((note) => note.content),
      summaries, retrieved, tokenizer: model.tokenizer as 'gemma4',
      messages: messages.map((message) => ({ id: message.id, role: message.role as 'user', content: message.content })),
    });
    if (plan.trimmed.length) {
      this.store.addStep({
        runId: run.id, kind: 'context', name: 'trim', status: 'completed', input: { trimmed: plan.trimmed },
        output: plan.notes.find((note) => note.startsWith('Trimmed')) || 'Trimmed optional context.', toolCallId: null,
        turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
      });
    }
    for (const piece of plan.excerpted) {
      if (piece.omitted.length > 80) indexText(this.store, this.vectors, { sessionId: run.sessionId, agentId: agent.id, text: piece.omitted.slice(0, 4000) });
    }
    const cut = plan.excerpted.filter((piece) => piece.omitted.length > 0 && recentRole(messages, piece.id) !== 'tool');
    const cutNote = cut.length
      ? `Cut ${cut.reduce((sum, piece) => sum + piece.omitted.length, 0).toLocaleString('en-US')} characters from the middle of ${cut.length === 1 ? 'a long message' : `${cut.length} long messages`} to fit ${model.name}. The start and end were kept.`
      : '';
    if (cutNote && run.cursor.turn === 0) {
      this.store.addStep({
        runId: run.id, kind: 'context', name: 'excerpt', status: 'completed', input: { excerpted: cut.map((piece) => ({ id: piece.id, omittedChars: piece.omitted.length })) },
        output: cutNote, toolCallId: null, turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
      });
    }
    this.bus.publish({ type: 'context', runId: run.id, used: plan.estimatedTokens, budget: plan.budgetTokens });
    const recent = new Map(messages.map((message) => [message.id, message]));
    const chat: ChatMessage[] = [{ role: 'system', content: plan.preamble }];
    for (const item of plan.recent) {
      const message = recent.get(item.id);
      if (!message) continue;
      const spoken = message.role === 'user' ? (readChatCommand(item.content).rest || item.content) : item.content;
      chat.push({
        role: message.role as ChatMessage['role'], content: spoken, toolCallId: message.toolCallId ?? undefined,
        name: message.toolName ?? undefined, toolCalls: (message.toolCalls as ToolCall[] | null) ?? undefined, imageUrl: message.imageUrl ?? undefined,
      });
    }
    return { plan, messages: chat, cutNote };
  }

  private async maybeFold(sessionId: string, agent: Agent, model: ModelRow) {
    const settings = this.store.getSettings();
    const messages = this.store.listMessages(sessionId);
    const summaries = this.store.listSummaries(sessionId);
    const covered = new Set(summaries.flatMap((summary) => summary.covers));
    const ids = foldCandidates(messages.map((message) => ({ id: message.id, role: message.role as 'user', content: message.content })), covered, model.tokenizer as 'approx', summaryTriggerFor(model, settings.summaryTriggerTokens), Math.min(model.contextWindow, model.practicalBudget) - settings.outputReserveTokens);
    if (!ids) return;
    const slice = messages.filter((message) => ids.includes(message.id));
    const transcript = slice.map((message) => `${message.role}: ${message.content}`).join('\n').slice(0, 12_000);
    const summary = await this.trySummarize(model, `Summarize this conversation segment in under 180 words. Keep names, decisions, numbers, and open questions.\n\n${transcript}`);
    if (!summary) {
      this.store.addLog('warn', 'Summary failed. Raw messages were kept and will be tried again later.', undefined, 'context');
      return;
    }
    const version = Math.max(0, ...summaries.map((item) => item.version)) + 1;
    const hierarchical = strategyFor(agent, model, undefined) === 'hierarchical' || strategyFor(agent, model, undefined) === 'hierarchical+retrieval';
    const created = this.store.addSummary({ sessionId, level: hierarchical ? 1 : 2, version, content: summary, covers: ids, foldedInto: null, tokenEstimate: estimateTokens(summary, model.tokenizer as 'approx') });
    if (hierarchical) {
      const open = this.store.listSummaries(sessionId).filter((item) => item.level === 1 && !item.foldedInto);
      if (open.length >= 4) {
        let root = await this.trySummarize(model, `Combine these chunk summaries into one root summary under 220 words.\n\n${open.map((item) => item.content).join('\n\n')}`);
        if (!root) return;
        const cap = Math.min(1200, Math.floor(model.practicalBudget * 0.2));
        if (estimateTokens(root, 'approx') > cap) {
          const shorter = await this.trySummarize(model, `Shorten this summary to under ${cap} tokens.\n\n${root}`);
          root = shorter && estimateTokens(shorter, 'approx') <= cap ? shorter : root.slice(0, cap * 3);
        }
        const rootRow = this.store.addSummary({ sessionId, level: 2, version: version + 1, content: root, covers: open.flatMap((item) => item.covers), foldedInto: null, tokenEstimate: estimateTokens(root, 'approx') });
        this.store.markSummariesFolded(open.map((item) => item.id), rootRow.id);
      }
    }
    indexText(this.store, this.vectors, { sessionId, agentId: agent.id, text: slice.map((message) => message.content).join('\n').slice(0, 4000) });
    void created;
  }

  private async trySummarize(model: ModelRow, prompt: string): Promise<string | null> {
    if (model.profileId === 'rehearsal') return prompt.split('\n').filter((line) => line.startsWith('user:') || line.startsWith('assistant:')).slice(0, 6).join(' ').slice(0, 800) || 'Summary stored.';
    try {
      const provider = this.provider(model);
      let text = '';
      const timer = AbortSignal.timeout(20_000);
      for await (const event of provider.complete({ model: model.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0, signal: timer })) {
        if (event.type === 'token') text += event.text;
      }
      return text.trim().slice(0, 4000) || null;
    } catch {
      return null;
    }
  }

  private async completeText(model: ModelRow, prompt: string) {
    if (model.profileId === 'rehearsal') return prompt.split('\n').filter((line) => line.startsWith('user:') || line.startsWith('assistant:')).slice(0, 6).join(' ').slice(0, 800) || 'Summary stored.';
    try {
      const provider = this.provider(model);
      let text = '';
      for await (const event of provider.complete({ model: model.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0 })) {
        if (event.type === 'token') text += event.text;
      }
      return text.slice(0, 4000) || 'Summary stored.';
    } catch {
      return prompt.slice(0, 800);
    }
  }

  /** Tool support from Ollama capabilities or a rejected request. undefined when not known yet. */
  private toolSupportOf(model: { apiName: string; name: string }): boolean | undefined {
    const map = this.store.getSettings().toolSupport;
    return map[model.apiName] ?? map[model.name];
  }

  private recordToolSupport(apiName: string, ok: boolean) {
    const current = this.store.getSettings();
    if (current.toolSupport[apiName] === ok) return;
    const toolSupport = { ...current.toolSupport, [apiName]: ok };
    this.store.saveSettings({ ...current, toolSupport }, ok ? `${apiName} supports tool calls` : `${apiName} does not support tool calls`, { toolSupport });
  }

  private ollamaRootFor(model: ModelRow): string | null {
    const provider = this.store.getProvider(model.providerId);
    if (!provider || provider.kind === 'openrouter' || provider.kind === 'gemini' || provider.kind === 'rehearsal') return null;
    const base = (provider.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
    if (provider.id === 'prov_ollama' || provider.name === 'Ollama' || /:11434(\/|$)/.test(base)) return base.replace(/\/v1$/, '');
    return null;
  }

  /** Ask Ollama once per model whether it takes tools. Cached in settings.toolSupport. */
  private async probeToolSupport() {
    if (this.providerOverride) return;
    const unknown = this.store.listModels().filter((model) => model.enabled && model.local && !model.embedding && this.toolSupportOf(model) === undefined);
    await Promise.all(unknown.map(async (model) => {
      const root = this.ollamaRootFor(model);
      if (!root) return;
      const found = await ollamaCapabilities(this.fetchImpl, model.apiName, root);
      if (found.capabilities) this.recordToolSupport(model.apiName, found.capabilities.includes('tools'));
    }));
  }

  /** The next Auto tier after `model`, for a retry. */
  private nextTier(run: RunRow, model: ModelRow, needTools: boolean): ModelRow | undefined {
    const settings = this.store.getSettings();
    const models = this.autoCandidates(settings);
    const exclude = new Set<string>();
    if (needTools) for (const item of models) if (this.toolSupportOf(item) === false) exclude.add(item.id);
    const pick = nextAutoTier({ role: run.cursor.autoRole, map: settings.autoModels, models, currentId: model.id, exclude });
    return pick ? this.store.getModel(pick.id) ?? undefined : undefined;
  }

  private hasKnowledge(agentId: string): boolean {
    try {
      const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM kb_documents d JOIN kb_collections c ON c.id = d.collection_id WHERE c.agent_id IS NULL OR c.agent_id = ?').get(agentId) as { n: number } | undefined;
      return Number(row?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private refreshing: Promise<unknown> | null = null;
  private refreshModels() {
    if (this.providerOverride || this.refreshing) return this.refreshing;
    this.refreshing = scanMachine(this.fetchImpl, this.docker, this.store)
      .then((scan) => { this.residentLarge = scan.resident; })
      .catch(() => undefined)
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private tools(agent: Agent, sessionMode?: string, stage?: 'plan' | 'implement') {
    const names = new Set(agent.toolAllowlist);
    names.add('request_secret');
    names.add('read_output');
    names.add('run_skill_script');
    names.add('kb_search');
    names.add('load_skill');
    names.add('repo_sync');
    if (stage === 'plan') {
      for (const name of ['web_search', 'web_fetch', 'read_file', 'list_dir', 'grep', 'glob', 'plan', 'recall', 'consult_agent']) names.add(name);
    }
    if (stage === 'implement' || sessionMode === 'code') for (const tool of CODING_TOOLS) names.add(tool.name);
    const catalog = [...toolsFor([...names]), ...CODING_TOOLS, requestSecretTool(), readOutputTool(), skillScriptTool(), kbSearchTool(), loadSkillTool(), repoSyncTool(), ...this.extraTools];
    const seen = new Set<string>();
    return catalog.filter((tool) => {
      if (!names.has(tool.name) || seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    }).map((tool) => ({ ...tool, parameters: toolParameters(tool.name).properties ? toolParameters(tool.name) : tool.parameters }));
  }

  private contextFor(run: RunRow, signal: AbortSignal): ToolContext {
    const agent = this.store.getAgent(run.agentId)!;
    const settings = this.store.getSettings();
    return {
      agent, workspace: agent.workspacePath, signal, docker: this.docker, fetchImpl: this.fetchImpl, searxngUrl: settings.searxngUrl || process.env.SEARXNG_URL || '',
      sandbox: settings.sandbox, store: this.store, depth: run.cursor.depth ?? 0,
      sessionId: run.sessionId, runId: run.id, codeApproval: settings.codeApproval,
      secretEnv: () => this.vault.envFor(agent.id, `run:${run.id}`),
      libraryDir: this.libraryDir,
      roots: turnRoots(this.store, run),
      gitIdentity: gitIdentity(this.store.getSettings()),
      consult: (name, question) => this.consult(run, name, question),
    };
  }

  private async consult(run: RunRow, name: string, question: string) {
    if ((run.cursor.depth ?? 0) >= 1) throw new Error('Nested consultations stop at one level.');
    const other = this.store.getAgentByName(name);
    if (!other) throw new Error(`No persona named ${name}.`);
    const session = this.store.getSession(run.sessionId);
    if (session?.roomId) {
      const room = this.store.getRoom(session.roomId);
      if (room && !room.agentIds.includes(other.id)) throw new Error(`${other.name} is not in this room.`);
    }
    const child = this.store.createSession({ agentId: other.id, title: `Consult: ${other.name}` });
    const childRun = await this.startTurn({ sessionId: child.id, agentId: other.id, content: question, parentRunId: run.id, depth: 1, wait: true });
    const answer = [...this.store.listMessages(child.id)].reverse().find((message) => message.role === 'assistant');
    return answer?.content || childRun.error || 'No answer.';
  }

  private provider(model: ModelRow) {
    if (this.providerOverride) return this.providerOverride(model);
    const provider = this.store.getProvider(model.providerId);
    if (!provider) throw new Error('Provider missing.');
    return providerFor(model, provider, this.fetchImpl);
  }

  private async askSecret(run: RunRow, call: ToolCall, args: Record<string, unknown>, signal: AbortSignal, completed: Set<string>) {
    const name = String(args.name || '');
    const agent = this.store.getAgent(run.agentId);
    if (!agent) return false;
    const existing = this.vault.active(name, agent.id);
    if (existing) {
      this.persistTool(run, call, `Handle ${existing.handle} is available. It is injected as an environment variable at runtime. Do not ask for or print the value.`, 'completed');
      return true;
    }
    const request = this.vault.createRequest({
      runId: run.id, name, scope: String(args.scope || 'agent'), scopeId: agent.id, reason: String(args.reason || 'Needed to continue.'),
    });
    const waiting = { ...this.store.getRun(run.id)!.cursor, completedToolIds: [...completed] };
    this.store.updateRun(run.id, { status: 'awaiting_secret', cursor: waiting });
    this.checkpoint(run.id, waiting, `Waiting for secret ${request.name}`);
    this.bus.publish({ type: 'secret', runId: run.id, request });
    const decision = await this.waitSecret(request.id, run.id, signal);
    this.store.updateRun(run.id, { status: 'running' });
    const handle = decision === 'provided' ? this.vault.active(name, agent.id)?.handle : null;
    this.persistTool(run, call, handle ? `Handle ${handle} is now available. Do not print it.` : 'The owner did not provide that secret.', decision === 'provided' ? 'completed' : 'skipped');
    return true;
  }

  private persistTool(run: RunRow, call: ToolCall, output: string, status: string, writeStep = true) {
    const safe = this.vault.redact(output);
    this.store.insertMessage({
      sessionId: run.sessionId, role: 'tool', content: safe, toolCallId: call.id, toolName: call.name, toolCalls: null,
      agentId: senderFor(this.store, run.agentId, call), runId: run.id, imageUrl: null, routingNote: null,
    });
    if (writeStep && status !== 'completed') {
      this.store.addStep({
        runId: run.id, kind: 'tool', name: call.name, status, input: parseArgs(call.arguments), output, toolCallId: call.id,
        turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: status === 'failed' ? output : null, startedAt: now(),
      });
    }
  }

  private bumpTools(runId: string, completed: Set<string>) {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.store.updateRun(runId, { cursor: { ...run.cursor, completedToolIds: [...completed] } });
    this.checkpoint(runId, { ...run.cursor, completedToolIds: [...completed] }, 'Tool checkpoint');
  }

  private checkpoint(runId: string, cursor: RunCursor, note: string) {
    const run = this.store.getRun(runId);
    const messages = run ? this.store.listMessages(run.sessionId) : [];
    this.store.addCheckpoint(runId, cursor, note, messages.at(-1)?.id ?? null);
  }

  private touch(runId: string) {
    this.store.updateRun(runId, { leaseOwner: this.instanceId, heartbeatAt: now() });
  }

  private rememberLarge(runId: string, modelId: string) {
    const model = this.store.getModel(modelId);
    if (model?.local && model.sizeClass === 'large') this.heldLarge.set(runId, model.name);
  }

  private async waitForLarge(runId: string, name: string) {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const other = [...this.heldLarge.entries()].find(([id, held]) => id !== runId && held !== name);
      if (!other) return;
      this.bus.publish({ type: 'status', runId, status: 'waiting', detail: `Waiting for ${other[1]}` });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async loadLarge(runId: string, model: ModelRow) {
    this.bus.publish({ type: 'status', runId, status: 'loading', detail: `Loading ${model.name}` });
    const step = this.store.addStep({
      runId, kind: 'loading', name: model.name, status: 'running', input: { keepAlive: '30m' }, output: null,
      toolCallId: null, turn: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
    });
    this.bus.publish({ type: 'step', runId, step });
    const others = [...new Set([
      ...this.residentLarge.filter((name) => name !== model.name && name !== model.apiName),
      ...[...this.heldLarge.entries()].filter(([id]) => id !== runId).map(([, name]) => name),
    ])];
    if (others.length) await this.unload(others);
    this.residentLarge = [model.name];
    this.rememberLarge(runId, model.id);
    this.store.updateStep(step.id, { status: 'completed', output: `Loading ${model.name}`, endedAt: now() });
    this.bus.publish({ type: 'step', runId, step: this.store.getStep(step.id) });
    this.bus.publish({ type: 'status', runId, status: 'running' });
  }

  private async unload(names: string[]) {
    const base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    for (const name of names) {
      try {
        await this.fetchImpl(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }) });
      } catch { /* the trace still records the attempt */ }
    }
  }

  private reserveGemini(model: ModelRow, tokens: number): boolean {
    const provider = this.store.getProvider(model.providerId);
    if (provider?.kind !== 'gemini') return true;
    const settings = this.store.getSettings();
    const configured = settings.quotaLimits[model.apiName];
    if (settings.geminiTier === 'paid' && !configured) {
      this.bumpQuota(model, tokens);
      return true;
    }
    const row = freeTierByApiName(model.apiName);
    const rpm = configured?.rpm ?? row?.rpm.limit ?? 5;
    const rpd = configured?.rpd ?? row?.rpd.limit ?? 20;
    const minute = new Date().toISOString().slice(0, 16);
    const used = this.store.quotaUse(model.apiName, quotaDay());
    const rpmUsed = used.rpmWindow === minute ? used.rpm : 0;
    if ((rpm != null && rpmUsed >= rpm) || (rpd != null && used.rpd >= rpd)) return false;
    this.bumpQuota(model, tokens);
    return true;
  }

  private bumpQuota(model: ModelRow, tokens: number) {
    if (!model.apiName.startsWith('gemini')) return;
    const minute = new Date().toISOString().slice(0, 16);
    this.store.bumpQuota(model.apiName, quotaDay(), minute, tokens);
  }

  private assertWithinLimits(agentId: string) {
    const limits = this.limitsFor(agentId);
    const usage = this.usageToday(agentId);
    if (limits.maxTokensPerDay != null && usage.tokens >= limits.maxTokensPerDay) {
      throw new Error(`Daily token limit reached (${limits.maxTokensPerDay}).`);
    }
    if (limits.maxSpendUsd != null && usage.spend >= limits.maxSpendUsd) {
      throw new Error(`Daily spend limit reached ($${limits.maxSpendUsd}).`);
    }
  }

  private limitsFor(agentId: string) {
    const settings = this.store.getSettings();
    const specific = settings.agentLimits[agentId] ?? {};
    return {
      readOnly: Boolean(specific.readOnly),
      maxTokensPerDay: specific.maxTokensPerDay ?? settings.dailyTokenLimit,
      maxSpendUsd: specific.maxSpendUsd ?? settings.dailySpendLimitUsd,
      maxRunMs: specific.maxRunMs ?? null,
    };
  }

  private runLimitMs(agentId: string) {
    return this.limitsFor(agentId).maxRunMs;
  }

  private usageToday(agentId: string) {
    const day = new Date().toISOString().slice(0, 10);
    const runs = this.store.listRuns(300).filter((run) => run.agentId === agentId && run.startedAt.startsWith(day));
    return {
      tokens: runs.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0),
      spend: runs.reduce((sum, run) => sum + run.costUsd, 0),
    };
  }

  private localFailureCount(agentId: string) {
    return this.store.listRuns(40).filter((run) => {
      if (run.agentId !== agentId || run.status !== 'failed') return false;
      const model = run.modelId ? this.store.getModel(run.modelId) : null;
      return !model || model.local;
    }).length;
  }

  private waitIfPaused(runId: string, signal: AbortSignal) {
    const state = this.inflight.get(runId);
    if (!state?.paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new StopError()); };
      signal.addEventListener('abort', onAbort);
      state.resumePause = () => { signal.removeEventListener('abort', onAbort); resolve(); };
    });
  }

  private waitSecret(id: string, runId: string, signal: AbortSignal) {
    return new Promise<'provided' | 'denied'>((resolve, reject) => {
      const beat = setInterval(() => this.touch(runId), 4000);
      const onAbort = () => { clearInterval(beat); this.secretWaiters.delete(id); reject(new StopError()); };
      signal.addEventListener('abort', onAbort);
      this.secretWaiters.set(id, (status) => {
        clearInterval(beat);
        signal.removeEventListener('abort', onAbort);
        this.secretWaiters.delete(id);
        resolve(status);
      });
    });
  }

  private waitApproval(id: string, runId: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const beat = setInterval(() => this.touch(runId), 4000);
      const finish = () => { clearInterval(beat); signal.removeEventListener('abort', onAbort); this.approvalWaiters.delete(id); resolve(); };
      const onAbort = () => { clearInterval(beat); this.approvalWaiters.delete(id); reject(new StopError()); };
      signal.addEventListener('abort', onAbort);
      this.approvalWaiters.set(id, finish);
    });
  }
}

function senderFor(store: Store, fallback: string, call: ToolCall) {
  if (call.name !== 'consult_agent') return fallback;
  const other = store.getAgentByName(String(parseArgs(call.arguments).agent || ''));
  return other?.id || fallback;
}

function stageFor(store: Store, run: RunRow): 'plan' | 'implement' | undefined {
  if ((run.cursor.depth ?? 0) > 0) return undefined;
  if (run.cursor.stage === 'implement') return 'implement';
  const session = store.getSession(run.sessionId);
  const text = [...store.listMessages(run.sessionId)].reverse().find((message) => message.role === 'user')?.content ?? '';
  const match = matchRepos(text, listSharedRepos(store));
  const relevant = Boolean(session?.workshopId) || match.wantsChange;
  if (!relevant) return undefined;
  if (isSmallEdit(text)) return 'implement';
  return 'plan';
}

/** Pulls inline <think> blocks out of an answer. Reasoning is kept apart and never shown as the answer. */
export function splitThinking(text: string): { answer: string; reasoning: string } {
  const parts: string[] = [];
  let answer = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_all, inner: string) => { parts.push(inner.trim()); return ''; });
  const open = answer.match(/<think>([\s\S]*)$/i);
  if (open) {
    parts.push(open[1]!.trim());
    answer = answer.slice(0, open.index);
  }
  return { answer: parts.length ? answer.trim() : answer, reasoning: parts.filter(Boolean).join('\n') };
}

function recentRole(messages: { id: string; role: string }[], id: string) {
  return messages.find((message) => message.id === id)?.role;
}

function isProviderOutage(message: string): boolean {
  return /\(429\)|\(5\d\d\)|status 429|status 5\d\d|rate limit|too many requests/i.test(message);
}

function strategyFor(agent: Agent, model: ModelRow, autoRole?: string) {
  if (autoRole === 'fast') return 'pinned' as const;
  if (agent.strategy) return agent.strategy;
  return contractForAgent(agent.name)?.strategy || model.strategy;
}

function gitIdentity(settings: Settings): GitIdentity {
  return { name: settings.gitName, email: settings.gitEmail, sshKey: settings.gitSshKey || undefined };
}

async function prepareRepos(store: Store, run: RunRow, stage: 'plan' | 'implement' | undefined) {
  const session = store.getSession(run.sessionId);
  const text = [...store.listMessages(run.sessionId)].reverse().find((message) => message.role === 'user')?.content ?? session?.title ?? 'task';
  const all = listSharedRepos(store);
  const workshop = session?.workshopId ? getWorkshop(store, session.workshopId) : null;
  const labels = new Set((workshop?.projects ?? matchRepos(text, all).projects).map((project) => project.label));
  const repos = all.filter((repo) => labels.has(repo.label));
  let lockedOut = '';
  const notes: string[] = [];
  let branched = run.cursor.branched ?? false;
  if (stage && !run.cursor.syncNote) {
    for (const repo of repos) {
      const lock = tryLockRepo(store, repo.label, run.id, run.agentId);
      if (!lock.ok) {
        lockedOut = `${repo.label} is being edited by ${lock.holder}. You can still read it.`;
        continue;
      }
      notes.push(await refreshRepo(repo.path));
      notes.push(await changesSince(store, repo, run.agentId));
      if (stage === 'implement') notes.push(await ensureTaskBranch(repo.path, taskBranchName(text), gitIdentity(store.getSettings())));
    }
    if (stage === 'implement') branched = true;
  }
  return {
    stage: lockedOut && stage === 'implement' ? undefined : stage,
    syncNote: run.cursor.syncNote || notes.filter(Boolean).join('\n'),
    branched,
    lockedOut,
    labels: repos.map((repo) => repo.label).join(' and '),
  };
}

function turnRoots(store: Store, run: RunRow) {
  const session = store.getSession(run.sessionId);
  const write = run.cursor.stage === 'implement' || (session?.mode === 'code' && run.cursor.stage !== 'plan');
  const roots = new Map<string, { label: string; path: string; write: boolean }>();
  for (const repo of listSharedRepos(store)) roots.set(repo.path, { label: repo.label, path: repo.path, write });
  if (session?.workshopId) {
    for (const project of getWorkshop(store, session.workshopId)?.projects ?? []) {
      roots.set(project.path, { label: project.label, path: project.path, write });
    }
  }
  return [...roots.values()];
}

function skillScriptTool(): Tool {
  return {
    name: 'run_skill_script',
    description: 'Run a script from a skill folder. A script that exceeds the time limit is killed, and the turn continues.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['path'] },
    mutates: () => true,
    approval: () => null,
    async execute(args) {
      const file = String(args.path || '');
      const result = await runSkillScript(file, Number(args.timeoutMs || 8000));
      if (result.timedOut) throw new Error(`Skill script timed out and was killed. ${result.output}`.trim());
      if (!result.ok) throw new Error(result.output || 'Skill script failed.');
      return result.output || 'Script finished.';
    },
  };
}

function readOutputTool(): Tool {
  return {
    name: 'read_output',
    description: 'Read a stored message or tool result by id. offset and limit are character positions into the saved text.',
    parameters: { type: 'object', properties: { message: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['message'] },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const message = ctx.store.getMessage(String(args.message || ''));
      if (!message || (ctx.sessionId && message.sessionId !== ctx.sessionId)) throw new Error('That output is not in this chat.');
      const offset = Math.max(0, Number(args.offset || 0));
      const limit = Math.min(8000, Math.max(200, Number(args.limit || 4000)));
      const slice = [...message.content].slice(offset, offset + limit).join('');
      const more = offset + limit < [...message.content].length ? `\n…more from offset ${offset + limit}` : '';
      return slice + more;
    },
  };
}

function requestSecretTool(): Tool {
  return {
    name: 'request_secret',
    description: 'Ask the owner for a credential. You receive a handle such as secret:NAME, never the value. The value is injected as an environment variable only when a tool runs.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' }, scope: { type: 'string' } }, required: ['name', 'reason'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args) {
      return `Requested ${args.name}. Wait for the handle. Do not invent a value.`;
    },
  };
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function memAvailableGiB() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/MemAvailable:\s+(\d+)/);
    if (match) return Number(match[1]) / 1024 / 1024;
  } catch { /* not linux */ }
  return 16;
}

function quotaDay(date = new Date()) {
  return geminiQuotaDay(date);
}
