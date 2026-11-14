/**
 * Latest-wins request gate. Each begin() aborts the previous request and returns a token;
 * only the newest token is still current, so slow stale responses can never be applied.
 * No DOM types beyond AbortController, so the server test suite can exercise it.
 */
export function latestOnly() {
  let seq = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const mine = ++seq;
      return { signal: controller.signal, current: () => mine === seq };
    },
    cancel() { controller?.abort(); controller = null; seq += 1; },
  };
}

export function isAbort(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}
