import type { Store } from './db.js';
import type { Tool } from './tools.js';
import { readPlan, replacePlan, updatePlanItem } from './coding.js';

/**
 * Long tasks: a visible task list the model keeps up to date, and a check before the final answer. An item can only
 * be marked done with evidence (what a tool result showed); a run cannot finish while items are still open unless they
 * are marked blocked with a reason.
 */
export const TASK_STATUSES = ['pending', 'doing', 'done', 'blocked'] as const;
export const LONG_TASK_STEPS = 60;
export const MAX_TASK_ROUNDS = 3;
export const TASKS_HINT = '\n\nLong tasks: for multi-file coding, complex edits, or deep investigation, call enter_plan_mode first to lock into read-only research (with read_file, grep, glob, web_search, or research helpers), then call exit_plan_mode with concrete steps and acceptance checks to unlock editing. For ordinary 3+ step requests without plan mode, call tasks with action "set" (and optional checks) first, then work through them, marking each "doing" and then "done" with evidence from a tool result, or "blocked" with the reason. Do not give the final answer while any item is still pending or doing. When finishing, verify your checks, summarize what changed, and list key takeaways for the future.';

const render = (store: Store, sessionId: string) => {
  const plan = readPlan(store, sessionId);
  if (!plan?.items.length) return 'No tasks.';
  return plan.items.map((item, index) => `${index + 1}. [${item.status}] ${item.text}${item.note ? ` (${item.note})` : ''}`).join('\n');
};

export function tasksTool(): Tool {
  return {
    name: 'tasks',
    description: 'The visible task list for this chat. action "set" replaces it with items (and optional acceptance checks); "update" changes one item by number (1-based): status pending|doing|done|blocked, evidence (required for done: what the tool result showed), note (required for blocked); "list" shows it.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['set', 'update', 'list'] }, items: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'string' } }, item: { type: 'number' }, status: { type: 'string', enum: [...TASK_STATUSES] }, evidence: { type: 'string' }, note: { type: 'string' } }, required: ['action'] },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const sessionId = ctx.sessionId;
      if (!sessionId) throw new Error('No chat for a task list.');
      const action = String(args.action || 'list');
      if (action === 'set') {
        const items = (Array.isArray(args.items) ? args.items : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 30);
        if (!items.length) throw new Error('Give at least one item.');
        replacePlan(ctx.store, sessionId, items, ctx.runId);
        const checks = Array.isArray(args.checks) ? (args.checks as unknown[]).map((c) => String(c).trim()).filter(Boolean).slice(0, 10) : [];
        if (checks.length && ctx.runId) {
          const live = ctx.store.getRun(ctx.runId);
          if (live) ctx.store.updateRun(live.id, { cursor: { ...live.cursor, acceptance: checks } });
        }
        return render(ctx.store, sessionId);
      }
      if (action === 'update') {
        const plan = readPlan(ctx.store, sessionId);
        const index = Number(args.item) - 1;
        const item = plan?.items[index];
        if (!item) throw new Error(`No task ${String(args.item)}. ${render(ctx.store, sessionId)}`);
        const status = String(args.status || item.status);
        if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new Error(`Status must be one of ${TASK_STATUSES.join(', ')}.`);
        const evidence = String(args.evidence ?? '').trim();
        const note = String(args.note ?? '').trim();
        if (status === 'done' && evidence.length < 8) throw new Error('Marking a task done needs evidence: quote or describe the tool result that shows it worked. If you have none, verify first.');
        if (status === 'blocked' && !note) throw new Error('Marking a task blocked needs a note with the reason.');
        updatePlanItem(ctx.store, item.id, { status, note: (status === 'done' ? evidence : note) || undefined });
        return render(ctx.store, sessionId);
      }
      return render(ctx.store, sessionId);
    },
  };
}

/** Open items of the task list this run set (an older list from a previous request does not hold the run). */
export function openTasks(store: Store, sessionId: string, runId: string): string[] {
  const plan = store.db.prepare('SELECT id, run_id AS runId FROM plans WHERE session_id = ?').get(sessionId) as { id: string; runId: string | null } | undefined;
  if (!plan || plan.runId !== runId) return [];
  return (store.db.prepare("SELECT text, status, position FROM plan_items WHERE plan_id = ? AND status IN ('pending', 'doing') ORDER BY position").all(plan.id) as { text: string; status: string; position: number }[])
    .map((row) => `${row.position + 1}. [${row.status}] ${row.text}`);
}

const FINAL_REPLY_TASK = /\b(summariz|summary|report|present|respond|answer|recommend|explain|deliver|reply|conclud|wrap\s*up|share\s+(?:the\s+)?(?:findings|results|recommendations))\b|לסכם|סיכום|להציג|המלצות/i;

