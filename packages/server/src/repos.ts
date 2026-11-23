import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.js';
import type { Tool } from './tools.js';
import { nid, now } from './util.js';

export interface SharedRepo {
  id: string;
  label: string;
  path: string;
  remote: string | null;
}

const LABEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const CHANGE = /\b(change|edit|fix|implement|add|remove|refactor|commit|push|pull|patch|update|bug|feature|wire|rename|delete|rewrite)\b/i;
const LOCK_MS = 3 * 60 * 1000;

export function isSmallEdit(text: string): boolean {
  if (text.length > 240) return false;
  if (/\b(refactor|redesign|architecture|both projects|and also|migrate|rewrite)\b/i.test(text)) return false;
  return /\b(typo|spelling|one[- ]line|small edit|tweak|comment|rename)\b/i.test(text);
}

export function taskBranchName(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `agent/${slug || 'task'}`;
}

export function pushApproval(branch: string, force = false): string {
  if (force) return `Force-push ${branch}`;
  if (branch === 'main' || branch === 'master') return `Push to ${branch}`;
  return `Git push ${branch}`;
}

export function explainPull(raw: string): string {
  const code = Number(/^exit (\d+)/.exec(raw)?.[1] ?? 1);
  if (code === 0) return raw;
  if (/non-fast-forward|Not possible to fast-forward|CONFLICT|divergent/i.test(raw)) {
    return `Pull stopped. The histories diverged or there is a conflict. Nothing was merged.\n${raw}`;
  }
  return raw;
}

