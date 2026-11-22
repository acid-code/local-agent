/**
 * What a "waiting" run is waiting for, so the UI can say it plainly:
 *  - queue:  another chat holds the large model / GPU; this one runs when that finishes. Never force it:
 *            loading a second large model next to the first one freezes the mini PC.
 *  - memory: the RAM admission check (MemAvailable) is waiting for room; Force run is a real option there.
 */
export interface QueueWaitInfo { kind: 'queue'; behind: string; ahead: number; since: string }

export interface WaitState {
  kind: 'queue' | 'memory';
  title: string;
  detail: string;
  behind: string | null;
  ahead: number;
  since: string | null;
  /** Force run only applies to the memory wait. */
  canForce: boolean;
}

const QUEUE_DETAIL = /^Waiting for (.+?) to finish(?: in another chat)? \(queued(?:, (\d+) ahead)?\)/i;

export function waitStateOf(detail: string | null | undefined, info?: unknown): WaitState {
  const text = (detail || '').trim();
  const q = info && typeof info === 'object' && (info as { kind?: string }).kind === 'queue' ? info as QueueWaitInfo : null;
  const m = q ? null : QUEUE_DETAIL.exec(text);
  if (q || m) {
    const behind = (q?.behind ?? m?.[1] ?? '').replace(/^the /, '') || null;
    const ahead = Math.max(1, q?.ahead ?? Number(m?.[2] ?? 1));
    return {
      kind: 'queue',
      title: behind ? `Queued behind ${behind}` : 'Queued',
      detail: ahead > 1
        ? `${ahead} chats are ahead of this one. It starts on its own when they finish.`
        : 'Another chat is using the large model. This one starts on its own when that finishes.',
      behind, ahead, since: q?.since ?? null, canForce: false,
    };
  }
  return { kind: 'memory', title: 'Waiting for memory', detail: text || 'Waiting for available RAM (MemAvailable)…', behind: null, ahead: 0, since: null, canForce: true };
}

/** "12s", "3m 04s" since an ISO time. */
export function waitedFor(since: string | null, nowMs = Date.now()): string {
  if (!since) return '';
  const s = Math.max(0, Math.round((nowMs - new Date(since).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
