export type ToastKind = 'info' | 'error' | 'ok';
export interface Toast { id: number; kind: ToastKind; text: string }

let seq = 0;
/** Shows a short message at the bottom of the screen. Safe to call from anywhere. */
export function toast(text: string, kind: ToastKind = 'info') {
  window.dispatchEvent(new CustomEvent<Toast>('la-toast', { detail: { id: ++seq, kind, text } }));
}

/** A readable sentence for any thrown value, never a raw JSON blob. */
export function errorText(error: unknown, fallback = 'Something went wrong.'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!raw) return fallback;
  if (/^\s*[{[]/.test(raw)) {
    try {
      const data = JSON.parse(raw) as { error?: string; message?: string };
      return data.error || data.message || fallback;
    } catch { return fallback; }
  }
  return raw.length > 240 ? `${raw.slice(0, 239)}…` : raw;
}