export function reposDir(dataDir: string) {
  const dir = path.join(dataDir, 'repos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listSharedRepos(store: Store): SharedRepo[] {
  return (store.db.prepare('SELECT id, label, path, remote FROM shared_repos ORDER BY label').all() as { id: string; label: string; path: string; remote: string | null }[])
    .map((row) => ({ id: row.id, label: row.label, path: row.path, remote: row.remote }));
}

export function registerSharedRepo(store: Store, input: { label: string; path: string; remote?: string | null }): SharedRepo {
  const label = input.label.trim().toLowerCase();
  if (!LABEL.test(label)) throw new Error('Repo labels look like server or apk.');
  if (!path.isAbsolute(input.path)) throw new Error('The repo path has to be absolute.');
  const stat = fs.statSync(input.path);
  if (!stat.isDirectory()) throw new Error(`${input.path} is not a folder.`);
  const real = fs.realpathSync(input.path);
  const remote = input.remote?.trim() || null;
  if (remote && !safeRemote(remote)) throw new Error('Use an https or git SSH remote.');
  const existing = store.db.prepare('SELECT id FROM shared_repos WHERE label = ?').get(label) as { id: string } | undefined;
  if (existing) {
    store.db.prepare('UPDATE shared_repos SET path = ?, remote = ? WHERE id = ?').run(real, remote, existing.id);
  } else {
    store.db.prepare('INSERT INTO shared_repos (id, label, path, remote, created_at) VALUES (?, ?, ?, ?, ?)').run(nid('repo'), label, real, remote, now());
  }
  return listSharedRepos(store).find((repo) => repo.label === label)!;
}

export function matchRepos(text: string, repos: { label: string; path: string }[]) {
  const all = /\b(both|all)\s+(projects|repos|repositories)\b/i.test(text);
  const mentioned = repos.filter((repo) => {
    const base = path.basename(repo.path);
    const names = base.toLowerCase() === repo.label ? [repo.label] : [repo.label, base];
    return names.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  });
  const wantsChange = CHANGE.test(text) && (mentioned.length > 0 || (all && repos.length > 0));
  return { projects: all && wantsChange ? repos : mentioned, wantsChange };
}

export function sharedRepoBrief(store: Store): string {
  const repos = listSharedRepos(store);
  if (!repos.length) return '';
  const lines = repos.map((repo) => {
    const notes = notesFor(store, repo.label, 3).map((note) => note.body).join(' | ');
    return `- ${repo.label}: ${repo.path}${repo.remote ? ` (${repo.remote})` : ''}${notes ? `\n  recent: ${notes}` : ''}`;
  });
  return `\n\nShared repos already cloned locally (do NOT call repo_sync with a guessed URL; use read_file "<label>/<path>", or git with project="<label>" and action="fetch" / "branches" / "show"):\n${lines.join('\n')}`;
}

export function tryLockRepo(store: Store, label: string, runId: string, agentId: string): { ok: true } | { ok: false; holder: string } {
  const row = store.db.prepare('SELECT lock_run_id, lock_agent_id, lock_at FROM shared_repos WHERE label = ?').get(label) as { lock_run_id: string | null; lock_agent_id: string | null; lock_at: string | null } | undefined;
  if (!row) return { ok: false, holder: 'missing' };
  if (row.lock_run_id && row.lock_run_id !== runId && row.lock_at && Date.now() - Date.parse(row.lock_at) < LOCK_MS) {
    return { ok: false, holder: row.lock_agent_id || 'another persona' };
  }
  store.db.prepare('UPDATE shared_repos SET lock_run_id = ?, lock_agent_id = ?, lock_at = ? WHERE label = ?').run(runId, agentId, now(), label);
  return { ok: true };
}

export function releaseRepoLocks(store: Store, runId: string) {
  store.db.prepare('UPDATE shared_repos SET lock_run_id = NULL, lock_agent_id = NULL, lock_at = NULL WHERE lock_run_id = ?').run(runId);
}

export function repoLockedByOther(store: Store, label: string, runId: string): string | null {
  const row = store.db.prepare('SELECT lock_run_id, lock_agent_id, lock_at FROM shared_repos WHERE label = ?').get(label) as { lock_run_id: string | null; lock_agent_id: string | null; lock_at: string | null } | undefined;
  if (!row?.lock_run_id || row.lock_run_id === runId) return null;
  if (!row.lock_at || Date.now() - Date.parse(row.lock_at) >= LOCK_MS) return null;
  return row.lock_agent_id || 'another persona';
}

export function addProjectNote(store: Store, input: { label: string; agentId: string | null; kind: 'sync' | 'change'; body: string; sha?: string | null }) {
  store.db.prepare('INSERT INTO project_notes (id, repo_label, agent_id, kind, body, sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    nid('note'), input.label, input.agentId, input.kind, input.body.slice(0, 2000), input.sha ?? null, now(),
  );
}

export function notesFor(store: Store, label: string, limit = 8) {
  return (store.db.prepare('SELECT body, kind, sha, created_at, agent_id FROM project_notes WHERE repo_label = ? ORDER BY created_at DESC LIMIT ?').all(label, limit) as { body: string; kind: string; sha: string | null; created_at: string; agent_id: string | null }[])
    .map((row) => ({ body: row.body, kind: row.kind, sha: row.sha, createdAt: row.created_at, agentId: row.agent_id }));
}

export async function changesSince(store: Store, repo: SharedRepo, agentId: string): Promise<string> {
  const headRaw = await git(repo.path, ['rev-parse', 'HEAD']);
  const head = headRaw.replace(/^exit \d+\n/, '').trim().split('\n').pop() || '';
  if (!/^[0-9a-f]{7,}$/i.test(head)) return `${repo.label}: not a git checkout yet.`;
  const view = store.db.prepare('SELECT last_sha FROM repo_views WHERE repo_label = ? AND agent_id = ?').get(repo.label, agentId) as { last_sha: string } | undefined;
  let log: string;
  if (view?.last_sha && view.last_sha !== head) {
    log = await git(repo.path, ['log', '--oneline', `${view.last_sha}..HEAD`]);
  } else if (!view) {
    log = await git(repo.path, ['log', '-5', '--oneline']);
  } else {
    log = 'exit 0\nNo new commits since this persona last looked.';
  }
  store.db.prepare(`INSERT INTO repo_views (repo_label, agent_id, last_sha, seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(repo_label, agent_id) DO UPDATE SET last_sha = excluded.last_sha, seen_at = excluded.seen_at`).run(repo.label, agentId, head, now());
  const body = log.replace(/^exit \d+\n/, '').trim() || 'No new commits.';
  return `${repo.label} since last look:\n${body}`;
}

export async function refreshRepo(repoPath: string): Promise<string> {
  const dirty = await git(repoPath, ['status', '--porcelain']);
  if (dirty.replace(/^exit \d+\n/, '').trim()) return 'Working tree has local edits. Pull was skipped so those edits stay put.';
  return explainPull(await git(repoPath, ['pull', '--ff-only']));
}

export async function ensureTaskBranch(repoPath: string, branch: string, identity?: GitIdentity): Promise<string> {
  const current = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).replace(/^exit \d+\n/, '').trim();
  if (!current || current === 'HEAD') return 'No branch to leave.';
  if (current !== 'main' && current !== 'master') return `Already on ${current}.`;
  return git(repoPath, ['checkout', '-b', branch], identity);
}

