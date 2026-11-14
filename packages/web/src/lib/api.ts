export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: { error?: string } = {};
  try { data = text ? JSON.parse(text) : {}; } catch {
    // A proxy error page or a half-written body. Never surface it raw.
    if (!res.ok) throw new ApiError(res.status === 502 || res.status === 504 ? 'The server is not answering right now.' : res.statusText || `Request failed (${res.status}).`, res.status);
    throw new ApiError('The server sent something that was not JSON.', res.status);
  }
  if (!res.ok) throw new ApiError(data.error || res.statusText || `Request failed (${res.status}).`, res.status);
  const method = (init?.method || 'GET').toUpperCase();
  // Lets autosaving pages (Settings) show a "Saved" tick for any change, whichever card made it.
  if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') window.dispatchEvent(new CustomEvent('la:saved', { detail: { path } }));
  return data as T;
}

export function post<T>(path: string, body?: unknown, init?: RequestInit) {
  return api<T>(path, { ...init, method: 'POST', body: body ? JSON.stringify(body) : '{}' });
}
