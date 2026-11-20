import fs from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext } from './tools.js';
import { clipToolOutput } from './tools.js';

const VERCEL_API = 'https://api.vercel.com';
const BLOB_API = 'https://blob.vercel-storage.com';

const WRITE_ACTIONS = new Set(['set_env', 'delete_env', 'update_project', 'redeploy']);

interface VercelAuth {
  token: string;
  teamId?: string;
  teamSlug?: string;
  blobToken?: string;
}

function readLocalVercelLink(ctx: ToolContext): { projectId?: string; orgId?: string; root?: string } {
  const roots = ctx.roots?.length ? ctx.roots.map((r) => r.path) : [ctx.workspace];
  for (const root of roots) {
    const file = path.join(root, '.vercel', 'project.json');
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { projectId?: string; orgId?: string };
        return { projectId: parsed.projectId, orgId: parsed.orgId, root };
      } catch { /* ignore malformed link */ }
    }
  }
  return { root: roots[0] };
}

function resolveAuth(ctx: ToolContext, args: Record<string, unknown>): VercelAuth {
  const secrets = ctx.secretEnv?.() ?? {};
  const token = (secrets.VERCEL_TOKEN || process.env.VERCEL_TOKEN || '').trim();
  const link = readLocalVercelLink(ctx);
  const teamId = String(args.teamId || secrets.VERCEL_TEAM_ID || process.env.VERCEL_TEAM_ID || (link.orgId?.startsWith('team_') ? link.orgId : '') || '').trim() || undefined;
  const teamSlug = String(args.teamSlug || secrets.VERCEL_TEAM_SLUG || process.env.VERCEL_TEAM_SLUG || '').trim() || undefined;
  const blobToken = (secrets.BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || '').trim() || undefined;
  return { token, teamId, teamSlug, blobToken };
}

function withTeam(urlPath: string, auth: VercelAuth): string {
  const url = new URL(`${VERCEL_API}${urlPath}`);
  if (auth.teamId && !url.searchParams.has('teamId')) url.searchParams.set('teamId', auth.teamId);
  else if (auth.teamSlug && !url.searchParams.has('slug')) url.searchParams.set('slug', auth.teamSlug);
  return url.toString();
}

