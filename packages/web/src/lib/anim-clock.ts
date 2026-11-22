/**
 * Live indicators (typing dots, pulsing step icons) remount whenever the stream toggles state. A plain CSS
 * animation restarts at 0% on every mount, which reads as flicker. Starting each one at a negative delay taken
 * from the wall clock puts every mount on the same shared timeline, so a remount continues the beat instead.
 * Pure (no React), so it is unit-tested from the server suite.
 */
export function clockDelay(periodMs: number, now: number = Date.now(), offsetMs = 0): string {
  const phase = ((now % periodMs) + periodMs) % periodMs;
  return `${Math.round(offsetMs - phase)}ms`;
}

/** Same id and same fields: the message did not change, so the old object (and its rendered rows) can stay. */
export function sameMessage(a: object, b: object): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (va === vb) continue;
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && JSON.stringify(va) === JSON.stringify(vb)) continue;
    return false;
  }
  return true;
}

/**
 * Applies a fresh server list while keeping the objects already on screen for messages that did not change, and
 * returns `prev` itself when nothing changed. Snapshots and reloads then no longer re-render (and restart the
 * animations of) every row.
 */
export function keepIdentity<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  let same = prev.length === next.length;
  const out = next.map((m, i) => {
    const old = byId.get(m.id);
    const kept = old && sameMessage(old, m) ? old : m;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}