/** If the only remaining open item is the final "summarize / present recommendations" step and the agent just wrote a real final answer, mark it done automatically. */
export function completeFinalReplyTask(store: Store, sessionId: string, runId: string, replyText: string): boolean {
  if (replyText.trim().length < 60) return false;
  const plan = store.db.prepare('SELECT id, run_id AS runId FROM plans WHERE session_id = ?').get(sessionId) as { id: string; runId: string | null } | undefined;
  if (!plan || plan.runId !== runId) return false;
  const all = store.db.prepare('SELECT id, text, status, position FROM plan_items WHERE plan_id = ? ORDER BY position').all(plan.id) as { id: string; text: string; status: string; position: number }[];
  const open = all.filter((row) => row.status === 'pending' || row.status === 'doing');
  if (open.length !== 1 || !all.length) return false;
  const only = open[0]!;
  const isLast = only.position === all[all.length - 1]!.position;
  if (!isLast || !FINAL_REPLY_TASK.test(only.text)) return false;
  return Boolean(updatePlanItem(store, only.id, { status: 'done', note: 'Delivered in final reply.' }));
}

export function tasksNote(open: string[]) {
  return `\n\nCHECK BEFORE FINISHING: your task list still has open items:\n${open.join('\n')}\nContinue with the next one now. If one cannot be done, mark it blocked with the reason. Finish only when every item is done (with evidence) or blocked.`;
}

export function enterPlanModeTool(): Tool {
  return {
    name: 'enter_plan_mode',
    description: 'Enter read-only plan mode while you read files, search, inspect logs, or run research helpers before editing anything. Call exit_plan_mode when your plan is ready.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you are investigating or planning.' },
        reason: { type: 'string', description: 'Why planning first helps.' },
      },
    },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined;
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;
      if (ctx.enterPlanMode) {
        ctx.enterPlanMode(goal, reason);
      } else if (ctx.runId) {
        const live = ctx.store.getRun(ctx.runId);
        if (live) {
          ctx.store.updateRun(live.id, {
            cursor: { ...live.cursor, stage: 'plan', workPhase: 'planning', enteredPlanViaTool: true },
          });
        }
      }
      ctx.setFocus?.(goal ? `Planning: ${goal.slice(0, 60)}` : 'Investigating in plan mode', 'planning');
      return `Entered read-only plan mode${goal ? ` (${goal})` : ''}. Investigate with read_file, grep, glob, list_dir, web_search, or research helpers; file edits and mutating commands are locked until you call exit_plan_mode with your steps.`;
    },
  };
}

export function exitPlanModeTool(): Tool {
  return {
    name: 'exit_plan_mode',
    description: 'Save the finalized ordered plan steps and acceptance checks, unlock file editing, and move to execute mode.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered imperative steps for the plan checklist.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Optional 1-5 acceptance checks (put commands in backticks) to verify before finishing.' },
        summary: { type: 'string', description: 'Brief 1-2 sentence summary of the approach.' },
      },
      required: ['steps'],
    },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const steps = (Array.isArray(args.steps) ? args.steps : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
      if (!steps.length) throw new Error('exit_plan_mode requires at least one step.');
      const checks = (Array.isArray(args.checks) ? args.checks : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 10);
      const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined;
      if (ctx.exitPlanMode) {
        ctx.exitPlanMode({ steps, checks, summary });
      } else {
        if (ctx.sessionId) replacePlan(ctx.store, ctx.sessionId, steps, ctx.runId);
        if (ctx.runId) {
          const live = ctx.store.getRun(ctx.runId);
          if (live) {
            ctx.store.updateRun(live.id, {
              cursor: {
                ...live.cursor,
                stage: 'implement',
                workPhase: 'editing',
                enteredPlanViaTool: false,
                ...(checks.length ? { acceptance: checks } : {}),
              },
            });
          }
        }
      }
      ctx.setFocus?.(summary ? summary.slice(0, 60) : 'Executing plan', 'editing');
      const listed = steps.map((s, i) => `${i + 1}. [pending] ${s}`).join('\n');
      const checkLines = checks.length ? `\nAcceptance checks (verified before you finish):\n${checks.map((c) => `- ${c}`).join('\n')}` : '';
      return `Exited plan mode. File edits and execution tools are now unlocked (stage: implement).\nPlan:\n${listed}${checkLines}\nFollow the steps in exact order (do not drift from each step's text). Right after finishing each step, call plan({ itemId: "<number>", status: "done", evidence: "..." }) before starting the next step.`;
    },
  };
}
