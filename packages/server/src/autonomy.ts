import fs from 'node:fs';
import path from 'node:path';
import { nextCron } from '@local-agent/shared';
import type { RunCursor } from '@local-agent/shared';
import { OWNER_ID, foreignPath } from './accounts.js';
import type { Bus } from './bus.js';
import { getChatWorkspaces, setChatWorkspaces } from './chat-workspaces.js';
import { OLLAMA_SIDE_MAX_GIB, isLlamaServerProvider, isNonChatModel, isOllamaProvider, isUncensoredProvider, modelGiB } from './coexist.js';
import type { ModelRow, RunRow, Store } from './db.js';
import type { Tool, ToolContext } from './tools.js';
import { createTrigger, getTrigger, listTriggers, updateTrigger, type TriggerKind } from './triggers.js';
import { nid, now, secret as randomSecret } from './util.js';
import type { Vault } from './vault.js';

/** Small models often leave out "action". Infer create when they pass what a new row needs, list when they pass nothing. */
const act = (args: Record<string, unknown>) => String(args.action || (args.id ? '' : (args.name || args.cron || args.prompt || args.kind || args.path) ? 'create' : 'list'));

/**
 * Agent self-management (timers and triggers it owns) and background helper agents.
 * Creating or deleting a timer/trigger is an approval card; pausing and resuming are not.
 * A persona only ever touches its own timers and triggers, so a member's persona only touches that member's.
 */

export const HELPER_LIMITS = { perChat: 3, total: 4, defaultSteps: 8, maxSteps: 24, defaultMinutes: 10, minMinutes: 1, maxMinutes: 30, maxTimersPerPersona: 20 };
/** A helper never gets these: no helpers of helpers, no scheduling or creating new projects from the background. */
export const HELPER_DENIED = ['spawn_agent', 'helpers', 'manage_timer', 'manage_trigger', 'create_project'];

export interface HelperRow {
  id: string; parentSessionId: string; parentRunId: string | null; childSessionId: string; childRunId: string | null;
  agentId: string; agentName: string; ownerId: string; task: string; cli: string | null;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'; result: string | null; error: string | null;
  maxSteps: number; timeoutMs: number; tools: string[] | null; createdAt: string; endedAt: string | null;
}

type StartTurn = (input: { sessionId: string; agentId: string; content: string; modelId?: string; parentRunId?: string | null; depth?: number; background?: boolean; cursorExtras?: Partial<RunCursor>; onDone?: (run: RunRow) => void }) => Promise<RunRow>;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted', 'cancelled']);

