import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside } from '@local-agent/shared';
import type { Store } from './db.js';
import type { Tool, ToolContext } from './tools.js';
import { nid, now } from './util.js';

export interface PlanItem { id: string; text: string; status: string; note: string | null; position: number }
export interface EditBatch { id: string; sessionId: string; runId: string | null; label: string; diff: string; createdAt: string; revertedAt: string | null }

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

export function applySearchReplace(before: string, search: string, replace: string): string {
  if (!search) throw new Error('The search text is empty.');
  const at = before.indexOf(search);
  if (at < 0) throw new Error('That text was not found. Read the file and include a longer unique snippet.');
  if (before.indexOf(search, at + search.length) >= 0) throw new Error('That snippet matches more than once. Include more context.');
  return `${before.slice(0, at)}${replace}${before.slice(at + search.length)}`;
}

export function replacePlan(store: Store, sessionId: string, items: string[], runId?: string | null) {
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
  const row = store.db.prepare('SELECT * FROM plan_items WHERE id = ?').get(itemId) as { text: string; status: string; note: string | null; plan_id: string } | undefined;
  if (!row) return null;
  store.db.prepare('UPDATE plan_items SET text = ?, status = ?, note = ? WHERE id = ?').run(patch.text ?? row.text, patch.status ?? row.status, patch.note ?? row.note, itemId);
  store.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now(), row.plan_id);
  return true;
}

