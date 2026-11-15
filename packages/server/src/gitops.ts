import fs from 'node:fs';
import { safeInside } from './pathsafe.js';
import path from 'node:path';
import type { Store } from './db.js';
import { git, listSharedRepos, registerSharedRepo, reposDir, type GitIdentity } from './repos.js';
import { getWorkshop } from './workshops.js';
import { nid, now } from './util.js';

/** Somewhere git can run: an agent's workspace folder, or a shared repo / workshop project. */
export interface GitRoot { id: string; label: string; path: string; kind: 'workspace' | 'project'; remote: string | null; workshops: string[] }

/** The account's persona workspaces, plus shared projects for the owner. Members never see the owner's repos. */
export function listGitRoots(store: Store, ownerId = 'owner'): GitRoot[] {
  const roots: GitRoot[] = [];
  for (const agent of store.listAgents(ownerId)) {
    if (agent.workspacePath) roots.push({ id: `ws:${agent.id}`, label: `${agent.name} workspace`, path: agent.workspacePath, kind: 'workspace', remote: null, workshops: [] });
  }
  if (ownerId !== 'owner') return roots;
  const shops = store.db.prepare('SELECT w.name, p.path FROM workshop_projects p JOIN workshops w ON w.id = p.workshop_id').all() as { name: string; path: string }[];
  for (const repo of listSharedRepos(store)) {
    roots.push({ id: `prj:${repo.label}`, label: repo.label, path: repo.path, kind: 'project', remote: repo.remote, workshops: shops.filter((row) => row.path === repo.path).map((row) => row.name) });
  }
  return roots;
}

export function gitRoot(store: Store, id: string, ownerId = 'owner'): GitRoot {
  const root = listGitRoots(store, ownerId).find((item) => item.id === id);
  if (!root) throw new Error('Unknown folder.');
  fs.mkdirSync(root.path, { recursive: true });
  return root;
}

const body = (raw: string) => raw.replace(/^exit \d+\n/, '');
const ok = (raw: string) => /^exit 0\n/.test(raw);

export interface GitStatus {
  isRepo: boolean; branch: string | null; upstream: string | null; ahead: number; behind: number; remote: string | null;
  files: { path: string; index: string; work: string }[]; log: { sha: string; subject: string }[]; branches: string[];
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  // Only the root's own repo counts: a plain folder that happens to sit inside another checkout is not a repo.
  const inside = fs.existsSync(path.join(cwd, '.git')) ? await git(cwd, ['rev-parse', '--is-inside-work-tree']) : '';
  if (!inside || !ok(inside) || body(inside).trim() !== 'true') return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, remote: null, files: [], log: [], branches: [] };
  const raw = body(await git(cwd, ['status', '--porcelain=v1', '--branch', '-uall']));
  const lines = raw.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  const m = /^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head);
  const files = lines.map((line) => ({ index: line[0] || ' ', work: line[1] || ' ', path: line.slice(3) }));
  const logRaw = await git(cwd, ['log', '-12', '--pretty=format:%h\t%s']);
  const log = ok(logRaw) ? body(logRaw).split('\n').filter(Boolean).map((line) => { const [sha, ...rest] = line.split('\t'); return { sha: sha!, subject: rest.join('\t') }; }) : [];
  const remoteRaw = await git(cwd, ['remote', 'get-url', 'origin']);
  const branchesRaw = await git(cwd, ['branch', '--format=%(refname:short)']);
  return {
    isRepo: true, branch: m?.[1] ?? null, upstream: m?.[2] ?? null, ahead: Number(m?.[3] || 0), behind: Number(m?.[4] || 0),
    remote: ok(remoteRaw) ? redactUrl(body(remoteRaw).trim()) : null, files, log,
    branches: ok(branchesRaw) ? body(branchesRaw).split('\n').map((s) => s.trim()).filter(Boolean) : [],
  };
}

/** Never show credentials that someone put inside a remote URL. */
export function redactUrl(url: string) {
  return url.replace(/(https?:\/\/)[^@/\s]+@/i, '$1***@');
}

export function githubRepoOf(remote: string | null): { owner: string; repo: string } | null {
  if (!remote) return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function validBranch(name: string) {
  return /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,100}(?<![./])$/.test(name) && !name.endsWith('.lock');
}