async function vercelFetch<T = Record<string, unknown>>(
  ctx: ToolContext,
  auth: VercelAuth,
  urlPath: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T; raw: string }> {
  const res = await ctx.fetchImpl(withTeam(urlPath, auth), {
    ...init,
    signal: ctx.signal,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const raw = await res.text();
  let data = {} as T;
  try { data = raw ? (JSON.parse(raw) as T) : ({} as T); } catch { /* plain text or ndjson */ }
  return { ok: res.ok, status: res.status, data, raw };
}

function formatApiError(status: number, data: unknown, raw: string): string {
  const obj = data as { error?: { message?: string; code?: string } } | null;
  const msg = obj?.error?.message || raw.slice(0, 400) || `HTTP ${status}`;
  const code = obj?.error?.code ? ` (${obj.error.code})` : '';
  return `Vercel API error ${status}${code}: ${msg}`;
}

function findWorkspaceRoot(ctx: ToolContext, requested?: string): string {
  const roots = ctx.roots?.length ? ctx.roots.map((r) => r.path) : [ctx.workspace];
  if (requested) {
    const match = roots.find((r) => path.basename(r) === requested || r === requested);
    if (match) return match;
  }
  for (const r of roots) {
    if (fs.existsSync(path.join(r, 'turbo.json')) || fs.existsSync(path.join(r, 'vercel.json')) || fs.existsSync(path.join(r, 'package.json'))) {
      return r;
    }
  }
  return roots[0] || ctx.workspace;
}

function inspectLocalTurboAndBlob(root: string): string[] {
  const notes: string[] = [];
  if (!root || !fs.existsSync(root)) return notes;

  // 1. turbo.json
  const turboFile = path.join(root, 'turbo.json');
  if (fs.existsSync(turboFile)) {
    try {
      const turbo = JSON.parse(fs.readFileSync(turboFile, 'utf8')) as Record<string, unknown>;
      const hasTasks = Boolean(turbo.tasks);
      const hasPipeline = Boolean(turbo.pipeline);
      notes.push(`turbo.json: found (${hasTasks ? 'Turbo v2 `tasks`' : hasPipeline ? 'Turbo v1 `pipeline` — note Turbo 2.x requires `tasks`' : 'custom schema'})`);
      const globalEnv = Array.isArray(turbo.globalEnv) ? turbo.globalEnv.map(String) : [];
      const globalPass = Array.isArray(turbo.globalPassThroughEnv) ? turbo.globalPassThroughEnv.map(String) : [];
      const tasksObj = (turbo.tasks || turbo.pipeline || {}) as Record<string, Record<string, unknown>>;
      const buildTask = tasksObj.build || {};
      const buildEnv = Array.isArray(buildTask.env) ? buildTask.env.map(String) : [];
      const buildPass = Array.isArray(buildTask.passThroughEnv) ? buildTask.passThroughEnv.map(String) : [];
      const allEnv = new Set([...globalEnv, ...globalPass, ...buildEnv, ...buildPass]);
      const hasBlobEnv = [...allEnv].some((k) => k === 'BLOB_READ_WRITE_TOKEN' || k === 'BLOB_*' || k === '*');
      if (!hasBlobEnv) {
        notes.push('⚠ Turborepo strict env check: `BLOB_READ_WRITE_TOKEN` is NOT listed in turbo.json (`globalEnv`, `globalPassThroughEnv`, or `tasks.build.env`). Turbo 2.x strips unlisted env vars during build/dev!');
      } else {
        notes.push('✓ turbo.json exposes BLOB_READ_WRITE_TOKEN.');
      }
      notes.push(`turbo tasks: ${Object.keys(tasksObj).join(', ') || '(none)'}`);
    } catch (e) {
      notes.push(`⚠ turbo.json could not be parsed: ${(e as Error).message}`);
    }
  } else {
    notes.push('turbo.json: not found at workspace root.');
  }

  // 2. package.json
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
      const deps = { ...((pkg.dependencies as Record<string, string>) || {}), ...((pkg.devDependencies as Record<string, string>) || {}) };
      if (pkg.packageManager) notes.push(`packageManager: ${pkg.packageManager}`);
      if (deps.turbo) notes.push(`turbo version: ${deps.turbo}`);
      if (deps['@vercel/blob']) notes.push(`@vercel/blob version (root): ${deps['@vercel/blob']}`);
      const scripts = (pkg.scripts as Record<string, string>) || {};
      if (Object.keys(scripts).length) notes.push(`root scripts: ${Object.keys(scripts).join(', ')}`);
    } catch { /* ignore */ }
  }

  // 3. vercel.json
  const vercelFile = path.join(root, 'vercel.json');
  if (fs.existsSync(vercelFile)) {
    try {
      const vj = JSON.parse(fs.readFileSync(vercelFile, 'utf8')) as Record<string, unknown>;
      notes.push(`vercel.json: ${JSON.stringify(vj).slice(0, 600)}`);
    } catch (e) {
      notes.push(`⚠ vercel.json parse error: ${(e as Error).message}`);
    }
  }

  // 4. next.config.* (root or apps/*)
  const nextCandidates = [
    path.join(root, 'next.config.ts'),
    path.join(root, 'next.config.mjs'),
    path.join(root, 'next.config.js'),
  ];
  const appsDir = path.join(root, 'apps');
  if (fs.existsSync(appsDir)) {
    try {
      for (const entry of fs.readdirSync(appsDir)) {
        for (const ext of ['ts', 'mjs', 'js']) {
          nextCandidates.push(path.join(appsDir, entry, `next.config.${ext}`));
        }
      }
    } catch { /* ignore */ }
  }
  for (const cfg of nextCandidates) {
    if (!fs.existsSync(cfg)) continue;
    const text = fs.readFileSync(cfg, 'utf8');
    const rel = path.relative(root, cfg);
    const hasBlobHost = /blob\.vercel-storage\.com/i.test(text);
    notes.push(`${rel}: ${hasBlobHost ? '✓ allows *.blob.vercel-storage.com images' : '⚠ does not mention blob.vercel-storage.com in images.remotePatterns (Next/Image will reject Blob URLs if used)'}`);
  }

  // 5. .vercel/project.json
  const linkFile = path.join(root, '.vercel', 'project.json');
  if (fs.existsSync(linkFile)) {
    try {
      const link = JSON.parse(fs.readFileSync(linkFile, 'utf8')) as { projectId?: string; orgId?: string; projectName?: string };
      notes.push(`.vercel/project.json: projectId=${link.projectId || '?'} orgId=${link.orgId || '?'}${link.projectName ? ` (${link.projectName})` : ''}`);
    } catch { /* ignore */ }
  }

  return notes;
}

