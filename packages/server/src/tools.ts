import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assessCommand, isBlockedUrl, resolveInside } from '@local-agent/shared';
import { formatCitations, searchKnowledge } from './kb.js';
import { loadSkill } from './skills.js';
import { locatePath, projectPath } from './workshops.js';
import type { Agent } from './db.js';
import type { DockerCtl } from './docker.js';
import type { Store } from './db.js';
import type { Settings } from './settings.js';

export interface ToolContext {
  agent: Agent;
  workspace: string;
  signal: AbortSignal;
  docker: DockerCtl;
  fetchImpl: typeof fetch;
  searxngUrl: string;
  sandbox: Settings['sandbox'];
  store: Store;
  depth: number;
  sessionId?: string;
  runId?: string;
  codeApproval?: Settings['codeApproval'];
  secretEnv?: () => Record<string, string>;
  consult?: (name: string, question: string) => Promise<string>;
  libraryDir?: string;
  roots?: { label: string; path: string; write?: boolean }[];
  gitIdentity?: { name?: string; email?: string; sshKey?: string };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutates: (args: Record<string, unknown>) => boolean;
  approval: (args: Record<string, unknown>, ctx?: ToolContext) => string | null;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export interface SearchHit {
  title: string;
  url: string;
  content: string;
}

/** SearXNG JSON search used by the web_search tool. No cloud search API. */
export async function searxngSearch(base: string, query: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<SearchHit[]> {
  const root = base.replace(/\/$/, '');
  if (!root) throw new Error('SearXNG is not configured. Start it from Setup.');
  const response = await fetchImpl(`${root}/search?q=${encodeURIComponent(query)}&format=json`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`SearXNG returned ${response.status}.`);
  const json = await response.json() as { results?: { title?: string; url?: string; content?: string }[] };
  return (json.results ?? []).slice(0, 6).map((result) => ({
    title: result.title ?? '',
    url: result.url ?? '',
    content: result.content ?? '',
  }));
}

/** Public page fetch used by the web_fetch tool. */
export async function fetchPublicText(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const blocked = isBlockedUrl(url);
  if (blocked) throw new Error(blocked);
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'local-agent/0.1' },
  });
  if (!response.ok) throw new Error(`Fetch returned ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes.slice(0, 500_000))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 12_000) || '(empty page)';
}

export const BUILTIN_TOOLS: Tool[] = [
  {
    name: 'list_dir',
    description: 'List files in the workspace, or in a workshop project when you pass its label (server, apk) or a path under it.',
    parameters: obj({ path: { type: 'string', description: 'Project label, or a directory under it. Defaults to the only project, or lists every project.' } }),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const target = String(args.path || '');
      if ((!target || target === '.') && (ctx.roots?.length ?? 0) > 1) {
        return ctx.roots!.map((root) => `project ${root.label} ${root.path}`).join('\n');
      }
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: target || '.' });
      if (!hit) throw new Error('That folder is not in this workshop.');
      const entries = await fs.readdir(hit.full, { withFileTypes: true });
      return entries.slice(0, 200).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n') || '(empty)';
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file in the workspace or a workshop project. Prefix the path with the project label, such as server/src/index.ts.',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: String(args.path || '') });
      if (!hit) throw new Error('That file is not in this workshop.');
      const stat = await fs.stat(hit.full);
      if (stat.size > 200_000) throw new Error('File is larger than 200 KB.');
      return fs.readFile(hit.full, 'utf8');
    },
  },
  {
    name: 'write_file',
    description: 'Write a text file inside the agent workspace. This changes disk and needs approval.',
    parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    mutates: () => true,
    approval: (args) => `Write ${args.path}`,
    async execute(args, ctx) {
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: String(args.path || '') });
      if (!hit?.write) throw new Error('That file is not in a writable project.');
      await fs.mkdir(path.dirname(hit.full), { recursive: true });
      await fs.writeFile(hit.full, String(args.content ?? ''), 'utf8');
      return `Wrote ${hit.label ? `${hit.label}/` : ''}${path.relative(hit.root, hit.full)} (${String(args.content ?? '').length} bytes).`;
    },
  },
  {
    name: 'shell',
    description: 'Run a shell command. Docker sandbox when Docker is available, otherwise a workspace-jailed host process. Destructive commands need approval.',
    parameters: obj({ command: { type: 'string' }, cwd: { type: 'string', description: 'Workshop project label, when this chat has more than one.' } }, ['command']),
    mutates: (args) => assessCommand(String(args.command || '')) !== 'ok',
    approval: (args) => {
      const command = String(args.command || '');
      const assessment = assessCommand(command);
      if (assessment === 'blocked') return null;
      if (assessment === 'mutating') return `Shell command looks destructive: ${command.slice(0, 180)}`;
      return null;
    },
    async execute(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('Missing command.');
      if (command.length > 4000) throw new Error('Command is too long.');
      if (assessCommand(command) === 'blocked') throw new Error('That command is blocked.');
      const cwd = (ctx.roots?.length ?? 0) > 0 ? projectPath(ctx.roots!, args.cwd ? String(args.cwd) : undefined, ctx.workspace) : ctx.workspace;
      if (ctx.sandbox !== 'host' && ctx.docker.available()) {
        const result = await ctx.docker.runCollect({
          Image: 'alpine:3.20',
          Cmd: ['sh', '-lc', command],
          WorkingDir: '/work',
          Labels: { 'local-agent.role': 'shell', 'local-agent.agent': ctx.agent.id },
          HostConfig: {
            AutoRemove: false,
            Memory: 512 * 1024 * 1024,
            NanoCpus: 1_000_000_000,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            NetworkMode: 'none',
            Binds: [`${cwd}:/work`],
            PidsLimit: 64,
          },
        });
        return `exit ${result.code}\n${result.output}`;
      }
      if (ctx.sandbox === 'docker-only') throw new Error('Docker sandbox is required and the Docker socket is not available.');
      return hostJail(command, ctx, cwd);
    },
  },
  {
    name: 'web_search',
    description: 'Search the web through SearXNG.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const results = await searxngSearch(ctx.searxngUrl, String(args.query || ''), ctx.fetchImpl, ctx.signal);
      if (!results.length) return 'No results.';
      return results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.content}`).join('\n\n');
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public http(s) URL and return visible text.',
    parameters: obj({ url: { type: 'string' } }, ['url']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      return fetchPublicText(String(args.url || ''), ctx.fetchImpl, ctx.signal);
    },
  },
  {
    name: 'remember',
    description: 'Save a long-term memory note for this agent.',
    parameters: obj({ content: { type: 'string' }, pinned: { type: 'boolean' } }, ['content']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const note = ctx.store.createNote(ctx.agent.id, String(args.content || '').slice(0, 2000), Boolean(args.pinned));
      return `Remembered ${note.id}${note.pinned ? ' (pinned)' : ''}.`;
    },
  },
  {
    name: 'recall',
    description: 'List this agent\'s memory notes.',
    parameters: obj({}),
    mutates: () => false,
    approval: () => null,
    async execute(_args, ctx) {
      const notes = ctx.store.listNotes(ctx.agent.id);
      if (!notes.length) return 'No notes yet.';
      return notes.map((note) => `${note.pinned ? '[pinned] ' : ''}${note.content}`).join('\n');
    },
  },
  {
    name: 'docker_ps',
    description: 'List Docker containers.',
    parameters: obj({}),
    mutates: () => false,
    approval: () => null,
    async execute(_args, ctx) {
      if (!ctx.docker.available()) return 'Docker socket is not available.';
      const rows = await ctx.docker.list();
      return rows.map((row) => `${row.state}\t${row.name}\t${row.image}`).join('\n') || 'No containers.';
    },
  },
  {
    name: 'docker_inspect',
    description: 'Inspect one container.',
    parameters: obj({ id: { type: 'string' } }, ['id']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const info = await ctx.docker.inspect(String(args.id));
      return JSON.stringify(info, null, 2).slice(0, 12_000);
    },
  },
  {
    name: 'docker_run',
    description: 'Create a container. Requires approval. Image names are restricted.',
    parameters: obj({ image: { type: 'string' }, cmd: { type: 'array', items: { type: 'string' } } }, ['image']),
    mutates: () => true,
    approval: (args) => `Create a container from ${args.image}`,
    async execute(args, ctx) {
      const image = String(args.image || '');
      if (!/^[a-z0-9._/:@-]{1,160}$/i.test(image)) throw new Error('Refusing that image name.');
      const cmd = Array.isArray(args.cmd) ? args.cmd.map(String).slice(0, 20) : undefined;
      const result = await ctx.docker.runCollect({
        Image: image,
        Cmd: cmd,
        Labels: { 'local-agent.role': 'agent-run', 'local-agent.agent': ctx.agent.id },
        HostConfig: { Memory: 512 * 1024 * 1024, CapDrop: ['ALL'], NetworkMode: 'none', PidsLimit: 64 },
      });
      return `exit ${result.code}\n${result.output}`;
    },
  },
  {
    name: 'docker_rm',
    description: 'Remove a container. Requires approval.',
    parameters: obj({ id: { type: 'string' } }, ['id']),
    mutates: () => true,
    approval: (args) => `Remove container ${args.id}`,
    async execute(args, ctx) {
      await ctx.docker.remove(String(args.id));
      return `Removed ${args.id}.`;
    },
  },
  {
    name: 'consult_agent',
    description: 'Ask another persona in this room a question. One level deep.',
    parameters: obj({ agent: { type: 'string' }, question: { type: 'string' } }, ['agent', 'question']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      if (!ctx.consult || ctx.depth >= 1) throw new Error('Nested consultations are stopped at one level.');
      return ctx.consult(String(args.agent || ''), String(args.question || ''));
    },
  },
];

