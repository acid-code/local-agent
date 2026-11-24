import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside } from '@local-agent/shared';
import { locatePath, projectPath, type PathHit } from './workshops.js';
import { addProjectNote, explainPull, git, listSharedRepos, pushApproval, registerSharedRepo, tryLockRepo } from './repos.js';
import { getChatWorkspaces, setChatWorkspaces } from './chat-workspaces.js';
import { listGitRoots, openPullRequest, validBranch } from './gitops.js';
import { runPreCommitSemgrep } from './semgrep.js';
import { OWNER_ID, foreignPath } from './accounts.js';
import type { Store } from './db.js';
import type { Tool, ToolContext } from './tools.js';
import { nid, now } from './util.js';

export interface PlanItem { id: string; text: string; status: string; note: string | null; position: number }
export interface EditBatch { id: string; sessionId: string; runId: string | null; label: string; diff: string; createdAt: string; revertedAt: string | null; keptAt: string | null; keptFiles: string[]; revertedFiles: string[] }

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function lineDiff(file: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
    aEnd -= 1;
    bEnd -= 1;
  }
  const lines = [`--- a/${file}`, `+++ b/${file}`, `@@ -${start + 1},${Math.max(0, aEnd - start + 1)} +${start + 1},${Math.max(0, bEnd - start + 1)} @@`];
  for (let index = start; index <= aEnd; index += 1) lines.push(`-${a[index] ?? ''}`);
  for (let index = start; index <= bEnd; index += 1) lines.push(`+${b[index] ?? ''}`);
  return lines.join('\n');
}