export function readPlan(store: Store, sessionId: string): { id: string; title: string; status: string; items: PlanItem[] } | null {
  const plan = store.db.prepare('SELECT * FROM plans WHERE session_id = ?').get(sessionId) as { id: string; title: string; status: string } | undefined;
  if (!plan) return null;
  const items = (store.db.prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position').all(plan.id) as { id: string; text: string; status: string; note: string | null; position: number }[])
    .map((item) => ({ id: item.id, text: item.text, status: item.status, note: item.note, position: item.position }));
  return { id: plan.id, title: plan.title, status: plan.status, items };
}

export function listEdits(store: Store, sessionId: string): EditBatch[] {
  return (store.db.prepare('SELECT * FROM edit_batches WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as Record<string, unknown>[]).map(mapBatch);
}

export async function revertBatch(store: Store, batchId: string) {
  const row = store.db.prepare('SELECT * FROM edit_batches WHERE id = ?').get(batchId) as { id: string; files: string; reverted_at: string | null } | undefined;
  if (!row) throw new Error('Edit batch not found.');
  if (row.reverted_at) throw new Error('That batch was already reverted.');
  const files = JSON.parse(row.files) as { path: string; before: string | null }[];
  for (const file of files) {
    if (file.before == null) await fs.rm(file.path, { force: true });
    else {
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, file.before, 'utf8');
    }
  }
  store.db.prepare('UPDATE edit_batches SET reverted_at = ? WHERE id = ?').run(now(), batchId);
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

function allowedRoot(ctx: ToolContext, target: string): { root: string; write: boolean } | null {
  const resolved = path.resolve(ctx.workspace, target);
  if (isInside(ctx.workspace, resolved) || resolved === path.resolve(ctx.workspace)) return { root: ctx.workspace, write: true };
  const grants = grantsFor(ctx.store, ctx.agent.id);
  const hit = grants.find((grant) => isInside(grant.path, resolved) || path.resolve(grant.path) === resolved);
  if (!hit) return null;
  return { root: hit.path, write: hit.mode === 'write' };
}

export const CODING_TOOLS: Tool[] = [
  {
    name: 'plan',
    description: 'Replace or update the visible plan for this coding session. The owner can edit it too.',
    parameters: obj({ items: { type: 'array', items: { type: 'string' } }, itemId: { type: 'string' }, status: { type: 'string' }, text: { type: 'string' } }),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const sessionId = ctx.sessionId;
      if (!sessionId) throw new Error('No session.');
      if (Array.isArray(args.items)) {
        const plan = replacePlan(ctx.store, sessionId, (args.items as unknown[]).map(String).slice(0, 20), ctx.runId);
        return (plan?.items ?? []).map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join('\n') || 'Plan cleared.';
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
    description: 'Search file contents under the workspace or a granted folder.',
    parameters: obj({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const root = allowedRoot(ctx, String(args.path || '.'));
      if (!root) throw new Error('That folder is not granted.');
      const hits = await walkGrep(root.root, String(args.pattern), 40);
      return hits.join('\n') || 'No matches.';
    },
  },
  {
    name: 'glob',
    description: 'Find files by a substring of their path.',
    parameters: obj({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const root = allowedRoot(ctx, String(args.path || '.'));
      if (!root) throw new Error('That folder is not granted.');
      const needle = String(args.pattern).replace(/\*/g, '').toLowerCase();
      const hits = await walkNames(root.root, needle, 80);
      return hits.join('\n') || 'No files.';
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a search-and-replace edit. A checkpoint of the previous bytes is stored first so the batch can be reverted.',
    parameters: obj({
      edits: { type: 'array', items: { type: 'object' } },
      path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' },
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
        const full = path.resolve(allowed.root, path.isAbsolute(edit.path) ? path.relative(allowed.root, edit.path) : edit.path);
        if (!isInside(allowed.root, full)) throw new Error('Path escapes the granted folder.');
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
    description: 'Git inside the workspace: status, diff, branch, commit, revert. Push always needs approval.',
    parameters: obj({ action: { type: 'string' }, name: { type: 'string' }, message: { type: 'string' } }, ['action']),
    mutates: (args) => !['status', 'diff'].includes(String(args.action)),
    approval: (args) => {
      const action = String(args.action || '');
      if (action === 'push' || action === 'revert') return `Git ${action}`;
      return null;
    },
    async execute(args, ctx) {
      const action = String(args.action || '');
      if (action === 'status') return git(ctx.workspace, ['status', '--short', '--branch']);
      if (action === 'diff') return git(ctx.workspace, ['diff', '--', '.']);
      if (action === 'branch') return git(ctx.workspace, ['checkout', '-b', String(args.name || '').trim() || 'agent']);
      if (action === 'commit') {
        await git(ctx.workspace, ['add', '-A']);
        return git(ctx.workspace, ['-c', 'user.email=agent@local', '-c', 'user.name=local-agent', 'commit', '-m', String(args.message || 'agent edit')]);
      }
      if (action === 'revert') return git(ctx.workspace, ['revert', '--no-edit', 'HEAD']);
      if (action === 'push') return git(ctx.workspace, ['push']);
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

function editsOf(args: Record<string, unknown>): { path: string; search: string; replace: string }[] {
  if (Array.isArray(args.edits)) {
    return (args.edits as Record<string, unknown>[]).map((edit) => ({ path: String(edit.path || ''), search: String(edit.search || ''), replace: String(edit.replace ?? '') }));
  }
  return [{ path: String(args.path || ''), search: String(args.search || ''), replace: String(args.replace ?? '') }];
}

async function walkGrep(root: string, pattern: string, limit: number) {
  const regex = new RegExp(pattern, 'i');
  const hits: string[] = [];
  const walk = async (dir: string) => {
    if (hits.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (hits.length >= limit) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const text = await fs.readFile(full, 'utf8').catch(() => '');
        text.split('\n').forEach((line, index) => {
          if (hits.length < limit && regex.test(line)) hits.push(`${path.relative(root, full)}:${index + 1}: ${line.slice(0, 180)}`);
        });
      }
    }
  };
  await walk(root);
  return hits;
}

async function walkNames(root: string, needle: string, limit: number) {
  const hits: string[] = [];
  const walk = async (dir: string) => {
    if (hits.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (rel.toLowerCase().includes(needle)) hits.push(rel);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return hits.slice(0, limit);
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve(`exit ${code ?? 1}\n${out.slice(0, 12_000)}`));
  });
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
  return { id: String(row.id), sessionId: String(row.session_id), runId: row.run_id ? String(row.run_id) : null, label: String(row.label), diff: String(row.diff), createdAt: String(row.created_at), revertedAt: row.reverted_at ? String(row.reverted_at) : null };
}