export function findExistingSharedRepo(store: Store, label?: string, url?: string): SharedRepo | undefined {
  const repos = listSharedRepos(store);
  const byLabel = label?.trim().toLowerCase();
  if (byLabel) {
    const hit = repos.find((item) => item.label.toLowerCase() === byLabel || path.basename(item.path).toLowerCase() === byLabel);
    if (hit) return hit;
  }
  if (url?.trim()) {
    const cleanUrl = url.trim().replace(/\.git$/, '').toLowerCase();
    const derived = labelFromRemote(url.trim());
    return repos.find((item) =>
      (item.remote && item.remote.replace(/\.git$/, '').toLowerCase() === cleanUrl)
      || item.label.toLowerCase() === derived
      || path.basename(item.path).toLowerCase() === derived,
    );
  }
  return undefined;
}

export function repoSyncTool(): Tool {
  return {
    name: 'repo_sync',
    description: 'Clone a new remote into the shared repo store, or fetch and pull an already-registered shared repo (pass label without overriding remote). Returns status, recent branches, and commits. Needs approval.',
    parameters: {
      type: 'object',
      properties: { label: { type: 'string' }, url: { type: 'string' } },
      additionalProperties: false,
    },
    mutates: () => true,
    approval: (args, ctx) => {
      const existing = ctx?.store ? findExistingSharedRepo(ctx.store, args.label ? String(args.label) : undefined, args.url ? String(args.url) : undefined) : undefined;
      if (existing && fs.existsSync(path.join(existing.path, '.git'))) {
        return `Fetch and pull ${existing.label}`;
      }
      return args.url ? `Clone ${args.url} into the shared repos` : `Pull ${args.label || 'the shared repo'}`;
    },
    async execute(args, ctx) {
      const dataDir = ctx.libraryDir || '';
      if (!dataDir) throw new Error('Shared repo storage is not configured.');
      return syncSharedRepo(ctx.store, dataDir, { label: args.label ? String(args.label) : undefined, url: args.url ? String(args.url) : undefined });
    },
  };
}

async function pullAndSummarize(repoPath: string, label: string): Promise<string> {
  const fetched = await git(repoPath, ['fetch', '--all', '--prune']);
  const pulled = await git(repoPath, ['pull', '--ff-only']);
  const status = await git(repoPath, ['status', '--short', '--branch']);
  const branches = await git(repoPath, ['branch', '-a', '-v', '--sort=-committerdate']);
  const log = await git(repoPath, ['log', '-5', '--oneline']);
  return [`# ${label}`, fetched, pulled, status, 'Recent branches:', branches.split('\n').slice(0, 12).join('\n'), log].join('\n');
}

export async function syncSharedRepo(store: Store, dataDir: string, input: { label?: string; url?: string }) {
  const root = reposDir(dataDir);
  const existing = findExistingSharedRepo(store, input.label, input.url);
  if (existing && fs.existsSync(path.join(existing.path, '.git'))) {
    return pullAndSummarize(existing.path, existing.label);
  }
  if (input.url) {
    if (!safeRemote(input.url)) throw new Error('Use an https or git SSH remote.');
    const label = (input.label || labelFromRemote(input.url)).toLowerCase();
    if (!LABEL.test(label)) throw new Error('Could not derive a repo label. Pass label.');
    const dest = path.join(root, label);
    if (!fs.existsSync(dest)) {
      const cloned = await git(root, ['clone', input.url, label]);
      if (!fs.existsSync(path.join(dest, '.git'))) return cloned;
    }
    registerSharedRepo(store, { label, path: dest, remote: input.url });
    return pullAndSummarize(dest, label);
  }
  throw new Error('Name a shared repo, or pass a remote url to clone.');
}

function safeRemote(url: string) {
  return /^(https:\/\/|ssh:\/\/|git@)/.test(url) && !/[\s;&|`$]/.test(url);
}

function labelFromRemote(url: string) {
  const cleaned = url.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo';
  return cleaned.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

export interface GitIdentity { name?: string; email?: string; sshKey?: string; token?: string | null }

export function git(cwd: string, args: string[], identity?: GitIdentity) {
  const prefix: string[] = [];
  if (identity?.name) prefix.push('-c', `user.name=${identity.name}`);
  if (identity?.email) prefix.push('-c', `user.email=${identity.email}`);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (identity?.token) {
    // The token stays in the environment of this one git process. It never lands in argv, config, or output.
    env.LA_GIT_TOKEN = identity.token;
    prefix.push('-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$LA_GIT_TOKEN"; }; f');
  }
  if (identity?.sshKey) env.GIT_SSH_COMMAND = `ssh -i ${identity.sshKey} -o IdentitiesOnly=yes`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', [...prefix, ...args], { cwd, env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve(`exit ${code ?? 1}\n${(identity?.token ? out.split(identity.token).join('***') : out).slice(0, 8_000)}`));
  });
}