/** Locate the closest matching line window when an exact search-and-replace snippet misses. */
export function findClosestBlock(before: string, search: string): { startLine: number; endLine: number; snippet: string } | null {
  const lines = before.split('\n');
  const searchLines = search.split('\n').map((l) => l.trim());
  const nonEmpty = searchLines.filter(Boolean);
  if (!nonEmpty.length || !lines.length) return null;
  const trimmedLines = lines.map((l) => l.trim());
  const nonEmptySet = new Set(nonEmpty);
  const candidates = new Set<number>();
  for (let i = 0; i < trimmedLines.length; i += 1) {
    if (!trimmedLines[i] || !nonEmptySet.has(trimmedLines[i]!)) continue;
    for (let s = 0; s < searchLines.length; s += 1) {
      if (searchLines[s] === trimmedLines[i]) candidates.add(Math.max(0, i - s));
    }
  }
  if (!candidates.size && nonEmpty[0]!.length >= 10) {
    const head = nonEmpty[0]!.slice(0, 24);
    for (let i = 0; i < trimmedLines.length; i += 1) {
      if (trimmedLines[i]!.includes(head)) candidates.add(Math.max(0, i));
    }
  }
  if (!candidates.size) return null;
  let bestStart = 0;
  let bestHits = 0;
  for (const start of candidates) {
    let hits = 0;
    const end = Math.min(lines.length, start + searchLines.length + 2);
    const windowSet = new Set(trimmedLines.slice(start, end).filter(Boolean));
    for (const needle of nonEmpty) {
      if (windowSet.has(needle)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestStart = start;
    }
  }
  const minRequired = nonEmpty.length <= 2 ? 1 : Math.max(2, Math.ceil(nonEmpty.length * 0.4));
  if (bestHits < minRequired) return null;
  const from = Math.max(0, bestStart - 1);
  const to = Math.min(lines.length - 1, Math.min(from + 13, bestStart + Math.max(searchLines.length, 4)));
  const snippet = lines.slice(from, to + 1).map((line, idx) => `${from + idx + 1}: ${line}`).join('\n');
  return { startLine: from + 1, endLine: to + 1, snippet };
}

export function applySearchReplace(before: string, search: string, replace: string): string {
  if (!search) throw new Error('The search text is empty.');
  const at = before.indexOf(search);
  if (at < 0) {
    const closest = findClosestBlock(before, search);
    if (closest) {
      throw new Error(`That text was not found. Closest match is lines ${closest.startLine}-${closest.endLine}:\n${closest.snippet}\nCopy the exact lines from above and retry apply_patch.`);
    }
    throw new Error('That text was not found. Read the file and include a longer unique snippet.');
  }
  if (before.indexOf(search, at + search.length) >= 0) throw new Error('That snippet matches more than once. Include more context.');
  return `${before.slice(0, at)}${replace}${before.slice(at + search.length)}`;
}

export function replacePlan(store: Store, sessionId: string, items: string[], runId?: string | null) {
  snapshotPlan(store, sessionId);
  const existing = store.db.prepare('SELECT id FROM plans WHERE session_id = ?').get(sessionId) as { id: string } | undefined;
  const id = existing?.id ?? nid('plan');
  const ts = now();
  if (!existing) store.db.prepare('INSERT INTO plans (id, session_id, run_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, runId ?? null, 'Plan', 'open', ts, ts);
  else store.db.prepare('UPDATE plans SET run_id = COALESCE(?, run_id), updated_at = ?, status = ? WHERE id = ?').run(runId ?? null, ts, 'open', id);
  store.db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(id);
  items.forEach((text, position) => {
    store.db.prepare('INSERT INTO plan_items (id, plan_id, position, text, status, note) VALUES (?, ?, ?, ?, ?, NULL)').run(nid('todo'), id, position, text, 'pending');
  });
  return readPlan(store, sessionId);
}

export function updatePlanItem(store: Store, itemId: string, patch: { text?: string; status?: string; note?: string }) {
  const row = store.db.prepare('SELECT i.*, p.session_id AS session_id FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ?').get(itemId) as { text: string; status: string; note: string | null; plan_id: string; session_id: string } | undefined;
  if (!row) return null;
  snapshotPlan(store, row.session_id);
  store.db.prepare('UPDATE plan_items SET text = ?, status = ?, note = ? WHERE id = ?').run(patch.text ?? row.text, patch.status ?? row.status, patch.note ?? row.note, itemId);
  store.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now(), row.plan_id);
  return true;
}

function snapshotPlan(store: Store, sessionId: string) {
  const plan = readPlan(store, sessionId);
  store.db.prepare('INSERT INTO plan_history (id, session_id, payload, created_at) VALUES (?, ?, ?, ?)').run(nid('ph'), sessionId, plan ? JSON.stringify(plan) : null, now());
  store.db.prepare('DELETE FROM plan_history WHERE id IN (SELECT id FROM plan_history WHERE session_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 20)').run(sessionId);
}

export function undoPlan(store: Store, sessionId: string): { id: string; title: string; status: string; items: PlanItem[] } | null {
  const snapshot = store.db.prepare('SELECT id, payload FROM plan_history WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId) as { id: string; payload: string | null } | undefined;
  if (!snapshot) return null;
  store.db.prepare('DELETE FROM plan_history WHERE id = ?').run(snapshot.id);
  if (!snapshot.payload) {
    store.db.prepare('DELETE FROM plan_items WHERE plan_id IN (SELECT id FROM plans WHERE session_id = ?)').run(sessionId);
    store.db.prepare('DELETE FROM plans WHERE session_id = ?').run(sessionId);
    return null;
  }
  const saved = JSON.parse(snapshot.payload) as { id: string; title: string; status: string; items: PlanItem[] };
  const ts = now();
  const existing = store.db.prepare('SELECT id FROM plans WHERE session_id = ?').get(sessionId) as { id: string } | undefined;
  const id = existing?.id ?? nid('plan');
  if (existing) store.db.prepare('UPDATE plans SET run_id = NULL, title = ?, status = ?, updated_at = ? WHERE id = ?').run(saved.title, saved.status, ts, id);
  else store.db.prepare('INSERT INTO plans (id, session_id, run_id, title, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(id, sessionId, saved.title, saved.status, ts, ts);
  store.db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(id);
  saved.items.forEach((item, position) => {
    store.db.prepare('INSERT INTO plan_items (id, plan_id, position, text, status, note) VALUES (?, ?, ?, ?, ?, ?)').run(item.id, id, position, item.text, item.status, item.note);
  });
  return readPlan(store, sessionId);
}

export function readPlan(store: Store, sessionId: string): { id: string; title: string; status: string; createdAt?: string; updatedAt?: string; items: PlanItem[]; canUndo: boolean } | null {
  const plan = store.db.prepare('SELECT * FROM plans WHERE session_id = ?').get(sessionId) as { id: string; title: string; status: string; created_at?: string; updated_at?: string } | undefined;
  if (!plan) return null;
  const items = (store.db.prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position').all(plan.id) as { id: string; text: string; status: string; note: string | null; position: number }[])
    .map((item) => ({ id: item.id, text: item.text, status: item.status, note: item.note, position: item.position }));
  const history = store.db.prepare('SELECT COUNT(*) AS count FROM plan_history WHERE session_id = ?').get(sessionId) as { count: number };
  return { id: plan.id, title: plan.title, status: plan.status, createdAt: plan.created_at, updatedAt: plan.updated_at, items, canUndo: history.count > 0 };
}

export function listEdits(store: Store, sessionId: string): EditBatch[] {
  return (store.db.prepare('SELECT * FROM edit_batches WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as Record<string, unknown>[]).map(mapBatch);
}

type BatchFile = { path: string; before: string | null; after?: string | null };
const readOrNull = async (file: string) => { try { return await fs.readFile(file, 'utf8'); } catch { return null; } };

/** A file changed after the agent's edit (by you or another run): rolling back would throw that work away. */
export class RollbackConflict extends Error {
  constructor(readonly paths: string[]) { super(`Not rolled back: ${paths.join(', ')} changed after this edit. Undo those changes first, or roll back the later edit.`); }
}

/**
 * Checks, then restores, a list of batches (newest first). Nothing is written when any file no longer
 * matches what the batch wrote, so a rollback never clobbers a later edit made by you or a concurrent run.
 */
export async function revertBatches(store: Store, batchIds: string[]) {
  const rows = batchIds.map((id) => {
    const row = store.db.prepare('SELECT * FROM edit_batches WHERE id = ?').get(id) as { id: string; files: string; reverted_at: string | null; reverted_files: string | null } | undefined;
    if (!row) throw new Error('Edit batch not found.');
    if (row.reverted_at) throw new Error('That batch was already reverted.');
    let revertedFiles: string[] = [];
    try { revertedFiles = JSON.parse(row.reverted_files || '[]') as string[]; } catch { revertedFiles = []; }
    return { id: row.id, files: (JSON.parse(row.files) as BatchFile[]).filter((file) => !revertedFiles.includes(file.path)), revertedFiles };
  });
  const current = new Map<string, string | null>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    for (const file of row.files) {
      if (!current.has(file.path)) current.set(file.path, await readOrNull(file.path));
      if (file.after !== undefined && current.get(file.path) !== file.after) conflicts.add(file.path);
      current.set(file.path, file.before);
    }
  }
  if (conflicts.size) throw new RollbackConflict([...conflicts]);
  for (const [file, content] of current) {
    if (content == null) await fs.rm(file, { force: true });
    else { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, 'utf8'); }
  }
  for (const row of rows) store.db.prepare('UPDATE edit_batches SET reverted_at = ? WHERE id = ?').run(now(), row.id);
  return rows.length;
}

export async function revertBatch(store: Store, batchId: string) {
  await revertBatches(store, [batchId]);
}

export async function revertBatchFile(store: Store, batchId: string, filePath: string) {
  const row = store.db.prepare('SELECT * FROM edit_batches WHERE id = ?').get(batchId) as { id: string; files: string; reverted_at: string | null; reverted_files: string | null } | undefined;
  if (!row) throw new Error('Edit batch not found.');
  if (row.reverted_at) throw new Error('That edit batch was already reverted.');
  const files = JSON.parse(row.files) as BatchFile[];
  const reverted = row.reverted_files ? JSON.parse(row.reverted_files) as string[] : [];
  const match = files.find((file) => file.path === filePath || file.path.endsWith(filePath) || filePath.endsWith(file.path));
  if (!match) throw new Error(`That file is not in this edit batch: ${filePath}`);
  if (reverted.includes(match.path)) throw new Error('That file was already reverted.');
  if (match.after !== undefined && await readOrNull(match.path) !== match.after) {
    throw new RollbackConflict([match.path]);
  }
  if (match.before == null) await fs.rm(match.path, { force: true });
  else { await fs.mkdir(path.dirname(match.path), { recursive: true }); await fs.writeFile(match.path, match.before, 'utf8'); }
  reverted.push(match.path);
  store.db.prepare('UPDATE edit_batches SET reverted_files=? WHERE id=?').run(JSON.stringify(reverted), batchId);
  if (files.every((file) => reverted.includes(file.path))) store.db.prepare('UPDATE edit_batches SET reverted_at=? WHERE id=?').run(now(), batchId);
}

export function keepBatch(store: Store, batchId: string, filePath?: string) {
  const row = store.db.prepare('SELECT kept_files FROM edit_batches WHERE id=?').get(batchId) as { kept_files: string | null } | undefined;
  if (!row) throw new Error('Edit batch not found.');
  if (!filePath) {
    store.db.prepare('UPDATE edit_batches SET kept_at=? WHERE id=?').run(now(), batchId);
    return;
  }
  const kept = row.kept_files ? JSON.parse(row.kept_files) as string[] : [];
  if (!kept.includes(filePath)) kept.push(filePath);
  store.db.prepare('UPDATE edit_batches SET kept_files=? WHERE id=?').run(JSON.stringify(kept), batchId);
}

export function grantFolder(store: Store, agentId: string, folder: string, mode: 'read' | 'write') {
  const id = nid('grant');
  store.db.prepare('INSERT INTO folder_grants (id, agent_id, path, mode, created_at) VALUES (?, ?, ?, ?, ?)').run(id, agentId, path.resolve(folder), mode, now());
  return { id, path: path.resolve(folder), mode };
}

export function grantsFor(store: Store, agentId: string) {
  return (store.db.prepare('SELECT id, path, mode, created_at FROM folder_grants WHERE agent_id = ?').all(agentId) as { id: string; path: string; mode: string; created_at: string }[])
    .map((row) => ({ id: row.id, path: row.path, mode: row.mode, createdAt: row.created_at }));
}

export async function detectCodingClis(): Promise<string[]> {
  const names = ['cursor-agent', 'claude', 'aider', 'codex'];
  const found: string[] = [];
  for (const name of names) if (await onPath(name)) found.push(name);
  return found;
}

function allowedRoot(ctx: ToolContext, target: string): PathHit | null {
  return locatePath({
    workspace: ctx.workspace,
    roots: ctx.roots,
    // Grants never open another account's folder.
    grants: grantsFor(ctx.store, ctx.agent.id).filter((grant) => !ctx.libraryDir || !foreignPath(ctx.libraryDir, ctx.agent.ownerId || OWNER_ID, grant.path)),
    target,
  });
}

/** Create a brand-new local git project under LA_PROJECTS_DIR (/projects), optionally create a GitHub repo, and attach it to a chat. */
export async function scaffoldProject(input: {
  store: Store;
  ownerId: string;
  name: string;
  description?: string;
  createGithub?: boolean;
  isPrivate?: boolean;
  token?: string | null;
  fetchImpl?: typeof fetch;
  sessionId?: string | null;
}) {
  const safeName = path.basename(input.name.trim()).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!safeName) throw new Error('Enter a valid project name (letters, numbers, hyphens).');
  const root = path.resolve(process.env.LA_PROJECTS_DIR || '/projects');
  await fs.mkdir(root, { recursive: true });
  const target = path.resolve(root, safeName);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid project path.');
  const exists = await fs.access(target).then(() => true).catch(() => false);
  if (!exists) {
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'README.md'), `# ${safeName}\n\n${(input.description || 'Created with local-agent.').trim()}\n`, 'utf8');
    await git(target, ['init', '-b', 'main']).catch(() => git(target, ['init']));
    await git(target, ['add', 'README.md']).catch(() => undefined);
    await git(target, ['-c', 'user.name=local-agent', '-c', 'user.email=agent@local-agent.local', 'commit', '-m', 'Initial commit']).catch(() => undefined);
  }
  let remoteUrl: string | null = null;
  if (input.createGithub && input.token) {
    const res = await (input.fetchImpl || fetch)('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.token}`, 'user-agent': 'local-agent', accept: 'application/vnd.github+json' },
      body: JSON.stringify({ name: safeName, description: input.description || '', private: input.isPrivate !== false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const created = await res.json() as { clone_url?: string };
      remoteUrl = created.clone_url || null;
      if (remoteUrl) {
        await git(target, ['remote', 'add', 'origin', remoteUrl]).catch(() => git(target, ['remote', 'set-url', 'origin', remoteUrl!]).catch(() => undefined));
      }
    }
  }
  const existing = listSharedRepos(input.store).find((r) => path.resolve(r.path) === target);
  const repo = existing ?? registerSharedRepo(input.store, { label: safeName, path: target, remote: remoteUrl });
  if (input.sessionId) {
    const rootEntry = listGitRoots(input.store, input.ownerId).find((r) => path.resolve(r.path) === target);
    const rootId = rootEntry?.id ?? `repo:${repo.label}`;
    const current = getChatWorkspaces(input.store, input.sessionId);
    if (!current.some((item) => item.kind === 'root' && item.id === rootId)) {
      setChatWorkspaces(input.store, input.sessionId, [...current, { kind: 'root', id: rootId }]);
    }
  }
  return { repo, path: target, remoteUrl, alreadyExisted: exists };
}

export const CODING_TOOLS: Tool[] = [
  {
    name: 'plan',
    description: 'Replace or update the visible plan for this coding session. The owner can edit it too. With items, also pass checks: 1-5 acceptance checks that prove it is done (put commands in backticks, e.g. "`npm test` passes"); the run cannot finish until they are verified.',
    parameters: obj({ items: { type: 'array', items: { type: 'string' } }, itemId: { type: 'string' }, status: { type: 'string' }, text: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } } }),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const sessionId = ctx.sessionId;
      if (!sessionId) throw new Error('No session.');
      if (Array.isArray(args.items)) {
        const plan = replacePlan(ctx.store, sessionId, (args.items as unknown[]).map(String).slice(0, 20), ctx.runId);
        const checks = Array.isArray(args.checks) ? (args.checks as unknown[]).map(String).map((item) => item.trim()).filter(Boolean).slice(0, 10) : [];
        if (checks.length && ctx.runId) {
          const run = ctx.store.getRun(ctx.runId);
          if (run) ctx.store.updateRun(run.id, { cursor: { ...run.cursor, acceptance: checks } });
        }
        const listed = (plan?.items ?? []).map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join('\n') || 'Plan cleared.';
        return checks.length ? `${listed}\nAcceptance checks (verified before you finish):\n${checks.map((item) => `- ${item}`).join('\n')}` : listed;
      }
      if (args.itemId) {
        updatePlanItem(ctx.store, String(args.itemId), { status: args.status ? String(args.status) : undefined, text: args.text ? String(args.text) : undefined });
        return 'Plan item updated.';
      }
      const plan = readPlan(ctx.store, sessionId);
      return plan ? plan.items.map((item) => `- [${item.status}] ${item.text}`).join('\n') : 'No plan yet.';
    },
  },
  {
    name: 'grep',
    description: 'Search file contents under the workspace or a granted folder (supports regex, include file globs, context lines, and filesOnly).',
    parameters: obj({
      pattern: { type: 'string', description: 'Regex or literal pattern to search for.' },
      path: { type: 'string', description: 'Optional project label or subdirectory.' },
      include: { type: 'string', description: 'Optional glob filter, e.g. "*.ts" or "src/**/*.kt".' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true).' },
      context: { type: 'number', description: 'Context lines around each match (0-2).' },
      filesOnly: { type: 'boolean', description: 'Return only matching file paths.' },
      maxResults: { type: 'number', description: 'Max match entries to return (1-80, default 40).' },
    }, ['pattern']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const root = allowedRoot(ctx, String(args.path || '.'));
      if (!root) throw new Error('That folder is not in this workshop.');
      const limit = Math.max(1, Math.min(80, Math.floor(Number(args.maxResults) || 40)));
      const context = Math.max(0, Math.min(2, Math.floor(Number(args.context) || 0)));
      return runGrep(root.full, String(args.pattern), {
        include: args.include ? String(args.include) : undefined,
        ignoreCase: args.ignoreCase !== false,
        context,
        filesOnly: Boolean(args.filesOnly),
        limit,
      });
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.ts") or path substring, skipping build/vendor folders.',
    parameters: obj({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const root = allowedRoot(ctx, String(args.path || '.'));
      if (!root) throw new Error('That folder is not in this workshop.');
      const hits = await walkNames(root.full, String(args.pattern), 80);
      return hits.join('\n') || 'No files.';
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a search-and-replace edit. A checkpoint of the previous bytes is stored first so the batch can be reverted.',
    parameters: obj({
      edits: { type: 'array', items: { type: 'object' } },
      path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' },
      why: { type: 'string', description: 'Optional 3-8 word intent shown in the step log.' },
    }),
    mutates: () => true,
    approval: (args, ctx) => {
      const edits = editsOf(args);
      if (ctx?.codeApproval === 'always') return `Apply ${edits.length} edit${edits.length === 1 ? '' : 's'}`;
      for (const edit of edits) {
        const allowed = ctx ? allowedRoot(ctx, edit.path) : null;
        if (!allowed) return `Path is outside the sandbox: ${edit.path}`;
        if (!allowed.write) return `Grant is read-only: ${edit.path}`;
      }
      return null;
    },
    async execute(args, ctx) {
      if (!ctx.sessionId) throw new Error('No session.');
      const edits = editsOf(args);
      const files: { path: string; before: string | null; after: string }[] = [];
      const diffs: string[] = [];
      for (const edit of edits) {
        const allowed = allowedRoot(ctx, edit.path);
        if (!allowed?.write) throw new Error(`Cannot write ${edit.path}.`);
        const full = allowed.full;
        if (!isInside(allowed.root, full)) throw new Error('Path escapes the project.');
        let before: string | null = null;
        try { before = await fs.readFile(full, 'utf8'); } catch { before = null; }
        const after = before == null ? edit.replace : applySearchReplace(before, edit.search, edit.replace);
        files.push({ path: full, before, after });
        diffs.push(lineDiff(path.relative(ctx.workspace, full), before ?? '', after));
      }
      const id = nid('edit');
      ctx.store.db.prepare('INSERT INTO edit_batches (id, session_id, run_id, label, files, diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, ctx.sessionId, ctx.runId ?? null, edits.map((edit) => edit.path).join(', '), JSON.stringify(files.map(({ path: file, before }) => ({ path: file, before }))), diffs.join('\n'), now(),
      );
      for (const file of files) {
        await fs.mkdir(path.dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, file.after, 'utf8');
      }
      return `Checkpoint ${id}\n${diffs.join('\n')}`;
    },
  },
  {
    name: 'git',
    description: 'Git in one shared project or your own workspace (project "workspace"): branches (list local and remote branches sorted by latest commit), show (read a commit or file from any branch without checking out, e.g. action="show", name="origin/dspine-v2-custom", path="README.md" or name="origin/dspine-v2-custom:README.md"), status, diff, log, fetch, branch, checkout, commit, pull (fast-forward only), push, force-push, revert, open_pr (GitHub, needs a saved GITHUB_TOKEN; pass title, body, base). Pass project when several are open. Pull, push, force-push, revert, and open_pr wait for approval. A push to main or a force-push says so in the approval.',
    parameters: obj({ action: { type: 'string' }, project: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' } }, ['action']),
    mutates: (args) => !['status', 'diff', 'log', 'fetch', 'branches', 'show'].includes(String(args.action)) && !(String(args.action) === 'branch' && !String(args.name || '').trim()),
    approval: (args, ctx) => {
      const action = String(args.action || '');
      if (action === 'revert') return `Git revert${args.project ? ` in ${args.project}` : ''}`;
      if (action === 'pull') return `Pull ${args.project || 'the project'} (fast-forward only)`;
      if (action === 'open_pr') return `Open a GitHub pull request${args.title ? `: ${String(args.title).slice(0, 80)}` : ''} into ${args.base || 'main'}`;
      if (action === 'push' || action === 'force-push') {
        try {
          const cwd = projectPath(ctx?.roots ?? [], args.project ? String(args.project) : undefined, ctx?.workspace || '.');
          const branch = execSyncBranch(cwd);
          return pushApproval(branch, action === 'force-push');
        } catch {
          return pushApproval('the current branch', action === 'force-push');
        }
      }
      return null;
    },
    async execute(args, ctx) {
      const action = String(args.action || '');
      const roots = ctx.roots ?? [];
      const named = args.project ? String(args.project) : undefined;
      const identity = ctx.gitIdentity;
      if (action === 'status' && !named && roots.length > 1) {
        const parts: string[] = [];
        for (const root of roots) parts.push(`# ${root.label}\n${await git(root.path, ['status', '--short', '--branch'], identity)}`);
        return parts.join('\n');
      }
      const cwd = projectPath(roots, named, ctx.workspace);
      const label = roots.find((root) => root.path === cwd)?.label;
      const readOnlyAction = ['status', 'diff', 'log', 'fetch', 'branches', 'show'].includes(action) || (action === 'branch' && !String(args.name || '').trim());
      if (label && !readOnlyAction) {
        const lock = tryLockRepo(ctx.store, label, ctx.runId || 'manual', ctx.agent.id);
        if (!lock.ok) throw new Error(`${label} is being edited by ${lock.holder}. You can still read it.`);
      }
      if (action === 'status') return git(cwd, ['status', '--short', '--branch'], identity);
      if (action === 'diff') return git(cwd, ['diff', '--', '.'], identity);
      if (action === 'fetch') return git(cwd, ['fetch'], identity);
      if (action === 'log') return git(cwd, ['log', '-15', '--oneline', '--decorate'], identity);
      if (action === 'branches' || (action === 'branch' && !String(args.name || '').trim())) {
        return git(cwd, ['branch', '-a', '-v', '--sort=-committerdate'], identity);
      }
      if (action === 'show') {
        const ref = String(args.name || 'HEAD').trim();
        const file = args.path ? String(args.path).trim() : '';
        const spec = file && !ref.includes(':') ? `${ref}:${file}` : ref;
        const out = await git(cwd, ['show', spec], identity);
        return out.length > 48_000 ? `${out.slice(0, 48_000)}\n…[truncated at 48,000 characters]` : out;
      }
      if (action === 'branch' || action === 'checkout') {
        const name = String(args.name || '').trim() || (action === 'branch' ? 'agent/task' : '');
        if (!validBranch(name)) throw new Error('Branch names look like agent/fix-login.');
        return git(cwd, action === 'branch' ? ['checkout', '-b', name] : ['checkout', name], identity);
      }
      if (action === 'open_pr') {
        return onceEffect(ctx, action, async () => {
          const pr = await openPullRequest(cwd, identity?.token ?? null, ctx.fetchImpl, { title: String(args.title || args.message || 'Changes from local-agent'), body: args.body ? String(args.body) : '', base: args.base ? String(args.base) : undefined });
          return `Opened PR #${pr.number}: ${pr.url}`;
        });
      }
      if (action === 'commit') {
        return onceEffect(ctx, action, async () => {
          const scan = await runPreCommitSemgrep(ctx.docker, cwd, { dataDir: ctx.libraryDir });
          if (!scan.ok) throw new Error(scan.summary);
          await git(cwd, ['add', '-A'], identity);
          const message = String(args.message || 'agent edit');
          const committed = await git(cwd, ['commit', '-m', message], identity);
          if (label && /^exit 0\n/.test(committed)) {
            const sha = (await git(cwd, ['rev-parse', '--short', 'HEAD'], identity)).replace(/^exit \d+\n/, '').trim();
            addProjectNote(ctx.store, { label, agentId: ctx.agent.id, kind: 'change', body: `${ctx.agent.name}: ${message}`, sha });
          }
          return scan.skipped ? committed : `${scan.summary}\n${committed}`;
        });
      }
      if (action === 'pull') return explainPull(await git(cwd, ['pull', '--ff-only'], identity));
      if (action === 'revert') return git(cwd, ['revert', '--no-edit', 'HEAD'], identity);
      if (action === 'push' || action === 'force-push') {
        return onceEffect(ctx, action, async () => {
          const args = action === 'force-push' ? ['push', '--force-with-lease'] : ['push'];
          const pushed = await git(cwd, args, identity);
          if (/non-fast-forward|rejected|fetch first|failed to push/i.test(pushed)) {
            return `Push rejected. The remote is ahead of this branch. Pull with fast-forward only, or ask before a force-push.\n${pushed}`;
          }
          return pushed;
        });
      }
      throw new Error('Unknown git action.');
    },
  },
  {
    name: 'request_folder',
    description: 'Ask to read or write a host project folder. Nothing is mounted until the owner approves.',
    parameters: obj({ path: { type: 'string' }, mode: { type: 'string' } }, ['path']),
    mutates: () => false,
    approval: (args) => `Grant ${args.mode || 'read'} on ${args.path}`,
    async execute(args, ctx) {
      const mode = args.mode === 'write' ? 'write' : 'read';
      const grant = grantFolder(ctx.store, ctx.agent.id, String(args.path), mode);
      return `Granted ${grant.mode} on ${grant.path}. Tools can use it. It is not mounted into other containers unless you say so.`;
    },
  },
  {
    name: 'create_project',
    description: 'Create a brand-new local git project/repo under /projects/<name>, attach it to this chat immediately so you can write code and run tests in it, and optionally create a private GitHub repository for it (when GITHUB_TOKEN is saved in Vault). Ideal when the user has a new app or script idea.',
    parameters: obj({
      name: { type: 'string', description: 'Short repo/folder name (e.g. gym-tracker).' },
      description: { type: 'string', description: 'One-line description for README and GitHub.' },
      createGithub: { type: 'boolean', description: 'If true and GITHUB_TOKEN is set, also create a private GitHub repo and wire origin.' },
      isPrivate: { type: 'boolean', description: 'Whether the GitHub repo should be private (default true).' },
    }, ['name']),
    mutates: () => true,
    approval: (args) => `Create new project “${String(args.name || '').slice(0, 60)}”${args.createGithub ? ' (+ GitHub repo)' : ''}`,
    async execute(args, ctx) {
      if ((ctx.agent.ownerId || OWNER_ID) !== OWNER_ID) throw new Error('Only the owner can create new projects.');
      const res = await scaffoldProject({
        store: ctx.store,
        ownerId: ctx.agent.ownerId || OWNER_ID,
        name: String(args.name || ''),
        description: args.description ? String(args.description) : undefined,
        createGithub: Boolean(args.createGithub),
        isPrivate: args.isPrivate !== false,
        token: ctx.gitIdentity?.token,
        fetchImpl: ctx.fetchImpl,
        sessionId: ctx.sessionId,
      });
      return `Project "${res.repo.label}" is ready at ${res.path} and attached to this chat${res.remoteUrl ? ` (GitHub: ${res.remoteUrl})` : ''}. You can now write files under ${res.repo.label}/ and run git/shell commands in it.`;
    },
  },
  {
    name: 'handoff_cli',
    description: 'Hand the task to a coding CLI already installed on the box (cursor-agent, claude, aider, codex). Requires approval. Refuses if none is installed.',
    parameters: obj({ cli: { type: 'string' }, prompt: { type: 'string' } }, ['prompt']),
    mutates: () => true,
    approval: (args) => `Hand off to ${args.cli || 'an installed coding CLI'}`,
    async execute(args, ctx) {
      const installed = await detectCodingClis();
      const wanted = String(args.cli || installed[0] || '');
      if (!wanted || !installed.includes(wanted)) {
        return installed.length
          ? `Installed coding CLIs: ${installed.join(', ')}. Pass cli as one of those.`
          : 'No coding CLI is installed (looked for cursor-agent, claude, aider, codex). The built-in edit tools still work.';
      }
      return runCli(wanted, String(args.prompt), ctx.workspace, ctx.signal);
    },
  },
];

async function onceEffect(ctx: ToolContext, action: string, run: () => Promise<string>): Promise<string> {
  if (!ctx.runId || !ctx.toolCallId || !ctx.store.claimEffect) return run();
  const key = `${ctx.runId}:${ctx.toolCallId}:${action}`;
  const claim = ctx.store.claimEffect(key, ctx.runId, ctx.toolCallId, action);
  if (claim.state === 'done') return claim.result;
  if (claim.state === 'started') return `${action} already started for this step. It was not repeated.`;
  const result = await run();
  ctx.store.finishEffect(key, result);
  return result;
}

function editsOf(args: Record<string, unknown>): { path: string; search: string; replace: string }[] {
  if (Array.isArray(args.edits)) {
    return (args.edits as Record<string, unknown>[]).map((edit) => ({ path: String(edit.path || ''), search: String(edit.search || ''), replace: String(edit.replace ?? '') }));
  }
  return [{ path: String(args.path || ''), search: String(args.search || ''), replace: String(args.replace ?? '') }];
}

const GREP_SKIP_EXT = /\.(?:db|sqlite3?|db-wal|db-shm|png|jpe?g|webp|gif|ico|bmp|pdf|zip|gz|tar|tgz|7z|wasm|gguf|bin|exe|dll|so|dylib|mp4|mp3|wav|ogg|woff2?|ttf|eot|pptx?|xlsx?|docx?)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', '.next', 'target']);

export function globToRegex(pattern: string): RegExp {
  const expanded = pattern.trim().replace(/\{([^{}]+)\}/g, (_m, inner: string) => `(?:${inner.split(',').map((s) => s.trim()).join('|')})`);
  let regex = '';
  for (let i = 0; i < expanded.length; i += 1) {
    const ch = expanded[i]!;
    if (ch === '*' && expanded[i + 1] === '*') {
      regex += expanded[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += expanded[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') regex += '[^/]*';
    else if (ch === '?') regex += '[^/]';
    else if ('\\^$.|+[]'.includes(ch)) regex += `\\${ch}`;
    else regex += ch;
  }
  const hasSlash = pattern.includes('/');
  return new RegExp(hasSlash ? `^${regex}$` : `(?:^|/)${regex}$`, 'i');
}

function matchesInclude(rel: string, name: string, include?: string): boolean {
  if (!include?.trim()) return true;
  const rx = globToRegex(include.trim());
  return rx.test(rel.replace(/\\/g, '/')) || rx.test(name);
}

interface GrepOpts { include?: string; ignoreCase?: boolean; context?: number; filesOnly?: boolean; limit?: number }

export async function runGrep(root: string, pattern: string, opts: GrepOpts = {}): Promise<string> {
  const limit = Math.max(1, Math.min(80, opts.limit ?? 40));
  const ignoreCase = opts.ignoreCase !== false;
  const context = Math.max(0, Math.min(2, opts.context ?? 0));
  const filesOnly = Boolean(opts.filesOnly);
  const rgOut = await tryRipgrep(root, pattern, { include: opts.include, ignoreCase, context, filesOnly, limit });
  if (rgOut != null) return rgOut;
  return walkGrep(root, pattern, { include: opts.include, ignoreCase, context, filesOnly, limit });
}

function tryRipgrep(root: string, pattern: string, opts: Required<Pick<GrepOpts, 'ignoreCase' | 'context' | 'filesOnly' | 'limit'>> & { include?: string }): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ['--no-heading', '--line-number', '--color=never', '--max-filesize=1M'];
    for (const dir of SKIP_DIRS) args.push('-g', `!${dir}`);
    if (opts.ignoreCase) args.push('-i');
    if (opts.include?.trim()) args.push('-g', opts.include.trim());
    if (opts.filesOnly) args.push('-l');
    else if (opts.context > 0) args.push('-C', String(opts.context));
    args.push('--', pattern, '.');
    const child = spawn('rg', args, { cwd: root, timeout: 15_000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { if (out.length < 400_000) out += String(chunk); });
    child.stderr.on('data', (chunk) => { if (err.length < 4000) err += String(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 1) { resolve('No matches.'); return; }
      if (code === 2 && err) { reject(new Error(`Invalid grep pattern: ${err.split('\n')[0]}`)); return; }
      if (code !== 0) { resolve(null); return; }
      const lines = out.trimEnd().split('\n').filter(Boolean);
      if (!lines.length) { resolve('No matches.'); return; }
      if (opts.filesOnly) {
        const sliced = lines.slice(0, opts.limit);
        const header = lines.length > opts.limit ? `Found ${lines.length} matching files (showing first ${opts.limit}):\n` : '';
        resolve(`${header}${sliced.join('\n')}`);
        return;
      }
      const matchLines = lines.filter((ln) => ln !== '--' && /^[^:]+:\d+:/.test(ln));
      const files = new Set(matchLines.map((ln) => ln.split(':', 1)[0]!));
      if (matchLines.length <= opts.limit) {
        resolve(lines.map((ln) => ln.slice(0, 200)).join('\n'));
        return;
      }
      const kept: string[] = [];
      let shownMatches = 0;
      for (const ln of lines) {
        if (/^[^:]+:\d+:/.test(ln)) {
          if (shownMatches >= opts.limit) break;
          shownMatches += 1;
        }
        kept.push(ln.slice(0, 200));
      }
      resolve(`Found ${matchLines.length} matches across ${files.size} files (showing first ${shownMatches}):\n${kept.join('\n')}`);
    });
  });
}

async function walkGrep(root: string, pattern: string, opts: GrepOpts = {}): Promise<string> {
  const limit = Math.max(1, Math.min(80, opts.limit ?? 40));
  const ignoreCase = opts.ignoreCase !== false;
  const context = Math.max(0, Math.min(2, opts.context ?? 0));
  const filesOnly = Boolean(opts.filesOnly);
  const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const hits: string[] = [];
  const fileSet = new Set<string>();
  let totalMatches = 0;
  let shownMatches = 0;
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (GREP_SKIP_EXT.test(entry.name)) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (!matchesInclude(rel, entry.name, opts.include)) continue;
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      if (!text || text.includes('\u0000')) continue;
      const lines = text.split('\n');
      let fileMatched = false;
      lines.forEach((line, index) => {
        if (!regex.test(line)) return;
        fileMatched = true;
        fileSet.add(rel);
        totalMatches += 1;
        if (filesOnly || shownMatches >= limit) return;
        shownMatches += 1;
        if (context > 0 && hits.length > 0) hits.push('--');
        const from = Math.max(0, index - context);
        const to = Math.min(lines.length - 1, index + context);
        for (let i = from; i <= to; i += 1) {
          const sep = i === index ? ':' : '-';
          hits.push(`${rel}${sep}${i + 1}${sep} ${lines[i]!.slice(0, 180)}`);
        }
      });
      if (filesOnly && fileMatched && hits.length < limit) hits.push(rel);
    }
  };
  await walk(root);
  if (filesOnly) {
    if (!hits.length) return 'No matches.';
    const header = fileSet.size > limit ? `Found ${fileSet.size} matching files (showing first ${hits.length}):\n` : '';
    return `${header}${hits.join('\n')}`;
  }
  if (!hits.length) return 'No matches.';
  const header = totalMatches > shownMatches ? `Found ${totalMatches} matches across ${fileSet.size} files (showing first ${shownMatches}):\n` : '';
  return `${header}${hits.join('\n')}`;
}

export async function walkNames(root: string, pattern: string, limit: number) {
  const hits: string[] = [];
  const raw = pattern.trim();
  const isGlob = /[*?{}]/.test(raw);
  const rx = isGlob ? globToRegex(raw) : null;
  const needle = raw.toLowerCase();
  const walk = async (dir: string) => {
    if (hits.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (hits.length >= limit) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!rx && (!needle || rel.toLowerCase().includes(needle))) hits.push(rel);
        await walk(full);
      } else {
        const matched = rx ? rx.test(rel) : (!needle || rel.toLowerCase().includes(needle));
        if (matched) hits.push(rel);
      }
    }
  };
  await walk(root);
  return hits.slice(0, limit);
}

function execSyncBranch(cwd: string) {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return (result.stdout || 'HEAD').trim() || 'HEAD';
}

function onPath(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function runCli(cli: string, prompt: string, cwd: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cli, [prompt], { cwd, timeout: 120_000 });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    const stop = () => child.kill('SIGKILL');
    signal.addEventListener('abort', stop);
    child.on('error', (error) => { signal.removeEventListener('abort', stop); reject(error); });
    child.on('close', (code) => { signal.removeEventListener('abort', stop); resolve(`exit ${code ?? 1}\n${out.slice(0, 12_000)}`); });
  });
}

function mapBatch(row: Record<string, unknown>): EditBatch {
  let keptFiles: string[] = [];
  let revertedFiles: string[] = [];
  try { keptFiles = JSON.parse(String(row.kept_files || '[]')) as string[]; } catch { keptFiles = []; }
  try { revertedFiles = JSON.parse(String(row.reverted_files || '[]')) as string[]; } catch { revertedFiles = []; }
  return { id: String(row.id), sessionId: String(row.session_id), runId: row.run_id ? String(row.run_id) : null, label: String(row.label), diff: String(row.diff), createdAt: String(row.created_at), revertedAt: row.reverted_at ? String(row.reverted_at) : null, keptAt: row.kept_at ? String(row.kept_at) : null, keptFiles, revertedFiles };
}