function parseEventsText(raw: string, data: unknown): string[] {
  const rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(data)) {
    for (const item of data) if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
  } else if (raw.trim()) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') rows.push(parsed);
      } catch {
        rows.push({ text: trimmed });
      }
    }
  }
  const out: string[] = [];
  for (const row of rows) {
    const payload = (row.payload as Record<string, unknown> | undefined) || row;
    const ts = row.created || row.date || payload.date || row.timestamp;
    const stamp = typeof ts === 'number' ? new Date(ts).toISOString().slice(11, 19) : '';
    const text = String(payload.text ?? row.text ?? row.message ?? payload.message ?? '').trim();
    const statusCode = payload.statusCode ?? row.statusCode;
    const reqPath = payload.requestPath ?? row.requestPath;
    const level = String(row.level ?? payload.level ?? row.type ?? '').trim();
    if (!text && !reqPath && !statusCode) continue;
    const prefix = [stamp, level && level !== 'stdout' ? `[${level}]` : '', statusCode ? `HTTP ${statusCode}` : '', reqPath ? String(reqPath) : ''].filter(Boolean).join(' ');
    out.push(prefix ? `${prefix}: ${text}` : text);
  }
  return out;
}

export function vercelTool(): Tool {
  return {
    name: 'vercel',
    description:
      'Inspect and manage Vercel projects, deployments, build & runtime logs, environment variables, and Vercel Blob storage. '
      + 'Use list_projects, get_project, list_deployments, get_deployment_logs, get_runtime_logs, list_env, blob_list, blob_diagnose (read-only), '
      + 'or set_env, delete_env, update_project, redeploy (asks approval). Uses VERCEL_TOKEN (and optional VERCEL_TEAM_ID / BLOB_READ_WRITE_TOKEN) from Settings → Vault.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_projects',
            'get_project',
            'list_deployments',
            'get_deployment_logs',
            'get_runtime_logs',
            'list_env',
            'set_env',
            'delete_env',
            'update_project',
            'redeploy',
            'blob_list',
            'blob_diagnose',
          ],
          description: 'Vercel action to perform.',
        },
        project: { type: 'string', description: 'Project name or ID (optional if .vercel/project.json exists in workspace).' },
        deploymentId: { type: 'string', description: 'Deployment ID or URL (optional for logs/redeploy — defaults to latest deployment of project).' },
        teamId: { type: 'string', description: 'Optional Vercel team ID override (team_...).' },
        teamSlug: { type: 'string', description: 'Optional Vercel team slug override.' },
        key: { type: 'string', description: 'Environment variable name (for set_env).' },
        value: { type: 'string', description: 'Environment variable value (for set_env).' },
        envId: { type: 'string', description: 'Environment variable ID (for delete_env).' },
        target: {
          type: 'array',
          items: { type: 'string', enum: ['production', 'preview', 'development'] },
          description: 'Target environments for set_env or redeploy target.',
        },
        envType: { type: 'string', enum: ['encrypted', 'plain', 'sensitive'], description: 'Env var storage type (default encrypted).' },
        prefix: { type: 'string', description: 'Optional blob pathname prefix for blob_list.' },
        limit: { type: 'number', description: 'Max items to return.' },
        settings: {
          type: 'object',
          description: 'Project settings patch for update_project (buildCommand, installCommand, outputDirectory, rootDirectory, framework, nodeVersion, ignoreCommand).',
        },
      },
      required: ['action'],
    },
    mutates: (args) => WRITE_ACTIONS.has(String(args.action || '')),
    approval: (args) => {
      const action = String(args.action || '');
      if (!WRITE_ACTIONS.has(action)) return null;
      const project = String(args.project || '(linked project)');
      if (action === 'set_env') return `Set Vercel env var ${String(args.key || '?')} on ${project}`;
      if (action === 'delete_env') return `Delete Vercel env var ${String(args.envId || '?')} on ${project}`;
      if (action === 'update_project') return `Update Vercel project settings on ${project}`;
      if (action === 'redeploy') return `Trigger Vercel redeploy for ${String(args.deploymentId || project)}`;
      return `Run Vercel write action ${action}`;
    },
    async execute(args, ctx) {
      const action = String(args.action || '').trim();
      const auth = resolveAuth(ctx, args);
      const link = readLocalVercelLink(ctx);
      const project = String(args.project || link.projectId || '').trim();

      if (action === 'blob_list' && !auth.token && !auth.blobToken) {
        return 'Missing BLOB_READ_WRITE_TOKEN and VERCEL_TOKEN. Ask the user with request_secret (name: "VERCEL_TOKEN" or "BLOB_READ_WRITE_TOKEN") or tell them to add it in Settings → Vault.';
      }
      if (action !== 'blob_list' && action !== 'blob_diagnose' && !auth.token) {
        return 'VERCEL_TOKEN is not set in Vault. Call request_secret(name="VERCEL_TOKEN", reason="Access Vercel projects, logs, and settings") or ask the user to add VERCEL_TOKEN (from https://vercel.com/account/tokens) in Settings → Vault.';
      }

      if (action === 'list_projects') {
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 25));
        const res = await vercelFetch<{ projects?: Array<Record<string, unknown>> }>(ctx, auth, `/v9/projects?limit=${limit}`);
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        const list = res.data.projects || [];
        if (!list.length) return 'No Vercel projects found (if your projects belong to a team, also add VERCEL_TEAM_ID in Settings → Vault).';
        return list.map((p) => {
          const latest = Array.isArray(p.latestDeployments) ? (p.latestDeployments[0] as Record<string, unknown> | undefined) : undefined;
          const state = latest?.readyState ? ` · ${latest.readyState}` : '';
          const url = latest?.url ? ` · https://${latest.url}` : '';
          const root = p.rootDirectory ? ` · root=${p.rootDirectory}` : '';
          return `- ${p.name} (id=${p.id}, fw=${p.framework || 'other'}${root}${state}${url})`;
        }).join('\n');
      }

      if (action === 'get_project') {
        if (!project) return 'Provide `project` (name or ID) or run list_projects first.';
        const res = await vercelFetch<Record<string, unknown>>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}`);
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        const p = res.data;
        const summary = {
          id: p.id,
          name: p.name,
          framework: p.framework,
          nodeVersion: p.nodeVersion,
          rootDirectory: p.rootDirectory,
          buildCommand: p.buildCommand,
          installCommand: p.installCommand,
          outputDirectory: p.outputDirectory,
          ignoreCommand: p.commandForIgnoringBuildStep,
          link: p.link,
        };
        return JSON.stringify(summary, null, 2);
      }

      if (action === 'list_deployments') {
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 12));
        const qs = new URLSearchParams({ limit: String(limit) });
        if (project) {
          // Accept either project ID or name by resolving project ID if needed
          if (!project.startsWith('prj_')) {
            const prj = await vercelFetch<{ id?: string }>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}`);
            if (prj.ok && prj.data.id) qs.set('projectId', prj.data.id);
            else qs.set('app', project);
          } else {
            qs.set('projectId', project);
          }
        }
        const res = await vercelFetch<{ deployments?: Array<Record<string, unknown>> }>(ctx, auth, `/v6/deployments?${qs.toString()}`);
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        const list = res.data.deployments || [];
        if (!list.length) return `No deployments found${project ? ` for ${project}` : ''}.`;
        return list.map((d) => {
          const meta = (d.meta as Record<string, string> | undefined) || {};
          const msg = meta.githubCommitMessage?.split('\n')[0]?.slice(0, 70) || '';
          const sha = meta.githubCommitSha?.slice(0, 7) || '';
          const when = typeof d.created === 'number' ? new Date(d.created).toISOString().slice(0, 16).replace('T', ' ') : '';
          return `- ${d.uid} | ${d.state || d.readyState} | ${d.target || 'preview'} | ${when} | https://${d.url}${sha ? ` | ${sha}` : ''}${msg ? ` "${msg}"` : ''}`;
        }).join('\n');
      }

      if (action === 'get_deployment_logs' || action === 'get_runtime_logs') {
        let depId = String(args.deploymentId || '').trim();
        let projectId = project.startsWith('prj_') ? project : '';
        if (!depId) {
          if (!project) return 'Provide `deploymentId` or `project` so I can inspect the latest deployment.';
          if (!projectId) {
            const prj = await vercelFetch<{ id?: string }>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}`);
            if (prj.ok && prj.data.id) projectId = prj.data.id;
          }
          const deps = await vercelFetch<{ deployments?: Array<{ uid: string; state?: string }> }>(
            ctx,
            auth,
            `/v6/deployments?${projectId ? `projectId=${encodeURIComponent(projectId)}` : `app=${encodeURIComponent(project)}`}&limit=5`,
          );
          if (!deps.ok) return formatApiError(deps.status, deps.data, deps.raw);
          const list = deps.data.deployments || [];
          if (!list.length) return `No deployments found for ${project}.`;
          // Prefer latest ERROR deployment if inspecting build logs, otherwise latest deployment
          const picked = action === 'get_deployment_logs' ? (list.find((d) => d.state === 'ERROR') || list[0]!) : list[0]!;
          depId = picked.uid;
        }

        const depInfo = await vercelFetch<Record<string, unknown>>(ctx, auth, `/v13/deployments/${encodeURIComponent(depId)}`);
        const headerLines: string[] = [];
        if (depInfo.ok) {
          const d = depInfo.data;
          if (!projectId && typeof d.projectId === 'string') projectId = d.projectId;
          headerLines.push(`Deployment: ${d.id || depId} (${d.readyState || d.status || 'unknown'}) · https://${d.url || ''}`);
          if (d.errorCode || d.errorMessage) {
            headerLines.push(`Error: ${d.errorCode || ''} ${d.errorMessage || ''}${d.errorStep ? ` (step: ${d.errorStep})` : ''}`.trim());
          }
        }

        const limit = Math.min(300, Math.max(20, Number(args.limit) || 150));
        if (action === 'get_deployment_logs') {
          const ev = await vercelFetch(ctx, auth, `/v3/deployments/${encodeURIComponent(depId)}/events?builds=1&direction=backward&limit=${limit}`);
          if (!ev.ok) return `${headerLines.join('\n')}\n${formatApiError(ev.status, ev.data, ev.raw)}`;
          const lines = parseEventsText(ev.raw, ev.data);
          return clipToolOutput([...headerLines, '', lines.length ? lines.join('\n') : '(No build log events returned.)'].join('\n'));
        }

        // Runtime logs: try v1 runtime-logs first if we have projectId, then fall back to v2 deployment events (builds=0)
        if (projectId) {
          const rt = await vercelFetch(ctx, auth, `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(depId)}/runtime-logs`);
          if (rt.ok && rt.raw.trim()) {
            const lines = parseEventsText(rt.raw, rt.data);
            if (lines.length) return clipToolOutput([...headerLines, '', ...lines.slice(-limit)].join('\n'));
          }
        }
        const ev = await vercelFetch(ctx, auth, `/v2/deployments/${encodeURIComponent(depId)}/events?builds=0&direction=backward&limit=${limit}`);
        if (!ev.ok) return `${headerLines.join('\n')}\n${formatApiError(ev.status, ev.data, ev.raw)}`;
        const lines = parseEventsText(ev.raw, ev.data);
        return clipToolOutput([...headerLines, '', lines.length ? lines.join('\n') : '(No runtime log events returned yet — trigger a request on the deployment URL to generate runtime logs.)'].join('\n'));
      }

      if (action === 'list_env') {
        if (!project) return 'Provide `project` (name or ID).';
        const res = await vercelFetch<{ envs?: Array<Record<string, unknown>> }>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}/env`);
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        const envs = res.data.envs || [];
        if (!envs.length) return `No environment variables configured on ${project}.`;
        const lines = envs.map((e) => {
          const targets = Array.isArray(e.target) ? e.target.join(',') : String(e.target || '');
          const branch = e.gitBranch ? ` [branch:${e.gitBranch}]` : '';
          return `- ${e.key} (id=${e.id}, type=${e.type}, targets=${targets}${branch})`;
        });
        const blobVars = envs.filter((e) => String(e.key || '').includes('BLOB'));
        lines.push('');
        lines.push(blobVars.length
          ? `Blob env vars found: ${blobVars.map((b) => `${b.key} (${Array.isArray(b.target) ? b.target.join(',') : b.target})`).join('; ')}`
          : '⚠ No BLOB_READ_WRITE_TOKEN found in this project\'s Vercel env vars.');
        return lines.join('\n');
      }

      if (action === 'set_env') {
        if (!project) return 'Provide `project` (name or ID).';
        const key = String(args.key || '').trim();
        const value = String(args.value ?? '');
        if (!key) return 'Provide `key` for set_env.';
        const target = Array.isArray(args.target) && args.target.length ? args.target.map(String) : ['production', 'preview', 'development'];
        const type = String(args.envType || 'encrypted');
        const res = await vercelFetch(ctx, auth, `/v10/projects/${encodeURIComponent(project)}/env?upsert=true`, {
          method: 'POST',
          body: JSON.stringify({ key, value, target, type }),
        });
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        return `Saved env var ${key} (${type}) on ${project} for targets: ${target.join(', ')}. Trigger a redeploy for changes to take effect.`;
      }

      if (action === 'delete_env') {
        if (!project || !args.envId) return 'Provide `project` and `envId` (from list_env).';
        const res = await vercelFetch(ctx, auth, `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(String(args.envId))}`, { method: 'DELETE' });
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        return `Deleted env var ${String(args.envId)} from ${project}.`;
      }

      if (action === 'update_project') {
        if (!project) return 'Provide `project` (name or ID).';
        const settings = (args.settings && typeof args.settings === 'object' ? args.settings : {}) as Record<string, unknown>;
        const allowed = ['buildCommand', 'installCommand', 'outputDirectory', 'rootDirectory', 'framework', 'nodeVersion', 'commandForIgnoringBuildStep'];
        const patch: Record<string, unknown> = {};
        for (const k of allowed) if (k in settings) patch[k] = settings[k];
        if ('ignoreCommand' in settings && !('commandForIgnoringBuildStep' in patch)) patch.commandForIgnoringBuildStep = settings.ignoreCommand;
        if (!Object.keys(patch).length) return `Provide at least one field in settings: ${allowed.join(', ')}.`;
        const res = await vercelFetch(ctx, auth, `/v9/projects/${encodeURIComponent(project)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        return `Updated ${project}: ${JSON.stringify(patch)}`;
      }

      if (action === 'redeploy') {
        let depId = String(args.deploymentId || '').trim();
        let name = project;
        if (!depId) {
          if (!project) return 'Provide `deploymentId` or `project`.';
          const prj = await vercelFetch<{ id?: string; name?: string }>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}`);
          const qs = prj.ok && prj.data.id ? `projectId=${encodeURIComponent(prj.data.id)}` : `app=${encodeURIComponent(project)}`;
          if (prj.ok && prj.data.name) name = prj.data.name;
          const deps = await vercelFetch<{ deployments?: Array<{ uid: string; name?: string }> }>(ctx, auth, `/v6/deployments?${qs}&limit=1`);
          if (!deps.ok || !deps.data.deployments?.length) return `Could not find a deployment to redeploy for ${project}.`;
          depId = deps.data.deployments[0]!.uid;
          if (!name && deps.data.deployments[0]!.name) name = deps.data.deployments[0]!.name!;
        }
        const targetArr = Array.isArray(args.target) ? args.target : [];
        const target = targetArr[0] === 'production' ? 'production' : undefined;
        const res = await vercelFetch<{ id?: string; url?: string; readyState?: string }>(ctx, auth, '/v13/deployments', {
          method: 'POST',
          body: JSON.stringify({ name: name || project || 'redeploy', deploymentId: depId, ...(target ? { target } : {}) }),
        });
        if (!res.ok) return formatApiError(res.status, res.data, res.raw);
        return `Triggered redeploy: ${res.data.id || '?'} (${res.data.readyState || 'QUEUED'}) · https://${res.data.url || ''}`;
      }

      if (action === 'blob_list') {
        const out: string[] = [];
        if (auth.token) {
          const stores = await vercelFetch<{ stores?: Array<Record<string, unknown>> }>(ctx, auth, '/v1/storage/stores');
          if (stores.ok && Array.isArray(stores.data.stores)) {
            const blobStores = stores.data.stores.filter((s) => String(s.type || '').toLowerCase().includes('blob'));
            out.push(`Connected Vercel Blob stores (${blobStores.length}):`);
            for (const s of blobStores) {
              out.push(`- ${s.name || s.id} (id=${s.id}, status=${s.status || 'ok'}, size=${s.size ?? '?'})`);
            }
          }
        }
        if (auth.blobToken) {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
          const qs = new URLSearchParams({ limit: String(limit) });
          if (args.prefix) qs.set('prefix', String(args.prefix));
          const res = await ctx.fetchImpl(`${BLOB_API}/?${qs.toString()}`, {
            signal: ctx.signal,
            headers: { Authorization: `Bearer ${auth.blobToken}`, 'x-api-version': '7' },
          });
          const text = await res.text();
          if (!res.ok) {
            out.push(`Blob store API error ${res.status}: ${text.slice(0, 300)}`);
          } else {
            try {
              const parsed = JSON.parse(text) as { blobs?: Array<{ pathname: string; size: number; url: string; uploadedAt: string }>; hasMore?: boolean };
              const blobs = parsed.blobs || [];
              out.push(`Blobs (${blobs.length}${parsed.hasMore ? '+' : ''}):`);
              for (const b of blobs) {
                out.push(`- ${b.pathname} (${(b.size / 1024).toFixed(1)} KB, ${b.uploadedAt?.slice(0, 16) || ''}) · ${b.url}`);
              }
            } catch {
              out.push(text.slice(0, 500));
            }
          }
        } else {
          out.push('Note: Add BLOB_READ_WRITE_TOKEN in Settings → Vault to list/inspect files inside a Blob store.');
        }
        return out.join('\n') || 'No blob stores or files found.';
      }

      if (action === 'blob_diagnose') {
        const sections: string[] = [];
        const root = findWorkspaceRoot(ctx);
        const localNotes = inspectLocalTurboAndBlob(root);
        if (localNotes.length) {
          sections.push(`=== Local Workspace (${root}) ===`, ...localNotes);
        }
        if (auth.token && project) {
          sections.push('', `=== Vercel Project (${project}) ===`);
          const envRes = await vercelFetch<{ envs?: Array<{ key: string; target?: string[] }> }>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}/env`);
          if (envRes.ok) {
            const blobEnvs = (envRes.data.envs || []).filter((e) => e.key.includes('BLOB'));
            if (!blobEnvs.length) {
              sections.push('⚠ CRITICAL: `BLOB_READ_WRITE_TOKEN` is NOT set on this Vercel project!');
            } else {
              for (const b of blobEnvs) {
                const targets = b.target || [];
                const missing = ['production', 'preview', 'development'].filter((t) => !targets.includes(t));
                sections.push(`✓ ${b.key}: targets=[${targets.join(', ')}]${missing.length ? ` (⚠ missing: ${missing.join(', ')})` : ''}`);
              }
            }
          } else {
            sections.push(formatApiError(envRes.status, envRes.data, envRes.raw));
          }
          // Check latest deployment for blob/413/env errors
          const prj = await vercelFetch<{ id?: string; rootDirectory?: string; buildCommand?: string }>(ctx, auth, `/v9/projects/${encodeURIComponent(project)}`);
          if (prj.ok) {
            sections.push(`Project config: rootDirectory=${prj.data.rootDirectory || '(root)'}, buildCommand=${prj.data.buildCommand || '(default)'}`);
            if (prj.data.id) {
              const deps = await vercelFetch<{ deployments?: Array<{ uid: string; state?: string; url?: string }> }>(ctx, auth, `/v6/deployments?projectId=${encodeURIComponent(prj.data.id)}&limit=3`);
              const latest = deps.data.deployments?.[0];
              if (latest) {
                sections.push(`Latest deployment: ${latest.uid} (${latest.state}) · https://${latest.url || ''}`);
              }
            }
          }
        } else if (!auth.token) {
          sections.push('', 'Tip: Add VERCEL_TOKEN in Settings → Vault so I can also check your live Vercel env vars, Blob store links, and deployment/runtime logs.');
        }
        sections.push(
          '',
          '=== Common Vercel Blob + Turbo Failure Checklist ===',
          '1. Turbo 2.x Strict Env Mode strips BLOB_READ_WRITE_TOKEN unless listed in turbo.json (`globalEnv` or `tasks.build.env`).',
          '2. Serverless Function request body limit is 4.5 MB — uploads >4.5 MB must use `@vercel/blob/client` (`upload()` + `handleUpload()`), NOT direct server `put()`.',
          '3. Next.js `<Image>` requires `images.remotePatterns` for `*.public.blob.vercel-storage.com`.',
          '4. `@vercel/blob` `put()` requires `access: "public"` (or private store support on newer SDK).',
          '5. Preview deployments fail if BLOB_READ_WRITE_TOKEN is only attached to Production.',
        );
        return sections.join('\n');
      }

      return `Unknown vercel action: ${action}`;
    },
  };
}

