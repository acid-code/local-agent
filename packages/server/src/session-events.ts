import type { LiveEvent } from './bus.js';
import type { Store } from './db.js';

/** Token-level events: many per second. The web gets them from the run stream; the phone takes them here. */
const STREAMING = new Set(['token', 'thinking']);

/**
 * Decides which bus events belong to one chat's live feed: events of the chat's top-level runs (status, steps,
 * messages, approvals, done…) and session-scoped events (context). Helper (child) runs stay out: their result
 * arrives as a message of the parent run. Run → chat lookups are cached; a run never changes chat.
 */
export function sessionEventFilter(store: Store, sessionId: string, opts: { tokens: boolean }) {
  const runChat = new Map<string, boolean>();
  const mine = (runId: string) => {
    let hit = runChat.get(runId);
    if (hit === undefined) {
      const run = store.getRun(runId);
      hit = Boolean(run && run.sessionId === sessionId && !run.parentRunId);
      // Only cache once the run exists, so an event racing the INSERT is looked up again.
      if (run) runChat.set(runId, hit);
    }
    return hit;
  };
  return (event: LiveEvent): LiveEvent | null => {
    if (!opts.tokens && STREAMING.has(event.type)) return null;
    if (event.runId) return mine(event.runId) ? { ...event, sessionId } : null;
    if (event.sessionId === sessionId) return event;
    const message = event.message as { sessionId?: string } | undefined;
    return message?.sessionId === sessionId ? event : null;
  };
}

/** The chat's newest top-level run that is still going, if any (same rule as GET /api/sessions/:id). */
export function activeRunOf(store: Store, sessionId: string): { id: string; status: string } | null {
  return (store.db.prepare(`SELECT id, status FROM runs WHERE session_id = ? AND parent_run_id IS NULL AND status IN ('running', 'awaiting_approval', 'paused') ORDER BY started_at DESC LIMIT 1`).get(sessionId) as { id: string; status: string } | undefined) ?? null;
}
