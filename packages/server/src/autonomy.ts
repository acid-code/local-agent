import fs from 'node:fs';
import path from 'node:path';
import { nextCron } from '@local-agent/shared';
import type { RunCursor } from '@local-agent/shared';
import { OWNER_ID, foreignPath } from './accounts.js';
import type { Bus } from './bus.js';
import { getChatWorkspaces, setChatWorkspaces } from './chat-workspaces.js';
import type { RunRow, Store } from './db.js';
import type { Tool, ToolContext } from './tools.js';
import { createTrigger, getTrigger, listTriggers, updateTrigger, type TriggerKind } from './triggers.js';
import { nid, now, secret as randomSecret } from './util.js';
import type { Vault } from './vault.js';

/**
 * Agent self-management (timers and triggers it owns) and background helper agents.
 * Creating or deleting a timer/trigger is an approval card; pausing and resuming are not.
 * A persona only ever touches its own timers and triggers, so a member's persona only touches that member's.
 */

export const HELPER_LIMITS = { perChat: 3, total: 4, defaultSteps: 8, maxSteps: 24, defaultMinutes: 10, maxMinutes: 30, maxTimersPerPersona: 20 };
/** A helper never gets these: no helpers of helpers, no scheduling from the background. */
export const HELPER_DENIED = ['spawn_agent', 'helpers', 'manage_timer', 'manage_trigger'];

export interface HelperRow {
  id: string; parentSessionId: string; parentRunId: string | null; childSessionId: string; childRunId: string | null;
  agentId: string; agentName: string; ownerId: string; task: string; cli: string | null;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'; result: string | null; error: string | null;
  maxSteps: number; timeoutMs: number; tools: string[] | null; createdAt: string; endedAt: string | null;
}