export function turboInspectTool(): Tool {
  return {
    name: 'turbo_inspect',
    description:
      'Inspect a Turborepo monorepo workspace (`turbo.json`, `package.json`, `pnpm-workspace.yaml`, `apps/*`, `packages/*`, `vercel.json`, `next.config.*`) '
      + 'to diagnose build/caching/env-stripping issues (like Turbo 2.x strict env mode stripping BLOB_READ_WRITE_TOKEN).',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Optional workspace name/path if multiple repos are attached.' },
      },
    },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const root = findWorkspaceRoot(ctx, args.workspace ? String(args.workspace) : undefined);
      const notes = inspectLocalTurboAndBlob(root);
      const workspaceDirs: string[] = [];
      for (const dir of ['apps', 'packages']) {
        const full = path.join(root, dir);
        if (!fs.existsSync(full)) continue;
        try {
          for (const entry of fs.readdirSync(full)) {
            const p = path.join(full, entry, 'package.json');
            if (fs.existsSync(p)) {
              const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; scripts?: Record<string, string> };
              workspaceDirs.push(`- ${dir}/${entry} (${pkg.name || entry}): scripts=[${Object.keys(pkg.scripts || {}).join(', ')}]`);
            }
          }
        } catch { /* ignore */ }
      }
      const lines = [
        `Workspace root: ${root}`,
        ...notes,
        ...(workspaceDirs.length ? ['', 'Monorepo packages:', ...workspaceDirs] : []),
        '',
        'Tip: Use `shell` to run `npx turbo run build --dry=json` or `npx turbo run build --filter=<pkg>` to verify task graph & env hashes.',
      ];
      return lines.join('\n');
    },
  };
}

export function vercelTools(): Tool[] {
  return [vercelTool(), turboInspectTool()];
}
