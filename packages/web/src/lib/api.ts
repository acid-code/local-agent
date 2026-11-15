import { lang, tMaybe, t } from '../i18n';

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
    if (!res.ok) throw new ApiError(tMaybe(res.status === 502 || res.status === 504 ? 'The server is not answering right now.' : res.statusText || `Request failed (${res.status}).`), res.status);
    throw new ApiError(tMaybe('The server sent something that was not JSON.'), res.status);
  }
  if (!res.ok) throw new ApiError(tMaybe(data.error || res.statusText || `Request failed (${res.status}).`), res.status);
  const method = (init?.method || 'GET').toUpperCase();
  // Lets autosaving pages (Settings) show a "Saved" tick for any change, whichever card made it.
  if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') window.dispatchEvent(new CustomEvent('la:saved', { detail: { path } }));
  return (lang === 'en' ? data : localize(data)) as T;
}

export function post<T>(path: string, body?: unknown, init?: RequestInit) {
  return api<T>(path, { ...init, method: 'POST', body: body ? JSON.stringify(body) : '{}' });
}

type Row = Record<string, unknown>;
/** Personas added from the gallery keep their English template text on the server; show it in the UI language. */
function localizeAgent(agent: Row): Row {
  if (!agent || typeof agent !== 'object') return agent;
  const helper = typeof agent.description === 'string' ? /^(.+)'s helper$/.exec(agent.description) : null;
  if (helper) return { ...agent, description: t("{0}'s helper", [helper[1]]) };
  if (!agent.templateId) return agent;
  return { ...agent, name: tMaybe(agent.name as string) || agent.name, title: tMaybe(agent.title as string) || agent.title, description: tMaybe(agent.description as string) || agent.description };
}
export function localize(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const row = data as Row;
  const out: Row = { ...row };
  if (Array.isArray(row.agents)) out.agents = (row.agents as Row[]).map(localizeAgent);
  if (row.agent && typeof row.agent === 'object') out.agent = localizeAgent(row.agent as Row);
  if (Array.isArray(row.personas)) {
    out.personas = (row.personas as Row[]).map((item) => ({
      ...item,
      name: tMaybe(item.name as string), title: tMaybe(item.title as string), description: tMaybe(item.description as string), category: tMaybe(item.category as string),
      starters: Array.isArray(item.starters) ? (item.starters as string[]).map(tMaybe) : item.starters,
    }));
  }
  return out;
}
