import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './db.js';
import { accountOf } from './accounts.js';
import { gitStatus, listGitRoots } from './gitops.js';
import { listSharedRepos, registerSharedRepo } from './repos.js';
import { createWorkshop, listWorkshops } from './workshops.js';

/** A workspace is a folder or a git repo (local or cloned). A set is a named group of them (stored as a workshop). */
export interface WorkspaceView { id: string; label: string; path: string; kind: 'folder' | 'repo'; source: 'agent' | 'project'; remote: string | null; branch: string | null; dirty: number; sets: string[] }

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function zparse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) fail(400, result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
  return result.data;
}

export function labelFor(input: string) {
  return (input.split(/[\\/]/).filter(Boolean).pop() || 'folder').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'w$1').slice(0, 32) || 'folder';
}

export async function listWorkspaces(store: Store, ownerId: string): Promise<WorkspaceView[]> {
  const roots = listGitRoots(store, ownerId);
  return Promise.all(roots.map(async (root) => {
    const isRepo = fs.existsSync(path.join(root.path, '.git'));
    let branch: string | null = null;
    let dirty = 0;
    if (isRepo) {
      try { const status = await gitStatus(root.path); branch = status.branch; dirty = status.files.length; } catch { /* unreadable repo */ }
    }
    return { id: root.id, label: root.label, path: root.path, kind: isRepo ? 'repo' : 'folder', source: root.kind === 'workspace' ? 'agent' : 'project', remote: root.remote, branch, dirty, sets: root.workshops } satisfies WorkspaceView;
  }));
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: { store: Store }) {
  const { store } = deps;
  const ownerOnly = (req: Parameters<typeof accountOf>[0]) => { if (accountOf(req).role === 'member') fail(403, 'Only the owner can add workspaces on this machine.'); };

  app.get('/api/workspaces', async (req) => {
    const account = accountOf(req);
    const workspaces = await listWorkspaces(store, account.id);
    const sets = account.role === 'member' ? [] : listWorkshops(store).map((shop) => ({ id: shop.id, name: shop.name, projects: shop.projects.map((project) => project.label) }));
    return { workspaces, sets };
  });

  /** Add a local folder or a local repo as a workspace. */
  app.post('/api/workspaces/folder', async (req) => {
    ownerOnly(req);
    const body = zparse(z.object({ path: z.string().min(1).max(500), label: z.string().max(32).optional() }), req.body);
    if (!path.isAbsolute(body.path)) fail(400, 'Use an absolute path on this machine, like /home/you/projects/api.');
    let stat: fs.Stats;
    try { stat = fs.statSync(body.path); } catch { fail(400, `Cannot open ${body.path}. Check the path exists and local-agent can read it.`); }
    if (!stat.isDirectory()) fail(400, `${body.path} is not a folder.`);
    const label = (body.label?.trim() || labelFor(body.path)).toLowerCase();
    const existing = listSharedRepos(store).find((repo) => repo.label === label && repo.path !== fs.realpathSync(body.path));
    if (existing) fail(409, `${label} is already used for ${existing.path}. Pick another label.`);
    try { return { workspace: registerSharedRepo(store, { label, path: body.path }) }; }
    catch (error) { fail(400, error instanceof Error ? error.message : 'Could not add that folder.'); }
  });

  /** Save several workspaces as a named set ("api + web"). Reuses an identical set when there is one. */
  app.post('/api/workspaces/sets', async (req) => {
    ownerOnly(req);
    const body = zparse(z.object({ name: z.string().min(1).max(80), labels: z.array(z.string().min(1)).min(1).max(8) }), req.body);
    const repos = listSharedRepos(store);
    const projects = body.labels.map((label) => {
      const repo = repos.find((item) => item.label === label);
      if (!repo) fail(404, `No workspace called ${label}.`);
      return { label: repo.label, path: repo.path };
    });
    const wanted = [...body.labels].sort().join(',');
    const same = listWorkshops(store).find((shop) => shop.name === body.name.trim() && shop.projects.map((project) => project.label).sort().join(',') === wanted);
    if (same) return { set: { id: same.id, name: same.name, projects: same.projects.map((project) => project.label) } };
    try {
      const shop = createWorkshop(store, { name: body.name, projects });
      return { set: { id: shop.id, name: shop.name, projects: shop.projects.map((project) => project.label) } };
    } catch (error) { fail(400, error instanceof Error ? error.message : 'Could not save that set.'); }
  });
}
