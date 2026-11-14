import fs from 'node:fs';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { Store } from './db.js';
import { nid, now } from './util.js';

/** The owner's account id. Rows created before members existed belong to the owner. */
export const OWNER_ID = 'owner';

export interface MemberLimits {
  /** Cloud models (Gemini). Off keeps the member on local models. */
  cloud: boolean;
  /** Most personas this member may create. */
  maxAgents: number;
}
export const DEFAULT_LIMITS: MemberLimits = { cloud: true, maxAgents: 12 };

export interface Account {
  id: string;
  role: 'owner' | 'member';
  username: string;
  displayName: string;
  limits: MemberLimits;
}

export interface MemberRow { id: string; username: string; displayName: string; limits: MemberLimits; disabled: boolean; createdAt: string }

const mapMember = (row: Record<string, unknown>): MemberRow => ({
  id: String(row.id), username: String(row.username), displayName: String(row.display_name),
  limits: { ...DEFAULT_LIMITS, ...safeJson(String(row.limits || '{}')) }, disabled: Boolean(row.disabled), createdAt: String(row.created_at),
});

function safeJson(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

export function getAccount(store: Store, id: string): Account | null {
  if (id === OWNER_ID) {
    const owner = store.getOwner();
    return owner ? { id: OWNER_ID, role: 'owner', username: owner.username, displayName: owner.username, limits: { cloud: true, maxAgents: 1000 } } : null;
  }
  const member = getMember(store, id);
  if (!member || member.disabled) return null;
  return { id: member.id, role: 'member', username: member.username, displayName: member.displayName, limits: member.limits };
}

export function listMembers(store: Store): MemberRow[] {
  return (store.db.prepare('SELECT * FROM members ORDER BY created_at').all() as Record<string, unknown>[]).map(mapMember);
}

export function getMember(store: Store, id: string): MemberRow | null {
  const row = store.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapMember(row) : null;
}

export function memberByUsername(store: Store, username: string): (MemberRow & { passwordHash: string }) | null {
  const row = store.db.prepare('SELECT * FROM members WHERE lower(username) = lower(?)').get(username) as Record<string, unknown> | undefined;
  return row ? { ...mapMember(row), passwordHash: String(row.password_hash) } : null;
}

export const USERNAME_RE = /^[a-zA-Z0-9._-]{1,32}$/;

export function createMember(store: Store, input: { username: string; displayName?: string; passwordHash: string; limits?: Partial<MemberLimits> }): MemberRow {
  if (!USERNAME_RE.test(input.username)) throw new Error('Usernames use letters, numbers, dot, dash and underscore.');
  const owner = store.getOwner();
  if (owner && owner.username.toLowerCase() === input.username.toLowerCase()) throw new Error('That username is taken.');
  if (memberByUsername(store, input.username)) throw new Error('That username is taken.');
  const id = nid('usr');
  const ts = now();
  store.db.prepare('INSERT INTO members (id, username, display_name, password_hash, limits, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(
    id, input.username, (input.displayName || input.username).slice(0, 60), input.passwordHash, JSON.stringify({ ...DEFAULT_LIMITS, ...(input.limits || {}) }), ts, ts,
  );
  return getMember(store, id)!;
}

export function updateMember(store: Store, id: string, patch: { displayName?: string; limits?: Partial<MemberLimits>; disabled?: boolean; passwordHash?: string }) {
  const current = getMember(store, id);
  if (!current) return null;
  store.db.prepare('UPDATE members SET display_name = ?, limits = ?, disabled = ?, updated_at = ? WHERE id = ?').run(
    (patch.displayName ?? current.displayName).slice(0, 60), JSON.stringify({ ...current.limits, ...(patch.limits || {}) }), (patch.disabled ?? current.disabled) ? 1 : 0, now(), id,
  );
  if (patch.passwordHash) store.db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(patch.passwordHash, id);
  if (patch.disabled || patch.passwordHash) store.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(id);
  return getMember(store, id);
}

/** Removes the member, their sign-ins, their rows, and their folder. */
export function deleteMember(store: Store, dataDir: string, id: string) {
  if (id === OWNER_ID) throw new Error('The owner cannot be removed.');
  store.transaction(() => {
    const sessions = (store.db.prepare('SELECT id FROM chat_sessions WHERE owner_id = ?').all(id) as { id: string }[]).map((row) => row.id);
    for (const sessionId of sessions) {
      store.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      store.db.prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId);
    }
    const agents = (store.db.prepare('SELECT id FROM agents WHERE owner_id = ?').all(id) as { id: string }[]).map((row) => row.id);
    for (const agentId of agents) {
      store.db.prepare('DELETE FROM memory_notes WHERE agent_id = ?').run(agentId);
      store.db.prepare('DELETE FROM schedules WHERE agent_id = ?').run(agentId);
    }
    const collections = (store.db.prepare('SELECT id FROM kb_collections WHERE owner_id = ?').all(id) as { id: string }[]).map((row) => row.id);
    for (const collectionId of collections) {
      store.db.prepare('DELETE FROM kb_chunks WHERE collection_id = ?').run(collectionId);
      store.db.prepare('DELETE FROM kb_documents WHERE collection_id = ?').run(collectionId);
    }
    for (const table of ['chat_sessions', 'agents', 'kb_collections', 'rooms', 'schedules', 'triggers', 'files']) {
      try { store.db.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).run(id); } catch { /* table without owner column */ }
    }
    store.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(id);
    store.db.prepare('DELETE FROM account_prefs WHERE account_id = ?').run(id);
    store.db.prepare('DELETE FROM members WHERE id = ?').run(id);
  });
  fs.rmSync(accountDir(dataDir, id), { recursive: true, force: true });
}