export function kbSearchTool(): Tool {
  return {
    name: 'kb_search',
    description: 'Search the knowledge base. Cite the numbered sources in the answer.',
    parameters: obj({ query: { type: 'string' }, collectionId: { type: 'string' } }, ['query']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const hits = await searchKnowledge(ctx.store, String(args.query || ''), {
        agentId: ctx.agent.id,
        collectionId: args.collectionId ? String(args.collectionId) : null,
        embed: undefined,
      });
      return formatCitations(hits);
    },
  };
}

export function loadSkillTool(): Tool {
  return {
    name: 'load_skill',
    description: 'Load a shared skill by slug when its when-to-use description fits the task. Returns the instructions and any scripts.',
    parameters: obj({ slug: { type: 'string' } }, ['slug']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      return loadSkill(ctx.store, ctx.libraryDir || '', ctx.agent.id, String(args.slug || ''));
    },
  };
}

export function toolsFor(allow: string[]): Tool[] {
  const wanted = new Set(allow);
  return BUILTIN_TOOLS.filter((tool) => wanted.has(tool.name));
}

async function realInside(root: string, relative: string) {
  const target = resolveInside(root, relative);
  if (!target) throw new Error('Path escapes the workspace.');
  try {
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(target);
    if (resolveInside(realRoot, path.relative(realRoot, real)) == null && real !== realRoot) throw new Error('Path escapes the workspace.');
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    const realRoot = await fs.realpath(root);
    const realParent = await fs.realpath(parent);
    if (!realParent.startsWith(realRoot)) throw new Error('Path escapes the workspace.');
    return target;
  }
}

function hostJail(command: string, ctx: ToolContext, cwd = ctx.workspace): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: ctx.workspace, LANG: 'C.UTF-8', ...(ctx.secretEnv?.() ?? {}) },
      timeout: 20_000,
    });
    let output = '';
    const take = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 64_000) output = output.slice(0, 64_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve(`exit ${code ?? 1}\n${output}`));
    ctx.signal.addEventListener('abort', () => child.kill('SIGKILL'));
  });
}

export async function listWorkspace(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return Promise.all(entries.slice(0, 200).map(async (entry) => {
    const full = path.join(root, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    return { name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file', bytes: stat?.size ?? 0 };
  }));
}

export async function readWorkspaceFile(root: string, relative: string) {
  const file = await realInside(root, relative);
  const stat = await fs.stat(file);
  if (stat.size > 200_000) throw new Error('File is too large to preview.');
  return fs.readFile(file, 'utf8');
}
