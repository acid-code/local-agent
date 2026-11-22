/** Live sync for the open chat (pure, so server tests import it). */

export interface LiveMessage { id: string; role: string; content: string; runId?: string | null }
export type ChatLiveAction =
  | { kind: 'adopt-run'; runId: string; status: string }
  | { kind: 'upsert-message'; message: LiveMessage }
  | { kind: 'reload' }
  | { kind: 'none' };

const ACTIVE = new Set(['running', 'loading', 'waiting', 'paused', 'awaiting_approval']);

/** Reconnect delay: 1s, 2s, 4s, 8s, then every 15s. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 4)));
}

/**
 * What the open chat does with one event from its live feed (/api/sessions/:id/events). `runId` is the run the page
 * already streams; that run's own stream handles its tokens, messages and done, so only other runs act here.
 */
export function chatLiveAction(event: { type?: string; runId?: string; status?: string; message?: LiveMessage; sessionId?: string }, ctx: { sessionId: string | null; runId: string | null }): ChatLiveAction {
  if (!ctx.sessionId || (event.sessionId && event.sessionId !== ctx.sessionId)) return { kind: 'none' };
  const other = Boolean(event.runId && event.runId !== ctx.runId);
  if (event.type === 'status' && other && ACTIVE.has(String(event.status))) return { kind: 'adopt-run', runId: event.runId!, status: String(event.status) };
  if (event.type === 'message' && event.message && (other || !event.runId)) return { kind: 'upsert-message', message: event.message };
  if (event.type === 'done' && other) return { kind: 'reload' };
  return { kind: 'none' };
}

/**
 * Merges the newest page from a reconnect snapshot into what is on screen: older pages already loaded stay,
 * everything from the snapshot's first message on is replaced by the server's copy, and optimistic local
 * messages the server has not echoed yet stay at the end.
 */
export function mergeSnapshot<T extends LiveMessage>(local: T[], server: T[]): T[] {
  if (!server.length) return local.filter((m) => isLocal(m.id));
  const serverIds = new Set(server.map((m) => m.id));
  const at = local.findIndex((m) => m.id === server[0]!.id);
  const older = at >= 0 ? local.slice(0, at).filter((m) => !serverIds.has(m.id)) : [];
  const echoed = new Set(server.filter((m) => m.role === 'user').map((m) => m.content.trim()));
  const pending = local.filter((m) => isLocal(m.id) && !echoed.has(m.content.trim()));
  return [...older, ...server, ...pending];
}

/** True when the newest message on screen differs from the server's (so a resync changes something). */
export function snapshotDiffers(local: LiveMessage[], server: LiveMessage[]): boolean {
  const lastLocal = [...local].reverse().find((m) => !isLocal(m.id));
  const lastServer = server[server.length - 1];
  return (lastLocal?.id ?? null) !== (lastServer?.id ?? null) || (lastLocal?.content ?? '') !== (lastServer?.content ?? '');
}

function isLocal(id: string) { return id.startsWith('local') || id.startsWith('steer-local') || id.startsWith('div-'); }

/** A page hidden this long may have a dead connection that has not errored yet: reconnect on return. */
export const WAKE_AFTER_MS = 20_000;