/** Each member's files live under dataDir/users/<id>. The owner keeps the original layout. */
export function accountDir(dataDir: string, accountId: string) {
  if (accountId === OWNER_ID) return dataDir;
  if (!/^usr_[A-Za-z0-9]+$/.test(accountId)) throw new Error('Bad account id.');
  return path.join(dataDir, 'users', accountId);
}

export function usersRoot(dataDir: string) {
  return path.join(path.resolve(dataDir), 'users');
}

/** True when `target` is a path the account may not touch: another member's folder (or any member folder for the owner). */
export function foreignPath(dataDir: string, accountId: string, target: string) {
  const root = usersRoot(dataDir);
  const full = path.resolve(target);
  if (full !== root && !full.startsWith(root + path.sep)) return accountId !== OWNER_ID && !full.startsWith(path.resolve(accountDir(dataDir, accountId)));
  if (accountId === OWNER_ID) return true;
  const own = path.resolve(accountDir(dataDir, accountId));
  return !(full === own || full.startsWith(own + path.sep));
}

export function workspaceFor(dataDir: string, accountId: string, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
  return path.join(accountDir(dataDir, accountId), 'workspaces', slug);
}

export function getTheme(store: Store, accountId: string): Record<string, unknown> | null {
  const row = store.db.prepare('SELECT theme FROM account_prefs WHERE account_id = ?').get(accountId) as { theme: string } | undefined;
  return row ? safeJson(row.theme) : null;
}

export function setTheme(store: Store, accountId: string, theme: Record<string, unknown>) {
  store.db.prepare('INSERT INTO account_prefs (account_id, theme, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at')
    .run(accountId, JSON.stringify(theme), now());
}

type Kind = 'agent' | 'session' | 'run' | 'file' | 'collection' | 'room' | 'schedule' | 'trigger' | 'message' | 'approval' | 'note' | 'workshop';

/** The account that owns a row, or null when the row does not exist. */
export function ownerOf(store: Store, kind: Kind, id: string): string | null {
  const sql: Record<Kind, string> = {
    agent: 'SELECT owner_id AS o FROM agents WHERE id = ?',
    session: 'SELECT owner_id AS o FROM chat_sessions WHERE id = ?',
    run: 'SELECT s.owner_id AS o FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE r.id = ?',
    file: 'SELECT owner_id AS o FROM files WHERE id = ?',
    collection: 'SELECT owner_id AS o FROM kb_collections WHERE id = ?',
    room: 'SELECT owner_id AS o FROM rooms WHERE id = ?',
    schedule: 'SELECT a.owner_id AS o FROM schedules x JOIN agents a ON a.id = x.agent_id WHERE x.id = ?',
    trigger: 'SELECT a.owner_id AS o FROM triggers x JOIN agents a ON a.id = x.agent_id WHERE x.id = ?',
    message: 'SELECT s.owner_id AS o FROM messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.id = ?',
    approval: 'SELECT s.owner_id AS o FROM approvals p JOIN runs r ON r.id = p.run_id JOIN chat_sessions s ON s.id = r.session_id WHERE p.id = ?',
    note: 'SELECT a.owner_id AS o FROM memory_notes n JOIN agents a ON a.id = n.agent_id WHERE n.id = ?',
    workshop: 'SELECT owner_id AS o FROM workshops WHERE id = ?',
  };
  try {
    const row = store.db.prepare(sql[kind]).get(id) as { o: string } | undefined;
    return row ? String(row.o || OWNER_ID) : null;
  } catch {
    return null;
  }
}