export class Autonomy {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly vault: Vault,
    private readonly startTurn: StartTurn,
    private readonly stopRun: (runId: string) => unknown,
    private readonly dataDir: () => string,
  ) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  private mapHelper(row: Record<string, unknown>): HelperRow {
    const agent = this.store.getAgent(String(row.agent_id));
    return {
      id: String(row.id), parentSessionId: String(row.parent_session_id), parentRunId: row.parent_run_id ? String(row.parent_run_id) : null,
      childSessionId: String(row.child_session_id), childRunId: row.child_run_id ? String(row.child_run_id) : null,
      agentId: String(row.agent_id), agentName: agent?.name || 'Persona', ownerId: String(row.owner_id), task: String(row.task), cli: row.cli ? String(row.cli) : null,
      status: String(row.status) as HelperRow['status'], result: row.result ? String(row.result) : null, error: row.error ? String(row.error) : null,
      maxSteps: Number(row.max_steps), timeoutMs: Number(row.timeout_ms), tools: row.tools ? JSON.parse(String(row.tools)) as string[] : null,
      createdAt: String(row.created_at), endedAt: row.ended_at ? String(row.ended_at) : null,
    };
  }

  getHelper(id: string): HelperRow | null {
    const row = this.store.db.prepare('SELECT * FROM helpers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.reconcile(this.mapHelper(row)) : null;
  }

  listHelpers(parentSessionId: string): HelperRow[] {
    return (this.store.db.prepare('SELECT * FROM helpers WHERE parent_session_id = ? ORDER BY created_at DESC').all(parentSessionId) as Record<string, unknown>[])
      .map((row) => this.reconcile(this.mapHelper(row)));
  }

  private runningCount(where: string, arg?: string) {
    const rows = this.store.db.prepare(`SELECT * FROM helpers WHERE status IN ('queued','running','waiting') ${where}`).all(...(arg ? [arg] : [])) as Record<string, unknown>[];
    return rows.map((row) => this.reconcile(this.mapHelper(row))).filter((row) => ['queued', 'running', 'waiting'].includes(row.status)).length;
  }

  /** Live status from the child run; finishes rows whose run ended while nobody was listening (e.g. after a restart). */
  private reconcile(helper: HelperRow): HelperRow {
    if (!['queued', 'running', 'waiting'].includes(helper.status) || !helper.childRunId) return helper;
    const run = this.store.getRun(helper.childRunId);
    if (!run) return helper;
    if (TERMINAL.has(run.status)) return this.finish(helper.id, run) ?? helper;
    const status = run.status === 'awaiting_approval' || run.status === 'paused' ? 'waiting' : 'running';
    if (status !== helper.status) this.store.db.prepare('UPDATE helpers SET status = ? WHERE id = ?').run(status, helper.id);
    return { ...helper, status };
  }

  /** Records the outcome once and posts it into the parent chat. */
  private finish(id: string, run: RunRow): HelperRow | null {
    const row = this.store.db.prepare('SELECT * FROM helpers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const helper = this.mapHelper(row);
    if (Number(row.delivered)) return helper;
    const answer = [...this.store.listMessages(helper.childSessionId)].reverse().find((message) => message.role === 'assistant' && message.content.trim());
    const result = (answer?.content || '').slice(0, 6000) || null;
    const emptyAnswerFail = Boolean(result && /(?:returned an empty answer twice|only produced reasoning and no answer, twice)/i.test(result));
    const status: HelperRow['status'] = run.status === 'completed'
      ? (emptyAnswerFail ? 'failed' : 'done')
      : run.status === 'stopped' ? 'stopped' : 'failed';
    const error = status === 'done'
      ? null
      : (run.error || (emptyAnswerFail ? result : null) || (status === 'stopped' ? 'Stopped.' : 'The helper did not finish.'));
    const claimed = this.store.db.prepare('UPDATE helpers SET status = ?, result = ?, error = ?, ended_at = ?, delivered = 1 WHERE id = ? AND delivered = 0').run(status, result, error, now(), id);
    if (!Number(claimed.changes)) return this.mapHelper(this.store.db.prepare('SELECT * FROM helpers WHERE id = ?').get(id) as Record<string, unknown>);
    const parent = this.store.getSession(helper.parentSessionId);
    if (parent) {
      const head = status === 'done' ? `Helper finished · ${helper.agentName}` : status === 'stopped' ? `Helper stopped · ${helper.agentName}` : `Helper failed · ${helper.agentName}`;
      const body = status === 'done' ? (result || 'No answer.') : `${error}${result && result !== error ? `\n\nLast words:\n${result}` : ''}`;
      const posted = this.store.insertMessage({
        sessionId: parent.id, role: 'assistant', content: `**${head}** — “${helper.task.slice(0, 120)}”\n\n${body}`,
        toolCallId: null, toolName: null, toolCalls: null, agentId: parent.agentId ?? helper.agentId, runId: null, imageUrl: null, routingNote: `helper:${helper.id}`,
      });
      this.bus.publish({ type: 'message', sessionId: parent.id, message: posted });
    }
    const done = this.mapHelper(this.store.db.prepare('SELECT * FROM helpers WHERE id = ?').get(id) as Record<string, unknown>);
    this.bus.publish({ type: 'helper', sessionId: helper.parentSessionId, helper: done });
    return done;
  }

  /**
   * Pick the model for a spawned mini-agent.
   * - tier "fast" (default): picks a lightweight local model (<= 4 GiB, e.g. gemma3:4b on Ollama)
   *   so mini-missions run in parallel without blocking llama-server's single slot or risking GTT OOM.
   * - tier "main" / "auto": leaves routing to the engine (uses llama-server / main model).
   */
  pickHelperModel(tier: 'fast' | 'main' | 'auto' = 'fast', explicit?: string, parentModelId?: string | null): ModelRow | undefined {
    const providers = new Map(this.store.listProviders().map((p) => [p.id, p]));
    // A big model needs most of the GPU. A helper must not bring in a second one next to the parent's (that froze
    // the mini PC, and the helper would wait forever for a parent that is waiting for it): it shares the parent's.
    const isBig = (m: ModelRow) => {
      const p = providers.get(m.providerId);
      if (p && (isLlamaServerProvider(p) || isUncensoredProvider(p))) return true;
      return m.local && (m.sizeClass === 'large' || modelGiB(m) > OLLAMA_SIDE_MAX_GIB);
    };
    const parentRow = parentModelId ? this.store.getModel(parentModelId) : null;
    const parentModel = parentRow && parentRow.enabled && !isNonChatModel(parentRow) ? parentRow : undefined;
    const shareParent = (m: ModelRow | undefined) => (m && parentModel && isBig(m) && isBig(parentModel) && m.id !== parentModel.id ? parentModel : m);
    const usable = this.store.listModels().filter((m) => {
      if (!m.enabled || isNonChatModel(m)) return false;
      const p = providers.get(m.providerId);
      return Boolean(p?.enabled && p.kind !== 'rehearsal');
    });
    if (explicit?.trim()) {
      const needle = explicit.trim().toLowerCase();
      const hit = usable.find((m) => m.id.toLowerCase() === needle || m.apiName.toLowerCase() === needle || m.name.toLowerCase() === needle)
        ?? usable.find((m) => m.apiName.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
      if (hit) return shareParent(hit);
    }
    // main/auto: the parent chat's model when it is a big one (already loaded), otherwise the role default.
    if (tier !== 'fast') return parentModel && isBig(parentModel) ? parentModel : undefined;
    const settings = this.store.getSettings();
    const fastWanted = (settings.autoModels?.fast || '').trim().toLowerCase();
    const isLightLocal = (m: ModelRow) => {
      if (!m.local) return false;
      const p = providers.get(m.providerId);
      if (p && isOllamaProvider(p)) return modelGiB(m) <= OLLAMA_SIDE_MAX_GIB;
      return m.sizeClass === 'small' && modelGiB(m) <= OLLAMA_SIDE_MAX_GIB;
    };
    const light = usable.filter(isLightLocal);
    if (!light.length) return undefined;
    if (fastWanted) {
      const named = light.find((m) => m.apiName.toLowerCase() === fastWanted || m.name.toLowerCase() === fastWanted || m.apiName.toLowerCase().startsWith(fastWanted));
      if (named) return named;
    }
    // Prefer Ollama small models so they run concurrently alongside llama-server.
    const ollamaLight = light.filter((m) => { const p = providers.get(m.providerId); return p ? isOllamaProvider(p) : false; });
    const pool = ollamaLight.length ? ollamaLight : light;
    return pool.sort((a, b) => modelGiB(a) - modelGiB(b))[0];
  }

  async spawn(ctx: ToolContext, input: { task: string; persona?: string; tools?: string[]; maxSteps?: number; timeoutMinutes?: number; cli?: string; tier?: 'fast' | 'main' | 'auto'; model?: string }): Promise<HelperRow & { modelName?: string }> {
    if (!ctx.sessionId) throw new Error('Helpers start from a chat.');
    if ((ctx.depth ?? 0) >= 1) throw new Error('A helper cannot start helpers of its own.');
    const task = input.task.trim();
    if (!task) throw new Error('Describe the task for the helper.');
    const owner = ctx.agent.ownerId || OWNER_ID;
    const agent = input.persona ? this.store.getAgentByName(input.persona, owner) : ctx.agent;
    if (!agent || (agent.ownerId || OWNER_ID) !== owner) throw new Error(`No persona named ${input.persona}.`);
    if (this.runningCount('AND parent_session_id = ?', ctx.sessionId) >= HELPER_LIMITS.perChat) throw new Error(`This chat already has ${HELPER_LIMITS.perChat} helpers running. Wait for one, or stop one.`);
    if (this.runningCount('') >= HELPER_LIMITS.total) throw new Error(`${HELPER_LIMITS.total} helpers are already running on this machine. Wait for one to finish.`);
    const cli = input.cli?.trim() || null;
    if (cli && owner !== OWNER_ID) throw new Error('Coding CLIs are for the owner\'s personas.');
    if (cli && !/^(claude|codex|gemini|aider|opencode|qwen)(?:[-_\w.]*)?$/i.test(cli)) {
      throw new Error(`cli is only for coding CLIs (claude, codex, gemini, aider, opencode). To run "${cli.slice(0, 60)}", call the shell tool directly (or omit cli so the helper uses shell directly).`);
    }
    const maxSteps = Math.max(1, Math.min(HELPER_LIMITS.maxSteps, Math.floor(input.maxSteps || HELPER_LIMITS.defaultSteps)));
    const timeoutMs = Math.max(HELPER_LIMITS.minMinutes, Math.min(HELPER_LIMITS.maxMinutes, input.timeoutMinutes || HELPER_LIMITS.defaultMinutes)) * 60_000;
    let tools = input.tools?.length ? input.tools.map(String).filter((name) => !HELPER_DENIED.includes(name)) : null;
    if (cli) tools = [...new Set([...(tools ?? ['read_file', 'list_dir', 'grep', 'glob', 'git']), 'handoff_cli'])];
    const parent = this.store.getSession(ctx.sessionId);
    const child = this.store.createSession({ agentId: agent.id, title: `Helper: ${task.slice(0, 60)}`, ownerId: owner });
    this.store.db.prepare('UPDATE chat_sessions SET helper_of = ? WHERE id = ?').run(ctx.sessionId, child.id);
    const childPatch: { mode?: 'chat' | 'code'; workshopId?: string | null } = {};
    if (parent?.mode === 'code' || cli) childPatch.mode = 'code';
    if (parent?.workshopId) childPatch.workshopId = parent.workshopId;
    if (Object.keys(childPatch).length) this.store.updateSession(child.id, childPatch);
    // Same workspaces as the parent chat, so a mini-agent works on the exact same repos.
    const items = getChatWorkspaces(this.store, ctx.sessionId);
    if (items.length) setChatWorkspaces(this.store, child.id, items);
    const chosenModel = cli ? undefined : this.pickHelperModel(input.tier ?? 'fast', input.model, ctx.runId ? this.store.getRun(ctx.runId)?.modelId : null);
    const id = nid('hlp');
    this.store.db.prepare(`INSERT INTO helpers (id, parent_session_id, parent_run_id, child_session_id, child_run_id, agent_id, owner_id, task, cli, status, max_steps, timeout_ms, tools, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, ctx.sessionId, ctx.runId ?? null, child.id, agent.id, owner, task, cli, maxSteps, timeoutMs, tools ? JSON.stringify(tools) : null, now());
    const prompt = cli
      ? `Use handoff_cli with cli "${cli}" to do the task below in this chat's workspace, then report briefly what changed and anything left to do.\n\nTask:\n${task}`
      : `You are a background helper (mini-agent) running in the same workspace as the main agent. Do the task below on your own, then answer with the result only: short, concrete, with file paths, line numbers, or links when relevant. You cannot ask questions.\n\nTask:\n${task}`;
    try {
      const run = await this.startTurn({
        sessionId: child.id, agentId: agent.id, content: prompt, modelId: chosenModel?.id, parentRunId: ctx.runId ?? null, depth: 1, background: true,
        cursorExtras: { maxSteps, timeoutMs, toolSubset: tools ?? undefined, helperId: id },
      });
      this.store.db.prepare("UPDATE helpers SET child_run_id = ?, status = CASE WHEN delivered = 1 THEN status ELSE 'running' END WHERE id = ?").run(run.id, id);
      if (TERMINAL.has(run.status)) this.finish(id, run);
    } catch (error) {
      this.store.db.prepare('UPDATE helpers SET status = ?, error = ?, ended_at = ?, delivered = 1 WHERE id = ?').run('failed', (error as Error).message, now(), id);
      throw error;
    }
    const helper = this.getHelper(id)!;
    this.bus.publish({ type: 'helper', sessionId: ctx.sessionId, helper });
    return { ...helper, modelName: chosenModel?.name };
  }

  /** Called by the engine whenever a helper's run ends, from the run record itself. */
  deliver(run: RunRow) {
    const id = run.cursor.helperId;
    if (!id) return;
    const row = this.store.db.prepare('SELECT id, child_run_id FROM helpers WHERE id = ?').get(id) as { id: string; child_run_id: string | null } | undefined;
    if (!row) return;
    // The run can end before spawn() records child_run_id (very fast helpers).
    if (!row.child_run_id) this.store.db.prepare('UPDATE helpers SET child_run_id = ? WHERE id = ?').run(run.id, id);
    this.finish(id, run);
  }

  /** On startup: hand over results of helpers whose runs finished while nobody was listening. */
  sweep() {
    const rows = this.store.db.prepare(`SELECT * FROM helpers WHERE delivered = 0 AND child_run_id IS NOT NULL`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const run = this.store.getRun(String(row.child_run_id));
      if (run && TERMINAL.has(run.status)) this.finish(String(row.id), run);
    }
  }

  /** Stop helpers that a reply started (when that reply is stopped). */
  stopChildrenOf(runId: string) {
    const rows = this.store.db.prepare(`SELECT id FROM helpers WHERE parent_run_id = ? AND status IN ('queued','running','waiting')`).all(runId) as { id: string }[];
    for (const row of rows) this.stop(row.id);
  }

  /** Stop every helper working for a chat (when the chat is deleted). */
  stopForSession(sessionId: string) {
    const rows = this.store.db.prepare(`SELECT id FROM helpers WHERE parent_session_id = ? AND status IN ('queued','running','waiting')`).all(sessionId) as { id: string }[];
    for (const row of rows) this.stop(row.id);
  }

  stop(id: string): HelperRow | null {
    const helper = this.getHelper(id);
    if (!helper) return null;
    if (helper.childRunId && ['queued', 'running', 'waiting'].includes(helper.status)) {
      this.stopRun(helper.childRunId);
      const run = this.store.getRun(helper.childRunId);
      if (run) this.finish(id, run);
    }
    return this.getHelper(id);
  }

  /** Waits until the given helpers (default: all running ones in this chat) finish, or the time runs out. */
  async wait(sessionId: string, ids: string[] | null, seconds: number, signal: AbortSignal): Promise<HelperRow[]> {
    const until = Date.now() + Math.max(1, Math.min(300, seconds)) * 1000;
    const pick = () => this.listHelpers(sessionId).filter((row) => (ids ? ids.includes(row.id) : true));
    let rows = pick();
    const watched = ids ?? rows.filter((row) => ['queued', 'running', 'waiting'].includes(row.status)).map((row) => row.id);
    if (!watched.length) return rows;
    while (Date.now() < until && !signal.aborted) {
      rows = pick().filter((row) => watched.includes(row.id));
      if (rows.every((row) => !['queued', 'running', 'waiting'].includes(row.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return pick().filter((row) => watched.includes(row.id));
  }

  // ── Context for one chat ──────────────────────────────────────────────────

  timersFor(sessionId: string) {
    return this.store.listSchedules().filter((row) => this.originOf('schedules', row.id) === sessionId).map((row) => ({ ...row, createdBy: this.createdBy('schedules', row.id) }));
  }

  triggersFor(sessionId: string) {
    return listTriggers(this.store).filter((row) => this.originOf('triggers', row.id) === sessionId).map((row) => ({ ...row, createdBy: this.createdBy('triggers', row.id) }));
  }

  private originOf(table: 'schedules' | 'triggers', id: string) {
    return (this.store.db.prepare(`SELECT origin_session_id AS s FROM ${table} WHERE id = ?`).get(id) as { s: string | null } | undefined)?.s ?? null;
  }

  private createdBy(table: 'schedules' | 'triggers', id: string) {
    return (this.store.db.prepare(`SELECT created_by AS c FROM ${table} WHERE id = ?`).get(id) as { c: string } | undefined)?.c ?? 'user';
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  tools(): Tool[] {
    const self = this;
    const ownTimer = (ctx: ToolContext, id: string) => {
      const row = ctx.store.getSchedule(id);
      if (!row || row.agentId !== ctx.agent.id) throw new Error(`No timer ${id} of yours. List them with action "list".`);
      return row;
    };
    const ownTrigger = (ctx: ToolContext, id: string) => {
      const row = getTrigger(ctx.store, id);
      if (!row || row.agentId !== ctx.agent.id) throw new Error(`No trigger ${id} of yours. List them with action "list".`);
      return row;
    };
    return [
      {
        name: 'manage_timer',
        description: 'Your own timers (scheduled prompts that start a run of you). action: list | create (name, cron as 5-field "m h dom mon dow", prompt) | pause | resume | delete (id). Creating or deleting asks the user first.',
        parameters: obj({ action: { type: 'string', enum: ['list', 'create', 'pause', 'resume', 'delete'] }, id: { type: 'string' }, name: { type: 'string' }, cron: { type: 'string' }, prompt: { type: 'string' } }, ['action']),
        mutates: (args) => act(args) !== 'list',
        approval: (args, ctx) => {
          if (act(args) === 'create') return `Create timer “${String(args.name || 'Timer')}” (${String(args.cron || '')}): ${String(args.prompt || '').slice(0, 140)}`;
          if (act(args) === 'delete') {
            const row = ctx?.store.getSchedule(String(args.id || ''));
            return `Delete timer “${row?.name || args.id}”${row ? ` (${row.cron})` : ''}`;
          }
          return null;
        },
        async execute(args, ctx) {
          const action = act(args);
          if (action === 'list') {
            const rows = ctx.store.listSchedules().filter((row) => row.agentId === ctx.agent.id);
            return rows.length ? rows.map((row) => `${row.id}\t${row.enabled ? 'on' : 'paused'}\t${row.cron}\t${row.name}\tnext ${row.nextRunAt || '—'}`).join('\n') : 'No timers yet.';
          }
          if (action === 'create') {
            const name = String(args.name || '').trim() || 'Timer';
            const cron = String(args.cron || '').trim();
            const prompt = String(args.prompt || '').trim();
            if (!prompt) throw new Error('A timer needs a prompt.');
            let next: string;
            try { next = nextCron(cron, new Date()).toISOString(); } catch { throw new Error(`"${cron}" is not a 5-field cron like "0 8 * * 1-5".`); }
            if (ctx.store.listSchedules().filter((row) => row.agentId === ctx.agent.id).length >= HELPER_LIMITS.maxTimersPerPersona) throw new Error(`You already have ${HELPER_LIMITS.maxTimersPerPersona} timers. Delete one first.`);
            const row = ctx.store.createSchedule({ agentId: ctx.agent.id, name: name.slice(0, 80), cron, prompt: prompt.slice(0, 4000), nextRunAt: next });
            ctx.store.db.prepare(`UPDATE schedules SET origin_session_id = ?, created_by = 'agent' WHERE id = ?`).run(ctx.sessionId ?? null, row.id);
            // It fires in the chat that asked for it.
            if (ctx.sessionId) ctx.store.updateSchedule(row.id, { sessionId: ctx.sessionId });
            self.bus.publish({ type: 'context', sessionId: ctx.sessionId, what: 'timers' });
            return `Created timer ${row.id} “${row.name}” (${cron}). Next run ${next}.`;
          }
          const row = ownTimer(ctx, String(args.id || ''));
          if (action === 'pause' || action === 'resume') {
            ctx.store.updateSchedule(row.id, { enabled: action === 'resume', ...(action === 'resume' ? { nextRunAt: nextCron(row.cron, new Date()).toISOString() } : {}) });
            self.bus.publish({ type: 'context', sessionId: ctx.sessionId, what: 'timers' });
            return `${action === 'pause' ? 'Paused' : 'Resumed'} timer “${row.name}”.`;
          }
          if (action === 'delete') {
            ctx.store.db.prepare('DELETE FROM schedules WHERE id = ?').run(row.id);
            self.bus.publish({ type: 'context', sessionId: ctx.sessionId, what: 'timers' });
            return `Deleted timer “${row.name}”.`;
          }
          throw new Error(`Unknown action "${action}". Pass action: list, create, pause, resume or delete.`);
        },
      },
      {
        name: 'manage_trigger',
        description: 'Your own triggers (events that start a run of you). action: list | create (name, kind webhook|github|folder, prompt with {{event}} placeholders, path for folder) | pause | resume | delete (id). Creating or deleting asks the user first. Webhook secrets are shown to the user on the Triggers page, never to you.',
        parameters: obj({ action: { type: 'string', enum: ['list', 'create', 'pause', 'resume', 'delete'] }, id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['webhook', 'github', 'folder'] }, prompt: { type: 'string' }, path: { type: 'string' } }, ['action']),
        mutates: (args) => act(args) !== 'list',
        approval: (args, ctx) => {
          if (act(args) === 'create') return `Create ${String(args.kind || 'webhook')} trigger “${String(args.name || 'Trigger')}”${args.path ? ` on ${String(args.path)}` : ''}: ${String(args.prompt || '').slice(0, 140)}`;
          if (act(args) === 'delete') {
            const row = ctx ? getTrigger(ctx.store, String(args.id || '')) : null;
            return `Delete trigger “${row?.name || args.id}”`;
          }
          return null;
        },
        async execute(args, ctx) {
          const action = act(args);
          if (action === 'list') {
            const rows = listTriggers(ctx.store).filter((row) => row.agentId === ctx.agent.id);
            return rows.length ? rows.map((row) => `${row.id}\t${row.enabled ? 'on' : 'paused'}\t${row.kind}\t${row.name}`).join('\n') : 'No triggers yet.';
          }
          if (action === 'create') {
            const kind = String(args.kind || 'webhook') as TriggerKind;
            if (!['webhook', 'github', 'folder'].includes(kind)) throw new Error('kind is webhook, github or folder.');
            const prompt = String(args.prompt || '').trim();
            if (!prompt) throw new Error('A trigger needs a prompt.');
            const config: Record<string, unknown> = {};
            if (kind === 'folder') {
              const folder = path.resolve(String(args.path || ''));
              if (!args.path || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Pass path as an existing folder.');
              if (foreignPath(self.dataDir(), ctx.agent.ownerId || OWNER_ID, folder)) throw new Error('That folder belongs to another account.');
              config.path = folder; config.debounceMs = 1500;
            }
            const row = createTrigger(ctx.store, self.vault, { name: String(args.name || 'Trigger').slice(0, 80), kind, agentId: ctx.agent.id, prompt: prompt.slice(0, 4000), config, secret: randomSecret(24) });
            ctx.store.db.prepare(`UPDATE triggers SET origin_session_id = ?, created_by = 'agent' WHERE id = ?`).run(ctx.sessionId ?? null, row.id);
            self.bus.publish({ type: 'trigger', message: row.id });
            self.bus.publish({ type: 'context', sessionId: ctx.sessionId, what: 'triggers' });
            const url = kind === 'github' ? `/api/hooks/github/${row.id}` : kind === 'webhook' ? `/api/hooks/${row.id}` : null;
            return `Created ${kind} trigger ${row.id} “${row.name}”.${url ? ` It listens at ${url}; the signing secret is on the Triggers page.` : ''}`;
          }
          const row = ownTrigger(ctx, String(args.id || ''));
          if (action === 'pause' || action === 'resume') {
            updateTrigger(ctx.store, row.id, { enabled: action === 'resume' });
            self.bus.publish({ type: 'trigger', message: row.id });
            self.bus.publish({ type: 'context', sessionId: ctx.sessionId, what: 'triggers' });
            return `${action === 'pause' ? 'Paused' : 'Resumed'} trigger “${row.name}”.`;
          }
          if (action === 'delete') {
            ctx.store.db.prepare('DELETE FROM triggers WHERE id = ?').run(row.id);
            self.bus.publish({ type: 'trigger', message: 'deleted' });
            self.bus.publish({ type: 'context', sessionId: ctx.sessionId, what: 'triggers' });
            return `Deleted trigger “${row.name}”.`;
          }
          throw new Error(`Unknown action "${action}". Pass action: list, create, pause, resume or delete.`);
        },
      },
      {
        name: 'spawn_agent',
        description: `Spawn a mini-agent on the same workspace and repos to run a smaller sub-mission in parallel (default ${HELPER_LIMITS.defaultSteps} steps, ${HELPER_LIMITS.defaultMinutes} min). By default (tier="fast") it runs on a lightweight local model (<=4 GiB on Ollama) so it executes concurrently alongside the main model without blocking it. Pass tier="main" only if the sub-mission needs heavy reasoning, or wait=true to wait and receive its result immediately. Fan out multiple mini-agents and call helpers({action:"wait"}) to collect all results.`,
        parameters: obj({
          task: { type: 'string', description: 'Concrete mission for the mini-agent.' },
          tier: { type: 'string', enum: ['fast', 'main', 'auto'], description: 'fast (default): lightweight parallel local model; main/auto: primary model.' },
          model: { type: 'string', description: 'Optional explicit model name.' },
          wait: { type: 'boolean', description: 'If true, wait for this mini-agent to finish and return its output directly.' },
          persona: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          max_steps: { type: 'number' },
          timeout_minutes: { type: 'number' },
          cli: { type: 'string' },
        }, ['task']),
        mutates: () => false,
        approval: () => null,
        async execute(args, ctx) {
          const tier = args.tier === 'main' || args.tier === 'auto' ? args.tier : 'fast';
          const helper = await self.spawn(ctx, {
            task: String(args.task || ''),
            tier,
            model: args.model ? String(args.model) : undefined,
            persona: args.persona ? String(args.persona) : undefined,
            tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined,
            maxSteps: Number(args.max_steps) || undefined,
            timeoutMinutes: Number(args.timeout_minutes) || undefined,
            cli: args.cli ? String(args.cli) : undefined,
          });
          if (args.wait && ctx.sessionId) {
            const done = (await self.wait(ctx.sessionId, [helper.id], Math.min(300, Math.round(helper.timeoutMs / 1000)), ctx.signal))[0] ?? helper;
            return `Mini-agent ${done.id} (${done.agentName}${helper.modelName ? ` on ${helper.modelName}` : ''}) ${done.status}:\n${done.result || done.error || '(no output)'}`;
          }
          return `Started mini-agent ${helper.id} (${helper.agentName}${helper.modelName ? ` on ${helper.modelName}` : ''}${helper.cli ? ` via ${helper.cli}` : ''}, up to ${helper.maxSteps} steps / ${Math.round(helper.timeoutMs / 60000)} min) on the same workspace. Call helpers({action:"wait"}) to collect results.`;
        },
      },
      {
        name: 'helpers',
        description: 'Helpers started from this chat. action: list | wait (id optional, timeout_seconds up to 300) | stop (id).',
        parameters: obj({ action: { type: 'string', enum: ['list', 'wait', 'stop'] }, id: { type: 'string' }, timeout_seconds: { type: 'number' } }, ['action']),
        mutates: (args) => args.action === 'stop',
        approval: () => null,
        async execute(args, ctx) {
          if (!ctx.sessionId) throw new Error('No chat.');
          const describe = (rows: HelperRow[]) => rows.length
            ? rows.map((row) => `${row.id}\t${row.status}\t${row.agentName}\t${row.task.slice(0, 80)}${row.result ? `\n  result: ${row.result.slice(0, 1500)}` : ''}${row.error ? `\n  error: ${row.error}` : ''}`).join('\n')
            : 'No helpers in this chat.';
          const id = args.id ? String(args.id) : null;
          if (id && self.getHelper(id)?.parentSessionId !== ctx.sessionId) throw new Error(`No helper ${id} in this chat.`);
          if (args.action === 'stop') { if (!id) throw new Error('Pass id.'); return describe([self.stop(id)!]); }
          if (args.action === 'wait') return describe(await self.wait(ctx.sessionId, id ? [id] : null, Number(args.timeout_seconds) || 120, ctx.signal));
          return describe(self.listHelpers(ctx.sessionId));
        },
      },
    ];
  }
}