type StartTurn = (input: { sessionId: string; agentId: string; content: string; parentRunId?: string | null; depth?: number; background?: boolean; cursorExtras?: Partial<RunCursor>; onDone?: (run: RunRow) => void }) => Promise<RunRow>;

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
    const status: HelperRow['status'] = run.status === 'completed' ? 'done' : run.status === 'stopped' ? 'stopped' : 'failed';
    const result = (answer?.content || '').slice(0, 6000) || null;
    const error = status === 'done' ? null : (run.error || (status === 'stopped' ? 'Stopped.' : 'The helper did not finish.'));
    const claimed = this.store.db.prepare('UPDATE helpers SET status = ?, result = ?, error = ?, ended_at = ?, delivered = 1 WHERE id = ? AND delivered = 0').run(status, result, error, now(), id);
    if (!Number(claimed.changes)) return this.mapHelper(this.store.db.prepare('SELECT * FROM helpers WHERE id = ?').get(id) as Record<string, unknown>);
    const parent = this.store.getSession(helper.parentSessionId);
    if (parent) {
      const head = status === 'done' ? `Helper finished · ${helper.agentName}` : status === 'stopped' ? `Helper stopped · ${helper.agentName}` : `Helper failed · ${helper.agentName}`;
      const body = status === 'done' ? (result || 'No answer.') : `${error}${result ? `\n\nLast words:\n${result}` : ''}`;
      this.store.insertMessage({
        sessionId: parent.id, role: 'assistant', content: `**${head}** — “${helper.task.slice(0, 120)}”\n\n${body}`,
        toolCallId: null, toolName: null, toolCalls: null, agentId: parent.agentId ?? helper.agentId, runId: null, imageUrl: null, routingNote: `helper:${helper.id}`,
      });
    }
    const done = this.mapHelper(this.store.db.prepare('SELECT * FROM helpers WHERE id = ?').get(id) as Record<string, unknown>);
    this.bus.publish({ type: 'helper', sessionId: helper.parentSessionId, helper: done });
    return done;
  }

  async spawn(ctx: ToolContext, input: { task: string; persona?: string; tools?: string[]; maxSteps?: number; timeoutMinutes?: number; cli?: string }): Promise<HelperRow> {
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
    const maxSteps = Math.max(1, Math.min(HELPER_LIMITS.maxSteps, Math.floor(input.maxSteps || HELPER_LIMITS.defaultSteps)));
    const timeoutMs = Math.max(1, Math.min(HELPER_LIMITS.maxMinutes, input.timeoutMinutes || HELPER_LIMITS.defaultMinutes)) * 60_000;
    let tools = input.tools?.length ? input.tools.map(String).filter((name) => !HELPER_DENIED.includes(name)) : null;
    if (cli) tools = [...new Set([...(tools ?? ['read_file', 'list_dir', 'grep', 'glob', 'git']), 'handoff_cli'])];
    const parent = this.store.getSession(ctx.sessionId);
    const child = this.store.createSession({ agentId: agent.id, title: `Helper: ${task.slice(0, 60)}`, ownerId: owner });
    this.store.db.prepare('UPDATE chat_sessions SET helper_of = ? WHERE id = ?').run(ctx.sessionId, child.id);
    if (parent?.mode === 'code' || cli) this.store.updateSession(child.id, { mode: 'code' });
    // Same workspaces as the parent chat, so a coding helper works on the same repos.
    const items = getChatWorkspaces(this.store, ctx.sessionId);
    if (items.length) setChatWorkspaces(this.store, child.id, items);
    const id = nid('hlp');
    this.store.db.prepare(`INSERT INTO helpers (id, parent_session_id, parent_run_id, child_session_id, child_run_id, agent_id, owner_id, task, cli, status, max_steps, timeout_ms, tools, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, ctx.sessionId, ctx.runId ?? null, child.id, agent.id, owner, task, cli, maxSteps, timeoutMs, tools ? JSON.stringify(tools) : null, now());
    const prompt = cli
      ? `Use handoff_cli with cli "${cli}" to do the task below in this chat's workspace, then report briefly what changed and anything left to do.\n\nTask:\n${task}`
      : `You are a background helper. Do the task below on your own, then answer with the result only: short, concrete, with paths or links when relevant. You cannot ask questions.\n\nTask:\n${task}`;
    try {
      const run = await this.startTurn({
        sessionId: child.id, agentId: agent.id, content: prompt, parentRunId: ctx.runId ?? null, depth: 1, background: true,
        cursorExtras: { maxSteps, timeoutMs, toolSubset: tools ?? undefined, helperId: id },
        onDone: (done) => { this.finish(id, done); },
      });
      this.store.db.prepare('UPDATE helpers SET child_run_id = ?, status = ? WHERE id = ?').run(run.id, TERMINAL.has(run.status) ? 'running' : 'running', id);
    } catch (error) {
      this.store.db.prepare('UPDATE helpers SET status = ?, error = ?, ended_at = ?, delivered = 1 WHERE id = ?').run('failed', (error as Error).message, now(), id);
      throw error;
    }
    const helper = this.getHelper(id)!;
    this.bus.publish({ type: 'helper', sessionId: ctx.sessionId, helper });
    return helper;
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
        mutates: (args) => args.action !== 'list',
        approval: (args, ctx) => {
          if (args.action === 'create') return `Create timer “${String(args.name || 'Timer')}” (${String(args.cron || '')}): ${String(args.prompt || '').slice(0, 140)}`;
          if (args.action === 'delete') {
            const row = ctx?.store.getSchedule(String(args.id || ''));
            return `Delete timer “${row?.name || args.id}”${row ? ` (${row.cron})` : ''}`;
          }
          return null;
        },
        async execute(args, ctx) {
          const action = String(args.action);
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
          throw new Error(`Unknown action ${action}.`);
        },
      },
      {
        name: 'manage_trigger',
        description: 'Your own triggers (events that start a run of you). action: list | create (name, kind webhook|github|folder, prompt with {{event}} placeholders, path for folder) | pause | resume | delete (id). Creating or deleting asks the user first. Webhook secrets are shown to the user on the Triggers page, never to you.',
        parameters: obj({ action: { type: 'string', enum: ['list', 'create', 'pause', 'resume', 'delete'] }, id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['webhook', 'github', 'folder'] }, prompt: { type: 'string' }, path: { type: 'string' } }, ['action']),
        mutates: (args) => args.action !== 'list',
        approval: (args, ctx) => {
          if (args.action === 'create') return `Create ${String(args.kind || 'webhook')} trigger “${String(args.name || 'Trigger')}”${args.path ? ` on ${String(args.path)}` : ''}: ${String(args.prompt || '').slice(0, 140)}`;
          if (args.action === 'delete') {
            const row = ctx ? getTrigger(ctx.store, String(args.id || '')) : null;
            return `Delete trigger “${row?.name || args.id}”`;
          }
          return null;
        },
        async execute(args, ctx) {
          const action = String(args.action);
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
          throw new Error(`Unknown action ${action}.`);
        },
      },
      {
        name: 'spawn_agent',
        description: `Start a helper in the background on an isolated copy of the task: its own chat, context and limits (default ${HELPER_LIMITS.defaultSteps} steps, ${HELPER_LIMITS.defaultMinutes} min). Use for side work that can run while you continue. persona: another persona by name (default you). tools: optional subset. cli: hand the work to an installed coding CLI (cursor-agent, claude, aider, codex). The result is posted into this chat when it finishes; call helpers with action "wait" to wait for it now.`,
        parameters: obj({ task: { type: 'string' }, persona: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, max_steps: { type: 'number' }, timeout_minutes: { type: 'number' }, cli: { type: 'string' } }, ['task']),
        mutates: () => false,
        approval: () => null,
        async execute(args, ctx) {
          const helper = await self.spawn(ctx, {
            task: String(args.task || ''), persona: args.persona ? String(args.persona) : undefined, tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined,
            maxSteps: Number(args.max_steps) || undefined, timeoutMinutes: Number(args.timeout_minutes) || undefined, cli: args.cli ? String(args.cli) : undefined,
          });
          return `Started helper ${helper.id} (${helper.agentName}${helper.cli ? ` via ${helper.cli}` : ''}, up to ${helper.maxSteps} steps / ${Math.round(helper.timeoutMs / 60000)} min). Its result will appear in this chat.`;
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
