import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assessCommand, isBlockedUrl, resolveInside } from '@local-agent/shared';
import { formatCitations, searchKnowledge } from './kb.js';
import { loadSkill } from './skills.js';
import { lineDiff } from './coding.js';
import { nid, now } from './util.js';
import { locatePath, projectPath } from './workshops.js';
import type { Agent } from './db.js';
import type { DockerCtl } from './docker.js';
import { workbenchEnabled } from './workbench.js';
import type { Store } from './db.js';
import type { Settings } from './settings.js';

export interface ToolContext {
  agent: Agent;
  workspace: string;
  signal: AbortSignal;
  docker: DockerCtl;
  /** Shared long-lived shell container (LA_SHELL=workbench, the default). */
  workbench?: import('./workbench.js').Workbench | null;
  browser?: import('./browser.js').ManagedBrowser | null;
  computer?: import('./live-computer.js').ComputerControl | null;
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
  sendPersonaMessage?: (to: string, text: string, files?: string[]) => Promise<string>;
  handoffToPersona?: (to: string, task: string, files?: string[]) => Promise<string>;
  libraryDir?: string;
  roots?: { label: string; path: string; write?: boolean }[];
  gitIdentity?: { name?: string; email?: string; sshKey?: string; token?: string | null };
  toolCallId?: string;
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

export interface SearchResult {
  hits: SearchHit[];
  /** Engines SearXNG could not reach, with the reason it gave. */
  unresponsive: string[];
  partial: boolean;
}

/** SearXNG JSON search with the details a person needs when it goes wrong. No cloud search API. */
export async function searxngQuery(base: string, query: string, fetchImpl: typeof fetch, signal?: AbortSignal, limit = 6): Promise<SearchResult> {
  const root = base.replace(/\/$/, '');
  if (!root) throw new Error('SearXNG is not configured. Start it from Setup, or set its URL in Settings.');
  const q = query.trim();
  if (!q) throw new Error('web_search needs a non-empty query.');
  let response: Response;
  try {
    response = await fetchImpl(`${root}/search?q=${encodeURIComponent(q)}&format=json`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = error instanceof Error && /timeout|aborted/i.test(`${error.name} ${error.message}`);
    throw new Error(timedOut ? `SearXNG at ${root} did not answer within 12 seconds.` : `SearXNG is not reachable at ${root}. Start it from Setup.`);
  }
  if (response.status === 403) throw new Error(`SearXNG at ${root} refused JSON (403). Turn on the json format in its settings.yml, or restart it from Setup.`);
  if (response.status === 429) throw new Error(`SearXNG at ${root} rate-limited the request (429). Turn its limiter off, or restart it from Setup.`);
  if (!response.ok) throw new Error(`SearXNG at ${root} returned ${response.status}.`);
  let json: { results?: { title?: string; url?: string; content?: string }[]; unresponsive_engines?: unknown[] };
  try {
    json = await response.json() as typeof json;
  } catch {
    throw new Error(`SearXNG at ${root} did not return JSON. Check that the json format is on.`);
  }
  const unresponsive = (json.unresponsive_engines ?? []).map((item) => Array.isArray(item) ? `${item[0]}${item[1] ? ` (${item[1]})` : ''}` : String(item));
  const hits = (json.results ?? []).slice(0, Math.max(1, limit)).map((result) => ({
    title: result.title ?? '',
    url: result.url ?? '',
    content: result.content ?? '',
  }));
  return { hits, unresponsive, partial: unresponsive.length > 0 };
}

/** Hits only. Used by reputation checks. */
export async function searxngSearch(base: string, query: string, fetchImpl: typeof fetch, signal?: AbortSignal, limit = 6): Promise<SearchHit[]> {
  return (await searxngQuery(base, query, fetchImpl, signal, limit)).hits;
}

/** A real JSON query, so health means web_search will work, not just that a URL is set. */
export async function searxngHealth(base: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  if (!base.trim()) return { ok: false, detail: 'SearXNG is not configured. Start it from Setup.' };
  try {
    const result = await searxngQuery(base, 'local-agent health check', fetchImpl, undefined, 3);
    if (!result.hits.length) {
      return { ok: false, detail: `SearXNG answered at ${base.replace(/\/$/, '')}, but returned no search results.${result.unresponsive.length ? ` ${result.unresponsive.length} engine${result.unresponsive.length === 1 ? '' : 's'} did not answer.` : ''}` };
    }
    const partial = result.partial ? ` ${result.unresponsive.length} engine${result.unresponsive.length === 1 ? '' : 's'} did not answer.` : '';
    return { ok: true, detail: `SearXNG answered JSON at ${base.replace(/\/$/, '')} with ${result.hits.length} result${result.hits.length === 1 ? '' : 's'}.${partial}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'SearXNG failed.' };
  }
}

/** What web_search hands the model. */
export function formatSearch(query: string, result: SearchResult): string {
  const note = result.partial ? `Partial results: ${result.unresponsive.length} engine${result.unresponsive.length === 1 ? '' : 's'} did not answer: ${result.unresponsive.join(', ')}.` : '';
  if (!result.hits.length) {
    return [`No results for "${query.trim()}".`, note, 'Try fewer or different words.'].filter(Boolean).join(' ');
  }
  const body = result.hits.map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}\n${hit.content}`).join('\n\n');
  return note ? `${note}\n\n${body}` : body;
}

/** Public page fetch used by the web_fetch tool. Strips comments, styles, nav/footer chrome, and (by default) scripts. */
export async function fetchPublicText(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  opts: { includeScripts?: boolean } = {},
): Promise<string> {
  const blocked = isBlockedUrl(url);
  if (blocked) throw new Error(blocked);
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'local-agent/0.1' },
  });
  if (!response.ok) throw new Error(`Fetch returned ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let raw = new TextDecoder().decode(bytes.slice(0, 500_000))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  if (!opts.includeScripts) {
    raw = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  }
  const text = raw
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/blockquote|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;/gi, "'")
    .replace(/[ \t\f\v\r]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '(empty page)';
  if (text.length > 48_000) return `${text.slice(0, 48_000)}\n…[truncated at 48,000 of ${text.length} characters]`;
  return text;
}

export const BUILTIN_TOOLS: Tool[] = [
  {
    name: 'create_file',
    description: 'Create or replace a text file in the agent workspace. Alias for write_file, for clients that use create-file names.',
    parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    mutates: () => true,
    approval: (args) => `Write ${args.path}`,
    async execute(args, ctx) {
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: String(args.path || '') });
      if (!hit?.write) throw new Error('That file is not in a writable project.');
      if (ctx.sessionId) {
        let before: string | null = null;
        try { before = await fs.readFile(hit.full, 'utf8'); } catch { before = null; }
        const rel = path.relative(ctx.workspace, hit.full);
        ctx.store.db.prepare('INSERT INTO edit_batches (id, session_id, run_id, label, files, diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          nid('edit'), ctx.sessionId, ctx.runId ?? null, String(args.path), JSON.stringify([{ path: hit.full, before, after: String(args.content ?? '') }]), lineDiff(rel, before ?? '', String(args.content ?? '')), now(),
        );
      }
      await fs.mkdir(path.dirname(hit.full), { recursive: true });
      await fs.writeFile(hit.full, String(args.content ?? ''), 'utf8');
      return `Created ${hit.label ? `${hit.label}/` : ''}${path.relative(hit.root, hit.full)} (${String(args.content ?? '').length} bytes).`;
    },
  },
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
    description: 'Read a text file in the workspace or a workshop project. Prefix the path with the project label, such as server/src/index.ts. Pass startLine and endLine (1-based) to read slices of large files.',
    parameters: obj({
      path: { type: 'string' },
      startLine: { type: 'number', description: 'Optional 1-based starting line.' },
      endLine: { type: 'number', description: 'Optional 1-based ending line (inclusive).' },
    }, ['path']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: String(args.path || '') });
      if (!hit) throw new Error('That file is not in this workshop.');
      const stat = await fs.stat(hit.full);
      if (stat.size > 1_000_000) throw new Error('File is larger than 1 MB.');
      const raw = await fs.readFile(hit.full, 'utf8');
      const lines = raw.split('\n');
      const hasRange = args.startLine != null || args.endLine != null;
      if (hasRange) {
        const start = Math.max(1, Math.floor(Number(args.startLine || 1)));
        const end = Math.min(lines.length, Math.max(start, Math.floor(Number(args.endLine || start + 399))));
        const body = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
        return `Lines ${start}-${end} of ${lines.length}:\n${body}`;
      }
      if (lines.length > 400 || stat.size > 200_000) {
        const cap = Math.min(400, lines.length);
        const body = lines.slice(0, cap).map((line, i) => `${i + 1}: ${line}`).join('\n');
        return `Lines 1-${cap} of ${lines.length} (truncated — pass startLine/endLine to read more):\n${body}`;
      }
      return raw;
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
      // Pre-edit checkpoint, so the reply's changes can be rolled back in one click.
      if (ctx.sessionId) {
        let before: string | null = null;
        try { before = await fs.readFile(hit.full, 'utf8'); } catch { before = null; }
        const rel = path.relative(ctx.workspace, hit.full);
        ctx.store.db.prepare('INSERT INTO edit_batches (id, session_id, run_id, label, files, diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          nid('edit'), ctx.sessionId, ctx.runId ?? null, String(args.path), JSON.stringify([{ path: hit.full, before, after: String(args.content ?? '') }]), lineDiff(rel, before ?? '', String(args.content ?? '')), now(),
        );
      }
      await fs.mkdir(path.dirname(hit.full), { recursive: true });
      await fs.writeFile(hit.full, String(args.content ?? ''), 'utf8');
      return `Wrote ${hit.label ? `${hit.label}/` : ''}${path.relative(hit.root, hit.full)} (${String(args.content ?? '').length} bytes).`;
    },
  },
  {
    name: 'shell',
    description: 'Run a shell command. Runs in the shared workbench computer (Debian, node 22, python3, git; network on; installs and caches persist; Python projects get a .venv automatically) when Docker is available, otherwise a workspace-jailed host process. Destructive commands need approval.',
    parameters: obj({ command: { type: 'string' }, cwd: { type: 'string', description: 'Workshop project label, when this chat has more than one.' } }, ['command']),
    mutates: (args) => assessCommand(String(args.command || '')) !== 'ok',
    approval: (args) => {
      const command = String(args.command || '');
      const assessment = assessCommand(command);
      if (assessment === 'blocked') return null;
      if (/\bapt(-get)?\s+install\b/i.test(command)) return `Installs system packages in the shared workbench (affects all personas): ${command.slice(0, 180)}`;
      if (assessment === 'mutating') return `Shell command looks destructive: ${command.slice(0, 180)}`;
      return null;
    },
    async execute(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('Missing command.');
      if (command.length > 4000) throw new Error('Command is too long.');
      if (assessCommand(command) === 'blocked') throw new Error('That command is blocked.');
      const cwd = (ctx.roots?.length ?? 0) > 0 ? projectPath(ctx.roots!, args.cwd ? String(args.cwd) : undefined, ctx.workspace, command) : ctx.workspace;
      if (!(await fs.access(cwd).then(() => true).catch(() => false))) {
        throw new Error(`Directory ${cwd} does not exist. Use your sandbox workspace (${ctx.workspace}) or create/clone a project under /data/workspaces/projects.`);
      }
      if (ctx.sandbox !== 'host' && ctx.docker.available() && ctx.workbench && workbenchEnabled()) {
        try {
          const result = await ctx.workbench.run(command, cwd, shellTimeoutMs());
          if (result) {
            ctx.computer?.recordShell({ runId: ctx.runId ?? null, persona: ctx.agent.name, command, output: result.output, code: result.code });
            return `exit ${result.code}\n${clipToolOutput(result.output)}`;
          }
        } catch (error) {
          ctx.store.addLog('warn', `Workbench unavailable, using a throwaway container: ${(error as Error).message}`, undefined, 'workbench');
        }
      }
      if (ctx.sandbox !== 'host' && ctx.docker.available()) {
        const hostCwd = toHostBindPath(cwd);
        const image = await pickShellImage(cwd, ctx.docker);
        const shellBin = image.startsWith('alpine') ? 'sh' : 'bash';
        const result = await ctx.docker.runCollect({
          Image: image,
          Cmd: [shellBin, '-lc', command],
          WorkingDir: '/work',
          Labels: { 'local-agent.role': 'shell', 'local-agent.agent': ctx.agent.id },
          HostConfig: {
            AutoRemove: false,
            Memory: 2 * 1024 * 1024 * 1024,
            NanoCpus: 4_000_000_000,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            NetworkMode: 'none',
            Binds: [`${hostCwd}:/work`],
            PidsLimit: 256,
          },
        }, shellTimeoutMs());
        ctx.computer?.recordShell({ runId: ctx.runId ?? null, persona: ctx.agent.name, command, output: result.output, code: result.code });
        return `exit ${result.code}\n${clipToolOutput(result.output)}`;
      }
      if (ctx.sandbox === 'docker-only') throw new Error('Docker sandbox is required and the Docker socket is not available.');
      return clipToolOutput(await hostJail(command, ctx, cwd));
    },
  },
  {
    name: 'web_search',
    description: 'Search the web through SearXNG.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const query = String(args.query ?? '');
      const result = await searxngQuery(ctx.searxngUrl, query, ctx.fetchImpl, ctx.signal, ctx.store?.getSettings().searchHits ?? 6);
      return formatSearch(query, result);
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public http(s) URL and return clean visible text (strips scripts, styles, comments, and nav/footer boilerplate by default). Set include_scripts=true only if you specifically need inline scripts. For JS-rendered stores/pages that return no prices or content, use browse instead.',
    parameters: obj({
      url: { type: 'string' },
      include_scripts: { type: 'boolean', description: 'Include inline <script> contents (default false).' },
    }, ['url']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      return fetchPublicText(String(args.url || ''), ctx.fetchImpl, ctx.signal, { includeScripts: Boolean(args.include_scripts) });
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
  {
    name: 'send_message',
    description: 'Send a note to another persona (by name) in their own chat and optionally start their run. Pass file IDs in files (never copy file contents).',
    parameters: obj({
      to: { type: 'string', description: 'Target persona name or slug.' },
      text: { type: 'string', description: 'Message text to deliver.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional file IDs to reference.' },
    }, ['to', 'text']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      if (!ctx.sendPersonaMessage) throw new Error('Persona messaging is not available in this run.');
      const files = Array.isArray(args.files) ? args.files.map(String) : undefined;
      return ctx.sendPersonaMessage(String(args.to || ''), String(args.text || ''), files);
    },
  },
  {
    name: 'handoff',
    description: 'Hand off a task to another persona (by name). Starts a run on the target persona and returns their result when done (or posts it back to your chat). Pass file IDs in files.',
    parameters: obj({
      to: { type: 'string', description: 'Target persona name or slug.' },
      task: { type: 'string', description: 'Clear task description for the target persona.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional file IDs to reference.' },
    }, ['to', 'task']),
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      if (!ctx.handoffToPersona) throw new Error('Persona handoff is not available in this run.');
      const files = Array.isArray(args.files) ? args.files.map(String) : undefined;
      return ctx.handoffToPersona(String(args.to || ''), String(args.task || ''), files);
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

/** Map container paths (/data, /projects) to host paths when launching sibling Docker containers. */
export function toHostBindPath(containerPath: string): string {
  const resolved = path.resolve(containerPath);
  const dataDir = path.resolve(process.env.DATA_DIR || '/data');
  const hostData = process.env.LA_HOST_DATA_DIR?.trim();
  if (hostData && (resolved === dataDir || resolved.startsWith(`${dataDir}${path.sep}`))) {
    return path.join(hostData, path.relative(dataDir, resolved));
  }
  const projDir = path.resolve(process.env.LA_PROJECTS_DIR || '/projects');
  const hostProj = process.env.LA_HOST_PROJECTS_DIR?.trim();
  if (hostProj && (resolved === projDir || resolved.startsWith(`${projDir}${path.sep}`))) {
    return path.join(hostProj, path.relative(projDir, resolved));
  }
  return resolved;
}

/** Pick a locally cached dev image matching the project so shell commands have node/python/git. */
async function pickShellImage(cwd: string, docker: DockerCtl): Promise<string> {
  const has = async (file: string) => fs.access(path.join(cwd, file)).then(() => true).catch(() => false);
  const candidates: string[] = [];
  if (await has('package.json')) candidates.push('node:22-bookworm-slim', 'node:22-alpine');
  if (await has('pyproject.toml') || await has('requirements.txt')) candidates.push('python:3.11-slim');
  candidates.push('alpine:3.20');
  for (const image of candidates) {
    if (await docker.hasImage(image).catch(() => false)) return image;
  }
  return 'alpine:3.20';
}

/** Keep shell outputs from flooding the context window: preserve head + tail when output is huge. */
export function clipToolOutput(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.45);
  const tail = Math.floor(maxChars * 0.45);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n... [${omitted.toLocaleString('en-US')} characters omitted to protect context] ...\n\n${text.slice(-tail)}`;
}

/** Shell commands (tests, builds, installs) often need minutes; 30s killed them. LA_SHELL_TIMEOUT_MS to change. */
export function shellTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.LA_SHELL_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 5_000 ? Math.min(value, 60 * 60_000) : 5 * 60_000;
}