/** Remotes the owner can clone: https, ssh, or a local path / file:// (handy for a bare repo on the box). */
export function cloneSource(url: string): string | null {
  const value = url.trim();
  if (/[\s;&|`$]/.test(value)) return null;
  if (/^(https:\/\/|ssh:\/\/|git@)/.test(value)) return value;
  if (/^file:\/\//.test(value)) return value;
  if (path.isAbsolute(value) && fs.existsSync(value)) return value;
  return null;
}

export async function cloneInto(store: Store, dataDir: string, input: { url: string; label?: string; workshopId?: string | null; parentDir?: string | null }) {
  const src = cloneSource(input.url);
  if (!src) throw new Error('Use an https or SSH remote, or an absolute path to a repo on this machine.');
  const label = (input.label || src.replace(/\.git\/?$/, '').split(/[/:]/).filter(Boolean).pop() || 'repo').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'repo';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(label)) throw new Error('Pick a label like server or apk.');
  // Clone into a folder the user picked, or the app's repo cache by default.
  const parent = input.parentDir?.trim() ? input.parentDir.trim() : reposDir(dataDir);
  if (!path.isAbsolute(parent)) throw new Error('Clone location must be an absolute folder, like /home/you/src.');
  fs.mkdirSync(parent, { recursive: true });
  const dest = path.join(parent, label);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists. Pick another label or location.`);
  const out = await git(parent, ['clone', '--', src, label]);
  if (!ok(out) || !fs.existsSync(path.join(dest, '.git'))) throw new Error(`Clone failed.\n${body(out).slice(0, 600)}`);
  registerSharedRepo(store, { label, path: dest, remote: /^(https:\/\/|ssh:\/\/|git@)/.test(src) ? src : null });
  if (input.workshopId) {
    const shop = getWorkshop(store, input.workshopId);
    if (!shop) throw new Error('Workshop not found.');
    if (!shop.projects.some((p) => p.label === label)) {
      store.db.prepare('INSERT INTO workshop_projects (id, workshop_id, label, path, created_at) VALUES (?, ?, ?, ?, ?)').run(nid('prj'), shop.id, label, fs.realpathSync(dest), now());
      store.db.prepare('UPDATE workshops SET updated_at = ? WHERE id = ?').run(now(), shop.id);
    }
  }
  return { label, path: dest, output: body(out) };
}

export async function currentBranch(cwd: string) {
  return body(await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export function isProtected(branch: string) {
  return branch === 'main' || branch === 'master';
}

export async function pushBranch(cwd: string, identity: GitIdentity, opts: { allowMain?: boolean } = {}) {
  const branch = await currentBranch(cwd);
  if (!branch || branch === 'HEAD') throw new Error('Check out a branch before pushing.');
  if (isProtected(branch) && !opts.allowMain) throw new Error(`Pushing to ${branch} needs an explicit confirmation. Make a branch, or confirm the push to ${branch}.`);
  const out = await git(cwd, ['push', '-u', 'origin', branch], identity);
  if (/non-fast-forward|rejected|fetch first/i.test(out)) return { ok: false, branch, output: `Push rejected. The remote is ahead. Pull first.\n${body(out)}` };
  return { ok: ok(out), branch, output: body(out) };
}

export async function openPullRequest(cwd: string, token: string | null, fetchImpl: typeof fetch, input: { title: string; body?: string; base?: string }) {
  if (!token) throw new Error('Opening a PR needs a GitHub token. Save one as GITHUB_TOKEN under Settings → Vault.');
  const remote = body(await git(cwd, ['remote', 'get-url', 'origin'])).trim();
  const gh = githubRepoOf(remote);
  if (!gh) throw new Error('The origin remote is not a GitHub repo.');
  const head = await currentBranch(cwd);
  if (isProtected(head)) throw new Error(`You are on ${head}. Push a feature branch, then open the PR.`);
  const res = await fetchImpl(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'local-agent' },
    body: JSON.stringify({ title: input.title, head, base: input.base || 'main', body: input.body || '' }),
  });
  const data = await res.json().catch(() => ({})) as { html_url?: string; number?: number; message?: string; errors?: { message?: string }[] };
  if (!res.ok) throw new Error(`GitHub said: ${data.message || res.statusText}${data.errors?.[0]?.message ? ` (${data.errors[0].message})` : ''}`);
  return { url: data.html_url || '', number: data.number || 0 };
}

/** A tree listing for a folder, bounded so it fits in a prompt. */
export function treeListing(root: string, rel = '.', opts: { depth?: number; max?: number } = {}): { text: string; truncated: boolean; count: number } {
  const start = path.resolve(root, rel);
  if (!safeInside(root, start)) throw new Error('That folder is outside the workspace.');
  const max = opts.max ?? 300;
  const lines: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number, prefix: string) => {
    if (lines.length >= max) { truncated = true; return; }
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter((e) => !['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build'].includes(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= max) { truncated = true; return; }
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) {
        if (depth > 1) walk(path.join(dir, entry.name), depth - 1, `${prefix}  `);
        else truncated = truncated || fs.readdirSync(path.join(dir, entry.name)).length > 0;
      }
    }
  };
  walk(start, opts.depth ?? 3, '');
  return { text: lines.join('\n'), truncated, count: lines.length };
}

export function listDir(root: string, rel = '.') {
  const dir = path.resolve(root, rel || '.');
  if (!safeInside(root, dir)) throw new Error('That folder is outside the workspace.');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = 0;
      try { size = e.isFile() ? fs.statSync(full).size : 0; } catch { size = 0; }
      return { name: e.name, path: path.relative(root, full).split(path.sep).join('/'), dir: e.isDirectory(), size };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export const EXCERPT_BYTES = 40_000;

/** File contents for a mention: whole file or a line range, capped, with a note when cut. */
export function readExcerpt(root: string, rel: string, range?: { start?: number; end?: number }) {
  const full = path.resolve(root, rel);
  if (!safeInside(root, full)) throw new Error('That file is outside the workspace.');
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('That is a folder, not a file.');
  const fd = fs.openSync(full, 'r');
  const buf = Buffer.alloc(Math.min(stat.size, 2_000_000));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  if (buf.subarray(0, 8000).includes(0)) return { text: '', truncated: false, binary: true, size: stat.size, lines: 0 };
  const all = buf.toString('utf8').split('\n');
  const startLine = Math.max(1, range?.start || 1);
  const endLine = Math.min(all.length, range?.end || all.length);
  let text = all.slice(startLine - 1, endLine).join('\n');
  let truncated = stat.size > buf.length;
  if (Buffer.byteLength(text) > EXCERPT_BYTES) { text = Buffer.from(text).subarray(0, EXCERPT_BYTES).toString('utf8'); truncated = true; }
  return { text, truncated, binary: false, size: stat.size, lines: all.length, startLine, endLine };
}
