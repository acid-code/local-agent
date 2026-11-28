import { keepAliveFor } from './pinned.js';
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
  roleContextBudget,
  shrinkBudget,
  quotaAvailability,
  readChatCommand,
  summaryTriggerFor,
  type AutoCandidate,
  type ChatMessage,
  type ContextBreakdown,
  type RouteCandidate,
  type RouteDecision,
  type RunCursor,
  type ToolCall,
  type WorkPhase,
  isHebrewText,
  riskOf,
  needsApproval,
  type ApprovalMode,
} from '@local-agent/shared';
import { Bus } from './bus.js';
import { vercelTools } from './vercel.js';
import type { Agent, Message, ModelRow, ProviderRow, RunRow, Store } from './db.js';
import { dispatchPersonaMessage } from './persona-messaging.js';
import type { DockerCtl } from './docker.js';
import { indexText, retrieve, type VectorIndex } from './embeddings.js';
import { computePrefillSnapshot, countGeminiTokens, maxTokensFor, ollamaNumCtx, providerFor, samplingFor, type ModelProvider, type PrefillSnapshot } from './providers.js';
import type { Settings } from './settings.js';
import { CODING_TOOLS, readPlan, replacePlan } from './coding.js';
import { formatCitations, searchKnowledge } from './kb.js';
import { kbSearchTool, loadSkillTool, setFocusTool, toolsFor, type Tool, type ToolContext } from './tools.js';
import { COMPACT_CODING_TOOLS, CORE_TOOLS, LEAN_MIN_TOOLS, SEED_TOOLS, STABLE_FULL_MENU_MAX, findToolsTool, leanMenuEnabled, rankTools } from './toolsearch.js';
import { FENCED_EDIT_HINT, extractFencedEdits } from './fenced-edits.js';
import { listSkills, runSkillScript, skillCatalog } from './skills.js';
import { getWorkshop, workshopBrief } from './workshops.js';
import { chatWorkspaceBrief, chatWorkspacePaths, getChatWorkspaces, setChatWorkspaces } from './chat-workspaces.js';
import { checkOrRepair, contractForAgent, mergeToolParameters, normalizeToolArgs, pickAutoRole, toolArgumentsSchema } from './contracts.js';
import { addProjectNote, changesSince, ensureTaskBranch, isSmallEdit, listSharedRepos, matchRepos, refreshRepo, releaseRepoLocks, repoSyncTool, sharedRepoBrief, taskBranchName, tryLockRepo, type GitIdentity } from './repos.js';
import { isMissingModelError, isToolUnsupportedError, ollamaCapabilities, ollamaRoot } from './ollama.js';
import { scanMachine } from './discovery.js';
import { CrashError, InterruptedToolError, StopError, clampText, now } from './util.js';
import type { Vault } from './vault.js';
import { cleanupHebrew } from './hebrew-cleanup.js';
import { LONG_TASK_STEPS, MAX_TASK_ROUNDS, TASKS_HINT, completeFinalReplyTask, enterPlanModeTool, exitPlanModeTool, openTasks, tasksNote, tasksTool } from './tasks.js';
import { HONESTY_RULE, checkFinalReply, recoveryHint } from './recovery.js';
import { ocrTool, understandImageTool, type ImageAnalysisResult, type OcrMode, type OcrResult } from './ocr.js';
import { getLanguage, languageHint, replyLanguage, wantsCleanup } from './language.js';
import { CITE_HINT, findContextTool, shareFileTool } from './files.js';
import { fetchImageTool, fetchWebImage, generateImage, imageTool, localStatus } from './images.js';
import { slidesTools } from './slides.js';
import { NO_MODEL_MESSAGE } from './usable-models.js';
import { BudgetError, type Lease, type MemoryBudget } from './memory.js';
import { MEMBER_DENIED_TOOLS, OWNER_ID, foreignPath, getAccount } from './accounts.js';
import { Autonomy, HELPER_DENIED } from './autonomy.js';
import type { McpAgentTool } from './mcp.js';
import { GALLERY } from './gallery.js';
import { disabledRules } from './rules.js';
import { CONNECTOR_TOOLS, disabledConnectorTools } from './connectors.js';
import { memoryBrief, memoryFileTool, projectRules, proposeSkillTool, searchChatsTool, skillNudge } from './learning.js';
import { cleanText, fallbackTitle, hasHebrew, isNotice, needsTitle, parseTitle, titlePrompt } from './chat-titles.js';
import { LlamaWatch, LocalGpuGate, OLLAMA_SIDE_MAX_GIB, isLlamaServerProvider, isNonChatModel, isOllamaProvider, isUncensoredProvider, modelGiB } from './coexist.js';

/** A run in one of these states can still use the answer to a secret request or approval. */
const WAITING_RUN_STATUSES = new Set(['running', 'paused', 'awaiting_approval', 'awaiting_secret']);
/** Unanswered secret requests are denied after a day, so the run carries on and the notice clears. */
export const SECRET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'loading', 'waiting', 'paused', 'awaiting_approval', 'awaiting_secret']);
/** Tools mechanically blocked while a run is locked in read-only plan mode. */
const PLAN_READONLY_BLOCKED = new Set(['apply_patch', 'write_file', 'create_file', 'docker_run', 'docker_rm', 'create_project', 'vercel', 'handoff_cli']);

