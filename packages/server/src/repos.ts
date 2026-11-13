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

const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const CHANGE = /\b(change|edit|fix|implement|add|remove|refactor|commit|push|pull|patch|update|bug|feature|wire|rename|delete|rewrite)\b/i;

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
  const lines = repos.map((repo) => `- ${repo.label}: ${repo.path}${repo.remote ? ` (${repo.remote})` : ''}`);
  return `\n\nShared repos, one copy for every persona:\n${lines.join('\n')}`;
}

export function repoSyncTool(): Tool {
  return {
    name: 'repo_sync',
    description: 'Clone a remote into the shared repo store, or pull an existing shared repo. Returns status and the latest commits so personas can talk about what changed. Needs approval.',
    parameters: {
      type: 'object',
      properties: { label: { type: 'string' }, url: { type: 'string' } },
      additionalProperties: false,
    },
    mutates: () => true,
    approval: (args) => args.url ? `Clone ${args.url} into the shared repos` : `Pull ${args.label || 'the shared repo'}`,
    async execute(args, ctx) {
      const dataDir = ctx.libraryDir || '';
      if (!dataDir) throw new Error('Shared repo storage is not configured.');
      return syncSharedRepo(ctx.store, dataDir, { label: args.label ? String(args.label) : undefined, url: args.url ? String(args.url) : undefined });
    },
  };
}

export async function syncSharedRepo(store: Store, dataDir: string, input: { label?: string; url?: string }) {
  const root = reposDir(dataDir);
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
    const pulled = await git(dest, ['pull', '--ff-only']);
    const log = await git(dest, ['log', '-5', '--oneline']);
    const status = await git(dest, ['status', '--short', '--branch']);
    return [`# ${label}`, pulled, status, log].join('\n');
  }
  const label = input.label?.toLowerCase();
  const repo = listSharedRepos(store).find((item) => item.label === label);
  if (!repo) throw new Error('Name a shared repo, or pass a remote url to clone.');
  const pulled = await git(repo.path, ['pull', '--ff-only']);
  const log = await git(repo.path, ['log', '-5', '--oneline']);
  const status = await git(repo.path, ['status', '--short', '--branch']);
  return [`# ${repo.label}`, pulled, status, log].join('\n');
}

function safeRemote(url: string) {
  return /^(https:\/\/|ssh:\/\/|git@)/.test(url) && !/[\s;&|`$]/.test(url);
}

function labelFromRemote(url: string) {
  const cleaned = url.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo';
  return cleaned.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve(`exit ${code ?? 1}\n${out.slice(0, 8_000)}`));
  });
}
