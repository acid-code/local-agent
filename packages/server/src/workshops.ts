import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '@local-agent/shared';
import type { Store } from './db.js';
import { registerSharedRepo } from './repos.js';
import { nid, now } from './util.js';

export interface ProjectRoot {
  id: string;
  label: string;
  path: string;
}

export interface Workshop {
  id: string;
  name: string;
  projects: ProjectRoot[];
  createdAt: string;
  updatedAt: string;
}

const LABEL = /^[a-z][a-z0-9-]{0,31}$/;

export function createWorkshop(store: Store, input: { name: string; projects: { label: string; path: string }[] }): Workshop {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error('Give the workshop a short name.');
  if (!input.projects.length || input.projects.length > 8) throw new Error('A workshop needs between 1 and 8 projects.');
  const projects = input.projects.map((project) => {
    const label = project.label.trim().toLowerCase();
    if (!LABEL.test(label)) throw new Error(`Project label "${project.label}" should be a short lowercase name, like server or apk.`);
    if (!path.isAbsolute(project.path)) throw new Error(`${label} needs an absolute path on this machine.`);
    let real: string;
    try {
      const stat = fs.statSync(project.path);
      if (!stat.isDirectory()) throw new Error(`${project.path} is not a folder.`);
      real = fs.realpathSync(project.path);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not a folder')) throw error;
      throw new Error(`Cannot open ${project.path}.`);
    }
    return { label, path: real };
  });
  if (new Set(projects.map((project) => project.label)).size !== projects.length) throw new Error('Each project needs its own label.');
  for (const project of projects) {
    for (const other of projects) {
      if (project === other) continue;
      if (isInside(project.path, other.path)) throw new Error(`${other.label} sits inside ${project.label}. Add the parent once, or pick folders that sit beside each other.`);
    }
  }
  const id = nid('shop');
  const ts = now();
  store.db.prepare('INSERT INTO workshops (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, ts, ts);
  const insert = store.db.prepare('INSERT INTO workshop_projects (id, workshop_id, label, path, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const project of projects) {
    insert.run(nid('prj'), id, project.label, project.path, ts);
    registerSharedRepo(store, { label: project.label, path: project.path });
  }
  return getWorkshop(store, id)!;
}

export function listWorkshops(store: Store): Workshop[] {
  const rows = store.db.prepare('SELECT * FROM workshops ORDER BY updated_at DESC').all() as Record<string, unknown>[];
  return rows.map((row) => hydrate(store, row));
}

export function getWorkshop(store: Store, id: string): Workshop | null {
  const row = store.db.prepare('SELECT * FROM workshops WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? hydrate(store, row) : null;
}

function hydrate(store: Store, row: Record<string, unknown>): Workshop {
  const projects = store.db.prepare('SELECT id, label, path FROM workshop_projects WHERE workshop_id = ? ORDER BY label').all(String(row.id)) as { id: string; label: string; path: string }[];
  return {
    id: String(row.id),
    name: String(row.name),
    projects: projects.map((project) => ({ id: project.id, label: project.label, path: project.path })),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function workshopBrief(store: Store, workshopId: string): string {
  const workshop = getWorkshop(store, workshopId);
  if (!workshop) return '';
  const lines = workshop.projects.map((project) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(project.path).filter((name) => name !== 'node_modules' && !name.startsWith('.')).slice(0, 16);
    } catch { names = []; }
    const git = fs.existsSync(path.join(project.path, '.git')) ? 'git' : 'not a git checkout';
    return `- ${project.label}: ${project.path} (${git}). Top: ${names.join(', ') || '(empty)'}`;
  });
  return `\n\nWorkshop "${workshop.name}" has ${workshop.projects.length} project${workshop.projects.length === 1 ? '' : 's'}. Name the project on git, shell, and edits. Pull and push wait for approval.\n${lines.join('\n')}`;
}

export interface PathHit {
  root: string;
  full: string;
  write: boolean;
  label: string | null;
}

export function locatePath(input: {
  workspace: string;
  roots?: { label: string; path: string; write?: boolean }[];
  grants?: { path: string; mode: string }[];
  target: string;
}): PathHit | null {
  const target = input.target.trim();
  const roots = input.roots ?? [];
  if (!target || target === '.') {
    if (roots.length === 1) return { root: roots[0]!.path, full: roots[0]!.path,     write: roots[0]!.write !== false, label: roots[0]!.label };
    if (roots.length > 1) return null;
    return { root: path.resolve(input.workspace), full: path.resolve(input.workspace), write: true, label: null };
  }
  const slash = target.indexOf('/');
  const head = slash === -1 ? target : target.slice(0, slash);
  const tail = slash === -1 ? '.' : target.slice(slash + 1);
  const labeled = roots.find((root) => root.label === head);
  if (labeled) {
    const full = inside(labeled.path, tail);
    return full ? { root: labeled.path, full, write: labeled.write !== false, label: labeled.label } : null;
  }
  if (path.isAbsolute(target)) {
    const resolved = path.resolve(target);
    for (const root of roots) {
      if (isInside(root.path, resolved)) return { root: root.path, full: resolved, write: root.write !== false, label: root.label };
    }
  }
  const inWorkspace = inside(input.workspace, target);
  if (inWorkspace) return { root: path.resolve(input.workspace), full: inWorkspace, write: true, label: null };
  for (const grant of input.grants ?? []) {
    const full = path.isAbsolute(target) && isInside(grant.path, path.resolve(target)) ? path.resolve(target) : inside(grant.path, target);
    if (full) return { root: grant.path, full, write: grant.mode === 'write', label: null };
  }
  return null;
}

export function projectPath(roots: { label: string; path: string }[], project: string | undefined, workspace: string): string {
  if (project === 'workspace') return workspace;
  if (project) {
    const hit = roots.find((root) => root.label === project || path.resolve(root.path) === path.resolve(project));
    if (!hit) throw new Error(`Unknown project "${project}". Use ${[...roots.map((root) => root.label), 'workspace'].join(', ')}.`);
    return hit.path;
  }
  if (roots.length === 1) return roots[0]!.path;
  if (roots.length > 1) throw new Error(`Name the project: ${[...roots.map((root) => root.label), 'workspace'].join(', ')}.`);
  return workspace;
}

function inside(root: string, relative: string): string | null {
  const full = path.resolve(root, relative || '.');
  return isInside(root, full) ? full : null;
}