export class Engine {
  private readonly inflight = new Map<string, { abort: AbortController; paused: boolean; resumePause: () => void }>();
  private readonly liveStreams = new Map<string, { text: string; thinking: string; status: string; detail?: string; waitInfo?: unknown; focus?: string; phase?: WorkPhase; startedAt?: string; prefill?: PrefillSnapshot | null }>();
  private readonly livePrefills = new Map<'main' | 'uncensored', { runId: string; snapshot: PrefillSnapshot; updatedAt: number }>();
  private readonly lastContext = new Map<string, { modelId: string; breakdown: ContextBreakdown }>();
  private readonly compacting = new Set<string>();
  private readonly approvalWaiters = new Map<string, (status: 'approved' | 'denied') => void>();
  private readonly secretWaiters = new Map<string, (status: 'provided' | 'denied') => void>();
  private readonly heldLarge = new Map<string, string>();
  private readonly dwell = new Map<string, { modelId: string; previousId: string | null; until: number; explicit: boolean }>();
  residentLarge: string[] = [];
  /** runId → which big GPU slot that run holds (llama-server or heavy Ollama). */
  private readonly llamaLeases = new Map<string, 'qwen' | 'uncensored' | 'ollama-large'>();
  private readonly gpuGate = new LocalGpuGate();
  extraTools: Tool[] = [];
  /** Set by the routes once OCR is wired: reads an image file for the read_image_text tool. */
  ocrReader: ((fileId: string, mode: OcrMode, ownerId: string) => Promise<OcrResult>) | null = null;
  /** Set by the routes once OCR/Vision is wired: full scene/color/chart/text understanding for understand_image. */
  imageAnalyzer: ((fileId: string, question: string | undefined, ownerId: string) => Promise<ImageAnalysisResult>) | null = null;
  /** Tools from installed MCP servers (owner personas only). */
  mcpTools: () => McpAgentTool[] = () => [];
  libraryDir = '';
  /** Shared RAM budget. Set by buildApp; absent in some unit tests. */
  memory: MemoryBudget | null = null;
  /** Shared long-lived shell workbench container. Set by buildApp. */
  workbench: import('./workbench.js').Workbench | null = null;
  /** Managed real browser container (la-browser). Set by buildApp. */
  browser: import('./browser.js').ManagedBrowser | null = null;
  /** Isolated opt-in VPN sidecar (la-vpn). Set by buildApp. */
  vpn: import('./vpn.js').VpnManager | null = null;
  /** Live Computer view + take-over + shell tail controller. Set by buildApp. */
  computer: import('./live-computer.js').ComputerControl | null = null;

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly docker: DockerCtl,
    private readonly vectors: VectorIndex,
    private readonly vault: Vault,
    private readonly instanceId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly providerOverride?: (model: ModelRow) => ModelProvider,
  ) {
    this.autonomy = new Autonomy(store, bus, vault, (input) => this.startTurn(input), (runId) => this.stop(runId), () => this.libraryDir);
    this.llama = new LlamaWatch(store, fetchImpl);
  }

  private localGpuLane(model: ModelRow, lane: 'foreground' | 'background'): 'foreground' | 'background' | null {
    if (!model.local || Boolean(this.providerOverride) || process.env.LA_GPU_SERIALIZE === '0') return null;
    return lane;
  }
  /**
   * One llama-server model owns the GPU at a time (Qwen on :8080 or the uncensored model on :8081).
   * Runs on the same server share it (llama-server queues requests itself); a run that needs the other
   * server waits in line, visibly, instead of switching the GPU out from under a running chat.
   */
  private async acquireLlamaLease(runId: string, kind: 'qwen' | 'uncensored' | 'ollama-large', signal: AbortSignal): Promise<void> {
    const mine = this.llamaLeases.get(runId);
    if (mine === kind) return;
    const others = () => [...this.llamaLeases.entries()].filter(([id, held]) => id !== runId && held !== kind);
    const queued = others().length > 0;
    if (queued) {
      const started = Date.now();
      const held = others()[0]?.[1];
      const label = held === 'ollama-large'
        ? 'a large Ollama model'
        : held === 'uncensored'
          ? 'the uncensored llama-server model'
          : 'the Qwen llama-server model';
      const detail = `Waiting for ${label} to finish in another chat (queued).`;
      const waitInfo = { kind: 'queue', behind: label.replace(/^the /, ''), ahead: others().length, since: new Date(started).toISOString() };
      const live = this.liveStreams.get(runId) ?? { text: '', thinking: '', status: 'waiting' };
      live.status = 'waiting';
      live.detail = detail;
      live.waitInfo = waitInfo;
      this.liveStreams.set(runId, live);
      this.bus.publish({ type: 'status', runId, status: 'waiting', detail, waitInfo } as never);
      while (others().length) {
        if (signal.aborted) throw new StopError();
        if (Date.now() - started > llamaWaitMs()) {
          throw new Error(`Gave up after ${Math.max(1, Math.round(llamaWaitMs() / 60_000))} min waiting for ${label} to finish in another chat. Your chat is kept; send again when the other chat is done, press Stop there, or pick another model for this chat.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    this.llamaLeases.set(runId, kind);
    const live = this.liveStreams.get(runId);
    if (live) { live.status = 'running'; live.detail = undefined; live.waitInfo = undefined; }
    if (queued) this.bus.publish({ type: 'status', runId, status: 'running', detail: undefined, focus: live?.focus, phase: live?.phase, startedAt: live?.startedAt } as never);
  }

  private publishFocus(runId: string, focus?: string, phase?: WorkPhase) {
    const cleanFocus = focus?.trim();
    const run = this.store.getRun(runId);
    const prev = this.liveStreams.get(runId) ?? {
      text: '', thinking: '', status: run?.status || 'running',
      startedAt: run?.startedAt || now(),
    };
    const next = {
      ...prev,
      focus: cleanFocus || prev.focus,
      phase: phase || prev.phase,
      startedAt: prev.startedAt || run?.startedAt || now(),
    };
    this.liveStreams.set(runId, next);
    if (run) {
      this.store.updateRun(runId, {
        cursor: { ...run.cursor, ...(next.focus ? { focus: next.focus } : {}), ...(next.phase ? { workPhase: next.phase } : {}) },
      });
    }
    this.bus.publish({
      type: 'status', runId, status: next.status, detail: next.detail, waitInfo: next.waitInfo,
      focus: next.focus, phase: next.phase, startedAt: next.startedAt,
    } as never);
  }
  /** llama-server ↔ Ollama GPU coexistence (see coexist.ts). */
  readonly llama: LlamaWatch;
  /** Timers/triggers an agent manages itself, and background helpers. */
  readonly autonomy: Autonomy;

  async startTurn(input: { sessionId: string; agentId: string; content?: string; imageUrl?: string; modelId?: string; parentRunId?: string | null; depth?: number; wait?: boolean; background?: boolean; planFirst?: boolean; cursorExtras?: Partial<RunCursor>; onDone?: (run: RunRow) => void }) {
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
    // /auto drops both the pin and the sticky chat model, so the next turn is routed fresh.
    if (command?.unpin) this.store.updateSession(session.id, { modelPin: null, activeModelId: null });
    if (command?.pinName) {
      const localOnly = this.localOnly(input.agentId);
      const match = this.store.listModels().find((model) => model.enabled && (!localOnly || model.local) && (model.apiName === command.pinName || model.name === command.pinName || model.apiName.startsWith(command.pinName!) || model.name.startsWith(command.pinName!)));
      if (match) {
        this.store.updateSession(session.id, { modelPin: match.id });
        if (!command.rest) commandAck = `Pinned to ${match.name}.`;
      } else if (!command.rest) commandAck = `No model named ${command.pinName}.`;
      else pinMiss = command.pinName;
    }
    if (command?.unpin && !command.rest) commandAck = 'Back on Auto.';
    const imageCommand = input.content ? /^\/(?:image|img|draw)\s+([\s\S]+)/i.exec(input.content.trim()) : null;
    if (command?.smart && !command.rest && !command.pinName) commandAck = 'Add the question after /smart. The next ordinary message goes back to the main model.';
    if (command?.plan && !command.rest && !command.pinName && !commandAck) commandAck = 'Add your task after /plan (or toggle Plan first in the composer) to start in read-only Plan mode.';
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
    const startInPlan = Boolean((input.planFirst || command?.plan) && !commandAck && !input.parentRunId && !input.cursorExtras?.stage);
    const cursor: RunCursor = {
      phase: 'route',
      turn: 0,
      userMessageId,
      messageModelId: input.modelId,
      depth: input.depth ?? 0,
      configVersion: this.store.getSettings().version,
      agentUpdatedAt: agent.updatedAt,
      commandAck,
      pinMiss,
      imagePrompt: imageCommand?.[1]?.trim() || undefined,
      background: input.background || undefined,
      ...(startInPlan ? { stage: 'plan' as const, workPhase: 'planning' as const, focus: 'Investigating in plan mode', enteredPlanViaTool: true } : {}),
      ...input.cursorExtras,
    };
    const run = this.store.createRun({ sessionId: session.id, agentId: agent.id, parentRunId: input.parentRunId, configVersion: cursor.configVersion ?? 1, cursor });
    const task = this.execute(run.id);
    if (input.onDone) void task.then(() => { const done = this.store.getRun(run.id); if (done) input.onDone!(done); }, () => { const done = this.store.getRun(run.id); if (done) input.onDone!(done); });
    if (input.wait) await task;
    else void task;
    return this.store.getRun(run.id)!;
  }

  async execute(runId: string) {
    if (this.inflight.has(runId)) return;
    const abort = new AbortController();
    const state = { abort, paused: false, resumePause: () => {} };
    const runForLimit = this.store.getRun(runId);
    const baseLimit = runForLimit ? this.runLimitMs(runForLimit.agentId) : null;
    const ownLimit = runForLimit?.cursor.timeoutMs;
    const limitMs = ownLimit ? Math.min(ownLimit, baseLimit || ownLimit) : baseLimit;
    let timedOut = false;
    const limitTimer = limitMs ? setTimeout(() => { timedOut = true; abort.abort(); }, limitMs) : null;
    this.inflight.set(runId, state);
    this.touch(runId);
    const beat = setInterval(() => this.touch(runId), 5000);
    try {
      this.store.updateRun(runId, { status: 'running', error: null, endedAt: null, leaseOwner: this.instanceId });
      // sessionId lets any open page of this chat (another tab, or a timer firing here) attach to the run.
      const started = this.store.getRun(runId);
      this.bus.publish({ type: 'status', runId, status: 'running', sessionId: started?.sessionId, parentRunId: started?.parentRunId ?? null } as never);
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
      // A run that hit its time limit failed (with a reason); only a real Stop is "stopped".
      const status = error instanceof StopError && !timedOut ? 'stopped' : 'failed';
      const message = timedOut ? `Ran out of time after ${Math.round((limitMs ?? 0) / 1000)} s.` : error instanceof Error ? error.message : String(error);
      try {
        const latest = this.store.getRun(runId);
        if (latest && latest.status !== 'stopped') {
          this.store.updateRun(runId, { status, error: message, endedAt: now() });
        }
        if (latest && status === 'failed' && !latest.cursor.helperId) this.recordFailure(latest, message);
        this.bus.publish({ type: 'error', runId, message });
      } catch { /* the store closed while shutting down */ }
    } finally {
      clearInterval(beat);
      if (limitTimer) clearTimeout(limitTimer);
      this.heldLarge.delete(runId);
      this.inflight.delete(runId);
      // Sticky chat model: the model the run really ended on (after a refusal fallback, a context escalation,
      // or a stall) becomes the chat's model, so the next turn continues there instead of re-routing.
      try {
        const ended = this.store.getRun(runId);
        const endedSession = ended ? this.store.getSession(ended.sessionId) : null;
        // The uncensored fallback is for one step only: the chat keeps the model the run came from.
        const keep = ended?.cursor.uncensoredFrom && this.store.getModel(ended.cursor.uncensoredFrom) ? ended.cursor.uncensoredFrom : ended?.modelId;
        if (keep && endedSession && !ended?.cursor.helperId && endedSession.activeModelId !== keep && this.store.getModel(keep)) {
          this.store.updateSession(endedSession.id, { activeModelId: keep });
        }
      } catch { /* the store closed while shutting down */ }
      // No automatic switch back to Qwen here: the next run that needs Qwen switches lazily under its lease.
      // Switching back eagerly reloaded ~20 GB and made the next turn of the same chat reload the other model.
      this.llamaLeases.delete(runId);
      // The store can already be closed when the app shuts down mid-run.
      try {
        this.liveStreams.delete(runId);
        releaseRepoLocks(this.store, runId);
        const ended = this.store.getRun(runId);
        // Steps still marked running when their run ends did not finish: record them as stopped, not running forever.
        if (ended && !ACTIVE_RUN_STATUSES.has(ended.status)) this.store.db.prepare(`UPDATE run_steps SET status = 'stopped' WHERE run_id = ? AND status IN ('running', 'pending', 'queued')`).run(runId);
        this.bus.publish({ type: 'done', runId, run: ended });
        this.sweepStaleWaits();
        // Helper results are delivered from the run's own record, so they survive a restart (no in-memory callback needed).
        if (ended?.cursor.helperId && ['completed', 'failed', 'stopped', 'interrupted', 'cancelled'].includes(ended.status)) this.autonomy.deliver(ended);
        if (ended && ['completed', 'stopped'].includes(ended.status) && !ended.cursor.helperId && !process.env.VITEST) {
          void this.maybeAutoCompact(ended.sessionId);
        }
        // After the first exchange the side model names the chat (3-6 words, the chat's language).
        if (ended && !ended.cursor.helperId && ['completed', 'stopped', 'failed'].includes(ended.status)) this.queueTitles([ended.sessionId]);
      } catch { /* shutting down */ }
    }
  }

  /** Current in-progress streaming text/thinking/status for a live run (used when switching chats or reconnecting SSE). */
  getLiveStream(runId: string) {
    return this.liveStreams.get(runId) ?? null;
  }

  /** Force a run waiting on the RAM admission queue to proceed immediately. */
  forceRun(runId: string) {
    const forced = this.memory ? this.memory.forceAdmit(runId) : false;
    if (forced) {
      const live = this.liveStreams.get(runId);
      if (live) { live.status = 'running'; live.detail = undefined; live.waitInfo = undefined; }
      this.bus.publish({ type: 'status', runId, status: 'running' });
    }
    return { forced, run: this.store.getRun(runId) };
  }

  /** Latest context breakdown for a session, or a quick live estimate when opening an idle chat. */
  getSessionContextBreakdown(sessionId: string): ContextBreakdown | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;
    const agent = session.agentId ? this.store.getAgent(session.agentId) : null;
    const settings = this.store.getSettings();
    const model = (session.modelPin && this.store.getModel(session.modelPin))
      || (session.activeModelId && this.store.getModel(session.activeModelId))
      || (agent?.modelId && this.store.getModel(agent.modelId))
      || (this.llama.isActive() ? this.llama.model() : undefined)
      || this.store.listModels().find((m) => m.enabled && m.local && m.sizeClass === 'large' && m.providerId !== 'prov_rehearsal')
      || this.store.listModels().find((m) => m.enabled && m.local && m.providerId !== 'prov_rehearsal')
      || this.store.listModels().find((m) => m.enabled);
    const role = agent ? (contractForAgent(agent.name)?.modelRole || 'main') : 'main';
    const repoTask = session.mode === 'code' || Boolean(session.workshopId);
    const budget = model ? roleContextBudget(role, model, { repoTask }) : 0;
    const expectedUsable = model ? Math.max(0, Math.min(model.contextWindow, budget) - settings.outputReserveTokens) : 0;
    const cached = this.lastContext.get(sessionId);
    if (cached && (!model || (cached.modelId === model.id && cached.breakdown.budget === expectedUsable))) return cached.breakdown;
    if (!model) return null;
    const messages = this.store.listMessages(sessionId);
    const notes = agent?.memoryEnabled ? this.store.listNotes(agent.id) : [];
    const memoryNote = agent?.memoryEnabled ? memoryBrief(this.store, agent.id) : '';
    const summaries = this.store.listSummaries(sessionId).map((s) => ({ id: s.id, level: s.level, content: s.content, covers: s.covers, foldedInto: s.foldedInto }));
    const compact = Boolean(
      model.local
      && settings.compactCodingPrompt !== false
      && process.env.LA_COMPACT_CODING !== '0'
      && contractForAgent(agent?.name || '')?.slug !== 'researcher'
      && agent?.templateId !== 'researcher'
      && (session.mode === 'code' || contractForAgent(agent?.name || '')?.slug === 'coder' || agent?.templateId === 'coder'),
    );
    const tools = agent ? this.tools(agent, session.mode, undefined, undefined, false, undefined, false, this.cacheFriendly(model), compact) : [];
    const tok = (model.tokenizer || 'approx') as 'gemma4';
    const toolToks = tools.length ? estimateTokens(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))), tok) : 0;
    const baseSys = agent?.systemPrompt || '';
    const plan = planContext({
      strategy: agent?.strategy || model.strategy,
      contextWindow: model.contextWindow,
      practicalBudget: budget,
      outputReserve: settings.outputReserveTokens,
      system: `${baseSys}${memoryNote}`,
      pinned: notes.filter((n) => n.pinned).map((n) => n.content),
      summaries,
      retrieved: [],
      tokenizer: tok,
      messages: this.uncoveredMessages(messages, summaries).map((m) => ({ id: m.id, role: m.role as 'user', content: m.content })),
      breakdownHints: {
        systemPrompt: estimateTokens(baseSys, tok),
        personaAndTools: toolToks,
        memory: estimateTokens(memoryNote, tok),
        files: 0,
      },
    });
    return plan.breakdown;
  }

  /** Skip older messages already covered by any summary (including older summaries already folded into the root), always keeping the latest 4 messages and never dropping below floorId once fixed. */
  private uncoveredMessages<T extends { id: string }>(messages: T[], summaries: { level: number; covers: string[]; foldedInto: string | null }[], floorId?: string): T[] {
    const covered = new Set(summaries.flatMap((s) => s.covers));
    if (!covered.size || messages.length <= 4) return messages;
    const tailStart = Math.max(0, messages.length - 4);
    const floorIdx = floorId ? messages.findIndex((m) => m.id === floorId) : -1;
    const keepFrom = floorIdx >= 0 ? Math.min(tailStart, floorIdx) : tailStart;
    return messages.filter((m, idx) => idx >= keepFrom || !covered.has(m.id));
  }

  /** Pick a fast lightweight model (e.g. gemma3:4b) for compaction/handoff so it finishes in ~3-5s without evicting llama-server's KV prefix cache. */
  private fastSummaryModel(fallbackId?: string | null): ModelRow | undefined {
    const models = this.store.listModels().filter((m) => m.enabled && !m.embedding && m.providerId !== 'prov_rehearsal');
    const fastName = (this.store.getSettings().autoModels?.fast || '').trim().toLowerCase();
    if (fastName) {
      const exact = models.find((m) => m.apiName.toLowerCase() === fastName || m.name.toLowerCase() === fastName);
      if (exact) return exact;
    }
    const smallLocal = models.find((m) => m.local && m.sizeClass === 'small' && m.providerId !== 'prov_llama');
    if (smallLocal) return smallLocal;
    return (fallbackId && this.store.getModel(fallbackId))
      || (this.llama.isActive() ? this.llama.model() : undefined)
      || models[0]
      || this.store.listModels().find((m) => m.enabled);
  }

  /** Automatically compact a chat in the background on the fast model once context crosses 75%. */
  private async maybeAutoCompact(sessionId: string): Promise<void> {
    if (this.compacting.has(sessionId) || this.sessionBusy(sessionId)) return;
    const breakdown = this.getSessionContextBreakdown(sessionId);
    if (!breakdown || breakdown.budget <= 0 || breakdown.used / breakdown.budget < 0.75) return;
    const messages = this.store.listMessages(sessionId);
    const summaries = this.store.listSummaries(sessionId).map((s) => ({ id: s.id, level: s.level, content: s.content, covers: s.covers, foldedInto: s.foldedInto }));
    if (this.uncoveredMessages(messages, summaries).length < 6) return;
    this.compacting.add(sessionId);
    try {
      const result = await this.compactSession(sessionId);
      if (result.compactedMessages > 0) {
        this.store.addLog('info', `Auto-compacted ${result.compactedMessages} messages in background.`, undefined, 'context');
        if (result.breakdown) this.bus.publish({ type: 'context', sessionId, breakdown: result.breakdown });
      }
    } catch { /* non-fatal */ } finally {
      this.compacting.delete(sessionId);
    }
  }

  /**
   * Compact older turns in a chat into a single structured summary right away using the fast model.
   * Frees context in seconds without evicting the main model's KV cache and falls back deterministically if busy.
   */
  async compactSession(sessionId: string): Promise<{ summary: string; compactedMessages: number; breakdown: ContextBreakdown | null }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error('Chat not found.');
    const messages = this.store.listMessages(sessionId);
    const keepTail = 4;
    const existing = this.store.listSummaries(sessionId);
    const alreadyCovered = new Set(existing.flatMap((s) => s.covers));
    const older = (messages.length > keepTail ? messages.slice(0, messages.length - keepTail) : messages)
      .filter((m) => !alreadyCovered.has(m.id));
    if (!older.length) {
      return { summary: '', compactedMessages: 0, breakdown: this.getSessionContextBreakdown(sessionId) };
    }
    const model = this.fastSummaryModel(session.activeModelId);
    const prevRoot = [...existing].reverse().find((s) => s.level === 2)?.content || '';
    const transcript = older
      .map((m) => `${m.role}${m.toolName ? `(${m.toolName})` : ''}: ${m.content.replace(/\s+/g, ' ').slice(0, m.role === 'tool' ? 200 : 360)}`)
      .join('\n')
      .slice(-4_500);
    const prompt = `Compact this conversation into a concise handoff summary (under 160 words) with bullets: Goal, Decisions, Files & Repos, Open Next Steps.\n\n${prevRoot ? `Previous summary:\n${prevRoot.slice(0, 700)}\n\n` : ''}Transcript:\n${transcript}`;
    const generated = model ? await this.trySummarize(model, prompt) : null;
    const summary = generated || this.fallbackSummary(older, prevRoot);
    const version = Math.max(0, ...existing.map((s) => s.version)) + 1;
    const created = this.store.addSummary({
      sessionId,
      level: 2,
      version,
      content: summary,
      covers: older.map((m) => m.id),
      foldedInto: null,
      tokenEstimate: estimateTokens(summary, (model?.tokenizer as 'approx') || 'approx'),
    });
    const open = existing.filter((s) => !s.foldedInto).map((s) => s.id);
    if (open.length) this.store.markSummariesFolded(open, created.id);
    this.lastContext.delete(sessionId);
    const breakdown = this.getSessionContextBreakdown(sessionId);
    return { summary, compactedMessages: older.length, breakdown };
  }

  /**
   * Hand off a full chat into a brand-new chat with the same persona, mode, and attached workspaces,
   * seeded with a concise structured brief so work continues smoothly at ~5% context.
   */
  async handoffSession(sessionId: string): Promise<{ session: ReturnType<Store['createSession']>; summary: string }> {
    const source = this.store.getSession(sessionId);
    if (!source) throw new Error('Chat not found.');
    const messages = this.store.listMessages(sessionId);
    const existing = this.store.listSummaries(sessionId);
    const prevRoot = [...existing].reverse().find((s) => s.level === 2)?.content || '';
    const model = this.fastSummaryModel(source.activeModelId);
    const transcript = messages
      .map((m) => `${m.role}${m.toolName ? `(${m.toolName})` : ''}: ${m.content.replace(/\s+/g, ' ').slice(0, 480)}`)
      .join('\n')
      .slice(-7_500);
    const prompt = `Write a concise continuation brief (under 250 words) so a fresh chat can pick up this work immediately without losing context. Use sections: **Goal**, **Completed**, **Files & Repos**, **Key Decisions**, **Next Steps**.\n\n${prevRoot ? `Earlier summary:\n${prevRoot.slice(0, 900)}\n\n` : ''}Recent messages:\n${transcript}`;
    const generated = model && messages.length ? await this.trySummarize(model, prompt) : null;
    const summary = generated || this.fallbackSummary(messages, prevRoot);
    const baseTitle = (source.title || 'Chat').replace(/\s*\(cont\.\d*\)$/i, '').slice(0, 60);
    const fresh = this.store.createSession({
      agentId: source.agentId,
      roomId: source.roomId,
      title: `${baseTitle} (cont.)`,
      ownerId: source.ownerId,
    });
    this.store.updateSession(fresh.id, {
      mode: source.mode,
      workshopId: source.workshopId,
      modelPin: source.modelPin,
      effort: source.effort,
      activeModelId: source.activeModelId,
    });
    const workspaces = getChatWorkspaces(this.store, source.id);
    if (workspaces.length) setChatWorkspaces(this.store, fresh.id, workspaces);
    if (summary) {
      this.store.insertMessage({
        sessionId: fresh.id,
        role: 'assistant',
        content: `### Continued from previous chat\n\n${summary}\n\nReady to continue whenever you are.`,
        toolCalls: null,
        agentId: source.agentId,
        runId: null,
        toolCallId: null,
        toolName: null,
        imageUrl: null,
        routingNote: 'Context handoff',
      });
    }
    return { session: this.store.getSession(fresh.id)!, summary };
  }

  private fallbackSummary(messages: { role: string; content: string; toolName?: string | null }[], prevRoot: string): string {
    const userLines = messages.filter((m) => m.role === 'user').slice(-6).map((m) => `- ${m.content.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
    const parts = [
      prevRoot ? prevRoot.slice(0, 900) : '',
      userLines.length ? `**Recent requests:**\n${userLines.join('\n')}` : '',
      lastAssistant ? `**Last status:** ${lastAssistant.content.replace(/\s+/g, ' ').trim().slice(0, 320)}` : '',
    ].filter(Boolean);
    return parts.join('\n\n') || 'Previous conversation compacted.';
  }

  /**
   * A failed or stalled reply leaves a short note in the chat itself: the error and the steps that did finish.
   * Before, the failure only lived on the run, so the next turn ("what was your last action?") saw no trace of it
   * and the model answered as if the work never happened. History is never dropped on failure.
   */
  private recordFailure(run: RunRow, message: string) {
    const model = run.modelId ? this.store.getModel(run.modelId) : null;
    const done = this.store.listSteps(run.id).filter((step) => step.kind === 'tool' && step.status === 'completed').map((step) => step.name);
    const counts = new Map<string, number>();
    for (const name of done) counts.set(name, (counts.get(name) ?? 0) + 1);
    const steps = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    const partial = (this.liveStreams.get(run.id)?.text ?? '').trim();
    const content = [
      `⚠️ This reply stopped before finishing${model ? ` on ${model.name}` : ''}: ${message}`,
      steps ? `Finished before it stopped: ${steps}.` : 'No tool steps had finished yet.',
      partial ? `Partial answer so far:\n${partial.slice(-1500)}` : '',
      'The chat history is kept. Send again to continue on the same model, or use /model to switch.',
    ].filter(Boolean).join('\n\n');
    try {
      const assistant = this.store.insertMessage({
        sessionId: run.sessionId, role: 'assistant', content, toolCalls: null, agentId: run.agentId, runId: run.id,
        toolCallId: null, toolName: null, imageUrl: null, routingNote: null,
      });
      this.bus.publish({ type: 'message', runId: run.id, message: assistant });
    } catch { /* best effort */ }
  }

  /** Live exact prefill snapshot reported by llama-server's `prompt_progress` stream, if a turn is currently prefilling. */
  activePrefill(server: 'main' | 'uncensored'): PrefillSnapshot | null {
    const entry = this.livePrefills.get(server);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt >= 60_000) return null;
    return entry.snapshot;
  }

  /** Runs in flight in this process (any chat). */
  busyRuns(): number { return this.inflight.size; }

  /** After a fresh-start reset: drop per-chat caches and stop chat-bound helpers/timers held in memory. */
  forgetChats(sessionIds: string[]) {
    for (const id of sessionIds) this.autonomy.stopForSession(id);
    this.liveStreams.clear();
    this.livePrefills.clear();
    this.lastContext.clear();
    this.dwell.clear();
  }

  /** True while a run on this chat is in flight in this process. */
  sessionBusy(sessionId: string): boolean {
    for (const runId of this.inflight.keys()) {
      if (this.store.getRun(runId)?.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Queue a user steering message into the active run. It is applied at the next safe model/tool boundary. */
  steer(runId: string, content: string): RunRow {
    const run = this.store.getRun(runId);
    if (!run) throw new Error('Run not found.');
    if (!['running', 'paused', 'awaiting_approval', 'awaiting_secret'].includes(run.status)) {
      throw new Error('This run is no longer active.');
    }
    const agent = this.store.getAgent(run.agentId);
    if (!agent) throw new Error('Persona disappeared.');
    const message = this.store.insertMessage({
      sessionId: run.sessionId,
      role: 'user',
      content,
      toolCallId: null,
      toolName: null,
      toolCalls: null,
      agentId: agent.id,
      runId,
      imageUrl: null,
      routingNote: 'Steering',
    });
    const updated = this.store.updateRun(runId, {
      cursor: {
        ...run.cursor,
        steering: { id: message.id, content },
        phase: run.status === 'awaiting_approval' || run.status === 'awaiting_secret' ? run.cursor.phase : 'model',
      },
    })!;
    this.bus.publish({ type: 'steering', runId, message, status: 'queued' });
    return updated;
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
    this.livePrefills.clear();
  }

  stop(runId: string) {
    // Stopping a reply also stops the helpers it started.
    this.autonomy.stopChildrenOf(runId);
    for (const [k, v] of this.livePrefills.entries()) if (v.runId === runId) this.livePrefills.delete(k);
    const live = this.liveStreams.get(runId);
    if (live) live.prefill = null;
    const state = this.inflight.get(runId);
    state?.abort.abort();
    if (state?.paused) state.resumePause();
    this.store.updateRun(runId, { status: 'stopped', endedAt: now(), error: 'Stopped.' });
    this.bus.publish({ type: 'status', runId, status: 'stopped' });
    this.sweepStaleWaits();
    return this.store.getRun(runId);
  }

  /**
   * Clears waits nobody can answer any more, so "secret request waiting" and approval notices never stick:
   * a secret request or approval whose run ended (stopped, failed, cancelled, interrupted, completed), whose run
   * is gone, or whose chat was deleted is marked expired. A secret request older than SECRET_REQUEST_TTL_MS is
   * denied, so a run still waiting on it carries on without the secret. Publishes 'secret'/'approval' events so
   * open clients refresh at once. Returns how many were cleared.
   */
  sweepStaleWaits(nowMs = Date.now()): number {
    const live = (runId: string) => {
      const run = this.store.getRun(runId);
      if (!run || !WAITING_RUN_STATUSES.has(run.status)) return false;
      const session = this.store.getSession(run.sessionId);
      return Boolean(session && !session.archived);
    };
    let cleared = 0;
    for (const request of this.vault.listRequests('pending')) {
      if (!live(request.runId)) {
        this.vault.resolveRequest(request.id, 'expired');
        this.secretWaiters.get(request.id)?.('denied');
        this.bus.publish({ type: 'secret', runId: request.runId, requestId: request.id, status: 'expired' });
        cleared += 1;
      } else if (nowMs - Date.parse(request.createdAt) > SECRET_REQUEST_TTL_MS) {
        this.provideSecret(request.id, null);
        cleared += 1;
      }
    }
    for (const approval of this.store.listApprovals('pending')) {
      if (live(approval.runId)) continue;
      this.store.resolveApproval(approval.id, 'expired');
      this.bus.publish({ type: 'approval', runId: approval.runId, approval: this.store.getApproval(approval.id) });
      cleared += 1;
    }
    return cleared;
  }

  provideSecret(id: string, value: string | null) {
    const request = this.vault.getRequest(id);
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
    // Deliver helper results whose runs ended while the process was down.
    this.autonomy.sweep();
  }

  /** /image <prompt>: one picture, saved to the user's files, shown as a preview in the chat. */
  private async stepImage(run: RunRow, prompt: string) {
    const agent = this.store.getAgent(run.agentId);
    const ownerId = agent?.ownerId || OWNER_ID;
    const cfg = this.store.getSettings().imageGen;
    const local = await localStatus(this.libraryDir, cfg, this.fetchImpl);
    if (cfg.mode !== 'off' && cfg.mode !== 'gemini' && local.ready) this.bus.publish({ type: 'thinking', runId: run.id, text: local.kind === 'mock' ? 'Drawing…' : 'Drawing on this machine with Stable Diffusion. On a CPU this usually takes 20-90 seconds…' });
    let content: string;
    let note: string;
    try {
      const result = await generateImage({ store: this.store, dataDir: this.libraryDir, fetchImpl: this.fetchImpl, memory: this.memory }, { prompt, ownerId, sessionId: run.sessionId, agentId: run.agentId, onWait: (ahead) => this.bus.publish({ type: 'status', runId: run.id, status: 'waiting', detail: ahead ? `Waiting for memory, ${ahead} ahead` : 'Waiting for memory to free up' }) });
      note = `Image · ${result.detail} · ${Math.max(1, Math.round(result.ms / 1000))} s`;
      content = `Here it is: [file:${result.file.id}]`;
    } catch (error) {
      note = 'Image failed';
      content = `I could not make that image. ${error instanceof Error ? error.message : String(error)}`;
    }
    const assistant = this.store.insertMessage({
      sessionId: run.sessionId, role: 'assistant', content, toolCalls: null,
      agentId: agent?.id ?? null, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: note,
    });
    this.store.updateRun(run.id, { cursor: { ...run.cursor, phase: 'done' as const }, status: 'completed', endedAt: now(), routingNote: note, switched: false });
    this.bus.publish({ type: 'message', runId: run.id, message: assistant });
  }

  private async stepRoute(run: RunRow) {
    if (run.cursor.imagePrompt) {
      await this.stepImage(run, run.cursor.imagePrompt);
      return;
    }
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
    await this.ensureSomeModel(agent.id);
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
    const otherOllamaLarge = [...this.llamaLeases.entries()].some(([id, held]) => id !== run.id && held === 'ollama-large');
    if (decision.unload.length && !otherOllamaLarge) {
      await this.unload(decision.unload);
      this.residentLarge = this.residentLarge.filter((n) => !decision.unload.includes(n));
    }
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

  /** Model turns allowed: generous locally so agents can loop, test, and double-check their own work. */
  private stepCap(cursor: RunCursor, sessionMode?: string) {
    const settings = this.store.getSettings();
    const configured = Number.isFinite(settings.maxSteps) ? settings.maxSteps : 36;
    if (cursor.maxSteps) return Math.min(cursor.maxSteps, cursor.longTask ? LONG_TASK_STEPS : 36);
    if (cursor.longTask) return Math.min(100, Math.max(configured, LONG_TASK_STEPS));
    if (cursor.stage === 'plan' || cursor.stage === 'implement' || sessionMode === 'code') {
      return Math.min(100, Math.max(configured, 40));
    }
    return Math.min(100, Math.max(configured, 32));
  }

  private async stepModel(run: RunRow, signal: AbortSignal) {
    await this.waitIfPaused(run.id, signal);
    const settings = this.store.getSettings();
    const sessionMode = this.store.getSession(run.sessionId)?.mode;
    const maxSteps = this.stepCap(run.cursor, sessionMode);
    let current = this.store.getRun(run.id)!;
    if (current.cursor.steering) {
      const steering = current.cursor.steering;
      const steeringNote = `\n\nUSER STEERING (newest instruction; apply it without stopping the rest of the task unless it directly conflicts):\n${steering.content}`;
      current = this.store.updateRun(run.id, {
        cursor: {
          ...current.cursor,
          steering: undefined,
          recovery: {
            rounds: current.cursor.recovery?.rounds ?? 0,
            note: `${current.cursor.recovery?.note ?? ''}${steeringNote}`,
          },
        },
      })!;
      const steeringAgent = this.store.getAgent(current.agentId);
      if (steeringAgent && !current.cursor.helperId) {
        const steerModel = current.modelId ? this.store.getModel(current.modelId) : null;
        const steerStable = Boolean(steerModel && this.cacheFriendly(steerModel));
        if (!steerStable) {
          const steerCompact = this.isCompactCoding(steeringAgent, sessionMode, current, steerModel, settings);
          const offered = this.tools(steeringAgent, sessionMode, current.cursor.stage, current.cursor.toolSubset, false, current, false, steerStable, steerCompact);
          const offeredNames = new Set(offered.map((t) => t.name));
          const contract = contractForAgent(steeringAgent.name);
          const { tools: allPermitted, servers } = this.allowedTools(steeringAgent, sessionMode, current.cursor.stage, current.cursor.toolSubset, false, steerStable);
          const discoverable = allPermitted.filter((t) => contractAllows(contract, t.name, servers) && !offeredNames.has(t.name));
          this.seedToolsFromText(current, steering.content, discoverable, servers);
          current = this.store.getRun(run.id) ?? current;
        }
      }
      this.bus.publish({ type: 'steering', runId: run.id, messageId: steering.id, status: 'applied' });
    }
    // Runs that switched to the uncensored model before the one-step rule (no uncensoredFrom) stayed on it for hours,
    // holding llama-server's uncensored slot so Qwen chats queued behind them. Send them back to the main model too.
    if (current.cursor.uncensoredRetry && !current.cursor.uncensoredFrom && current.cursor.modelId) {
      const onModel = this.store.getModel(current.cursor.modelId);
      const provider = onModel ? this.store.getProvider(onModel.providerId) : undefined;
      const answered = onModel ? this.store.listSteps(run.id).some((step) => step.kind === 'model' && step.status === 'completed' && step.name === onModel.name) : false;
      if (onModel && provider && isUncensoredProvider(provider) && answered) {
        const qwen = this.llama.model();
        const qwenProvider = qwen ? this.store.getProvider(qwen.providerId) : undefined;
        const back = (qwen && qwenProvider && !isUncensoredProvider(qwenProvider) ? qwen : undefined) ?? this.toolCapableModel(settings, run.agentId, onModel.id);
        if (back && back.id !== onModel.id) current = this.store.updateRun(run.id, { cursor: { ...current.cursor, uncensoredFrom: back.id, uncensoredAt: current.cursor.turn - 1 } })!;
      }
    }
    // The uncensored fallback answers one step after a refusal; then the run goes back to the model it came from.
    if (current.cursor.uncensoredFrom && current.cursor.uncensoredAt !== undefined && current.cursor.turn > current.cursor.uncensoredAt) {
      const back = this.store.getModel(current.cursor.uncensoredFrom);
      if (back && back.enabled !== false) {
        const reason = `Back to ${back.name} after one step on the uncensored fallback.`;
        this.store.addLog('info', reason, undefined, 'router');
        current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: back.id, uncensoredFrom: undefined, uncensoredAt: undefined, routingReason: reason }, modelId: back.id, routingNote: reason })!;
      } else {
        current = this.store.updateRun(run.id, { cursor: { ...current.cursor, uncensoredFrom: undefined, uncensoredAt: undefined } })!;
      }
    }
    if (current.cursor.turn >= maxSteps) {
      if (!current.cursor.finalSynthesis) {
        // Give the model one final tool-free turn to synthesize everything it gathered so a run never ends silently on a tool output.
        current = this.store.updateRun(run.id, {
          cursor: {
            ...current.cursor,
            noTools: true,
            finalSynthesis: true,
            recovery: {
              rounds: current.cursor.recovery?.rounds ?? 0,
              note: 'You have reached the step limit for this run. Do NOT call any more tools. Write a clear final response for the user now covering: (1) everything you found or completed so far, (2) anything still unfinished, and (3) a concrete plan / next steps for the next run.',
            },
          },
        })!;
      } else {
        this.store.updateRun(run.id, { cursor: { ...current.cursor, phase: 'summarize' } });
        return;
      }
    } else if (current.cursor.turn === maxSteps - 1 && !current.cursor.recovery?.note) {
      current = this.store.updateRun(run.id, {
        cursor: {
          ...current.cursor,
          recovery: {
            rounds: current.cursor.recovery?.rounds ?? 0,
            note: 'Note: this is your last tool step before the final answer — wrap up and synthesize what you have.',
          },
        },
      })!;
    }
    const agent = this.store.getAgent(run.agentId);
    if (!agent) throw new Error('Persona disappeared.');
    if (agent.updatedAt !== current.cursor.agentUpdatedAt || settings.version !== current.cursor.configVersion) {
      this.store.addStep({
        runId: run.id, kind: 'config', name: 'config', status: 'completed', input: { from: current.cursor.configVersion, to: settings.version },
        output: 'Applied the new config between steps.', toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
      });
      current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: undefined, frozen: undefined, agentUpdatedAt: agent.updatedAt, configVersion: settings.version } })!;
    }
    if (!current.cursor.modelId) {
      await this.ensureSomeModel(agent.id);
      const decision = this.choose(agent, current);
      current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: decision.modelId, routingReason: decision.reason, switched: decision.switched, reasoning: Boolean(decision.reasoning) }, modelId: decision.modelId, routingNote: decision.reason, switched: decision.switched })!;
      const otherOllamaLarge = [...this.llamaLeases.entries()].some(([id, held]) => id !== run.id && held === 'ollama-large');
      if (decision.unload.length && !otherOllamaLarge) {
        await this.unload(decision.unload);
        this.residentLarge = this.residentLarge.filter((n) => !decision.unload.includes(n));
      }
    }
    let model = this.store.getModel(current.cursor.modelId!);
    if (!model) throw new Error('Selected model is gone.');
    // A turn that needs tools never runs tool-less on a model that cannot call them: move to the main model once.
    if (this.toolSupportOf(model) === false && !current.cursor.noTools && !current.cursor.toolFallback) {
      const sessionRow = this.store.getSession(run.sessionId);
      const needsTools = current.cursor.turn > 0 || likelyNeedsTools(this.userText(current), { kb: this.hasKnowledge(run.agentId), code: sessionRow?.mode === 'code' || Boolean(current.cursor.stage) });
      const capable = needsTools ? this.toolCapableModel(settings, run.agentId, model.id) : undefined;
      if (capable) {
        const reason = `Switched to ${capable.name} — ${model.name} cannot call tools and this turn needs them.`;
        this.store.addLog('warn', reason, undefined, 'router');
        current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: capable.id, toolFallback: true, switched: true, routingReason: reason }, modelId: capable.id, switched: true, routingNote: reason })!;
        model = capable;
      }
    }
    let built = await this.buildMessages(current, agent, model);
    if (!this.reserveGemini(model, built.plan.estimatedTokens)) {
      const fallback = this.candidates(settings, run.agentId).find((item) => item.local && item.providerKind !== 'rehearsal');
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
    const providerRow = this.store.getProvider(model.providerId);
    // Big-model queue first (before the RAM lease and before any llama-server switch), so a waiting chat holds nothing.
    const big = this.isBig(model);
    if (big && run.parentRunId) {
      // A helper never loads a second big model next to its parent's: it would wait for a parent that waits for it.
      const parent = this.store.getRun(run.parentRunId);
      const parentModel = parent?.modelId ? this.store.getModel(parent.modelId) : null;
      if (parentModel && parentModel.enabled && parentModel.id !== model.id && this.isBig(parentModel) && this.heldLarge.has(run.parentRunId)) {
        const reason = `Using ${parentModel.name} like the parent chat — only one big model fits at a time.`;
        this.store.addLog('warn', reason, run.id, 'router');
        this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: parentModel.id, phase: 'model', switched: true, routingReason: reason }, modelId: parentModel.id, switched: true, routingNote: reason });
        return;
      }
    }
    const viaOllama = this.viaOllama(model);
    let swappedFromLlama = false;
    if (this.llama.blocks(model, providerRow ?? undefined)) {
      if (!this.llama.hasSwapControl()) {
        const coexist = this.llama.model();
        if (coexist) {
          const reason = `Using ${coexist.name} on llama-server: ${model.name} is too big to load in Ollama while llama-server holds the GPU.`;
          this.store.addLog('warn', reason, undefined, 'router');
          this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: coexist.id, phase: 'model', switched: true, routingReason: reason }, modelId: coexist.id, switched: true, routingNote: reason });
          return;
        }
      } else {
        if (signal.aborted) throw new StopError();
        this.rememberLarge(run.id, model.id);
        await this.waitForLarge(run.id, model.name, signal);
        await this.acquireLlamaLease(run.id, 'ollama-large', signal);
        if (signal.aborted) throw new StopError();
        const liveSwap = this.liveStreams.get(run.id) ?? { text: '', thinking: '', status: 'loading' };
        liveSwap.status = 'loading';
        liveSwap.detail = `Stopping llama-server to load ${model.name}…`;
        this.liveStreams.set(run.id, liveSwap);
        this.bus.publish({ type: 'status', runId: run.id, status: 'loading', detail: liveSwap.detail });
        const stopped = await this.llama.stopAll();
        if (!stopped) {
          this.llamaLeases.delete(run.id);
          const coexist = this.llama.model();
          if (coexist) {
            const reason = `Using ${coexist.name} on llama-server: ${model.name} is too big to load in Ollama while llama-server holds the GPU.`;
            this.store.addLog('warn', reason, undefined, 'router');
            this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: coexist.id, phase: 'model', switched: true, routingReason: reason }, modelId: coexist.id, switched: true, routingNote: reason });
            return;
          }
        } else {
          swappedFromLlama = true;
        }
      }
    }
    if (!swappedFromLlama && big) {
      this.rememberLarge(run.id, model.id);
      await this.waitForLarge(run.id, model.name, signal);
      if (viaOllama) await this.acquireLlamaLease(run.id, 'ollama-large', signal);
    }
    if (providerRow && (isLlamaServerProvider(providerRow) || isUncensoredProvider(providerRow))) {
      const kind = isUncensoredProvider(providerRow) ? 'uncensored' : 'qwen';
      await this.acquireLlamaLease(run.id, kind, signal);
      if (signal.aborted) throw new StopError();
      await this.unloadHeavyOllama();
      if (kind === 'uncensored') await this.llama.switchToUncensored();
      else await this.llama.switchToQwen();
    }
    const sessionForCtx = this.store.getSession(run.sessionId);
    const explicitEffort = !current.cursor.noThink && sessionForCtx?.effort ? sessionForCtx.effort : undefined;
    const autoEffort: 'low' | 'medium' | 'high' | undefined = current.cursor.noThink || explicitEffort
      ? undefined
      : (current.cursor.stage === 'plan' || (current.cursor.recovery?.rounds ?? 0) > 0 || Boolean(current.cursor.failStreak && current.cursor.failStreak.count >= 2))
        ? 'high'
        : current.cursor.autoRole === 'fast'
          ? 'low'
          : (current.cursor.stage === 'implement' && current.cursor.turn > 0)
            ? 'medium'
            : undefined;
    const sessionEffort = explicitEffort ?? autoEffort;
    const thinkingOn = current.cursor.noThink || sessionEffort === 'off'
      ? false
      : explicitEffort
        ? true
        : (Boolean(current.cursor.reasoning) || autoEffort === 'high' || autoEffort === 'medium' || Boolean(providerRow && (isLlamaServerProvider(providerRow) || isUncensoredProvider(providerRow))));
    const staticNativeThinking = /(?:qwen3|flint|deepseek[-_]?r1|qwq|\bo[134]\b)/i.test(`${model.apiName} ${model.name}`) && !/-instruct\b/i.test(model.apiName);
    const nativeThinking = thinkingOn || staticNativeThinking;
    const cacheFriendly = this.cacheFriendly(model);
    const stripThinkTool = cacheFriendly ? staticNativeThinking : nativeThinking;
    // On llama-server (cacheFriendly), dropping `tools` to [] on `noTools` / `finalSynthesis` turns invalidates
    // token 0 of the entire KV cache (forcing a full 48K+ token re-prefill). Keep tool schemas stable for prefix reuse
    // and discard any returned tool calls below when `current.cursor.noTools` is set.
    const toolless = Boolean(current.cursor.noTools && (!cacheFriendly || current.cursor.emptyRetry)) || this.toolSupportOf(model) === false;
    const compactCoding = this.isCompactCoding(agent, sessionForCtx?.mode, current, model, settings);
    const tools = toolless
      ? []
      : this.tools(agent, sessionForCtx?.mode, current.cursor.stage, current.cursor.toolSubset, Boolean(current.cursor.helperId), current, false, cacheFriendly, compactCoding)
          .filter((tool) => !(stripThinkTool && tool.name === 'think'))
          .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    const repoTask = Boolean(sessionForCtx?.mode === 'code' || sessionForCtx?.workshopId || current.cursor.stage || turnRoots(this.store, current, this.libraryDir).length > 0);
    const roleForCtx = current.cursor.autoRole || contractForAgent(agent.name)?.modelRole || 'main';
    const roleBudget = roleContextBudget(roleForCtx, model, { repoTask });
    let numCtx = model.local ? ollamaNumCtx(current.cursor.budgetOverride || roleBudget, settings.outputReserveTokens, model.contextWindow) : undefined;
    // llama-server and other external servers keep their model loaded themselves: no RAM admission, no Ollama load.
    const admitted = model.local && numCtx && viaOllama ? await this.admitLocal(current, model, numCtx, signal) : { lease: null, numCtx };
    if ('switchTo' in admitted) {
      this.store.addLog('warn', admitted.reason, undefined, 'router');
      this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: admitted.switchTo.id, phase: 'model', switched: true, routingReason: admitted.reason }, modelId: admitted.switchTo.id, switched: true, routingNote: admitted.reason });
      return;
    }
    const lease = admitted.lease;
    numCtx = admitted.numCtx;
    if (big && viaOllama) {
      await this.loadLarge(run.id, model);
    } else if (big && this.residentLarge.length) {
      // Switching to llama-server: free whatever big model Ollama still holds.
      const others = this.residentLarge.filter((name) => name !== model.name && name !== model.apiName);
      if (others.length) await this.unload(others);
      this.residentLarge = [];
    }
    const step = this.store.addStep({
      runId: run.id, kind: 'model', name: model.name, status: 'running', input: { turn: current.cursor.turn, budget: built.plan.budgetTokens, estimated: built.plan.estimatedTokens, notes: built.plan.notes, breakdown: built.plan.breakdown },
      output: null, toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
    });
    this.bus.publish({ type: 'step', runId: run.id, step });
    const started = Date.now();
    let text = '';
    let reasoningText = '';
    const prevLive = this.liveStreams.get(run.id);
    const livePhase: WorkPhase | undefined = current.cursor.stage === 'plan'
      ? 'planning'
      : prevLive?.phase ?? current.cursor.workPhase;
    this.liveStreams.set(run.id, {
      text: '', thinking: '', status: 'running',
      focus: prevLive?.focus ?? current.cursor.focus,
      phase: livePhase,
      startedAt: prevLive?.startedAt || current.startedAt || now(),
      prefill: null,
    });
    const llamaServerLabel: 'main' | 'uncensored' | null = providerRow
      ? isUncensoredProvider(providerRow)
        ? 'uncensored'
        : isLlamaServerProvider(providerRow)
          ? 'main'
          : null
      : null;
    const clearLivePrefill = () => {
      const live = this.liveStreams.get(run.id);
      if (live) live.prefill = null;
      for (const [k, v] of this.livePrefills.entries()) {
        if (v.runId === run.id) this.livePrefills.delete(k);
      }
    };
    clearLivePrefill();
    let toolCalls: ToolCall[] | undefined;
    let usage = { inputTokens: built.plan.estimatedTokens, outputTokens: 0 };
    let telemetry: import('./providers.js').Telemetry | undefined;
    const streamAbort = new AbortController();
    const onParentAbort = () => streamAbort.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });
    let degenerateMatch: string | null = null;
    const baseSampling = samplingFor(`${model.apiName} ${model.name}`, { thinking: thinkingOn, task: repoTask ? 'code' : 'general' });
    const effectiveSampling = current.cursor.safeSampling
      ? { temperature: 0.6, top_p: 0.85, top_k: 20, min_p: 0.05, presence_penalty: 0.3, repeat_penalty: 1.08 }
      : baseSampling;
    const gateLane = this.localGpuLane(model, current.cursor.helperId ? 'background' : 'foreground');
    let releaseGpu: (() => void) | null = null;
    try {
      try {
        if (gateLane) {
          try {
            releaseGpu = await this.gpuGate.acquire(gateLane, streamAbort.signal);
          } catch (err) {
            if (signal.aborted) throw new StopError();
            throw err;
          }
        }
        let prevPrefill: PrefillSnapshot | null = null;
        for await (const event of provider.complete({
          model: model.apiName, messages: built.messages, tools, signal: streamAbort.signal,
          paceMs: model.profileId === 'rehearsal' && process.env.NODE_ENV !== 'test' ? 10 : 0,
          numCtx,
          keepAlive: model.local ? keepAliveFor(model) : undefined,
          think: (Boolean(current.cursor.reasoning) || autoEffort === 'high') && !current.cursor.noThink && sessionEffort !== 'off',
          noThink: Boolean(current.cursor.noThink),
          effort: sessionEffort,
          sampling: effectiveSampling,
          maxTokens: maxTokensFor({ thinking: thinkingOn }),
        })) {
          if (signal.aborted) throw new StopError();
          if (event.type === 'progress') {
            const snapshot = computePrefillSnapshot(event.progress, prevPrefill);
            prevPrefill = snapshot;
            const live = this.liveStreams.get(run.id);
            if (live) live.prefill = snapshot;
            if (llamaServerLabel) this.livePrefills.set(llamaServerLabel, { runId: run.id, snapshot, updatedAt: Date.now() });
            this.bus.publish({ type: 'prefill', runId: run.id, prefill: snapshot });
          } else if (event.type === 'token') {
            clearLivePrefill();
            text += event.text;
            const hit = detectDegenerateRepeat(text);
            if (hit) {
              degenerateMatch = hit;
              text = text.slice(0, text.length - hit.length).trimEnd();
              streamAbort.abort();
              break;
            }
            const live = this.liveStreams.get(run.id);
            if (live) live.text = text;
            this.bus.publish({ type: 'token', runId: run.id, text: event.text });
          } else if (event.type === 'thinking') {
            clearLivePrefill();
            reasoningText += event.text;
            const hit = detectDegenerateRepeat(reasoningText);
            if (hit) {
              degenerateMatch = hit;
              reasoningText = reasoningText.slice(0, reasoningText.length - hit.length).trimEnd();
              streamAbort.abort();
              break;
            }
            const live = this.liveStreams.get(run.id);
            if (live) live.thinking = reasoningText;
            this.bus.publish({ type: 'thinking', runId: run.id, text: event.text });
          } else if (event.type === 'done') {
            toolCalls = event.toolCalls;
            if (event.usage) usage = event.usage;
            if (event.telemetry) telemetry = event.telemetry;
          }
        }
      } finally {
        releaseGpu?.();
        clearLivePrefill();
      }
      if (degenerateMatch) {
        this.store.addLog('warn', `Stopped degenerate output loop from ${model.name} (snippet=${JSON.stringify(degenerateMatch.slice(0, 16))}).`, run.id, 'providers');
      }
      signal.removeEventListener('abort', onParentAbort);
      if (lease) await this.calibrateLease(lease, model.apiName, numCtx);
      const uncensored = this.llama.uncensoredModel();
      if (!current.cursor.uncensoredRetry
        && !toolCalls?.length
        && isRefusalText(text)) {
        let fallback = uncensored;
        // Only start the uncensored server here when no other chat is using Qwen; otherwise the next
        // model step queues for it under the llama lease instead of yanking the GPU from that chat.
        const qwenBusyElsewhere = [...this.llamaLeases.entries()].some(([id, held]) => id !== run.id && held === 'qwen');
        if (!fallback && !qwenBusyElsewhere) {
          if (await this.llama.switchToUncensored()) {
            await this.refreshModels();
            fallback = this.llama.uncensoredModel();
          }
        }
        if (!fallback || model.id === fallback.id) {
          this.store.addLog('warn', 'The uncensored fallback could not be started.', undefined, 'router');
        } else {
          // The next model step takes the uncensored lease (and waits if another chat is on Qwen).
          const reason = `Switched to ${fallback.name} — ${model.name} returned a clear refusal.`;
          this.store.addLog('warn', reason, undefined, 'router');
          this.store.updateStep(step.id, { status: 'failed', error: 'The selected model refused the request.', endedAt: now(), latencyMs: Date.now() - started });
          this.store.updateRun(run.id, {
            cursor: { ...current.cursor, modelId: fallback.id, uncensoredRetry: true, uncensoredFrom: model.id, uncensoredAt: current.cursor.turn, phase: 'model', switched: true, routingReason: reason },
            modelId: fallback.id,
            switched: true,
            routingNote: reason,
          });
          return;
        }
      }
    } catch (error) {
      lease?.release();
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
        this.store.addLog('warn', `Context overflow from ${model.name}. Compacting chat and retrying at ${shrunk} tokens.`, undefined, 'context');
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        await this.compactSession(run.sessionId).catch(() => null);
        current = this.store.updateRun(run.id, { cursor: { ...current.cursor, budgetOverride: shrunk, phase: 'model' } })!;
        return;
      }
      if (isContextOverflowError(message) && current.cursor.budgetOverride && !current.cursor.contextEscalated) {
        const bigger = this.candidates(this.store.getSettings(), run.agentId).filter((item) => item.practicalBudget > model.practicalBudget).sort((a, b) => b.practicalBudget - a.practicalBudget)[0];
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        if (bigger) {
          this.store.addLog('warn', `Still over budget. Escalating to ${bigger.name}.`, undefined, 'router');
          current = this.store.updateRun(run.id, { cursor: { ...current.cursor, modelId: bigger.id, budgetOverride: undefined, contextEscalated: true, phase: 'model', switched: true, routingReason: `Switched to ${bigger.name} — the previous model ran out of context.` }, modelId: bigger.id, switched: true, routingNote: `Switched to ${bigger.name} — the previous model ran out of context.` })!;
          return;
        }
      }
      if (isToolParseError(message) && !current.cursor.recovery?.note?.includes('invalid JSON')) {
        this.store.addLog('warn', `${model.name} emitted malformed tool-call JSON; retrying on the same model.`, undefined, 'providers');
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        current = this.store.updateRun(run.id, {
          cursor: {
            ...current.cursor,
            phase: 'model',
            recovery: {
              rounds: (current.cursor.recovery?.rounds ?? 0) + 1,
              note: 'Your previous tool call failed because its arguments had invalid JSON (e.g. an unescaped quote or overly long string). Retry with strictly valid JSON—escape quotes properly and keep large payloads concise or split them across steps.',
            },
          },
        })!;
        return;
      }
      // llama-server restarted or dropped the connection mid-stream: back off, wait for /health, retry the same step.
      if (!signal.aborted && isTransientModelError(message) && (current.cursor.transientRetries ?? 0) < transientRetryCap()) {
        const attempt = (current.cursor.transientRetries ?? 0) + 1;
        const delay = transientDelayMs(attempt);
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        this.store.addLog('warn', `${model.name} connection dropped (${message.slice(0, 120)}). Retry ${attempt}/${transientRetryCap()} in ${Math.round(delay / 1000)}s.`, undefined, 'providers');
        await this.waitForModelServer(providerRow, delay, signal);
        if (signal.aborted) throw new StopError();
        const fresh = this.store.getRun(run.id) ?? current;
        current = this.store.updateRun(run.id, { cursor: { ...fresh.cursor, transientRetries: attempt, phase: 'model' } })!;
        return;
      }
      if (isProviderOutage(message) && !current.cursor.providerFallback) {
        const localCandidates = this.candidates(this.store.getSettings(), run.agentId).filter((item) => item.local && item.id !== model.id);
        const local = localCandidates.filter((item) => item.contextWindow >= 16_384).sort((a, b) => b.contextWindow - a.contextWindow)[0]
          || localCandidates[0];
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
    if (current.cursor.noTools && toolCalls?.length) toolCalls = undefined;
    // Fallback parser for raw Qwen3/XML <tool_call> blocks when llama-server's peg-native parser misses whitespace variants.
    // On tool-free / finalSynthesis turns, strip leaked <tool_call> markup (including unclosed blocks) instead of executing more tools.
    if (!toolCalls?.length && /<tool_call>/i.test(text)) {
      const recovered = extractInlineToolCalls(text);
      if (recovered.calls.length || recovered.truncated) {
        text = recovered.text;
        if (!current.cursor.noTools && recovered.calls.length) toolCalls = recovered.calls;
      }
    }
    if (!toolCalls?.length && !current.cursor.noTools && current.cursor.stage !== 'plan' && /`{3,}(?:file|edit):/.test(text)) {
      const offeredSet = new Set(tools.map((t) => t.name));
      if (offeredSet.has('write_file') || offeredSet.has('apply_patch')) {
        const fenced = extractFencedEdits(text);
        const validCalls = fenced.calls.filter((call) => offeredSet.has(call.name));
        if (validCalls.length) {
          text = validCalls.length === fenced.calls.length ? fenced.text : text;
          toolCalls = validCalls;
        }
      }
    }
    let emptyAnswerFailed = false;
    if (!text.trim() && !toolCalls?.length) {
      if (!current.cursor.emptyRetry) {
        const why = degenerateMatch
          ? `${model.name} hit a repetition loop before answering. Retrying once with safer sampling.`
          : reasoningText
            ? `${model.name} thought but gave no answer. Retrying once with thinking off.`
            : `${model.name} returned an empty answer. Retrying once.`;
        this.store.updateStep(step.id, { status: 'failed', error: why, output: reasoningText ? { reasoning: reasoningText.slice(0, 4000) } : null, endedAt: now(), latencyMs: Date.now() - started });
        this.store.addLog('warn', why, undefined, 'providers');
        const freshEmpty = this.store.getRun(run.id);
        this.store.updateRun(run.id, { cursor: { ...current.cursor, ...(freshEmpty?.cursor.steering ? { steering: freshEmpty.cursor.steering } : {}), emptyRetry: true, noThink: true, ...(degenerateMatch ? { safeSampling: true } : {}), phase: 'model' } });
        return;
      }
      emptyAnswerFailed = true;
      text = reasoningText
        ? `${model.name} only produced reasoning and no answer, twice. Try again, rephrase, or pick a bigger model.`
        : `${model.name} returned an empty answer twice. Try again or pick another model.`;
    }
    const cost = ((usage.inputTokens * (model.priceIn ?? 0)) + (usage.outputTokens * (model.priceOut ?? 0))) / 1_000_000;
    const note = [current.cursor.switched ? current.cursor.routingReason : '', built.cutNote].filter(Boolean).join(' ') || null;
    text = this.vault.redact(text);
    // Researcher persona: automatically enforce web_search on turn 0 when answering a substantive question without having searched yet.
    const speakerContract = contractForAgent(agent.name);
    const isResearcher = speakerContract?.slug === 'researcher' || agent.templateId === 'researcher';
    if (!emptyAnswerFailed && !toolCalls?.length && text.trim() && isResearcher && !current.cursor.researchRetried && tools.some((t) => t.name === 'web_search')) {
      const userPrompt = this.userText(run).trim();
      const trivial = userPrompt.length < 12 || /^(hi|hello|hey|thanks|thank you|ok|okay|שלום|היי|תודה)[!.\s?]*$/i.test(userPrompt);
      const alreadySearched = this.store.listSteps(run.id).some((s) => s.kind === 'tool' && (
        s.name === 'web_search' || s.name === 'web_fetch' || s.name === 'browse' || s.name === 'kb_search'
        || s.name === 'read_file' || s.name === 'grep' || s.name === 'glob' || s.name === 'list_dir' || s.name === 'shell'
      ));
      if (!trivial && !alreadySearched && maxSteps - current.cursor.turn > 1) {
        this.store.updateStep(step.id, { status: 'completed', output: { text, discarded: 'researcher must search first' }, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: cost, latencyMs: Date.now() - started, endedAt: now() });
        this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
        this.store.addStep({ runId: run.id, kind: 'contract', name: 'auto-search', status: 'completed', input: { turn: current.cursor.turn }, output: 'Prompted Researcher to call web_search before answering.', toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now() });
        const fresh = this.store.getRun(run.id)!;
        this.store.updateRun(run.id, {
          cursor: {
            ...current.cursor,
            ...(fresh.cursor.steering ? { steering: fresh.cursor.steering } : {}),
            phase: 'model',
            turn: current.cursor.turn + 1,
            researchRetried: true,
            recovery: {
              rounds: current.cursor.recovery?.rounds ?? 0,
              note: '\n\nRESEARCHER REQUIREMENT: You answered without calling web_search. Call web_search right now with a focused query to verify current facts and gather sources before writing your final answer.',
            },
          },
          inputTokens: fresh.inputTokens + usage.inputTokens,
          outputTokens: fresh.outputTokens + usage.outputTokens,
          costUsd: fresh.costUsd + cost,
        });
        return;
      }
    }
    if (!emptyAnswerFailed && !toolCalls?.length && text.trim()) {
      const rounds = current.cursor.recovery?.rounds ?? 0;
      const check = checkFinalReply(this.store.listSteps(run.id), text, rounds, maxSteps - current.cursor.turn, this.replyLang(agent, this.userText(run)) === 'he', tools.map((t) => t.name), this.store.getRun(run.id)?.cursor.acceptance ?? []);
      if (check.action === 'retry') {
        this.store.updateStep(step.id, { status: 'completed', output: { text, discarded: check.reason }, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: cost, latencyMs: Date.now() - started, endedAt: now() });
        this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
        this.store.addStep({ runId: run.id, kind: 'contract', name: 'verify', status: 'completed', input: { round: rounds + 1 }, output: `Sent back: ${check.reason}`, toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now() });
        this.store.addLog('warn', `Run ${run.id}: ${check.reason} Asking ${model.name} to recover (round ${rounds + 1}).`, undefined, 'engine');
        const fresh = this.store.getRun(run.id)!;
        this.store.updateRun(run.id, { cursor: { ...current.cursor, ...(fresh.cursor.steering ? { steering: fresh.cursor.steering } : {}), phase: 'model', turn: current.cursor.turn + 1, recovery: { rounds: rounds + 1, note: check.note } }, inputTokens: fresh.inputTokens + usage.inputTokens, outputTokens: fresh.outputTokens + usage.outputTokens, costUsd: fresh.costUsd + cost });
        return;
      }
      if (check.action === 'ok') completeFinalReplyTask(this.store, run.sessionId, run.id, text);
      const open = check.action === 'ok' ? openTasks(this.store, run.sessionId, run.id) : [];
      const taskRounds = current.cursor.taskRounds ?? 0;
      const taskSnapshot = open.slice().sort().join('\n');
      const repeatedTasks = Boolean(current.cursor.taskSnapshot && taskSnapshot && current.cursor.taskSnapshot === taskSnapshot);
      if (open.length && !current.cursor.noTools && !repeatedTasks && taskRounds < MAX_TASK_ROUNDS && maxSteps - current.cursor.turn > 1) {
        this.store.updateStep(step.id, { status: 'completed', output: { text, discarded: 'open tasks' }, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: cost, latencyMs: Date.now() - started, endedAt: now() });
        this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
        this.store.addStep({ runId: run.id, kind: 'contract', name: 'verify', status: 'completed', input: { tasks: open.length }, output: `Sent back: ${open.length} task(s) still open`, toolCallId: null, turn: current.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now() });
        const fresh = this.store.getRun(run.id)!;
        this.store.updateRun(run.id, { cursor: { ...current.cursor, ...(fresh.cursor.steering ? { steering: fresh.cursor.steering } : {}), phase: 'model', turn: current.cursor.turn + 1, taskRounds: taskRounds + 1, taskSnapshot, recovery: { rounds: current.cursor.recovery?.rounds ?? 0, note: tasksNote(open) } }, inputTokens: fresh.inputTokens + usage.inputTokens, outputTokens: fresh.outputTokens + usage.outputTokens, costUsd: fresh.costUsd + cost });
        return;
      }
      if (open.length) text += `\n\n⚠️ ${open.length} task(s) still open: ${open.join('; ')}`;
      if (check.action === 'footer') {
        text += check.footer;
        this.store.addLog('warn', `Run ${run.id}: ${check.reason} Added a note to the reply.`, undefined, 'engine');
      }
      text = await this.polishHebrew(run, agent, model, text);
    }
    const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
    if (!telemetry && usage.outputTokens > 0 && model.local && model.profileId !== 'rehearsal') {
      telemetry = { tokPerSec: Math.round((usage.outputTokens / elapsedSec) * 10) / 10 };
    }
    const perfParts: string[] = [];
    if (telemetry?.tokPerSec) perfParts.push(`${telemetry.tokPerSec} tok/s`);
    if (typeof telemetry?.cacheHitPct === 'number') perfParts.push(`${telemetry.cacheHitPct}% cache`);
    const perfTag = !toolCalls?.length && perfParts.length ? perfParts.join(' · ') : '';
    const finalNote = [note, perfTag].filter(Boolean).join(' · ') || null;
    const assistant = this.store.insertMessage({
      sessionId: run.sessionId, role: 'assistant', content: text, toolCalls: toolCalls?.length ? toolCalls : null,
      agentId: agent.id, runId: run.id, toolCallId: null, toolName: null, imageUrl: null, routingNote: finalNote,
      thinking: reasoningText.trim() || null,
    });
    const live = this.liveStreams.get(run.id);
    if (live) { live.text = ''; live.thinking = ''; }
    const fresh = this.store.getRun(run.id)!;
    const queuedSteering = fresh.cursor.steering;
    const cursor: RunCursor = toolCalls?.length
      ? { ...current.cursor, ...(queuedSteering ? { steering: queuedSteering } : {}), phase: 'tools', toolCalls, completedToolIds: [], approvalId: undefined }
      : queuedSteering && current.cursor.turn + 1 < maxSteps
        ? { ...current.cursor, steering: queuedSteering, phase: 'model', turn: current.cursor.turn + 1, toolCalls: undefined }
        : { ...current.cursor, phase: 'summarize', toolCalls: undefined };
    this.store.updateStep(step.id, { status: 'completed', output: { text, toolCalls, ...(telemetry ? { telemetry } : {}), ...(reasoningText ? { reasoning: reasoningText.slice(0, 4000) } : {}) }, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: cost, latencyMs: Date.now() - started, endedAt: now() });
    this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
    this.store.updateRun(run.id, {
      cursor,
      inputTokens: fresh.inputTokens + usage.inputTokens,
      outputTokens: fresh.outputTokens + usage.outputTokens,
      costUsd: fresh.costUsd + cost,
    });
    this.checkpoint(run.id, cursor, toolCalls?.length ? 'Model requested tools' : 'Model answered');
    this.bus.publish({ type: 'message', runId: run.id, message: assistant, ...(telemetry ? { telemetry } : {}) });
  }

  private async stepTools(run: RunRow, signal: AbortSignal) {
    const calls = run.cursor.toolCalls ?? [];
    const completed = new Set(run.cursor.completedToolIds ?? []);
    const batchTouchedPlan = calls.some((c) => c.name === 'plan' || c.name === 'tasks' || c.name === 'exit_plan_mode');
    const lastExecCallId = [...calls].reverse().find((c) => ['write_file', 'create_file', 'apply_patch', 'shell', 'git'].includes(c.name))?.id;
    let handoff = false;
    for (const call of calls) {
      if (completed.has(call.id)) continue;
      await this.waitIfPaused(run.id, signal);
      if (signal.aborted) throw new StopError();
      const stepAgent = this.store.getAgent(run.agentId)!;
      const stepSessionMode = this.store.getSession(run.sessionId)?.mode;
      const stepModelRow = run.modelId ? this.store.getModel(run.modelId) : null;
      const stepStable = Boolean(stepModelRow && this.cacheFriendly(stepModelRow));
      const stepCompact = this.isCompactCoding(stepAgent, stepSessionMode, run, stepModelRow, this.store.getSettings());
      const tools = this.tools(stepAgent, stepSessionMode, run.cursor.stage, run.cursor.toolSubset, Boolean(run.cursor.helperId), run, true, stepStable, stepCompact);
      const tool = tools.find((item) => item.name === call.name);
      // A permitted tool called before find_tools surfaced it still runs, and stays on the menu for non-cached providers.
      if (tool && !stepStable && run.cursor.extraTools !== undefined && call.name !== 'find_tools') {
        const offered = this.tools(stepAgent, stepSessionMode, run.cursor.stage, run.cursor.toolSubset, Boolean(run.cursor.helperId), run, false, stepStable, stepCompact);
        if (!offered.some((item) => item.name === call.name)) this.addRunTools(run, [call.name]);
      }
      // Malformed arguments go back to the model as a fixable error instead of running the tool with {}.
      const badAttempt = (this.store.getRun(run.id)?.cursor.badArgs ?? 0) + 1;
      const badJson = argumentsError(call.name, call.arguments, badAttempt);
      if (badJson) {
        const latestRun = this.store.getRun(run.id)!;
        run.cursor.badArgs = badAttempt;
        // Past the cap the run stops calling tools and answers with what it has (one more model step, no tools).
        const stop = badAttempt >= BAD_ARGS_CAP;
        if (stop) run.cursor.noTools = true;
        this.store.updateRun(run.id, { cursor: { ...latestRun.cursor, badArgs: badAttempt, ...(stop ? { noTools: true } : {}) } });
        if (stop) this.store.addLog('warn', `Run ${run.id}: ${badAttempt} malformed tool calls; finishing without tools.`, undefined, 'engine');
        this.store.addStep({ runId: run.id, kind: 'contract', name: call.name, status: 'failed', input: { raw: call.arguments.slice(0, 2000) }, output: badJson, toolCallId: call.id, turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: badJson, startedAt: now() });
        this.persistTool(run, call, stop ? `${badJson}\nThat was the last try: no more tool calls in this run. Answer now with what you have and say what you could not do.` : badJson, 'failed', false);
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      let args = normalizeToolArgs(call.name, parseArgs(call.arguments));
      const speaker = this.store.getAgent(run.agentId);
      const contract = speaker ? contractForAgent(speaker.name) : null;
      if (contract && speaker && !contractAllows(contract, call.name, this.allowedTools(speaker, this.store.getSession(run.sessionId)?.mode, run.cursor.stage, run.cursor.toolSubset, Boolean(run.cursor.helperId)).servers)) {
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
        const liveLock = this.store.getRun(run.id) ?? run;
        const planBlocked = liveLock.cursor.stage === 'plan' && PLAN_READONLY_BLOCKED.has(call.name);
        const msg = planBlocked
          ? 'Blocked by plan mode (read-only): finish investigating and call exit_plan_mode with your plan before editing files or running mutating commands.'
          : `Unknown tool ${call.name}.`;
        this.persistTool(run, call, msg, planBlocked ? 'skipped' : 'failed');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      // Loop breaker: the same call (name + arguments) again and again. 3rd in a row: nudge. 4th: refuse it and let the
      // model answer once more without tools, so the run ends cleanly instead of burning every step.
      const sig = `${call.name}:${stableJson(args)}`;
      const latest = this.store.getRun(run.id)!;
      const loop = latest.cursor.loop?.sig === sig ? { sig, count: latest.cursor.loop.count + 1 } : { sig, count: 1 };
      run.cursor.loop = loop;
      this.store.updateRun(run.id, { cursor: { ...latest.cursor, loop } });
      if (loop.count >= LOOP_STOP) {
        const message = `Stopped: this is the ${loop.count}th identical ${call.name} call in a row and nothing changed. No more tool calls in this run. Answer now: what you found, what did not work, and what the user can do next.`;
        this.store.addStep({ runId: run.id, kind: 'contract', name: 'loop', status: 'failed', input: { tool: call.name, count: loop.count }, output: message, toolCallId: call.id, turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: message, startedAt: now() });
        this.store.addLog('warn', `Run ${run.id}: ${call.name} repeated ${loop.count} times with the same arguments. Asking for a final answer without tools.`, undefined, 'engine');
        this.persistTool(run, call, message, 'failed', false);
        const fresh = this.store.getRun(run.id)!;
        run.cursor.noTools = true;
        this.store.updateRun(run.id, { cursor: { ...fresh.cursor, noTools: true } });
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      const loopNote = loop.count >= LOOP_NUDGE ? `\n[loop] This is call ${loop.count} in a row of ${call.name} with the same arguments. Repeating it will not change the result: use what you have, try a different approach, or answer.` : '';
      // A read-only call repeated with nothing changed since: point at the earlier result instead of running (and pasting)
      // it again. After a write, shell command or other change, it runs fresh (the file or state may differ now).
      if (!tool.mutates(args)) {
        const history = this.store.listSteps(run.id);
        const prior = history
          .filter((step) => step.kind === 'tool' && step.name === call.name && step.status === 'completed')
          .reverse()
          .find((step) => stableJson(step.input) === stableJson(args));
        const changedSince = prior ? history.some((step) => step.index > prior.index && step.kind === 'tool' && step.status === 'completed' && Boolean(tools.find((item) => item.name === step.name)?.mutates((step.input ?? {}) as Record<string, unknown>))) : false;
        if (prior && !changedSince) {
          const output = String(prior.output ?? '');
          const priorMsg = prior.toolCallId
            ? this.store.listMessages(run.sessionId).find((m) => m.role === 'tool' && m.toolCallId === prior.toolCallId)
            : undefined;
          const moreHint = priorMsg
            ? `… (use read_output with message="${priorMsg.id}" and offset=1500, or narrower arguments, for more)`
            : '… (use read_output or narrower arguments for more)';
          const repeated = `Already ran ${call.name} with these arguments in this run and nothing has changed since; the result is above.${output.length > 1500 ? ` First part again:\n${output.slice(0, 1500)}\n${moreHint}` : `\n${output}`}${loopNote || '\nDo not repeat it: use that result or try something different.'}`;
          this.persistTool(run, call, repeated, 'completed', false);
          completed.add(call.id);
          this.bumpTools(run.id, completed);
          continue;
        }
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
      const liveForLock = this.store.getRun(run.id) ?? run;
      if ((limits.readOnly || this.store.getSettings().readOnly) && tool.mutates(args)) {
        this.persistTool(run, call, 'Blocked. This persona is in read-only mode.', 'skipped');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      const inPlanMode = liveForLock.cursor.stage === 'plan';
      const coderHelperInPlan = call.name === 'spawn_agent' && String(args.role || args.persona || '').toLowerCase() === 'coder';
      if (inPlanMode && (PLAN_READONLY_BLOCKED.has(call.name) || coderHelperInPlan || (tool.mutates(args) && call.name !== 'repo_sync' && call.name !== 'consult_agent'))) {
        this.persistTool(run, call, 'Blocked by plan mode (read-only): finish investigating and call exit_plan_mode with your plan before editing files or running mutating commands.', 'skipped');
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      const failTarget = String(args.path ?? args.command ?? args.query ?? args.pattern ?? args.action ?? args.url ?? '').slice(0, 80);
      const failKey = `${call.name}:${failTarget}`;
      if (liveForLock.cursor.failStreak?.key === failKey && liveForLock.cursor.failStreak.count >= 3) {
        const nextCount = liveForLock.cursor.failStreak.count + 1;
        const msg = `[thrash] Re-plan stop: ${call.name} failed ${liveForLock.cursor.failStreak.count} times in a row on ${failTarget || call.name}. Do not repeat — switch approach, call enter_plan_mode to re-investigate, or summarize where you are blocked.`;
        if (nextCount >= 4) run.cursor.noTools = true;
        this.store.updateRun(run.id, { cursor: { ...liveForLock.cursor, failStreak: { key: failKey, count: nextCount }, ...(nextCount >= 4 ? { noTools: true } : {}) } });
        this.store.addStep({ runId: run.id, kind: 'contract', name: 'thrash', status: 'failed', input: { tool: call.name, target: failTarget, count: nextCount }, output: msg, toolCallId: call.id, turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: msg, startedAt: now() });
        this.persistTool(run, call, msg, 'failed', false);
        completed.add(call.id);
        this.bumpTools(run.id, completed);
        continue;
      }
      let reason = tool.approval(args, toolContext);
      const risk = riskOf(call.name, args, reason);
      const mode: ApprovalMode = limits.approvalMode ?? settings.approvalMode ?? (settings.approvalForDestructive ? 'balanced' : 'autonomous');
      if (needsApproval(risk.tier, reason, mode)) reason = `[${risk.tier} risk] ${reason ?? risk.why}`;
      else {
        if (reason) this.store.addLog('info', `Auto-approved ${call.name} (${risk.tier} risk, ${mode} mode): ${reason}`, undefined, 'approvals');
        reason = null;
      }
      if (reason) {
        let approval = run.cursor.approvalId ? this.store.getApproval(run.cursor.approvalId) : null;
        if (!approval || approval.toolCallId !== call.id || approval.status === 'denied') {
          approval = this.store.createApproval({ runId: run.id, toolCallId: call.id, toolName: call.name, args, reason });
        }
        const waiting = { ...this.store.getRun(run.id)!.cursor, approvalId: approval.id, completedToolIds: [...completed] };
        this.store.updateRun(run.id, { status: 'awaiting_approval', cursor: waiting });
        this.checkpoint(run.id, waiting, 'Waiting for approval');
        this.bus.publish({ type: 'approval', runId: run.id, sessionId: run.sessionId, agentId: run.agentId, approval });
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
      const whyText = typeof args.why === 'string' && args.why.trim() ? args.why.trim() : typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined;
      const stepSummary = whyText || deriveStepFocus(call.name, args);
      if (call.name !== 'set_focus' && !run.cursor.helperId) {
        const autoPhase = deriveStepPhase(call.name, args, run.cursor.stage);
        this.publishFocus(run.id, stepSummary, autoPhase);
      }
      if (run.cursor.helperId) {
        this.autonomy.noteProgress(run.cursor.helperId, { tool: call.name, summary: stepSummary, status: 'running', at: now() });
      }
      const started = Date.now();
      try {
        const output = this.vault.redact(clampText(await tool.execute(args, { ...this.contextFor(run, signal), toolCallId: call.id }), 200_000));
        const afterOk = this.store.getRun(run.id);
        if (afterOk?.cursor.failStreak) this.store.updateRun(run.id, { cursor: { ...afterOk.cursor, failStreak: undefined } });
        let planNote = '';
        const liveStage = afterOk?.cursor.stage ?? run.cursor.stage;
        if (call.id === lastExecCallId && !batchTouchedPlan && !run.cursor.helperId && liveStage === 'implement') {
          const activePlan = readPlan(this.store, run.sessionId);
          if (activePlan?.items.length) {
            const done = activePlan.items.filter((item) => item.status === 'done').length;
            const nextIdx = activePlan.items.findIndex((item) => item.status !== 'done' && item.status !== 'blocked');
            if (nextIdx >= 0) {
              planNote = `\n\n[plan] ${done}/${activePlan.items.length} done · next step #${nextIdx + 1}: "${activePlan.items[nextIdx]!.text}" — match this exact step and call plan({ itemId: "${nextIdx + 1}", status: "done", evidence: "..." }) as soon as you finish it.`;
            }
          }
        }
        this.store.updateStep(step.id, { status: 'completed', output, latencyMs: Date.now() - started, endedAt: now() });
        this.persistTool(run, call, `${output}${loopNote}${planNote}`, 'completed', false);
        this.bus.publish({ type: 'step', runId: run.id, step: this.store.getStep(step.id) });
        if (run.cursor.helperId) {
          this.autonomy.noteProgress(run.cursor.helperId, { tool: call.name, summary: stepSummary, status: 'completed', at: now() });
        }
      } catch (error) {
        if (error instanceof CrashError || error instanceof StopError || error instanceof InterruptedToolError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const liveForFail = this.store.getRun(run.id) ?? run;
        const prevStreak = liveForFail.cursor.failStreak;
        const failCount = prevStreak?.key === failKey ? prevStreak.count + 1 : 1;
        if (failCount >= 4) run.cursor.noTools = true;
        this.store.updateRun(run.id, { cursor: { ...liveForFail.cursor, failStreak: { key: failKey, count: failCount }, ...(failCount >= 4 ? { noTools: true } : {}) } });
        const thrashNote = failCount === 2
          ? `\n[thrash] Failed twice on ${failTarget || call.name}. Stop repeating blindly: inspect a wider slice, rethink the approach, or call enter_plan_mode.`
          : failCount === 3
            ? `\n[thrash] Re-plan stop: failed 3 times in a row on ${failTarget || call.name}. Do not repeat this call — switch approach or mark the step blocked.`
            : failCount >= 4
              ? `\n[thrash] Stopped retrying after ${failCount} failures on ${failTarget || call.name}. Summarize what worked and where you are blocked.`
              : '';
        this.store.updateStep(step.id, { status: 'failed', error: message, endedAt: now(), latencyMs: Date.now() - started });
        this.persistTool(run, call, `Error: ${message}${recoveryHint(call.name, message)}${thrashNote}${loopNote}`, 'failed', false);
        if (run.cursor.helperId) {
          this.autonomy.noteProgress(run.cursor.helperId, { tool: call.name, summary: `${stepSummary}: ${message.slice(0, 60)}`, status: 'failed', at: now() });
        }
      }
      const afterCall = this.store.getRun(run.id);
      if (call.name === 'plan' && Array.isArray(args.items) && args.items.length && (afterCall?.cursor.stage ?? run.cursor.stage) === 'plan' && !afterCall?.cursor.enteredPlanViaTool) handoff = true;
      const promotesLongTask = (call.name === 'tasks' && args.action === 'set' && Array.isArray(args.items) && args.items.length >= 2)
        || (call.name === 'plan' && Array.isArray(args.items) && args.items.length >= 2)
        || call.name === 'exit_plan_mode'
        || (call.name === 'slide_draft' && args.action === 'start');
      if (promotesLongTask) {
        const live = this.store.getRun(run.id)!;
        if (!live.cursor.longTask) this.store.updateRun(run.id, { cursor: { ...live.cursor, longTask: true } });
      }
      completed.add(call.id);
      this.bumpTools(run.id, completed);
    }
    const latest = this.store.getRun(run.id)!;
    const turn = latest.cursor.turn + 1;
    const cap = this.stepCap(latest.cursor, this.store.getSession(run.sessionId)?.mode);
    // When the step cap is reached, route back to stepModel once so finalSynthesis produces a tool-free answer + plan forward.
    const nextPhase: RunCursor['phase'] = turn >= cap && latest.cursor.finalSynthesis ? 'summarize' : 'model';
    let next: RunCursor = { ...latest.cursor, phase: nextPhase, turn, toolCalls: undefined, completedToolIds: [], approvalId: undefined };
    if (handoff) {
      const approval = this.store.createApproval({ runId: run.id, toolCallId: 'plan', toolName: 'plan', args: { stage: 'plan' }, reason: 'Start coding from this plan. Edit the plan first if you want to change it.' });
      const waiting = { ...latest.cursor, phase: 'tools' as const, stage: 'plan' as const, approvalId: approval.id };
      this.store.updateRun(run.id, { status: 'awaiting_approval', cursor: waiting });
      this.checkpoint(run.id, waiting, 'Waiting for the plan');
      this.bus.publish({ type: 'approval', runId: run.id, sessionId: run.sessionId, agentId: run.agentId, approval });
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
    if (agent && run.cursor.stage === 'implement') {
      const labels = turnRoots(this.store, run, this.libraryDir).map((root) => root.label);
      for (const label of labels) addProjectNote(this.store, { label, agentId: agent.id, kind: 'change', body: `${agent.name} finished a change on ${label}.` });
    }
    // Safety net: never finish a tool-heavy run silently without a visible assistant reply or next steps.
    const runMessages = this.store.listMessages(run.sessionId).filter((m) => m.runId === run.id);
    const lastRunMsg = runMessages[runMessages.length - 1];
    const hasFinalAnswer = Boolean(lastRunMsg && lastRunMsg.role === 'assistant' && !(Array.isArray(lastRunMsg.toolCalls) && lastRunMsg.toolCalls.length) && lastRunMsg.content.trim());
    if (!hasFinalAnswer && !run.cursor.commandAck && !run.cursor.imagePrompt && agent) {
      const toolSteps = this.store.listSteps(run.id).filter((s) => s.kind === 'tool');
      if (toolSteps.length) {
        const names = [...new Set(toolSteps.map((s) => s.name))].slice(0, 6).join(', ');
        const fallback = this.store.insertMessage({
          sessionId: run.sessionId,
          role: 'assistant',
          content: `Reached the step limit after ${toolSteps.length} tool steps (${names}) without a final summary.\n\n**Next step:** Reply **"continue"** to pick up right where I left off and synthesize the results.`,
          toolCalls: null,
          agentId: agent.id,
          runId: run.id,
          toolCallId: null,
          toolName: null,
          imageUrl: null,
          routingNote: null,
          thinking: null,
        });
        this.bus.publish({ type: 'message', runId: run.id, message: fallback });
      }
    }
    const cursor = { ...this.store.getRun(run.id)!.cursor, phase: 'done' as const };
    this.store.updateRun(run.id, { cursor, status: 'completed', endedAt: now() });
    this.checkpoint(run.id, cursor, 'Finished');
    // Run auto-compaction in the background after marking the run done so the user never waits 5-10s after the reply lands.
    if (agent && model) {
      const fold = this.maybeFold(run.sessionId, agent, model).catch(() => undefined);
      if (process.env.VITEST) await fold;
    }
  }

  private choose(agent: Agent, run: RunRow): RouteDecision {
    const settings = this.store.getSettings();
    if (!this.candidates(settings, agent.id).length) throw new Error(NO_MODEL_MESSAGE);
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
        models: this.candidates(settings, agent.id),
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
    const pinnedId = session?.modelPin || run.cursor.messageModelId || (agent.routing === 'pinned' ? agent.modelId : null);
    if (pinnedId && picked.modelId !== pinnedId) {
      const pinnedModel = this.store.getModel(pinnedId);
      const pinnedProvider = pinnedModel ? this.store.getProvider(pinnedModel.providerId) ?? undefined : undefined;
      if (pinnedModel?.enabled && this.llama.blocks(pinnedModel, pinnedProvider)) {
        if (this.llama.hasSwapControl()) {
          picked = {
            ...picked,
            modelId: pinnedModel.id,
            modelName: pinnedModel.name,
            switched: false,
            reason: `Pinned to ${pinnedModel.name} — swapping GPU from llama-server.`,
          };
        } else {
          const reason = `Using ${picked.modelName}: ${pinnedModel.name} is too big to load in Ollama while llama-server holds the GPU.`;
          this.store.addLog('warn', reason, run.id, 'router');
          picked = { ...picked, switched: true, reason };
        }
      }
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

  private autoCandidates(settings: Settings, agentId?: string): AutoCandidate[] {
    return this.candidates(settings, agentId).map((model) => ({
      id: model.id, name: model.name, apiName: model.apiName, local: model.local, embedding: false,
      sizeClass: model.sizeClass, providerKind: model.providerKind, quotaOpen: model.quotaOpen,
      practicalBudget: model.practicalBudget, enabled: model.enabled,
    }));
  }

  /**
   * Sticky chat model: once a chat is on a model (picked by the user, or switched to automatically inside a run,
   * e.g. the uncensored fallback after a refusal), later turns stay on it. Auto re-routes only when the user asks
   * (/model, /auto, /smart, "think harder", a per-message pick or a pin), when the model is gone or unusable now, or
   * when the previous turn was only on Auto's short-reply "fast" tier. Re-routing on every turn sent "what did you
   * just do?" from the uncensored model to gemma, which then had no RAM to load.
   */
  private stickyModel(text: string, run: RunRow, settings: Settings): RouteCandidate | undefined {
    const session = this.store.getSession(run.sessionId);
    if (!session?.activeModelId || session.modelPin || run.cursor.messageModelId) return undefined;
    if (run.cursor.stage) return undefined;
    const command = readChatCommand(text);
    if (command.unpin || command.smart || command.pinName || /think harder/i.test(text)) return undefined;
    const activeId = session.activeModelId;
    const previous = this.store.listSessionRuns(run.sessionId, 6).find((item) => item.id !== run.id && item.modelId);
    // The fast tier is a short-reply shortcut, not the chat's model, unless a run moved off it by itself (e.g. a refusal).
    if (previous && previous.cursor.autoRole === 'fast' && !previous.cursor.uncensoredRetry && !previous.cursor.contextEscalated && !previous.cursor.providerFallback) return undefined;
    const candidate = this.candidates(settings, run.agentId).find((item) => item.id === activeId);
    if (!candidate) return undefined;
    const user = (run.cursor.userMessageId && this.store.listMessages(run.sessionId).find((message) => message.id === run.cursor.userMessageId)) || null;
    if (user?.imageUrl && !(candidate.modalities as string[] | undefined)?.some((mode) => /image|vision/i.test(mode))) return undefined;
    const needsTools = likelyNeedsTools(text, { kb: this.hasKnowledge(run.agentId), code: session.mode === 'code' });
    if (needsTools && this.toolSupportOf(candidate) === false) return undefined;
    return candidate;
  }

  private autoDecision(text: string, run: RunRow, settings: Settings): RouteDecision {
    const session = this.store.getSession(run.sessionId);
    const sticky = this.stickyModel(text, run, settings);
    if (sticky) {
      const previous = this.store.listSessionRuns(run.sessionId, 6).find((item) => item.id !== run.id && item.modelId === sticky.id);
      return {
        kind: previous?.cursor.autoRole === 'coder' ? 'code' : 'chat', confidence: 1, signals: ['sticky'], modelId: sticky.id, modelName: sticky.name,
        switched: false, reason: `Staying on ${sticky.name} — this chat's model. Use /model or /auto to change it.`,
        unload: (this.residentLarge ?? []).filter((name) => name !== sticky.name && name !== sticky.apiName), trace: 'sticky',
        // Reasoning is per turn ("think harder"); it is not carried over.
        reasoning: false, role: previous?.cursor.autoRole && previous.cursor.autoRole !== 'fast' ? previous.cursor.autoRole : 'main', escalated: false,
      };
    }
    const models = this.autoCandidates(settings, run.agentId);
    const unsupported = new Set(Object.entries(settings.toolSupport).filter(([, ok]) => ok === false).map(([name]) => name));
    // A model without tool calls still answers chat. Skip it only when this turn probably needs a tool.
    const needsTools = likelyNeedsTools(text, { kb: this.hasKnowledge(run.agentId), code: session?.mode === 'code' || Boolean(run.cursor.stage) });
    const capable = needsTools ? models.filter((model) => !unsupported.has(model.apiName) && !unsupported.has(model.name)) : models;
    const pool = capable.length ? capable : models;
    const agent = this.store.getAgent(run.agentId);
    const activeTools = agent ? this.tools(agent, session?.mode || 'chat', undefined, undefined, false) : [];
    const toolTokens = activeTools.length ? estimateTokens(JSON.stringify(activeTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))), 'approx') : 0;
    const sysTokens = agent ? estimateTokens(agent.systemPrompt || '', 'approx') : 0;
    const histTokens = this.store.listMessages(run.sessionId).slice(-20).reduce((sum, m) => sum + estimateTokens(m.content || '', 'approx'), 0);
    const estimatedTokens = estimateTokens(text, 'approx') + sysTokens + toolTokens + histTokens;
    const auto = decideAuto({
      text, stage: run.cursor.stage, failures: this.localFailureCount(run.agentId), map: settings.autoModels, models: pool,
      estimatedTokens,
      pinId: session?.modelPin || run.cursor.messageModelId || null,
      residentLarge: [...new Set([...this.residentLarge, ...this.heldLarge.values()])],
      hebrew: this.replyLang(run.agentId, text) === 'he',
      fits: (model) => roughModelGiB(model.apiName) <= settings.ramBudgetGiB * 0.85,
    });
    return {
      kind: auto.role === 'coder' ? 'code' : auto.role === 'thinking' || auto.role === 'cloud' ? 'hard-reasoning' : 'chat',
      confidence: 0.8, signals: [auto.role], modelId: auto.modelId, modelName: auto.modelName,
      switched: auto.switched, reason: auto.reason, unload: auto.unload, trace: auto.trace,
      reasoning: auto.reasoning, role: auto.role, escalated: auto.escalated,
    };
  }

  /** Members whose cloud models are off only see local models. */
  private localOnly(agentId?: string) {
    const ownerId = agentId ? this.store.getAgent(agentId)?.ownerId : undefined;
    if (!ownerId || ownerId === OWNER_ID) return false;
    return getAccount(this.store, ownerId)?.limits.cloud === false;
  }

  private candidates(settings: Settings, agentId?: string): RouteCandidate[] {
    const providers = new Map(this.store.listProviders().map((provider) => [provider.id, provider]));
    const localOnly = this.localOnly(agentId);
    const minute = new Date().toISOString().slice(0, 16);
    const day = quotaDay();
    return this.store.listModels().filter((model) => model.enabled && !isNonChatModel(model)).flatMap((model) => {
      const provider = providers.get(model.providerId);
      if (!provider?.enabled) return [];
      if (localOnly && !model.local) return [];
      // While llama-server holds ~22 GiB of GTT, big Ollama models are off the table (host freeze otherwise).
      if (this.llama.blocks(model, provider)) return [];
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
    const user = (run.cursor.userMessageId && messages.find((message) => message.id === run.cursor.userMessageId))
      || [...messages].reverse().find((message) => message.role === 'user');
    const retrieved = strategy === 'retrieval' || strategy === 'hierarchical+retrieval' ? retrieve(this.store, this.vectors, run.sessionId, user?.content ?? '', 4) : [];
    const session = this.store.getSession(run.sessionId);
    const repoTask = Boolean(session?.mode === 'code' || session?.workshopId || run.cursor.stage || turnRoots(this.store, run, this.libraryDir).length > 0);
    const roleForBudget = run.cursor.autoRole || contractForAgent(agent.name)?.modelRole || 'main';
    let budget = run.cursor.budgetOverride || roleContextBudget(roleForBudget, model, { repoTask });
    const workshopNote = session?.workshopId ? workshopBrief(this.store, session.workshopId) : '';
    // Exactly this chat's attached workspaces: names, paths, branch, recent changes.
    const chatWorkspaces = run.cursor.worktreePath
      ? `\n\nThis helper runs in an isolated git worktree at ${run.cursor.worktreePath}. Read and edit files inside this worktree only.`
      : session
        ? await chatWorkspaceBrief(this.store, run.sessionId, session.ownerId || OWNER_ID).catch(() => '')
        : '';
    const stageNote = run.cursor.syncNote ? `\n\nWhat changed since you last looked:\n${run.cursor.syncNote}` : '';
    const roleNote = run.cursor.stage === 'plan'
      ? run.cursor.enteredPlanViaTool
        ? '\n\nPLAN MODE (read-only): investigate with read_file, grep, glob, list_dir, web_search, or read-only research helpers. File edits and mutating commands are locked. Once you know the exact files and steps, call exit_plan_mode with your plan and acceptance checks.'
        : '\n\nYou are planning a change to a shared repo. Pull it with repo_sync, summarize what changed, and consult the coder persona with that summary if one exists. Search the web when the task depends on current facts. Save the plan with the plan tool. Do not edit files yet.'
      : run.cursor.stage === 'implement'
        ? '\n\nEXECUTE STAGE: the plan is saved and editing tools are unlocked. Work through the plan steps methodically (marking each step doing and done with evidence via plan({ itemId: "1", status: "done", evidence: "..." })), spawn research/verify/coder helpers when helpful, verify your checks, then summarize what changed, what was verified, and main points to keep in mind for the future.'
        : '';
    const skillNote = skillCatalog(this.store, agent.id, user?.content ?? '');
    const hasKb = this.hasKnowledge(agent.id);
    const kbHint = hasKb ? '\n\nA knowledge base of the owner\'s documents is attached. When a question could be answered from it, call kb_search first and cite the numbered sources.' : '';
    const kbNote = hasKb ? await this.knowledgeNote(agent.id, user?.content ?? '') : '';
    // Hermes-style context: capped memory files, the project's own rule files, and a nudge to save a skill after hard tasks.
    const memoryNote = agent.memoryEnabled ? memoryBrief(this.store, agent.id) : '';
    const rulesNote = session ? projectRules(chatWorkspacePaths(this.store, run.sessionId, session.ownerId || OWNER_ID), disabledRules(this.store, run.sessionId)) : '';
    // Everything this persona can reach (found or not): notes about skills and teammates name what find_tools can surface.
    const cacheFriendly = this.cacheFriendly(model);
    const compactCoding = this.isCompactCoding(agent, session?.mode, run, model, settings);
    const offeredTools = this.tools(agent, session?.mode, run.cursor.stage, run.cursor.toolSubset, Boolean(run.cursor.helperId), run, true, cacheFriendly, compactCoding);
    const toolNames = offeredTools.map((tool) => tool.name);
    const menuTools = ((!cacheFriendly && run.cursor.noTools) || this.toolSupportOf(model) === false)
      ? []
      : this.tools(agent, session?.mode, run.cursor.stage, run.cursor.toolSubset, Boolean(run.cursor.helperId), run, false, cacheFriendly, compactCoding);
    const toolSteps = run.cursor.helperId || run.cursor.turn < 4 ? [] : this.store.listSteps(run.id).filter((step) => step.kind === 'tool');
    const nudge = run.cursor.helperId ? '' : skillNudge(run.cursor.turn, toolNames, {
      proposed: toolSteps.some((step) => step.name === 'propose_skill'),
      lastFailed: toolSteps.at(-1)?.status === 'failed',
      loaded: [...new Set(toolSteps.filter((step) => step.name === 'load_skill' && step.status === 'completed').map((step) => String((step.input as { slug?: unknown })?.slug ?? '')).filter(Boolean))],
    });
    const languageNote = languageHint(this.replyLang(agent, user?.content ?? ''));
    const recoveryNote = run.cursor.recovery?.note ?? '';
    // Persona awareness: let each persona know what teammates exist for consult_agent / spawn_agent.
    const teammates = compactCoding ? [] : this.store.listAgents(agent.ownerId || OWNER_ID).filter((a) => a.id !== agent.id && !a.hidden);
    const teamNote = [
      teammates.length && (toolNames.includes('consult_agent') || toolNames.includes('spawn_agent'))
        ? `\n\nAvailable teammates you can consult or delegate to: ${teammates.slice(0, 12).map((t) => `${t.name}${t.title ? ` (${t.title})` : ''}`).join(', ')}.`
        : '',
      toolNames.includes('spawn_agent') && !run.cursor.helperId
        ? '\n\nMini-agents: use spawn_agent with role="research" (fast 4B read-only search/facts), role="verify" (fast 4B test/build runner), or role="coder" (main model in an isolated git worktree) and pass structured goal/scope/done_when. Collect results with helpers({action:"wait"}).'
        : '',
      compactCoding ? '' : (() => {
        const caps: string[] = [];
        if (toolNames.includes('make_slides')) caps.push('make_slides (real designed .pptx decks: hero title, split picture slides, cards, big-number stats, charts, kickers, source lines, notes. Always give most slides a real picture via image.query (short English search words) and vary layouts; read the DESIGN CHECK in the result and fix it with revise_file_id before replying. Never ship a plain text-only deck)');
        if (toolNames.includes('fetch_image')) caps.push('fetch_image (search and download real high-resolution PNG/JPEG photos & scientific/medical diagrams from Wikimedia Commons or SearXNG as [file:<id>] to embed in slides or chat)');
        if (toolNames.includes('read_slides')) caps.push('read_slides (inspect .pptx decks)');
        if (toolNames.includes('read_image_text')) caps.push('read_image_text (run local OCR on images/screenshots)');
        if (toolNames.includes('understand_image')) caps.push('understand_image (full multimodal vision analysis: scene description, colors/shades/hex codes, charts/numbers, layout, and text)');
        if (toolNames.includes('browse')) caps.push('browse (live visual browser / surf tool: preferred over web_fetch for websites, stores, prices, product listings, JS-rendered pages, screenshots as [file:<id>] for understand_image, and click/fill/press/scroll)');
        if (toolNames.includes('create_project')) caps.push('create_project (spin up a brand-new local git repo + optional private GitHub repo and start building immediately)');
        if (toolNames.includes('vercel')) caps.push('vercel (inspect Vercel projects, deployments, build & runtime logs, env vars, Vercel Blob stores/diagnostics, update project settings/env vars, and trigger redeploys)');
        if (toolNames.includes('turbo_inspect')) caps.push('turbo_inspect (inspect Turborepo monorepos, turbo.json strict env pass-through, vercel.json, and Next.js Blob image config)');
        if (toolNames.includes('generate_image')) caps.push('generate_image (create images locally)');
        if (toolNames.includes('propose_skill')) caps.push('propose_skill + run_skill_script (create reusable skills and custom scripts shared across all personas)');
        return caps.length
          ? `\n\nActive built-in tools you can use right now regardless of persona: ${caps.join('; ')}. Never tell the user you cannot do these — call the tool directly. Take time to think deeply, verify your outputs, and loop to fix any mistake before giving your final answer.`
          : '';
      })(),
    ].join('');
    const searchEnabled = compactCoding ? (run.cursor.extraTools ?? []).includes('web_search') : toolNames.includes('web_search');
    const searchFirstNote = searchEnabled
      ? '\n\nWeb lookup rule: call web_search (SearXNG) first to discover real URLs and facts; never invent URLs. When opening a website, store/shopping page (AliExpress, Amazon, eBay, etc.), product listing, live prices, JS-heavy page, or whenever the user asks to browse/surf/open a site, prefer browse (live browser) instead of web_fetch. Reserve web_fetch for lightweight static articles, manuals, or docs. If web_fetch returns nav chrome, missing prices, empty text, or a block/403, switch immediately to browse — do not keep calling web_fetch.'
      : '';
    const sharedRepoNote = compactCoding && chatWorkspaces.trim() ? '' : sharedRepoBrief(this.store);
    const citeHint = compactCoding && !hasKb
      ? '\n\nTo deliver a created file to the user with a preview/download card, call share_file({ path }) and cite the returned [file:<id>] (do not start python http.server or give raw /workspaces paths).'
      : CITE_HINT;
    const fencedHint = compactCoding ? `\n\n${FENCED_EDIT_HINT}` : '';
    const todayIso = (run.startedAt || new Date().toISOString()).slice(0, 10);
    const dateNote = `\n\nCurrent date: ${todayIso} (current year is ${todayIso.slice(0, 4)}; use ${todayIso.slice(0, 4)} when searching for current news, models, prices, or releases).`;
    // llama-server reuses the longest cached prompt prefix, and the hybrid Qwen3.6 cannot roll back into the middle of
    // it. So for these models the prompt only ever grows within a run: the preamble and the per-run context are frozen
    // at the first step, and notes (recovery, steering, nudges) are pinned once after the message that was last when
    // they appeared, instead of being rewritten into an earlier message each step.
    const system = cacheFriendly
      ? `${agent.systemPrompt}${dateNote}${sharedRepoNote}${rulesNote}${memoryNote}${teamNote}${searchFirstNote}${kbHint}${citeHint}${HONESTY_RULE}${run.cursor.helperId ? '' : TASKS_HINT}${fencedHint}${languageNote}`
      : `${agent.systemPrompt}${dateNote}${sharedRepoNote}${chatWorkspaces}${rulesNote}${memoryNote}${teamNote}${searchFirstNote}${stageNote}${roleNote}${kbHint}${citeHint}${HONESTY_RULE}${run.cursor.helperId ? '' : TASKS_HINT}${fencedHint}${nudge}${languageNote}${recoveryNote}`;
    const preambleGuess = `${system}\n${notes.map((note) => note.content).join('\n')}`;
    if (model.providerId === 'prov_gemini' && estimateTokens(preambleGuess, 'gemini') > budget * 0.75) {
      const key = process.env.GEMINI_API_KEY;
      if (key) {
        const counted = await countGeminiTokens(key, model.apiName, preambleGuess, this.fetchImpl);
        if (counted && counted > budget) budget = Math.min(model.contextWindow, counted + settings.outputReserveTokens);
      }
    }
    const tok = model.tokenizer as 'gemma4';
    const toolSchemaTokens = menuTools.length
      ? estimateTokens(JSON.stringify(menuTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))), tok)
      : 0;
    const optionalParts = [{ label: 'knowledge base passages', text: kbNote }, { label: 'workshop brief', text: workshopNote }, { label: 'skills catalog', text: skillNote }].filter((part) => part.text.trim());
    const frozen = cacheFriendly && run.cursor.frozen?.modelId === model.id ? run.cursor.frozen : undefined;
    let turnContext = '';
    if (cacheFriendly) {
      if (frozen) {
        turnContext = frozen.turnContext;
      } else {
        const parts = [chatWorkspaces.trim(), ...optionalParts.map((part) => part.text.trim())];
        const cap = (run.cursor.budgetOverride || budget) * 0.4;
        while (parts.length > 1 && estimateTokens(parts.join('\n\n'), tok) > cap) parts.pop();
        turnContext = parts.filter(Boolean).join('\n\n');
      }
    }
    // Pin new notes once (split on blank lines so a growing recovery note does not repeat its earlier paragraphs).
    // For cache-friendly models, deliver mid-run steering via a pinned <note> at the tail instead of a new user turn
    // (a mid-run user turn strips <think> from earlier steps in Qwen's Jinja template and shifts the KV prefix).
    const isMidRunSteering = (m: Message) =>
      cacheFriendly && m.role === 'user' && m.runId === run.id && m.routingNote === 'Steering' && m.id !== user?.id;
    const pinnedNotes = [...(run.cursor.notes ?? [])];
    if (cacheFriendly) {
      const seen = new Set(pinnedNotes.map((note) => note.text));
      const anchorId = [...messages].reverse().find((m) => !isMidRunSteering(m))?.id ?? user?.id ?? '';
      for (const piece of [stageNote, roleNote, nudge, recoveryNote].flatMap((text) => text.split(/\n{2,}/)).map((text) => text.trim()).filter(Boolean)) {
        if (seen.has(piece)) continue;
        seen.add(piece);
        pinnedNotes.push({ anchorId, text: piece });
      }
    }
    const notesTokens = pinnedNotes.reduce((sum, note) => sum + estimateTokens(note.text, tok) + 8, 0);
    const turnContextTokens = turnContext ? estimateTokens(turnContext, tok) + 16 : 0;
    const runMessageIds = messages.filter((message) => !isMidRunSteering(message) && (message.runId === run.id || message.id === user?.id)).map((message) => message.id);
    const fullBudget = run.cursor.budgetOverride || budget;
    const toolDeduction = toolSchemaTokens <= fullBudget * 0.35 ? toolSchemaTokens : 0;
    const plan = planContext({
      strategy, contextWindow: model.contextWindow, practicalBudget: fullBudget - turnContextTokens - notesTokens - toolDeduction, outputReserve: settings.outputReserveTokens,
      system, optional: cacheFriendly ? [] : optionalParts,
      pinned: notes.filter((note) => note.pinned).map((note) => note.content),
      summaries, retrieved, tokenizer: tok,
      messages: this.uncoveredMessages(messages.filter((message) => !isMidRunSteering(message)), summaries, run.cursor.historyFloorId).map((message) => ({ id: message.id, role: message.role as 'user', content: message.content })),
      run: { messageIds: runMessageIds, digestIds: run.cursor.digestIds, historyFloorId: run.cursor.historyFloorId },
      breakdownHints: {
        systemPrompt: estimateTokens(`${citeHint}${HONESTY_RULE}${run.cursor.helperId ? '' : TASKS_HINT}${fencedHint}${searchFirstNote}${languageNote}${stageNote}${roleNote}${recoveryNote}`, tok),
        personaAndTools: estimateTokens(`${agent.systemPrompt}${teamNote}${skillNote}`, tok) + toolSchemaTokens,
        memory: estimateTokens(`${memoryNote}${kbHint}${kbNote}`, tok),
        files: estimateTokens(`${sharedRepoNote}${chatWorkspaces}${rulesNote}${workshopNote}`, tok),
      },
    });
    if (frozen) plan.preamble = frozen.system;
    const digestsBefore = run.cursor.digestIds?.length ?? 0;
    // Keep the run's context decisions on the run, so every later step renders the same prefix.
    const patch: Partial<RunCursor> = {
      digestIds: plan.digestIds,
      historyFloorId: plan.historyFloorId,
      ...(cacheFriendly ? { notes: pinnedNotes, frozen: frozen ?? { modelId: model.id, system: plan.preamble, turnContext } } : {}),
    };
    Object.assign(run.cursor, patch);
    const stored = this.store.getRun(run.id);
    if (stored) this.store.updateRun(run.id, { cursor: { ...stored.cursor, ...patch } });
    if ((plan.digestIds?.length ?? 0) > digestsBefore) {
      this.store.addStep({
        runId: run.id, kind: 'context', name: 'digest', status: 'completed', input: { digestIds: plan.digestIds },
        output: plan.notes.find((note) => note.startsWith('Condensed')) || 'Condensed older tool results.', toolCallId: null,
        turn: run.cursor.turn, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, error: null, startedAt: now(),
      });
    }
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
    // planContext receives practicalBudget minus tool schemas/notes so it reserves room for them when packing messages,
    // while breakdown.used ALREADY includes toolSchemaTokens in personaAndTools. Restore the full usable budget for the
    // UI breakdown so tool schemas are never double-counted (dropping the denominator from 31k -> 23k mid-run).
    const fullUsableBudget = Math.max(plan.breakdown.budget, Math.min(model.contextWindow, budget) - settings.outputReserveTokens);
    const uiBreakdown = {
      ...plan.breakdown,
      budget: fullUsableBudget,
      remaining: Math.max(0, fullUsableBudget - plan.breakdown.used),
    };
    this.lastContext.set(run.sessionId, { modelId: model.id, breakdown: uiBreakdown });
    this.bus.publish({ type: 'context', runId: run.id, sessionId: run.sessionId, used: uiBreakdown.used, budget: uiBreakdown.budget, breakdown: uiBreakdown });
    const recent = new Map(messages.map((message) => [message.id, message]));
    const runIds = new Set(runMessageIds);
    const chat: ChatMessage[] = [{ role: 'system', content: plan.preamble }];
    const chatIds: string[] = [''];
    for (const item of plan.recent) {
      const message = recent.get(item.id);
      if (!message) continue;
      const spoken = message.role === 'user' ? (readChatCommand(item.content).rest || item.content) : item.content;
      chat.push({
        role: message.role as ChatMessage['role'], content: spoken, toolCallId: message.toolCallId ?? undefined,
        name: message.toolName ?? undefined, toolCalls: (message.toolCalls as ToolCall[] | null) ?? undefined, imageUrl: message.imageUrl ?? undefined,
        // This run's reasoning goes back to llama-server (the template keeps it after the last user turn).
        reasoning: cacheFriendly && message.role === 'assistant' && runIds.has(message.id) ? message.thinking ?? undefined : undefined,
      });
      chatIds.push(message.id);
    }
    if (turnContext) {
      const userIndex = user ? chatIds.indexOf(user.id) : -1;
      const target = userIndex > 0 ? userIndex : chat.map((message) => message.role).lastIndexOf('user');
      if (target > 0) {
        chat[target] = { ...chat[target]!, content: `<turn_context>\n${turnContext}\n</turn_context>\n\n${chat[target]!.content}` };
      } else {
        chat[0] = { ...chat[0]!, content: `${chat[0]!.content}\n\n${turnContext}` };
      }
    }
    for (const note of cacheFriendly ? pinnedNotes : []) {
      let index = chatIds.indexOf(note.anchorId);
      if (index <= 0) index = chat.length - 1;
      chat[index] = { ...chat[index]!, content: `${chat[index]!.content}\n\n<note>\n${note.text}\n</note>` };
    }
    return { plan, messages: chat, cutNote };
  }

  /** Models served by llama-server get a turn-stable system prompt so its prompt cache hits. */
  private cacheFriendly(model: ModelRow): boolean {
    if (this.providerOverride) return false;
    const provider = this.store.getProvider(model.providerId);
    // The uncensored llama-server prefills at ~41 t/s: a changing system prompt re-processed the whole 16K chat each turn.
    return Boolean(provider && (isLlamaServerProvider(provider) || isUncensoredProvider(provider)));
  }

  private async maybeFold(sessionId: string, agent: Agent, model: ModelRow) {
    const settings = this.store.getSettings();
    const messages = this.store.listMessages(sessionId);
    const summaries = this.store.listSummaries(sessionId);
    const covered = new Set(summaries.flatMap((summary) => summary.covers));
    const usableBudget = Math.min(model.contextWindow, model.practicalBudget) - settings.outputReserveTokens;
    const session = this.store.getSession(sessionId);
    const activeTools = this.tools(agent, session?.mode || 'chat', undefined, undefined, false, undefined, false, this.cacheFriendly(model));
    const tok = model.tokenizer as 'approx';
    const toolTokens = activeTools.length ? estimateTokens(JSON.stringify(activeTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))), tok) : 0;
    const sysTokens = estimateTokens(agent.systemPrompt || '', tok);
    // Subtract system + tool schema overhead so auto-compact triggers when TOTAL context (including tools) nears 75-80%.
    const messageBudget = Math.max(1024, Math.floor((usableBudget - toolTokens - sysTokens) * 0.94));
    const ids = foldCandidates(messages.map((message) => ({ id: message.id, role: message.role as 'user', content: message.content })), covered, tok, summaryTriggerFor(model, settings.summaryTriggerTokens), messageBudget);
    if (!ids) return;
    const slice = messages.filter((message) => ids.includes(message.id));
    const transcript = slice
      .map((message) => `${message.role}: ${message.content.replace(/\s+/g, ' ').slice(0, message.role === 'tool' ? 220 : 400)}`)
      .join('\n')
      .slice(-4_500);
    const summary = await this.trySummarize(model, `Summarize this conversation segment in under 140 words. Keep names, decisions, numbers, and open questions.\n\n${transcript}`);
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
    this.lastContext.delete(sessionId);
    void created;
  }

  /** The language this turn is answered in: the persona override, the member's language, or the message's. */
  replyLang(agentOrId: Agent | string | undefined, text: string): 'en' | 'he' {
    const agent = typeof agentOrId === 'string' ? this.store.getAgent(agentOrId) : agentOrId;
    const prefs = getLanguage(this.store, agent?.ownerId || OWNER_ID);
    return replyLanguage(prefs, agent?.language, text);
  }

  private userText(run: RunRow): string {
    const messages = this.store.listMessages(run.sessionId);
    const user = (run.cursor.userMessageId && messages.find((message) => message.id === run.cursor.userMessageId)) || [...messages].reverse().find((message) => message.role === 'user');
    return user?.content ?? '';
  }

  /** Hebrew cleanup pass on a finished reply (small local models by default). Never fails the turn. */
  private async polishHebrew(run: RunRow, agent: Agent, model: ModelRow, text: string): Promise<string> {
    if (model.profileId === 'rehearsal' || run.cursor.helperId) return text;
    if (this.replyLang(agent, this.userText(run)) !== 'he' && !isHebrewText(text)) return text;
    const member = getLanguage(this.store, agent.ownerId || OWNER_ID);
    const setting = agent.hebrewCleanup && agent.hebrewCleanup !== 'inherit' ? agent.hebrewCleanup : member.cleanup;
    if (!wantsCleanup(setting, model)) return text;
    this.bus.publish({ type: 'status', runId: run.id, status: 'running', detail: 'Polishing the Hebrew' });
    const side = this.sideModel(model);
    const ask = async (target: ModelRow, prompt: string) => {
      const provider = this.provider(target);
      const sig = AbortSignal.timeout(60_000);
      const lane = this.localGpuLane(target, 'background');
      const release = lane ? await this.gpuGate.acquire(lane, sig) : null;
      let out = '';
      try {
        for await (const event of provider.complete({ model: target.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0, signal: sig, noThink: true, sampling: samplingFor(`${target.apiName} ${target.name}`, { thinking: false, task: 'general' }), maxTokens: Math.max(1536, Math.ceil(prompt.length / 2)) })) {
          if (event.type === 'token') out += event.text;
        }
      } finally {
        release?.();
      }
      return out;
    };
    // Off Qwen's single llama-server slot when a small Ollama model is there; the main model if that fails.
    const result = await cleanupHebrew(text, async (prompt) => {
      if (side.id === model.id) return ask(model, prompt);
      try { return await ask(side, prompt); } catch { return ask(model, prompt); }
    });
    if (result.changed) this.store.addLog('info', `Hebrew cleanup: ${result.before} → ${result.after} foreign words.`, run.id, 'router');
    else if (result.reason !== 'already clean') this.store.addLog('info', `Hebrew cleanup kept the original: ${result.reason}.`, run.id, 'router');
    return result.text;
  }

  /**
   * Side work (summaries, Hebrew polish) for a model on llama-server goes to a small Ollama model (gemma3:4b by
   * default, LA_SIDE_MODEL to change, "off" to disable), so it does not queue behind or evict the chat on Qwen's
   * single slot. Falls back to the main model when none is installed or llama-server would block it.
   */
  private sideModel(main: ModelRow): ModelRow {
    const wanted = (process.env.LA_SIDE_MODEL ?? 'gemma3:4b').trim().toLowerCase();
    if (wanted === 'off' || main.profileId === 'rehearsal') return main;
    const provider = this.store.getProvider(main.providerId);
    if (!provider || !(isLlamaServerProvider(provider) || isUncensoredProvider(provider))) return main;
    const usable = (item: ModelRow) => {
      const owner = this.store.getProvider(item.providerId);
      return item.enabled && !item.embedding && item.local && owner && !isLlamaServerProvider(owner) && !isUncensoredProvider(owner) && !this.llama.blocks(item, owner);
    };
    const models = this.store.listModels();
    return models.find((item) => usable(item) && (item.apiName.toLowerCase() === wanted || item.name.toLowerCase() === wanted))
      ?? models.find((item) => usable(item) && item.sizeClass === 'small' && /gemma/i.test(item.apiName))
      ?? main;
  }

  private titleQueue: string[] = [];
  private titleBusy = false;
  /** Queues chats for a generated title (after a run, or lazily for old chats a list shows). One at a time. */
  queueTitles(sessionIds: string[]) {
    // Engine tests count model calls exactly; titles are covered by their own unit tests.
    if (process.env.VITEST) return;
    for (const id of sessionIds) if (!this.titleQueue.includes(id)) this.titleQueue.push(id);
    if (this.titleBusy) return;
    this.titleBusy = true;
    void (async () => {
      try {
        while (this.titleQueue.length) {
          const id = this.titleQueue.shift()!;
          try { await this.titleSession(id); } catch { /* a title is never worth failing anything */ }
        }
      } finally { this.titleBusy = false; }
    })();
  }

  /** Names one chat from its first exchange, unless the user named it or it already has a generated title. */
  async titleSession(sessionId: string): Promise<string | null> {
    const session = this.store.getSession(sessionId);
    if (!session || !needsTitle(session.titleSource, session.title)) return null;
    const messages = this.store.listMessages(sessionId);
    const user = messages.find((m) => m.role === 'user' && cleanText(m.content));
    if (!user) return null;
    const reply = messages.find((m) => m.role === 'assistant' && m.seq > user.seq && cleanText(m.content) && !isNotice(m.content));
    if (!reply && session.titleSource === 'fallback') return null;
    const model = this.titleModel();
    let title: string | null = null;
    if (model) {
      try {
        const provider = this.provider(model);
        const runTitleComplete = async (prompt: string): Promise<string> => {
          const sig = AbortSignal.timeout(20_000);
          const lane = this.localGpuLane(model, 'background');
          const release = lane ? await this.gpuGate.acquire(lane, sig) : null;
          let out = '';
          try {
            for await (const event of provider.complete({ model: model.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0, noThink: true, sampling: samplingFor(`${model.apiName} ${model.name}`, { thinking: false, task: 'general' }), maxTokens: 40, signal: sig })) {
              if (event.type === 'token') out += event.text;
            }
          } finally {
            release?.();
          }
          return out;
        };
        const out = await runTitleComplete(titlePrompt(user.content, reply?.content ?? ''));
        title = parseTitle(out);
        if (!title && hasHebrew(out)) {
          const retryPrompt = `Translate the topic of this chat into a 3 to 6 word English title using only English words. Reply with the title only:\n\n${out.trim().slice(0, 200)}\nUser: ${cleanText(user.content).slice(0, 300)}`;
          title = parseTitle(await runTitleComplete(retryPrompt));
        }
      } catch { title = null; }
    }
    const source = title ? 'auto' : 'fallback';
    if (!title) {
      const fb = fallbackTitle(user.content);
      if (session.titleSource === 'auto' && hasHebrew(fb)) return null;
      title = fb;
    }
    if (session.titleSource === 'fallback' && source === 'fallback') return null;
    const fresh = this.store.getSession(sessionId);
    if (!fresh || fresh.titleSource === 'user') return null;
    this.store.setSessionTitle(sessionId, title, source);
    this.bus.publish({ type: 'title', sessionId, agentId: session.agentId, title } as never);
    return title;
  }

  /** The small local model for titles (LA_SIDE_MODEL, gemma3:4b by default); null = no model, use the fallback. */
  private titleModel(): ModelRow | null {
    const wanted = (process.env.LA_SIDE_MODEL ?? 'gemma3:4b').trim().toLowerCase();
    if (wanted === 'off') return null;
    const usable = (item: ModelRow) => {
      const owner = this.store.getProvider(item.providerId);
      return item.enabled && !item.embedding && item.local && item.profileId !== 'rehearsal' && owner && !isLlamaServerProvider(owner) && !isUncensoredProvider(owner) && !this.llama.blocks(item, owner);
    };
    const models = this.store.listModels();
    return models.find((item) => usable(item) && (item.apiName.toLowerCase() === wanted || item.name.toLowerCase() === wanted))
      ?? models.find((item) => usable(item) && item.sizeClass === 'small' && /gemma/i.test(item.apiName))
      ?? null;
  }

  private async trySummarize(model: ModelRow, prompt: string): Promise<string | null> {
    const side = this.sideModel(model);
    if (side.id !== model.id) {
      const text = await this.summarizeOn(side, prompt);
      if (text) return text;
      this.store.addLog('warn', `Summary on ${side.name} failed; using ${model.name}.`, undefined, 'context');
    }
    return this.summarizeOn(model, prompt);
  }

  private async summarizeOn(model: ModelRow, prompt: string): Promise<string | null> {
    if (model.profileId === 'rehearsal') return prompt.split('\n').filter((line) => line.startsWith('user:') || line.startsWith('assistant:')).slice(0, 6).join(' ').slice(0, 800) || 'Summary stored.';
    try {
      const provider = this.provider(model);
      let text = '';
      const timer = AbortSignal.timeout(30_000);
      const lane = this.localGpuLane(model, 'background');
      const release = lane ? await this.gpuGate.acquire(lane, timer) : null;
      try {
        for await (const event of provider.complete({ model: model.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0, noThink: true, sampling: samplingFor(`${model.apiName} ${model.name}`, { thinking: false, task: 'general' }), maxTokens: Math.min(280, maxTokensFor({ thinking: false, side: true })), signal: timer })) {
          if (event.type === 'token') text += event.text;
        }
      } finally {
        release?.();
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
      const sig = AbortSignal.timeout(60_000);
      const lane = this.localGpuLane(model, 'background');
      const release = lane ? await this.gpuGate.acquire(lane, sig) : null;
      try {
        for await (const event of provider.complete({ model: model.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0, noThink: true, sampling: samplingFor(`${model.apiName} ${model.name}`, { thinking: false, task: 'general' }), maxTokens: maxTokensFor({ thinking: false, side: true }), signal: sig })) {
          if (event.type === 'token') text += event.text;
        }
      } finally {
        release?.();
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
    const models = this.autoCandidates(settings, run.agentId);
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

  /** Top knowledge-base passages for a question, so small models that skip kb_search still see them. */
  private async knowledgeNote(agentId: string, text: string): Promise<string> {
    if (!text.trim() || !likelyNeedsTools(text, { kb: true })) return '';
    try {
      const hits = await searchKnowledge(this.store, readChatCommand(text).rest || text, { agentId, k: 3 });
      return hits.length ? `Knowledge base passages that may answer the latest question. Cite them by number:\n${formatCitations(hits)}` : '';
    } catch {
      return '';
    }
  }

  /** A fresh install has not scanned for Ollama yet: look once (briefly) before saying there is no model. */
  private async ensureSomeModel(agentId: string) {
    // OLLAMA_HOST moved (new port, restored or upgraded data folder): re-scan so chats stop going to the old address.
    const host = process.env.OLLAMA_HOST?.replace(/\/$/, '');
    const stored = this.store.getProvider('prov_ollama')?.baseUrl;
    const moved = Boolean(host && /^https?:\/\//.test(host) && !this.providerOverride && stored && stored !== `${host}/v1` && this.rescannedFor !== host);
    if (moved) this.rescannedFor = host!; // once per address, so an unreachable host never slows every turn
    if (!moved && this.candidates(this.store.getSettings(), agentId).length) return;
    await Promise.race([this.refreshModels(), new Promise((resolve) => setTimeout(resolve, 6000))]);
  }

  private refreshing: Promise<unknown> | null = null;
  private rescannedFor: string | null = null;
  private refreshModels() {
    if (this.providerOverride || this.refreshing) return this.refreshing;
    this.refreshing = scanMachine(this.fetchImpl, this.docker, this.store)
      .then((scan) => { this.residentLarge = scan.resident; })
      .catch(() => undefined)
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Pi/Cline-style lean coding prompt + compact core tool menu for local coding runs. */
  private isCompactCoding(agent: Agent, sessionMode: string | undefined, run: RunRow, model: ModelRow | null | undefined, settings: Settings): boolean {
    if (settings.compactCodingPrompt === false || process.env.LA_COMPACT_CODING === '0') return false;
    const slug = contractForAgent(agent.name)?.slug;
    if (slug === 'researcher' || agent.templateId === 'researcher') return false;
    if (!model?.local && process.env.LA_COMPACT_CODING !== '1') return false;
    return sessionMode === 'code' || Boolean(run.cursor.stage) || Boolean(run.cursor.worktreePath) || slug === 'coder' || agent.templateId === 'coder';
  }

  /**
   * What the model is offered. Small allowlists get everything; larger ones get a lean menu (declared tools plus
   * essentials), find_tools, and whatever this run found or was seeded with, appended in order so the prefix holds.
   * `all` returns every permitted tool (for executing a call), plus find_tools.
   */
  private tools(agent: Agent, sessionMode?: string, stage?: 'plan' | 'implement', subset?: string[], helper = false, run?: RunRow, all = false, stablePrefix = false, compactCoding = false): Tool[] {
    const { tools: allowed, servers } = this.allowedTools(agent, sessionMode, stage, subset, helper, stablePrefix);
    // Tools the persona's contract would reject are never offered (they only cost tokens and a failed call).
    const contract = contractForAgent(agent.name);
    const permitted = allowed.filter((tool) => contractAllows(contract, tool.name, servers));
    const hideDuplicateTasks = (list: Tool[]) => list.some((tool) => tool.name === 'plan') && !agent.toolAllowlist.includes('tasks')
      ? list.filter((tool) => tool.name !== 'tasks')
      : list;
    if (!leanMenuEnabled() || permitted.length <= LEAN_MIN_TOOLS || (stablePrefix && !compactCoding && permitted.length <= STABLE_FULL_MENU_MAX)) {
      return all ? permitted : hideDuplicateTasks(permitted);
    }
    const core = compactCoding
      ? new Set<string>(COMPACT_CODING_TOOLS)
      : new Set<string>([...agent.toolAllowlist, ...CORE_TOOLS]);
    if (stage === 'plan' || (stablePrefix && !helper && !subset)) {
      const planNames = compactCoding ? ['plan', 'enter_plan_mode', 'exit_plan_mode'] : ['plan', 'recall', 'consult_agent', 'enter_plan_mode', 'exit_plan_mode'];
      for (const name of planNames) core.add(name);
    }
    if (!compactCoding && core.has('make_slides')) core.add('slide_draft');
    if (stage === 'implement' || sessionMode === 'code' || (stablePrefix && !helper && !subset)) {
      for (const tool of CODING_TOOLS) {
        if (!compactCoding || COMPACT_CODING_TOOLS.includes(tool.name)) core.add(tool.name);
      }
    }
    if (permitted.some((tool) => tool.name === 'plan' && core.has('plan')) && !agent.toolAllowlist.includes('tasks')) core.delete('tasks');
    const base = permitted.filter((tool) => core.has(tool.name));
    const baseNames = new Set(base.map((tool) => tool.name));
    const discoverable = permitted.filter((tool) => !baseNames.has(tool.name));
    if (!discoverable.length) return permitted;
    if (run && run.cursor.extraTools === undefined) {
      const prev = stablePrefix
        ? this.store.listSessionRuns(run.sessionId, 8).find((r) => r.id !== run.id && r.agentId === agent.id && r.cursor.extraTools !== undefined)
        : undefined;
      if (prev?.cursor.extraTools) {
        const inherited = prev.cursor.extraTools.filter((name) => discoverable.some((tool) => tool.name === name));
        run.cursor.extraTools = inherited;
        const stored = this.store.getRun(run.id);
        if (stored && stored.cursor.extraTools === undefined) {
          this.store.updateRun(run.id, { cursor: { ...stored.cursor, extraTools: inherited } });
        }
      } else {
        this.seedTools(run, discoverable, servers);
      }
    }
    const extras = (run?.cursor.extraTools ?? []).map((name) => discoverable.find((tool) => tool.name === name)).filter((tool): tool is Tool => Boolean(tool));
    const finder = findToolsTool({
      discoverable, servers,
      offered: () => new Set([...baseNames, ...(run?.cursor.extraTools ?? [])]),
      add: (names) => { if (run) this.addRunTools(run, names); },
      skills: () => (permitted.some((tool) => tool.name === 'load_skill') ? listSkills(this.store, agent.id).filter((skill) => skill.enabled) : []),
    });
    if (all) return [...base, finder, ...discoverable];
    return [...base, finder, ...extras];
  }

  /** First step of a run: pre-load the few tools the request obviously needs, so it skips a find_tools round trip. */
  private seedTools(run: RunRow, discoverable: Tool[], servers: Map<string, string>) {
    const msgs = this.store.listMessages(run.sessionId);
    const user = run.cursor.userMessageId ? msgs.find((message) => message.id === run.cursor.userMessageId) : undefined;
    const session = this.store.getSession(run.sessionId);
    const prevUser = [...msgs].reverse().find((m) => m.role === 'user' && m.id !== user?.id && m.content.trim());
    const contextText = [
      user?.content?.slice(0, 1200) || '',
      session?.title && session.title !== 'New chat' ? session.title : '',
      prevUser?.content?.slice(0, 400) || '',
    ].filter(Boolean).join('\n');
    run.cursor.extraTools = [];
    if (contextText) this.seedToolsFromText(run, contextText, discoverable, servers);
  }

  /** Pre-load discoverable tools matching a request or steering text (append-only so prompt prefixes hold). */
  private seedToolsFromText(run: RunRow, text: string, discoverable: Tool[], servers: Map<string, string>) {
    if (!text.trim() || !discoverable.length) return;
    const seeds = rankTools(discoverable, text.slice(0, 2000), servers).filter((row) => row.score >= 3).slice(0, SEED_TOOLS).map((row) => row.tool.name);
    if (seeds.length) this.addRunTools(run, seeds);
  }

  /** Append tools to this run's menu (never removed, never reordered). */
  private addRunTools(run: RunRow, names: string[]) {
    const current = run.cursor.extraTools ?? [];
    const next = [...current, ...names.filter((name) => !current.includes(name))];
    run.cursor.extraTools = next;
    const stored = this.store.getRun(run.id);
    if (stored) {
      const merged = [...(stored.cursor.extraTools ?? []), ...next.filter((name) => !(stored.cursor.extraTools ?? []).includes(name))];
      run.cursor.extraTools = merged;
      this.store.updateRun(run.id, { cursor: { ...stored.cursor, extraTools: merged } });
    }
  }

  /** Sleep the backoff, then (for llama-server) poll /health until it answers or a minute passes. */
  private async waitForModelServer(provider: ProviderRow | null | undefined, delayMs: number, signal: AbortSignal) {
    const sleep = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    await sleep(delayMs);
    if (!provider?.baseUrl || !(isLlamaServerProvider(provider) || isUncensoredProvider(provider))) return;
    const root = provider.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    const until = Date.now() + Math.max(delayMs, Number(process.env.LA_HEALTH_WAIT_MS || 60_000));
    while (!signal.aborted && Date.now() < until) {
      const ok = await this.fetchImpl(`${root}/health`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
      if (ok) return;
      await sleep(Math.min(2000, Math.max(50, delayMs)));
    }
  }

  /** The main model (Auto's "main" role, else llama-server's model, else any candidate) that is known or assumed to call tools. */
  private toolCapableModel(settings: Settings, agentId: string, excludeId: string): ModelRow | undefined {
    const ok = (item: ModelRow | null | undefined): item is ModelRow => Boolean(item && item.id !== excludeId && item.enabled && !item.embedding && this.toolSupportOf(item) !== false);
    const candidates = this.candidates(settings, agentId).map((item) => this.store.getModel(item.id)).filter(ok);
    const mainName = (settings.autoModels?.main || '').trim().toLowerCase();
    const llama = this.llama.isActive() ? this.llama.model() : undefined;
    return candidates.find((item) => item.apiName.toLowerCase() === mainName || item.name.toLowerCase() === mainName)
      ?? (ok(llama) && candidates.some((item) => item.id === llama.id) ? llama : undefined)
      ?? candidates.find((item) => item.providerId !== 'prov_rehearsal');
  }

  /** Every tool this persona may use in this run (allowlist, member and helper limits, disabled connectors). */
  private allowedTools(agent: Agent, sessionMode?: string, stage?: 'plan' | 'implement', subset?: string[], helper = false, stablePrefix = false): { tools: Tool[]; servers: Map<string, string> } {
    const names = new Set(agent.toolAllowlist);
    names.add('create_file');
    names.add('write_file');
    names.add('read_file');
    names.add('list_dir');
    names.add('grep');
    names.add('glob');
    names.add('git');
    names.add('request_secret');
    names.add('read_output');
    names.add('run_skill_script');
    names.add('kb_search');
    names.add('load_skill');
    names.add('repo_sync');
    names.add('find_context');
    names.add('share_file');
    names.add('make_slides');
    names.add('read_slides');
    names.add('slide_draft');
    names.add('fetch_image');
    names.add('browse');
    names.add('web_search');
    names.add('web_fetch');
    if ((agent.ownerId || OWNER_ID) === OWNER_ID) {
      if (!agent.toolAllowlist.length || agent.templateId === 'assistant' || agent.toolAllowlist.includes('shell') || agent.toolAllowlist.includes('write_file')) {
        names.add('shell');
      }
      names.add('create_project');
      names.add('vercel');
      names.add('turbo_inspect');
      if (this.vpn?.isConfigured()) names.add('vpn');
    }
    if (this.ocrReader) names.add('read_image_text');
    if (this.imageAnalyzer) names.add('understand_image');
    for (const name of ['tasks', 'enter_plan_mode', 'exit_plan_mode', 'manage_timer', 'manage_trigger', 'spawn_agent', 'helpers', 'memory_file', 'search_chats', 'propose_skill', 'run_tool_script', 'time_now', 'think', 'set_focus']) names.add(name);
    if (this.store.getSettings().imageGen.mode !== 'off') names.add('generate_image');
    if (stage === 'plan' || (stablePrefix && !helper && !subset)) {
      for (const name of ['web_search', 'web_fetch', 'read_file', 'list_dir', 'grep', 'glob', 'plan', 'recall', 'consult_agent', 'enter_plan_mode', 'exit_plan_mode']) names.add(name);
    }
    if (stage === 'implement' || sessionMode === 'code' || (stablePrefix && !helper && !subset)) for (const tool of CODING_TOOLS) names.add(tool.name);
    if (stage === 'plan' && !stablePrefix) for (const blocked of PLAN_READONLY_BLOCKED) names.delete(blocked);
    // MCP connector tools: owner personas only (servers carry the owner's tokens). A persona gets a server's tools when its
    // allowlist names them (exact name, "mcp:<server>" or "mcp:*"), or when its gallery template lists that connector.
    const mcp = (agent.ownerId || OWNER_ID) === OWNER_ID ? this.mcpTools() : [];
    const templateConnectors = agent.templateId ? GALLERY.find((item) => item.id === agent.templateId)?.connectors ?? [] : [];
    for (const row of mcp) {
      if (names.has(row.tool.name) || names.has('mcp:*') || names.has(`mcp:${row.serverName}`) || (row.connector && templateConnectors.includes(row.connector))) names.add(row.tool.name);
    }
    if (agent.ownerId !== OWNER_ID) for (const name of MEMBER_DENIED_TOOLS) names.delete(name);
    // A helper run gets only the tools it was started with (never more than its persona allows).
    if (subset) for (const name of [...names]) if (!subset.includes(name)) names.delete(name);
    if (helper) for (const name of HELPER_DENIED) names.delete(name);
    // Built-in connectors the owner switched off take their tools with them.
    for (const name of disabledConnectorTools(this.store)) names.delete(name);
    const catalog = [...toolsFor([...names]), ...CODING_TOOLS, requestSecretTool(), readOutputTool(), skillScriptTool(), kbSearchTool(), loadSkillTool(), setFocusTool(), repoSyncTool(), findContextTool(), shareFileTool(() => this.libraryDir), imageTool({ dataDir: this.libraryDir, fetchImpl: this.fetchImpl, memory: this.memory }), fetchImageTool({ dataDir: this.libraryDir, fetchImpl: this.fetchImpl }),     ...slidesTools({ dataDir: this.libraryDir, photo: async (query, ctx) => ({ fileId: (await fetchWebImage({ store: this.store, dataDir: this.libraryDir, fetchImpl: this.fetchImpl, searxngUrl: this.store.getSettings().searxngUrl || process.env.SEARXNG_URL || '' }, { query, ownerId: ctx.ownerId, sessionId: ctx.sessionId ?? null, agentId: ctx.agentId ?? null, signal: ctx.signal })).file.id }), image: async (prompt, ctx) => { try { return { fileId: (await generateImage({ store: this.store, dataDir: this.libraryDir, fetchImpl: this.fetchImpl, memory: this.memory }, { prompt, ownerId: ctx.ownerId, shape: 'landscape', sessionId: ctx.sessionId ?? null, agentId: ctx.agentId ?? null, signal: ctx.signal })).file.id }; } catch { const searxngUrl = this.store.getSettings().searxngUrl || process.env.SEARXNG_URL || ''; return { fileId: (await fetchWebImage({ store: this.store, dataDir: this.libraryDir, fetchImpl: this.fetchImpl, searxngUrl }, { query: prompt, ownerId: ctx.ownerId, sessionId: ctx.sessionId ?? null, agentId: ctx.agentId ?? null, signal: ctx.signal })).file.id }; } } }), ...this.autonomy.tools(), tasksTool(), enterPlanModeTool(), exitPlanModeTool(), memoryFileTool(), searchChatsTool(), proposeSkillTool(), ...CONNECTOR_TOOLS(), ...vercelTools(), ...(this.ocrReader ? [ocrTool(this.ocrReader)] : []), ...(this.imageAnalyzer ? [understandImageTool(this.imageAnalyzer)] : []), ...this.extraTools, ...mcp.map((row) => row.tool)];
    const seen = new Set<string>();
    const vpnConfigured = Boolean(this.vpn?.isConfigured());
    const chosen = catalog.filter((tool) => {
      if (!names.has(tool.name) || seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    }).map((tool) => {
      const merged = mergeToolParameters(tool.name, tool.parameters);
      if (tool.name === 'shell' && !vpnConfigured) {
        const props = { ...((merged.properties as Record<string, unknown> | undefined) ?? {}) };
        delete props.use_vpn;
        return { ...tool, parameters: { ...merged, properties: props } };
      }
      return { ...tool, parameters: merged };
    });
    const servers = new Map(mcp.filter((row) => names.has(row.tool.name)).map((row) => [row.tool.name, row.serverName] as [string, string]));
    return { tools: names.has('run_tool_script') ? [...chosen, toolScript(chosen)] : chosen, servers };
  }

  private contextFor(run: RunRow, signal: AbortSignal): ToolContext {
    const agent = this.store.getAgent(run.agentId)!;
    const settings = this.store.getSettings();
    const member = agent.ownerId !== OWNER_ID;
    return {
      agent, workspace: run.cursor.worktreePath || agent.workspacePath, signal, docker: this.docker, workbench: this.workbench, browser: this.browser, computer: this.computer, vpn: this.vpn, fetchImpl: this.fetchImpl, searxngUrl: settings.searxngUrl || process.env.SEARXNG_URL || '',
      sandbox: settings.sandbox, store: this.store, depth: run.cursor.depth ?? 0,
      sessionId: run.sessionId, runId: run.id, codeApproval: settings.codeApproval,
      autoDiagnostics: settings.autoDiagnostics !== false && process.env.LA_POST_EDIT_DIAGNOSTICS !== '0',
      secretEnv: () => (member ? {} : this.vault.envFor(agent.id, `run:${run.id}`)),
      libraryDir: this.libraryDir,
      roots: turnRoots(this.store, run, this.libraryDir),
      setFocus: (focus, phase) => this.publishFocus(run.id, focus, phase),
      enterPlanMode: (goal, reason) => {
        const live = this.store.getRun(run.id);
        if (!live) return;
        const focus = goal ? `Planning: ${goal.slice(0, 60)}` : reason ? `Planning: ${reason.slice(0, 60)}` : 'Planning in read-only mode';
        this.store.updateRun(run.id, {
          cursor: { ...live.cursor, stage: 'plan', workPhase: 'planning', focus, enteredPlanViaTool: true },
        });
        this.publishFocus(run.id, focus, 'planning');
      },
      exitPlanMode: ({ steps, checks, summary }) => {
        const cleanSteps = (steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 20);
        if (run.sessionId && cleanSteps.length) {
          replacePlan(this.store, run.sessionId, cleanSteps, run.id);
        }
        const live = this.store.getRun(run.id);
        if (live) {
          const focus = summary ? summary.slice(0, 60) : 'Executing plan';
          this.store.updateRun(run.id, {
            cursor: {
              ...live.cursor,
              stage: 'implement',
              workPhase: 'editing',
              focus,
              enteredPlanViaTool: false,
              ...(checks?.length ? { acceptance: checks } : {}),
            },
          });
          this.publishFocus(run.id, focus, 'editing');
        }
      },
      // The owner's GitHub token, SSH key and vault never reach a member's persona.
      gitIdentity: member ? { name: agent.name, email: 'agent@local-agent.invalid' } : { ...gitIdentity(this.store.getSettings()), token: this.vault.valueByName('GITHUB_TOKEN') },
      consult: (name, question) => this.consult(run, name, question),
      sendPersonaMessage: async (to, text, files) => {
        const res = await dispatchPersonaMessage({
          store: this.store,
          bus: this.bus,
          startTurn: (input) => this.startTurn(input),
          isRunActive: (id) => this.inflight.has(id),
          fromAgent: agent,
          fromSessionId: run.sessionId,
          fromRunId: run.id,
          currentHop: run.cursor.hop ?? 0,
          kind: 'message',
          to,
          text,
          files,
          signal,
        });
        return res.note;
      },
      handoffToPersona: async (to, task, files) => {
        const res = await dispatchPersonaMessage({
          store: this.store,
          bus: this.bus,
          startTurn: (input) => this.startTurn(input),
          isRunActive: (id) => this.inflight.has(id),
          fromAgent: agent,
          fromSessionId: run.sessionId,
          fromRunId: run.id,
          currentHop: run.cursor.hop ?? 0,
          kind: 'handoff',
          to,
          text: task,
          files,
          signal,
        });
        return res.note;
      },
    };
  }

  private async consult(run: RunRow, name: string, question: string) {
    if ((run.cursor.depth ?? 0) >= 1) throw new Error('Nested consultations stop at one level.');
    const other = this.store.getAgentByName(name, this.store.getAgent(run.agentId)?.ownerId ?? OWNER_ID);
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

  private viaOllama(model: ModelRow): boolean {
    if (this.providerOverride) return true;
    const provider = this.store.getProvider(model.providerId);
    return !provider || isOllamaProvider(provider);
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
    this.bus.publish({ type: 'secret', runId: run.id, sessionId: run.sessionId, agentId: run.agentId, request });
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
    // The heartbeat timer can outlive the database during shutdown; a closed store means there is nothing to renew.
    if (!this.store.isOpen) return;
    this.store.updateRun(runId, { leaseOwner: this.instanceId, heartbeatAt: now() });
  }

  /** A model that needs most of the GPU/RAM: a large local model, or anything served by llama-server. */
  private isBig(model: ModelRow): boolean {
    if (!model.local) return false;
    if (model.sizeClass === 'large') return true;
    const provider = this.store.getProvider(model.providerId);
    return Boolean(provider && (isLlamaServerProvider(provider) || isUncensoredProvider(provider)));
  }

  private rememberLarge(runId: string, modelId: string) {
    const model = this.store.getModel(modelId);
    // Map.set on an existing key keeps its place in line, so a run that switches model mid-run keeps its turn.
    if (model && this.isBig(model)) this.heldLarge.set(runId, model.name);
  }

  /**
   * Big-model queue: only one big model at a time. Runs line up in the order they were routed; a run waits
   * while any run ahead of it holds a different big model, then loads. Two big models together froze the
   * mini PC (GTT memory cannot be swapped or OOM-killed), so this never gives up early and loads anyway.
   */
  private async waitForLarge(runId: string, name: string, signal?: AbortSignal) {
    const ahead = () => {
      const blocking: string[] = [];
      for (const [id, held] of this.heldLarge) {
        if (id === runId) break;
        if (held !== name) blocking.push(held);
      }
      return blocking;
    };
    let blocking = ahead();
    if (!blocking.length) return;
    const started = Date.now();
    let shown = '';
    while (blocking.length) {
      if (signal?.aborted) throw new StopError();
      if (Date.now() - started > LARGE_WAIT_MS) {
        throw new Error(`Gave up after ${Math.round(LARGE_WAIT_MS / 60_000)} min waiting for ${blocking[0]} to finish in another chat. Your chat is kept; send again when it is done.`);
      }
      const detail = `Waiting for ${blocking[0]} to finish (queued${blocking.length > 1 ? `, ${blocking.length} ahead` : ''}).`;
      if (detail !== shown) {
        shown = detail;
        const waitInfo = { kind: 'queue', behind: blocking[0], ahead: blocking.length, since: new Date(started).toISOString() };
        const live = this.liveStreams.get(runId) ?? { text: '', thinking: '', status: 'waiting' };
        live.status = 'waiting';
        live.detail = detail;
        live.waitInfo = waitInfo;
        this.liveStreams.set(runId, live);
        this.bus.publish({ type: 'status', runId, status: 'waiting', detail, waitInfo } as never);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      blocking = ahead();
    }
    const live = this.liveStreams.get(runId);
    if (live) { live.status = 'running'; live.detail = undefined; live.waitInfo = undefined; }
    this.bus.publish({ type: 'status', runId, status: 'running' });
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

  /**
   * RAM admission for a local model call. Waits (concurrently with other jobs) until the model fits the budget.
   * If it can never fit, tries a smaller context, then a smaller local model, then fails with a clear message.
   */
  private async admitLocal(run: RunRow, model: ModelRow, numCtx: number, signal: AbortSignal): Promise<{ lease: Lease | null; numCtx: number } | { switchTo: ModelRow; reason: string }> {
    const memory = this.memory;
    if (!memory) return { lease: null, numCtx };
    const kind = run.cursor.background ? 'background' : 'chat';
    const onWait = (ahead: number, info?: import('./memory.js').WaitInfo) => {
      const detail = info?.reason || (ahead ? `Waiting for memory, ${ahead} ahead` : 'Waiting for memory to free up');
      const live = this.liveStreams.get(run.id) ?? { text: '', thinking: '', status: 'waiting' };
      live.status = 'waiting';
      live.detail = detail;
      live.waitInfo = info;
      this.liveStreams.set(run.id, live);
      this.bus.publish({ type: 'status', runId: run.id, status: 'waiting', detail, waitInfo: info });
    };
    // GTT/RAM admission: when this model would have to load and does not fit now, prefer a model that is already
    // resident (a loaded Ollama model or llama-server) over queueing. Never a third resident model.
    const firstBytes = await memory.estimateModel(model.apiName, numCtx);
    if (firstBytes && !run.cursor.switched && !(await memory.fitsNow({ kind, label: model.name, model: model.apiName, bytes: firstBytes }))) {
      const loaded = new Set((await memory.usage()).loaded.map((item) => item.name));
      const resident = this.candidates(this.store.getSettings(), run.agentId).find((candidate) => {
        if (!candidate.local || candidate.id === model.id) return false;
        const row = this.store.getModel(candidate.id);
        const provider = row ? this.store.getProvider(row.providerId) : null;
        if (!row || !provider || isUncensoredProvider(provider)) return false;
        return loaded.has(row.apiName) || isLlamaServerProvider(provider);
      });
      const row = resident ? this.store.getModel(resident.id) : null;
      if (row) {
        this.store.addLog('info', `${model.name} does not fit GTT/RAM now; using already-loaded ${row.name}.`, undefined, 'memory');
        return { switchTo: row, reason: `Switched to ${row.name}: it is already loaded, and ${model.name} does not fit in memory right now.` };
      }
    }
    let last: unknown = null;
    for (const ctx of [...new Set([numCtx, Math.min(numCtx, 8192)])]) {
      const bytes = await memory.estimateModel(model.apiName, ctx);
      if (!bytes) return { lease: null, numCtx };
      try {
        const lease = await memory.admit({ kind, runId: run.id, label: model.name, model: model.apiName, bytes, onWait, signal });
        const live = this.liveStreams.get(run.id);
        if (live) { live.status = 'running'; live.detail = undefined; live.waitInfo = undefined; }
        this.bus.publish({ type: 'status', runId: run.id, status: 'running' });
        if (ctx !== numCtx) this.store.addLog('warn', `Using ${model.name} with a ${ctx}-token context so it fits the RAM budget.`, undefined, 'router');
        return { lease, numCtx: ctx };
      } catch (error) {
        if (error instanceof BudgetError && !error.neverFits && signal.aborted) throw new StopError();
        if (!(error instanceof BudgetError) || !error.neverFits) throw error;
        last = error;
      }
    }
    const budget = this.store.getSettings().ramBudgetGiB * 1024 ** 3;
    for (const candidate of this.candidates(this.store.getSettings(), run.agentId)) {
      if (!candidate.local || candidate.id === model.id) continue;
      const bytes = await memory.estimateModel(candidate.apiName, 8192);
      if (bytes && bytes < budget * 0.9) {
        const row = this.store.getModel(candidate.id);
        if (row) return { switchTo: row, reason: `Switched to ${row.name} — ${model.name} does not fit the ${this.store.getSettings().ramBudgetGiB} GB RAM budget.` };
      }
    }
    throw last instanceof Error ? last : new Error(`${model.name} does not fit the RAM budget.`);
  }

  /** After a call, compare Ollama's reported size for the model with the estimate and nudge future estimates. */
  private async calibrateLease(lease: Lease, apiName: string, numCtx: number | undefined) {
    lease.release();
    const memory = this.memory;
    if (!memory || !numCtx) return;
    try {
      const loaded = (await memory.usage()).loaded.find((item) => item.name === apiName);
      if (loaded?.sizeBytes && (loaded.contextLength == null || loaded.contextLength === numCtx)) {
        const key = `ollama:${apiName}`;
        memory.calibrate(key, lease.bytes / memory.factor(key), loaded.sizeBytes);
      }
    } catch { /* calibration is best effort */ }
  }

  /** Unload heavy (> 4 GiB) Ollama models while preserving resident small sidecars (e.g. qwen3.5:4b, nomic-embed-text). */
  private async unloadHeavyOllama(keepApiName?: string) {
    const base = ollamaRoot();
    const byName = new Map(this.store.listModels().map((m) => [m.apiName, m]));
    const heavy = new Set<string>();
    try {
      const res = await this.fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.json() as { models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number }> };
        for (const item of body.models ?? []) {
          const name = String(item.model || item.name || '').trim();
          if (!name || name === keepApiName) continue;
          const bytes = Number(item.size_vram || item.size || 0);
          const row = byName.get(name);
          const gib = row ? modelGiB(row) : (bytes > 0 ? bytes / 1024 ** 3 : modelGiB({ apiName: name, typicalQ4GiB: null }));
          if (gib > OLLAMA_SIDE_MAX_GIB) heavy.add(name);
        }
      }
    } catch { /* best-effort /api/ps lookup */ }
    for (const name of this.residentLarge) {
      if (!name || name === keepApiName) continue;
      const row = byName.get(name);
      if (!row || modelGiB(row) > OLLAMA_SIDE_MAX_GIB) heavy.add(name);
    }
    if (heavy.size) {
      const names = [...heavy];
      await this.unload(names);
      this.residentLarge = this.residentLarge.filter((n) => !heavy.has(n));
    }
  }

  private async unload(names: string[]) {
    const base = ollamaRoot();
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
      approvalMode: specific.approvalMode,
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
  const other = store.getAgentByName(String(parseArgs(call.arguments).agent || ''), store.getAgent(fallback)?.ownerId ?? OWNER_ID);
  return other?.id || fallback;
}

function stageFor(store: Store, run: RunRow): 'plan' | 'implement' | undefined {
  if ((run.cursor.depth ?? 0) > 0) return undefined;
  if (run.cursor.stage === 'plan' || run.cursor.stage === 'implement') return run.cursor.stage;
  const priorParent = store.listSessionRuns(run.sessionId, 5).find((r) => r.id !== run.id && !r.parentRunId);
  if (priorParent?.cursor.stage === 'implement') {
    const plan = readPlan(store, run.sessionId);
    if (plan?.items.some((item) => item.status === 'pending' || item.status === 'doing')) return 'implement';
  }
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

function isToolParseError(message: string): boolean {
  return /failed to parse tool call arguments as json|json\.exception\.parse_error|invalid tool call/i.test(message);
}

/** A dropped or refused connection, or a server that is restarting: worth a retry on the same model after a pause. */
export function isTransientModelError(message: string): boolean {
  if (isToolParseError(message)) return false;
  return /fetch failed|\bterminated\b|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|\(503\)|status 503|loading model/i.test(message);
}
function transientRetryCap() { return Math.max(0, Number(process.env.LA_TRANSIENT_RETRIES ?? 4)); }
/** 2s, 4s, 8s, 16s… capped at 30s (LA_TRANSIENT_BASE_MS scales it). */
export function transientDelayMs(attempt: number) { return Math.min(30_000, Number(process.env.LA_TRANSIENT_BASE_MS ?? 2000) * 2 ** (attempt - 1)); }

function isProviderOutage(message: string): boolean {
  if (isToolParseError(message)) return false;
  return /\(429\)|\(5\d\d\)|status 429|status 5\d\d|rate limit|too many requests/i.test(message);
}

export function isRefusalText(text: string): boolean {
  const value = text.trim();
  if (value.length < 12 || value.length > 4000) return false;
  return (
    /\b(i[' ]?m sorry|i am sorry|i can[' ]?t (help|assist)|i cannot (help|assist)|unable to help|won[' ]?t be able to|can[' ]?t comply|cannot comply)\b/i.test(value)
    || /\b(i (?:cannot|can't|won't|will not) (?:provide|generate|create|perform|assist with|help with|fulfil|fulfill)|not allowed to|not permitted to|against (?:my|our) (?:safety )?policy|safety (?:guidelines|policy)|content (?:filter|policy)|policy restrictions?|refuse to|terms of service|terms and (?:conditions|policies)|due to (?:terms|polic(?:y|ies))|prohibited by|disallowed by|violat(?:e|es|ing) (?:my|the|our) (?:safety )?(?:policy|guidelines|terms)|cannot (?:access|search|browse) (?:that|those|the) (?:site|website|platform)|restricted (?:website|platform|action))\b/i.test(value)
    || /אסור לי|לא אוכל לעזור|לא יכול לעזור|אין לי אפשרות|מדיניות בטיחות|בהתאם למדיניות|המערכת לא מאפשר/i.test(value)
  );
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

function turnRoots(store: Store, run: RunRow, dataDir = '') {
  if (run.cursor.worktreePath) return [{ label: 'worktree', path: run.cursor.worktreePath, write: true }];
  const session = store.getSession(run.sessionId);
  // Shared projects and workshops are the owner's. A member's persona works in its own workspace only.
  if ((store.getAgent(run.agentId)?.ownerId ?? OWNER_ID) !== OWNER_ID) return [];
  const write = run.cursor.stage === 'implement' || (session?.mode === 'code' && run.cursor.stage !== 'plan');
  const roots = new Map<string, { label: string; path: string; write: boolean }>();
  for (const repo of listSharedRepos(store)) roots.set(repo.path, { label: repo.label, path: repo.path, write });
  if (session?.workshopId) {
    for (const project of getWorkshop(store, session.workshopId)?.projects ?? []) {
      roots.set(project.path, { label: project.label, path: project.path, write });
    }
  }
  for (const root of chatWorkspacePaths(store, run.sessionId, OWNER_ID)) roots.set(root.path, { label: root.label, path: root.path, write });
  return [...roots.values()].filter((root) => !dataDir || !foreignPath(dataDir, OWNER_ID, root.path));
}

/** Tools a script may not call: no nesting, no helpers or scheduling, nothing that pauses for the user. */
const SCRIPT_DENIED = new Set(['run_tool_script', 'spawn_agent', 'helpers', 'manage_timer', 'manage_trigger', 'request_secret', 'request_folder', 'propose_skill', 'handoff_cli']);
const SCRIPT_MAX_STEPS = 10;
/** How long a chat waits in the big-model queue (or for the other llama-server model) before failing clearly. */
/** How long a run waits for the other llama-server model's chat (one step on the uncensored model is a few minutes). */
function llamaWaitMs() { return Number(process.env.LA_LLAMA_WAIT_MS ?? 2 * 60_000); }
const LARGE_WAIT_MS = Number(process.env.LA_LARGE_WAIT_MS || 15 * 60_000);

/**
 * Several tool calls in one step, run in order. Plain data, not code: each step names an allowed tool and its args,
 * and string args may use {{name}} for an earlier step's output. If any step would need approval, the whole script asks once.
 */
export function toolScript(available: Tool[]): Tool {
  const byName = new Map(available.filter((tool) => !SCRIPT_DENIED.has(tool.name)).map((tool) => [tool.name, tool]));
  const stepsOf = (args: Record<string, unknown>) => {
    const steps = Array.isArray(args.steps) ? args.steps as { tool?: unknown; args?: unknown; save_as?: unknown }[] : [];
    if (!steps.length) throw new Error('Pass steps: [{ tool, args, save_as }].');
    if (steps.length > SCRIPT_MAX_STEPS) throw new Error(`At most ${SCRIPT_MAX_STEPS} steps per script.`);
    return steps.map((step, index) => {
      const name = String(step.tool || '');
      const tool = byName.get(name);
      if (!tool) throw new Error(`Step ${index + 1}: ${name || 'a tool'} is not allowed in a script here. Allowed: ${[...byName.keys()].join(', ')}.`);
      const stepArgs = step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args as Record<string, unknown> : {};
      return { tool, args: stepArgs, saveAs: step.save_as ? String(step.save_as).replace(/[^\w-]/g, '').slice(0, 32) : `step${index + 1}` };
    });
  };
  const fill = (value: unknown, vars: Map<string, string>): unknown => {
    if (typeof value === 'string') return value.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key: string) => (vars.get(key) ?? '').slice(0, 4000));
    if (Array.isArray(value)) return value.map((item) => fill(item, vars));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fill(item, vars)]));
    return value;
  };
  return {
    name: 'run_tool_script',
    description: `Run up to ${SCRIPT_MAX_STEPS} of your tools in one step, in order: steps [{ tool, args, save_as }]. A string arg may contain {{save_as}} (or {{step1}}) to use an earlier output. Stops at the first error unless continue_on_error. Use it for mechanical sequences (read several files, search then fetch); it cannot start helpers or schedule anything.`,
    parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' }, save_as: { type: 'string' } }, required: ['tool'] } }, continue_on_error: { type: 'boolean' } }, required: ['steps'], additionalProperties: false },
    mutates: (args) => { try { return stepsOf(args).some((step) => step.tool.mutates(step.args)); } catch { return false; } },
    approval: (args, ctx) => {
      let steps;
      try { steps = stepsOf(args); } catch { return null; }
      const asks = steps.map((step) => step.tool.approval(step.args, ctx)).filter(Boolean);
      return asks.length ? `Run a ${steps.length}-step tool script: ${steps.map((step) => step.tool.name).join(' → ')}. Needs approval for: ${asks.join('; ')}` : null;
    },
    async execute(args, ctx) {
      const steps = stepsOf(args);
      const vars = new Map<string, string>();
      const log: string[] = [];
      for (const [index, step] of steps.entries()) {
        if (ctx.signal.aborted) throw new StopError();
        const filled = fill(step.args, vars) as Record<string, unknown>;
        try {
          const output = await step.tool.execute(filled, { ...ctx, toolCallId: ctx.toolCallId ? `${ctx.toolCallId}:${index}` : undefined });
          vars.set(step.saveAs, output);
          log.push(`[${index + 1}] ${step.tool.name} → ${step.saveAs}\n${output.slice(0, 3000)}`);
        } catch (error) {
          log.push(`[${index + 1}] ${step.tool.name} failed: ${(error as Error).message}`);
          if (!args.continue_on_error) break;
        }
      }
      return log.join('\n\n').slice(0, 16_000);
    },
  };
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
      const chars = [...message.content];
      const total = chars.length;
      const offset = Math.max(0, Number(args.offset || 0));
      const priorReads = ctx.runId
        ? ctx.store.listSteps(ctx.runId).filter((s) => s.kind === 'tool' && s.name === 'read_output' && s.status === 'completed' && String((s.input as { message?: unknown })?.message || '') === message.id).length
        : 0;
      const limit = Math.min(16_000, Math.max(200, Number(args.limit || 8000)));
      const end = Math.min(total, offset + (priorReads >= 2 ? 16_000 : limit));
      if (offset >= total) {
        return `[offset ${offset} is past the end of stored output (${total} characters total). Do not call read_output on this message again — use what you already read.]`;
      }
      const tail = priorReads >= 2
        ? `\n[You have already called read_output ${priorReads + 1} times on ${message.id}. Do NOT call read_output on ${message.id} again — synthesize your answer from what you have.]`
        : end < total
          ? `\n…more from offset ${end} (${total - end} characters remaining)`
          : `\n[end of stored output — ${total} characters total. Do not call read_output on this message again.]`;
      return `[characters ${offset}..${end} of ${total}]\n${chars.slice(offset, end).join('')}${tail}`;
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

export const BAD_ARGS_CAP = 3;

/**
 * Null when the arguments parse to an object; otherwise a structured error the model can act on: what broke, where,
 * how big the payload was, how many tries are left, and what to do (split big payloads; decks go through slide_draft).
 */
export function argumentsError(name: string, raw: string | undefined, attempt = 1, cap = BAD_ARGS_CAP): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  let problem: string;
  let position: number | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return null;
    problem = `arguments must be a JSON object like {"key": "value"}, not ${Array.isArray(parsed) ? 'an array' : typeof parsed}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    problem = `not valid JSON: ${detail.replace(/\s+in JSON.*$/, '')}`;
    const found = Number(detail.match(/position (\d+)/)?.[1]);
    if (Number.isFinite(found)) position = found;
  }
  const truncatedLarge = text.length > 10_000 && name !== 'make_slides';
  const big = text.length > 6000;
  const fix = truncatedLarge
    ? `TRUNCATED BY OUTPUT LIMIT: your ${name} call was ${text.length.toLocaleString('en-US')} characters and got cut off before the JSON closed. Do NOT retry a huge single-file dump, and do NOT wrap it in a shell heredoc (shell max is 4,000 chars) or a generator script. Instead: split into modular files (e.g. index.html, style.css, app.js) OR write <=150 lines (~5,000 chars) first with write_file and add remaining sections with write_file({ path, content, append: true }) or apply_patch.`
    : [
        'Call the tool again with one valid JSON object: escape double quotes and backslashes inside strings, write newlines as \\n, close every brace and bracket.',
        big ? (name === 'make_slides' ? 'The deck is too big for one call: use slide_draft (start, then one add per slide) and make_slides {draft_id}.' : 'The payload is large: split it (write <=150 lines first with write_file, then append: true or apply_patch for the rest).') : '',
      ].filter(Boolean).join(' ');
  const info = {
    error: 'invalid_tool_arguments', tool: name, problem, length: text.length,
    ...(position !== undefined ? { position, near: text.slice(Math.max(0, position - 40), position + 20).replace(/\s+/g, ' ') } : {}),
    attempt, attempts_left: Math.max(0, cap - attempt), fix,
  };
  return `Nothing ran: the arguments for ${name} were ${problem.startsWith('not valid') ? 'not valid JSON' : 'not a JSON object'} (${text.length} characters). ${fix}\n${JSON.stringify(info)}`;
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

/** Resident size from the tag (Q4 weights ≈ 0.6 GB per billion parameters plus runtime); unknown sizes count as small. */
/** Personal and platform tools every persona keeps whatever its contract lists (they still go through approval tiers and member restrictions): reminders, triggers, time, task list, memory, skills, helpers. */
const LOOP_NUDGE = 3;
const LOOP_STOP = 4;
/** JSON with sorted keys at every level, so {a,b} and {b,a} compare equal. */
export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sort(value ?? {}));
}

const CONTRACT_ALWAYS = new Set([
  'request_secret', 'kb_search', 'load_skill', 'manage_timer', 'manage_trigger',
  'time_now', 'tasks', 'plan', 'enter_plan_mode', 'exit_plan_mode', 'set_focus', 'think', 'memory_file', 'search_chats', 'web_search', 'web_fetch',
  'spawn_agent', 'helpers', 'propose_skill', 'read_output', 'run_skill_script',
  'find_context', 'share_file', 'make_slides', 'read_slides', 'slide_draft', 'fetch_image', 'browse', 'vpn', 'create_project', 'vercel', 'turbo_inspect', 'read_image_text', 'understand_image', 'generate_image', 'repo_sync',
  'create_file', 'write_file', 'read_file', 'list_dir', 'grep', 'glob', 'apply_patch', 'shell', 'git', 'find_tools',
]);

/** A contract limits a persona's built-in tools; connector (MCP) tools it was granted by allowlist or template stay callable. */
function contractAllows(contract: { tools: string[] } | null, name: string, servers: Map<string, string>): boolean {
  if (!contract || !contract.tools.length) return true;
  return contract.tools.includes(name) || CONTRACT_ALWAYS.has(name) || servers.has(name);
}

export function roughModelGiB(apiName: string): number {
  const size = Number(apiName.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? 4);
  return size * 0.6 + 1;
}

/** Fallback parser for leaked Qwen3 XML (<tool_call> <function=name> <parameter=k>v</parameter> </function> </tool_call>) or JSON <tool_call>{...}</tool_call>, plus stripping truncated unclosed <tool_call> blocks. */
export function extractInlineToolCalls(raw: string): { text: string; calls: ToolCall[]; truncated: boolean } {
  const calls: ToolCall[] = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let cleaned = raw.replace(blockRe, (full, body: string) => {
    const fnMatch = /<function\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/function>/i.exec(body);
    if (fnMatch) {
      const name = fnMatch[1]!.trim();
      const args: Record<string, unknown> = {};
      const paramRe = /<parameter\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/parameter>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(fnMatch[2]!)) !== null) {
        const key = pm[1]!.trim();
        const val = pm[2]!.trim();
        if (val === 'true') args[key] = true;
        else if (val === 'false') args[key] = false;
        else if (/^-?\d+(?:\.\d+)?$/.test(val) && val.length < 16) args[key] = Number(val);
        else if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
          try { args[key] = JSON.parse(val); } catch { args[key] = val; }
        } else {
          args[key] = val;
        }
      }
      calls.push({ id: `call_${Date.now().toString(36)}_${calls.length}`, name, arguments: JSON.stringify(args) });
      return '';
    }
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { name?: string; arguments?: unknown };
        if (parsed.name) {
          const argStr = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {});
          calls.push({ id: `call_${Date.now().toString(36)}_${calls.length}`, name: parsed.name, arguments: argStr });
          return '';
        }
      } catch { /* leave unmatched */ }
    }
    return full;
  });
  let truncated = false;
  if (/<tool_call>[\s\S]*$/i.test(cleaned)) {
    truncated = true;
    cleaned = cleaned.replace(/<tool_call>[\s\S]*$/i, '');
  }
  return { text: cleaned.trim(), calls, truncated };
}

/**
 * Detect genuine degenerate repetition loops (e.g. "/////////..." or "foo foo foo...")
 * while ignoring legitimate Markdown/ASCII formatting (table separators, rules, indentation).
 */
export function detectDegenerateRepeat(buf: string): string | null {
  if (buf.length < 60) return null;
  const tail = buf.slice(-240);
  const single = tail.match(/([^\s\-=_*#|.─═~`])\1{59,}$/);
  if (single) return single[0];
  const multi = tail.match(/(.{2,8})\1{19,}$/);
  if (multi && /[^\s\-=_*#|.─═~`]/.test(multi[1])) return multi[0];
  const longTail = buf.slice(-600);
  const wordLoop = longTail.match(/\b([\p{L}\p{N}_'-]{2,24})(?:[\s,.;:!?]+\1){7,}\b/iu);
  if (wordLoop) return wordLoop[0];
  const phraseLoop = longTail.match(/(.{10,80}?)\1{4,}$/s);
  if (phraseLoop && /[\p{L}\p{N}]{3,}/u.test(phraseLoop[1]!)) return phraseLoop[0];
  return null;
}

export function deriveStepPhase(toolName: string, _args: Record<string, unknown>, stage?: 'plan' | 'implement'): WorkPhase | undefined {
  if (stage === 'plan' || ['plan', 'tasks', 'enter_plan_mode'].includes(toolName)) return 'planning';
  if (['apply_patch', 'write_file', 'create_file'].includes(toolName)) return 'editing';
  if (['shell'].includes(toolName)) return 'verifying';
  if (['read_file', 'list_dir', 'grep', 'glob', 'web_search', 'browse', 'web_fetch', 'vpn', 'kb_search', 'search_chats', 'find_context'].includes(toolName)) return 'investigating';
  return undefined;
}

export function deriveStepFocus(toolName: string, args: Record<string, unknown>): string {
  const base = (p: unknown) => String(p || '').replace(/\/+$/, '').split('/').pop() || String(p || '');
  switch (toolName) {
    case 'read_file': return `Reading ${base(args.path) || 'file'}`;
    case 'list_dir': return `Listing ${base(args.path) || 'workspace'}`;
    case 'grep': return `Searching for ${String(args.pattern || 'matches').slice(0, 32)}`;
    case 'glob': return `Finding files matching ${String(args.pattern || '*').slice(0, 32)}`;
    case 'apply_patch': case 'write_file': case 'create_file': return `Editing ${base(args.path) || 'file'}`;
    case 'shell': return `Running ${String(args.command || 'command').split('\n')[0]!.slice(0, 36)}`;
    case 'web_search': return `Searching web: ${String(args.query || '').slice(0, 32)}`;
    case 'browse': return `Browsing ${String(args.url || 'page').replace(/^https?:\/\//, '').slice(0, 36)}`;
    case 'web_fetch': return `Fetching ${String(args.url || 'page').replace(/^https?:\/\//, '').slice(0, 36)}`;
    case 'vpn': return 'Using VPN…';
    case 'plan': case 'tasks': return 'Updating plan steps';
    case 'spawn_agent': return `Spawning helper${args.role ? ` (${String(args.role)})` : ''}`;
    default: return `Running ${toolName.replace(/_/g, ' ')}`;
  }
}