export function accountOf(req: FastifyRequest): Account {
  const account = (req as { account?: Account }).account;
  if (!account) throw Object.assign(new Error('Sign in required.'), { statusCode: 401 });
  return account;
}

/** 404 unless the row belongs to the signed-in account. Not-found and not-yours look the same. */
export function mustOwn(store: Store, req: FastifyRequest, kind: Kind, id: string, what = 'Not found.') {
  const owner = ownerOf(store, kind, id);
  if (!owner || owner !== accountOf(req).id) throw Object.assign(new Error(what), { statusCode: 404 });
}

/** Tools a member's personas never get: host shell, Docker, other people's folders, the owner's vault and CLIs. */
export const MEMBER_DENIED_TOOLS = new Set([
  'shell', 'docker_ps', 'docker_inspect', 'docker_run', 'docker_rm', 'request_folder', 'handoff_cli', 'repo_sync', 'run_skill_script', 'request_secret',
]);

/**
 * Routes a member may call. Everything else is owner-only (setup, providers, MCP, Docker, debug, vault, tokens, backups, settings).
 * Each listed route still checks that the row belongs to the caller.
 */
export const MEMBER_ROUTES = new Set([
  'GET /api/auth/me', 'POST /api/auth/logout', 'POST /api/account/password', 'GET /api/me', 'GET /api/me/theme', 'PUT /api/me/theme', 'GET /api/me/quota', 'POST /api/me/wallpaper', 'GET /api/me/wallpaper', 'DELETE /api/me/wallpaper', 'GET /api/images/status', 'POST /api/images/generate',
  'GET /api/agents', 'POST /api/agents', 'POST /api/agents/reorder', 'GET /api/agents/:id', 'PATCH /api/agents/:id', 'DELETE /api/agents/:id',
  'POST /api/agents/:id/read', 'POST /api/agents/:id/avatar', 'GET /api/agents/:id/avatar', 'GET /api/agents/:id/files', 'GET /api/agents/:id/file',
  'GET /api/rooms', 'POST /api/rooms',
  'POST /api/files', 'GET /api/files', 'GET /api/files/:id', 'GET /api/files/:id/raw', 'DELETE /api/files/:id',
  'GET /api/messages/:id', 'GET /api/context/search',
  'GET /api/git/roots', 'GET /api/git/:root/status', 'GET /api/git/:root/diff', 'GET /api/git/:root/tree', 'GET /api/git/:root/raw', 'GET /api/git/:root/file', 'POST /api/git/:root/action',
  'GET /api/sessions', 'POST /api/sessions', 'GET /api/sessions/:id', 'PATCH /api/sessions/:id', 'DELETE /api/sessions/:id', 'POST /api/sessions/:id/messages',
  'GET /api/sessions/:id/plan', 'PUT /api/sessions/:id/plan', 'PATCH /api/plan-items/:id', 'GET /api/sessions/:id/edits', 'POST /api/edits/:id/revert',
  'GET /api/runs', 'GET /api/runs/:id', 'GET /api/runs/:id/events', 'POST /api/runs/:id/control',
  'GET /api/approvals', 'POST /api/approvals/:id',
  'GET /api/models',
  'GET /api/schedules', 'POST /api/schedules', 'PATCH /api/schedules/:id', 'DELETE /api/schedules/:id', 'POST /api/schedules/:id/run',
  'GET /api/voice', 'POST /api/voice/transcribe', 'POST /api/voice/speak',
  'GET /api/memory', 'POST /api/memory', 'DELETE /api/memory/:id',
  'GET /api/live',
  'GET /api/kb/collections', 'POST /api/kb/collections', 'POST /api/kb/collections/:id/files', 'GET /api/kb/collections/:id/files',
  'DELETE /api/kb/collections/:id/files/:docId', 'DELETE /api/kb/collections/:id', 'POST /api/kb/collections/:id/reindex', 'POST /api/kb/search',
  'GET /api/skills', 'GET /api/skills/:slug',
]);
