import type { Store } from './db.js';
import type { Tool } from './tools.js';
import { readPlan, replacePlan, updatePlanItem } from './coding.js';

/**
 * Long tasks: a visible task list the model keeps up to date, and a check before the final answer. An item can only
 * be marked done with evidence (what a tool result showed); a run cannot finish while items are still open unless they
 * are marked blocked with a reason.
 */
export const TASK_STATUSES = ['pending', 'doing', 'done', 'blocked'] as const;
export const LONG_TASK_STEPS = 40;
export const MAX_TASK_ROUNDS = 3;
export const TASKS_HINT = '\n\nLong tasks: when a request needs 3 or more steps, call tasks with action "set" and the steps first, then work through them, marking each "doing" and then "done" with evidence from a tool result, or "blocked" with the reason. Do not give the final answer while any item is still pending or doing.';

const render = (store: Store, sessionId: string) => {
  const plan = readPlan(store, sessionId);
  if (!plan?.items.length) return 'No tasks.';
  return plan.items.map((item, index) => `${index + 1}. [${item.status}] ${item.text}${item.note ? ` (${item.note})` : ''}`).join('\n');
};

export function tasksTool(): Tool {
  return {
    name: 'tasks',
    description: 'The visible task list for this chat. action "set" replaces it with items; "update" changes one item by number (1-based): status pending|doing|done|blocked, evidence (required for done: what the tool result showed), note (required for blocked); "list" shows it.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['set', 'update', 'list'] }, items: { type: 'array', items: { type: 'string' } }, item: { type: 'number' }, status: { type: 'string', enum: [...TASK_STATUSES] }, evidence: { type: 'string' }, note: { type: 'string' } }, required: ['action'] },
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

export function tasksNote(open: string[]) {
  return `\n\nCHECK BEFORE FINISHING: your task list still has open items:\n${open.join('\n')}\nContinue with the next one now. If one cannot be done, mark it blocked with the reason. Finish only when every item is done (with evidence) or blocked.`;
}
