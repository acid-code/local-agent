import type { Store } from './db.js';
import { gitStatus, listGitRoots, type GitRoot } from './gitops.js';
import { getWorkshop } from './workshops.js';

/**
 * Workspaces are chat context. Each chat keeps its own list of attached folders/repos ("root") and named sets ("set").
 * New chats start from the persona's default sets. The agent sees exactly this list.
 */
export interface ChatWorkspaceItem { kind: 'root' | 'set'; id: string }
export interface ChatWorkspaceRoot { id: string; label: string; path: string; kind: GitRoot['kind']; via: string | null; branch: string | null; dirty: number; isRepo: boolean }

const ready = new WeakSet<Store>();
function ensure(store: Store) {
  if (ready.has(store)) return;
  store.db.exec(`CREATE TABLE IF NOT EXISTS session_workspaces (
    session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, kind, ref))`);
  ready.add(store);
}

export function getChatWorkspaces(store: Store, sessionId: string): ChatWorkspaceItem[] {
  ensure(store);
  const rows = store.db.prepare('SELECT kind, ref FROM session_workspaces WHERE session_id = ? ORDER BY position, rowid').all(sessionId) as { kind: string; ref: string }[];
  const items = rows.map((row) => ({ kind: row.kind === 'set' ? 'set' as const : 'root' as const, id: row.ref }));
  // Chats from before this table used one workshop per session.
  const legacy = store.getSession(sessionId)?.workshopId;
  if (legacy && !items.some((item) => item.kind === 'set' && item.id === legacy)) items.unshift({ kind: 'set', id: legacy });
  return items;
}

export function setChatWorkspaces(store: Store, sessionId: string, items: ChatWorkspaceItem[]) {
  ensure(store);
  const unique = [...new Map(items.map((item) => [`${item.kind}:${item.id}`, item])).values()];
  store.db.prepare('DELETE FROM session_workspaces WHERE session_id = ?').run(sessionId);
  const insert = store.db.prepare('INSERT INTO session_workspaces (session_id, kind, ref, position) VALUES (?, ?, ?, ?)');
  unique.forEach((item, index) => insert.run(sessionId, item.kind, item.id, index));
  // Keep the legacy single-set column in step, so older code paths (workshop planning) still work.
  const firstSet = unique.find((item) => item.kind === 'set')?.id ?? null;
  const session = store.getSession(sessionId);
  if (session && session.workshopId !== firstSet) store.updateSession(sessionId, { workshopId: firstSet, ...(unique.length ? { mode: 'code' as const } : {}) });
  else if (session && unique.length && session.mode !== 'code') store.updateSession(sessionId, { mode: 'code' });
  return unique;
}

/** A new chat starts with its persona's default workspace sets. */
export function prefillChatWorkspaces(store: Store, sessionId: string, agentId: string | null | undefined) {
  if (!agentId) return [];
  const defaults = store.getAgent(agentId)?.workshopIds ?? [];
  if (!defaults.length) return [];
  return setChatWorkspaces(store, sessionId, defaults.map((id) => ({ kind: 'set' as const, id })));
}

/** The folders a chat works in, sets expanded, each once, with branch and uncommitted count. */
export async function resolveChatWorkspaces(store: Store, sessionId: string, ownerId: string, opts: { status?: boolean } = {}) {
  const items = getChatWorkspaces(store, sessionId);
  const all = listGitRoots(store, ownerId);
  const byId = new Map(all.map((root) => [root.id, root]));
  const byPath = new Map(all.map((root) => [root.path, root]));
  const sets: { id: string; name: string; roots: string[] }[] = [];
  const picked = new Map<string, { root: GitRoot; via: string | null }>();
  for (const item of items) {
    if (item.kind === 'root') { const root = byId.get(item.id); if (root && !picked.has(root.id)) picked.set(root.id, { root, via: null }); continue; }
    const shop = getWorkshop(store, item.id);
    if (!shop) continue;
    const ids: string[] = [];
    for (const project of shop.projects) {
      const root = byPath.get(project.path) ?? byId.get(`prj:${project.label}`);
      if (!root) continue;
      ids.push(root.id);
      if (!picked.has(root.id)) picked.set(root.id, { root, via: shop.name });
    }
    sets.push({ id: shop.id, name: shop.name, roots: ids });
  }
  const roots: ChatWorkspaceRoot[] = [];
  for (const { root, via } of picked.values()) {
    let branch: string | null = null; let dirty = 0; let isRepo = false;
    if (opts.status !== false) {
      try { const status = await gitStatus(root.path); branch = status.branch; dirty = status.files.length; isRepo = status.isRepo; } catch { /* unreadable folder */ }
    }
    roots.push({ id: root.id, label: root.label, path: root.path, kind: root.kind, via, branch, dirty, isRepo });
  }
  return { items, roots, sets };
}

/** What the agent is told about this chat's workspaces: names, paths, branch, recent changes. */
export async function chatWorkspaceBrief(store: Store, sessionId: string, ownerId: string): Promise<string> {
  const { roots } = await resolveChatWorkspaces(store, sessionId, ownerId, { status: false });
  if (!roots.length) return '';
  const lines: string[] = [];
  for (const root of roots) {
    let line = `- ${root.label}: ${root.path}`;
    try {
      const status = await gitStatus(root.path);
      if (status.isRepo) {
        line += ` (git, branch ${status.branch ?? 'detached'}${status.ahead ? `, ${status.ahead} ahead` : ''}${status.behind ? `, ${status.behind} behind` : ''})`;
        if (status.files.length) line += `\n  Uncommitted: ${status.files.slice(0, 12).map((file) => `${(file.index + file.work).trim() || '?'} ${file.path}`).join(', ')}${status.files.length > 12 ? ` and ${status.files.length - 12} more` : ''}`;
        if (status.log.length) line += `\n  Recent commits: ${status.log.slice(0, 3).map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`).join('; ')}`;
      } else line += ' (folder, not a git repo)';
    } catch { line += ' (unreadable right now)'; }
    lines.push(line);
  }
  return `\n\nThis chat is attached to ${roots.length} workspace${roots.length === 1 ? '' : 's'}. Work only in these unless asked; name the workspace on git, shell and edits. Files the user @-mentions are attached to their message. Pull, push and commits on main wait for approval.\n${lines.join('\n')}`;
}

/** Paths the agent may read and edit in this chat. */
export function chatWorkspacePaths(store: Store, sessionId: string, ownerId: string): { label: string; path: string }[] {
  const items = getChatWorkspaces(store, sessionId);
  if (!items.length) return [];
  const all = listGitRoots(store, ownerId);
  const out = new Map<string, { label: string; path: string }>();
  for (const item of items) {
    if (item.kind === 'root') { const root = all.find((r) => r.id === item.id); if (root) out.set(root.path, { label: root.label, path: root.path }); continue; }
    for (const project of getWorkshop(store, item.id)?.projects ?? []) out.set(project.path, { label: project.label, path: project.path });
  }
  return [...out.values()];
}
