import fs from 'node:fs';
import {
  decideRoute,
  estimateTokens,
  foldCandidates,
  freeTierByApiName,
  planContext,
  quotaAvailability,
  type ChatMessage,
  type RouteCandidate,
  type RunCursor,
  type ToolCall,
} from '@local-agent/shared';
import { Bus } from './bus.js';
import type { Agent, ModelRow, RunRow, Store } from './db.js';
import type { DockerCtl } from './docker.js';
import { indexText, retrieve, type VectorIndex } from './embeddings.js';
import { countGeminiTokens, providerFor, type ModelProvider } from './providers.js';
import type { Settings } from './settings.js';
import { CODING_TOOLS } from './coding.js';
import { toolsFor, type Tool, type ToolContext } from './tools.js';
import { CrashError, InterruptedToolError, StopError, clampText, now } from './util.js';
import type { Vault } from './vault.js';

export class Engine {
  private readonly inflight = new Map<string, { abort: AbortController; paused: boolean; resumePause: () => void }>();
  private readonly approvalWaiters = new Map<string, (status: 'approved' | 'denied') => void>();
  private readonly secretWaiters = new Map<string, (status: 'provided' | 'denied') => void>();
  private readonly heldLarge = new Map<string, string>();
  residentLarge: string[] = [];
  extraTools: Tool[] = [];

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
    if (input.content) {
      const message = this.store.insertMessage({
        sessionId: session.id, role: 'user', content: input.content, toolCallId: null, toolName: null, toolCalls: null,
        agentId: agent.id, runId: null, imageUrl: input.imageUrl ?? null, routingNote: null,
      });
      if (session.title === 'New chat') {
        this.store.updateSession(session.id, { title: input.content.slice(0, 72) });
      }
      void message;
    }
    const cursor: RunCursor = { phase: 'route', turn: 0, messageModelId: input.modelId, depth: input.depth ?? 0, configVersion: this.store.getSettings().version, agentUpdatedAt: agent.updatedAt };
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
      this.heldLarge.delete(runId);
      this.inflight.delete(runId);
      this.bus.publish({ type: 'done', runId, run: this.store.getRun(runId) });
    }
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
    const agent = this.store.getAgent(run.agentId);
    if (!agent) throw new Error('Persona disappeared.');
    const decision = this.choose(agent, run);
    const cursor: RunCursor = {
      ...run.cursor,
      phase: 'context',
      modelId: decision.modelId,
      routingReason: decision.reason,
      switched: decision.switched,
      agentUpdatedAt: agent.updatedAt,
      configVersion: this.store.getSettings().version,
      weightNote: decision.unload.length ? `Unload ${decision.unload.join(', ')} before loading ${decision.modelName}.` : undefined,
    };
    this.store.updateRun(run.id, { cursor, modelId: decision.modelId, routingNote: decision.reason, switched: decision.switched, configVersion: cursor.configVersion });
    this.store.addStep({
      runId: run.id, kind: 'routing', name: decision.modelName, status: 'completed', input: { kind: decision.kind, signals: decision.signals },
      output: { reason: decision.reason, switched: decision.switched, trace: decision.trace, unload: decision.unload },
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
    const maxSteps = sessionMode === 'code' ? Math.max(settings.maxSteps, 24) : settings.maxSteps;
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
      current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: decision.modelId, routingReason: decision.reason, switched: decision.switched }, modelId: decision.modelId, routingNote: decision.reason, switched: decision.switched })!;
      if (decision.unload.length) await this.unload(decision.unload);
    }
    let model = this.store.getModel(current.cursor.modelId!);
    if (!model) throw new Error('Selected model is gone.');
    let built = await this.buildMessages(current, agent, model);
    if (!this.reserveGemini(model, built.plan.estimatedTokens)) {
      const fallback = this.candidates(settings).find((item) => item.local && item.providerKind !== 'rehearsal');
      if (!fallback) throw new Error('Gemini quota is exhausted and no local model is available.');
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
    const tools = this.tools(agent, this.store.getSession(run.sessionId)?.mode).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    const step = this.store.addStep({
      runId: run.id, kind: 'model', name: model.name, status: 'running', input: { turn: current.cursor.turn, budget: built.plan.budgetTokens, estimated: built.plan.estimatedTokens, notes: built.plan.notes },
      output: null, toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
    });
    this.bus.publish({ type: 'step', runId: run.id, step });
    const started = Date.now();
    let text = '';
    let toolCalls: ToolCall[] | undefined;
    let usage = { inputTokens: built.plan.estimatedTokens, outputTokens: 0 };
    try {
      for await (const event of provider.complete({ model: model.apiName, messages: built.messages, tools, signal, paceMs: model.profileId === 'rehearsal' && process.env.NODE_ENV !== 'test' ? 10 : 0 })) {
        if (signal.aborted) throw new StopError();
        if (event.type === 'token') {
          text += event.text;
          this.bus.publish({ type: 'token', runId: run.id, text: event.text });
        } else {
          toolCalls = event.toolCalls;
          if (event.usage) usage = event.usage;
        }
      }
    } catch (error) {
      if (error instanceof StopError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
      throw error;
    }
    const cost = ((usage.inputTokens * (model.priceIn ?? 0)) + (usage.outputTokens * (model.priceOut ?? 0))) / 1_000_000;
    const note = current.cursor.switched ? current.cursor.routingReason ?? null : null;
    text = this.vault.redact(text);
    const assistant = this.store.insertMessage({
      sessionId: run.sessionId, role: 'assistant', content: text, toolCalls: toolCalls?.length ? toolCalls : null,
      agentId: agent.id, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: note,
    });
    const cursor: RunCursor = toolCalls?.length
      ? { ...current.cursor, phase: 'tools', toolCalls, completedToolIds: [], approvalId: undefined }
      : { ...current.cursor, phase: 'summarize', toolCalls: undefined };
    this.store.updateStep(step.id, { status: 'completed', output: { text, toolCalls }, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: cost, latencyMs: Date.now() - started, endedAt: now() });
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
    for (const call of calls) {
      if (completed.has(call.id)) continue;
      await this.waitIfPaused(run.id, signal);
      if (signal.aborted) throw new StopError();
      const tools = this.tools(this.store.getAgent(run.agentId)!, this.store.getSession(run.sessionId)?.mode);
      const tool = tools.find((item) => item.name === call.name);
      const args = parseArgs(call.arguments);
      const existing = this.store.findToolStep(run.id, call.id);
      if (existing?.status === 'completed') {
        completed.add(call.id);
        continue;
      }
      if (existing?.status === 'running' && tool?.mutates(args)) {
        throw new InterruptedToolError(`Tool ${call.name} was interrupted after it started. It was not repeated. Retry that step explicitly if the side effect should happen again.`);
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
        const output = this.vault.redact(clampText(await tool.execute(args, this.contextFor(run, signal)), 16_000));
        this.store.updateStep(step.id, { status: 'completed', output, latencyMs: Date.now() - started, endedAt: now() });
        this.persistTool(run, call, output, 'completed', false);
        this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
      } catch (error) {
        if (error instanceof CrashError || error instanceof StopError || error instanceof InterruptedToolError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        this.persistTool(run, call, `Error: ${message}`, 'failed', false);
      }
      completed.add(call.id);
      this.bumpTools(run.id, completed);
    }
    const latest = this.store.getRun(run.id)!;
    const next: RunCursor = { ...latest.cursor, phase: latest.cursor.turn + 1 >= this.store.getSettings().maxSteps ? 'summarize' : 'model', turn: latest.cursor.turn + 1, toolCalls: undefined, completedToolIds: [], approvalId: undefined };
    this.store.updateRun(run.id, { cursor: next, status: 'running' });
    this.checkpoint(run.id, next, 'Tools finished');
  }

  private async stepSummarize(run: RunRow) {
    const agent = this.store.getAgent(run.agentId);
    const model = run.modelId ? this.store.getModel(run.modelId) : null;
    if (agent && model) await this.maybeFold(run.sessionId, agent, model).catch(() => undefined);
    const cursor = { ...this.store.getRun(run.id)!.cursor, phase: 'done' as const };
    this.store.updateRun(run.id, { cursor, status: 'completed', endedAt: now() });
    this.checkpoint(run.id, cursor, 'Finished');
  }

  private choose(agent: Agent, run: RunRow) {
    const settings = this.store.getSettings();
    const session = this.store.getSession(run.sessionId);
    const messages = this.store.listMessages(run.sessionId);
    const user = [...messages].reverse().find((message) => message.role === 'user');
    const decision = decideRoute({
      text: user?.content ?? '',
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
    });
    if (session && session.activeModelId !== decision.modelId) this.store.updateSession(session.id, { activeModelId: decision.modelId });
    return decision;
  }

  private candidates(settings: Settings): RouteCandidate[] {
    const providers = new Map(this.store.listProviders().map((provider) => [provider.id, provider]));
    const minute = new Date().toISOString().slice(0, 16);
    const day = quotaDay();
    return this.store.listModels().filter((model) => model.enabled && !model.embedding).flatMap((model) => {
      const provider = providers.get(model.providerId);
      if (!provider?.enabled) return [];
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
    const strategy = agent.strategy || model.strategy;
    const notes = agent.memoryEnabled ? this.store.listNotes(agent.id) : [];
    const summaries = this.store.listSummaries(run.sessionId).map((summary) => ({
      id: summary.id, level: summary.level, content: summary.content, covers: summary.covers, foldedInto: summary.foldedInto,
    }));
    const messages = this.store.listMessages(run.sessionId);
    const user = [...messages].reverse().find((message) => message.role === 'user');
    const retrieved = strategy === 'retrieval' ? retrieve(this.store, this.vectors, run.sessionId, user?.content ?? '', 4) : [];
    let budget = Math.min(model.contextWindow, model.practicalBudget);
    const preambleGuess = `${agent.systemPrompt}\n${notes.map((note) => note.content).join('\n')}`;
    if (model.providerId === 'prov_gemini' && estimateTokens(preambleGuess, 'gemini') > budget * 0.75) {
      const key = process.env.GEMINI_API_KEY;
      if (key) {
        const counted = await countGeminiTokens(key, model.apiName, preambleGuess, this.fetchImpl);
        if (counted && counted > budget) budget = Math.min(model.contextWindow, counted + settings.outputReserveTokens);
      }
    }
    const plan = planContext({
      strategy, contextWindow: model.contextWindow, practicalBudget: budget, outputReserve: settings.outputReserveTokens,
      system: agent.systemPrompt, pinned: notes.filter((note) => note.pinned).map((note) => note.content),
      summaries, retrieved, tokenizer: model.tokenizer as 'gemma4',
      messages: messages.map((message) => ({ id: message.id, role: message.role as 'user', content: message.content })),
    });
    const recent = new Map(messages.map((message) => [message.id, message]));
    const chat: ChatMessage[] = [{ role: 'system', content: plan.preamble }];
    for (const item of plan.recent) {
      const message = recent.get(item.id);
      if (!message) continue;
      chat.push({
        role: message.role as ChatMessage['role'], content: item.content, toolCallId: message.toolCallId ?? undefined,
        name: message.toolName ?? undefined, toolCalls: (message.toolCalls as ToolCall[] | null) ?? undefined, imageUrl: message.imageUrl ?? undefined,
      });
    }
    return { plan, messages: chat };
  }

  private async maybeFold(sessionId: string, agent: Agent, model: ModelRow) {
    const settings = this.store.getSettings();
    const messages = this.store.listMessages(sessionId);
    const summaries = this.store.listSummaries(sessionId);
    const covered = new Set(summaries.flatMap((summary) => summary.covers));
    const ids = foldCandidates(messages.map((message) => ({ id: message.id, role: message.role as 'user', content: message.content })), covered, model.tokenizer as 'approx', settings.summaryTriggerTokens);
    if (!ids) return;
    const slice = messages.filter((message) => ids.includes(message.id));
    const transcript = slice.map((message) => `${message.role}: ${message.content}`).join('\n').slice(0, 12_000);
    const summary = await this.completeText(model, `Summarize this conversation segment in under 180 words. Keep names, decisions, numbers, and open questions.\n\n${transcript}`);
    const version = Math.max(0, ...summaries.map((item) => item.version)) + 1;
    const hierarchical = (agent.strategy || model.strategy) === 'hierarchical';
    const created = this.store.addSummary({ sessionId, level: hierarchical ? 1 : 2, version, content: summary, covers: ids, foldedInto: null, tokenEstimate: estimateTokens(summary, model.tokenizer as 'approx') });
    if (hierarchical) {
      const open = this.store.listSummaries(sessionId).filter((item) => item.level === 1 && !item.foldedInto);
      if (open.length >= 4) {
        const root = await this.completeText(model, `Combine these chunk summaries into one root summary under 220 words.\n\n${open.map((item) => item.content).join('\n\n')}`);
        const rootRow = this.store.addSummary({ sessionId, level: 2, version: version + 1, content: root, covers: open.flatMap((item) => item.covers), foldedInto: null, tokenEstimate: estimateTokens(root, 'approx') });
        this.store.markSummariesFolded(open.map((item) => item.id), rootRow.id);
      }
    }
    indexText(this.store, this.vectors, { sessionId, agentId: agent.id, text: slice.map((message) => message.content).join('\n').slice(0, 4000) });
    void created;
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

  private tools(agent: Agent, sessionMode?: string) {
    const names = new Set(agent.toolAllowlist);
    names.add('request_secret');
    if (sessionMode === 'code') for (const tool of CODING_TOOLS) names.add(tool.name);
    const catalog = [...toolsFor([...names]), ...CODING_TOOLS, requestSecretTool(), ...this.extraTools];
    const seen = new Set<string>();
    return catalog.filter((tool) => {
      if (!names.has(tool.name) || seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    });
  }

  private contextFor(run: RunRow, signal: AbortSignal): ToolContext {
    const agent = this.store.getAgent(run.agentId)!;
    const settings = this.store.getSettings();
    return {
      agent, workspace: agent.workspacePath, signal, docker: this.docker, fetchImpl: this.fetchImpl, searxngUrl: settings.searxngUrl || process.env.SEARXNG_URL || '',
      sandbox: settings.sandbox, store: this.store, depth: run.cursor.depth ?? 0,
      sessionId: run.sessionId, runId: run.id, codeApproval: settings.codeApproval,
      secretEnv: () => this.vault.envFor(agent.id, `run:${run.id}`),
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
      agentId: run.agentId, runId: run.id, imageUrl: null, routingNote: null,
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
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}
