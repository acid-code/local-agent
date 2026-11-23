import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isBlockedUrl } from '@local-agent/shared';
import { OWNER_ID } from './accounts.js';
import { isPasswordAction, isPaymentAction, realBrowserEnabled, redactVaultValues, type BrowserAction } from './browser.js';
import type { Store } from './db.js';
import { saveFile } from './files.js';
import type { Tool, ToolContext } from './tools.js';
import { fetchPublicText } from './tools.js';
import { locatePath } from './workshops.js';

/**
 * Connectors that ship with the app and work offline with no account or secret. They implement the same tool contracts as the
 * reference MCP servers (filesystem, fetch, git, memory, time, sequential-thinking, SQLite, a browser, SearXNG search, Docker),
 * but run in-process, scoped to the chat's workspaces, so there is nothing to download or start. Docker is owner-only.
 * Account-based services (GitHub, Gmail, Calendar…) are "recommended": one click starts the vetted, containerized MCP install.
 */
export type ConnectorStatus = 'healthy' | 'degraded' | 'off';
export interface BuiltinConnector {
  id: string; name: string; description: string; tools: string[]; ownerOnly?: boolean; mcpEquivalent: string;
  health: (env: HealthEnv) => Promise<{ status: Exclude<ConnectorStatus, 'off'>; detail: string }>;
}
export interface HealthEnv { store: Store; dataDir: string; searxngUrl: string; fetchImpl: typeof fetch; dockerAvailable: () => boolean }

const which = (bin: string) => { try { return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim() || null; } catch { return null; } };

export function chromePath(): string | null {
  const configured = process.env.CHROME_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) if (fs.existsSync(candidate)) return candidate;
  return null;
}

export const BUILTIN_CONNECTORS: BuiltinConnector[] = [
  { id: 'filesystem', name: 'Filesystem', mcpEquivalent: '@modelcontextprotocol/server-filesystem', description: 'Read, list and search files in the chat\'s workspaces only. Writes still ask first.', tools: ['list_dir', 'read_file', 'glob', 'grep'],
    async health(env) { try { fs.accessSync(env.dataDir, fs.constants.W_OK); return { status: 'healthy', detail: 'Scoped to attached workspaces.' }; } catch { return { status: 'degraded', detail: 'Data folder is not writable.' }; } } },
  { id: 'fetch', name: 'Fetch', mcpEquivalent: '@modelcontextprotocol/server-fetch', description: 'Fetch public web pages as text. Private and local addresses are blocked.', tools: ['web_fetch'],
    async health() { return { status: 'healthy', detail: 'Public http(s) only.' }; } },
  { id: 'git', name: 'Git', mcpEquivalent: 'mcp-server-git', description: 'Status, diff, log, branches and commits in workspace repos. Pushes and main need approval.', tools: ['git'],
    async health() { const bin = which('git'); return bin ? { status: 'healthy', detail: bin } : { status: 'degraded', detail: 'git is not installed.' }; } },
  { id: 'memory', name: 'Memory', mcpEquivalent: '@modelcontextprotocol/server-memory', description: 'Long-term notes and capped USER/NOTES memory files per persona.', tools: ['remember', 'recall', 'memory_file'],
    async health(env) { try { env.store.db.prepare('SELECT 1').get(); return { status: 'healthy', detail: 'Stored in the local database.' }; } catch { return { status: 'degraded', detail: 'Database unavailable.' }; } } },
  { id: 'time', name: 'Time', mcpEquivalent: 'mcp-server-time', description: 'Current time and time-zone conversion.', tools: ['time_now'],
    async health() { return { status: 'healthy', detail: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }; } },
  { id: 'search', name: 'Web search', mcpEquivalent: 'SearXNG', description: 'Private web search through the local SearXNG container.', tools: ['web_search'],
    async health(env) {
      const base = env.searxngUrl || 'http://127.0.0.1:8088';
      try { const res = await env.fetchImpl(`${base.replace(/\/$/, '')}/search?q=ping&format=json`, { signal: AbortSignal.timeout(4000) }); return res.ok ? { status: 'healthy', detail: base } : { status: 'degraded', detail: `SearXNG answered ${res.status}.` }; }
      catch { return { status: 'degraded', detail: env.dockerAvailable() ? 'SearXNG is starting or stopped (Setup → Web search).' : 'SearXNG needs Docker (Setup → Web search).' }; }
    } },
  { id: 'thinking', name: 'Sequential thinking', mcpEquivalent: '@modelcontextprotocol/server-sequential-thinking', description: 'Step-by-step reasoning scratchpad for hard problems: numbered thoughts, revisions, branches.', tools: ['think'],
    async health() { return { status: 'healthy', detail: 'In-process.' }; } },
  { id: 'browser', name: 'Browser', mcpEquivalent: '@playwright/mcp', description: 'Render JavaScript-heavy public pages in a headless browser with a throwaway profile. Public URLs only.', tools: ['browse'],
    async health() { const chrome = chromePath(); return { status: 'healthy', detail: chrome ? `Headless ${path.basename(chrome)}, throwaway profile.` : 'No Chrome found: plain fetch fallback.' }; } },
  { id: 'sqlite', name: 'SQLite', mcpEquivalent: 'mcp-server-sqlite', description: 'Read-only SQL queries on .db/.sqlite files in the chat\'s workspaces.', tools: ['sqlite_query'],
    async health() { try { new DatabaseSync(':memory:').prepare('SELECT 1').get(); return { status: 'healthy', detail: 'node:sqlite, read-only.' }; } catch { return { status: 'degraded', detail: 'node:sqlite unavailable.' }; } } },
  { id: 'docker', name: 'Docker', mcpEquivalent: 'docker-mcp', ownerOnly: true, description: 'List and inspect containers; run and remove need approval. Owner only.', tools: ['docker_ps', 'docker_inspect', 'docker_run', 'docker_rm'],
    async health(env) { return env.dockerAvailable() ? { status: 'healthy', detail: 'Docker answered.' } : { status: 'degraded', detail: 'Docker is not reachable.' }; } },
  { id: 'vercel', name: 'Vercel & Turborepo', mcpEquivalent: 'vercel-api', ownerOnly: true, description: 'Inspect Vercel projects, build & runtime logs, Blob storage, env vars, redeploys, and Turborepo workspaces. Add VERCEL_TOKEN in Vault.', tools: ['vercel', 'turbo_inspect'],
    async health(env) {
      const hasSecret = Boolean(process.env.VERCEL_TOKEN || env.store.db.prepare("SELECT 1 FROM secrets WHERE name = 'VERCEL_TOKEN' AND revoked_at IS NULL LIMIT 1").get());
      return hasSecret
        ? { status: 'healthy', detail: 'VERCEL_TOKEN configured (plus turbo_inspect).' }
        : { status: 'healthy', detail: 'turbo_inspect ready (add VERCEL_TOKEN in Vault for Vercel API & logs).' };
    } },
];

/**
 * Account-based connectors, pinned: a Docker catalog image by sha256 digest where one exists, otherwise an exact npm version that
 * "Download all recommended" installs into a local cache (mounted read-only into the container), so nothing changes under you.
 */
export interface RecommendedConnector {
  id: string; name: string; description: string; package: string; ecosystem: 'npm' | 'docker'; needs: string;
  image?: string; npm?: string; bin?: string; secrets: string[]; env?: Record<string, string>; trust: 'official' | 'docker' | 'community'; note?: string;
}
export const RECOMMENDED_CONNECTORS: RecommendedConnector[] = [
  { id: 'github', name: 'GitHub', description: 'Issues, pull requests and repos.', package: 'ghcr.io/github/github-mcp-server', ecosystem: 'docker', trust: 'official', needs: 'A GitHub token.',
    image: 'ghcr.io/github/github-mcp-server@sha256:f6056fc10bfffcc8c81a6417a2e9ca12808647e8dd6049642a4feaadee0e0f8a', secrets: ['GITHUB_PERSONAL_ACCESS_TOKEN'] },
  { id: 'gmail', name: 'Gmail', description: 'Read and send email over IMAP/SMTP with an app password.', package: 'yashtekwani/gmail-mcp', ecosystem: 'docker', trust: 'community', needs: 'Your address and a Google app password.',
    image: 'yashtekwani/gmail-mcp@sha256:9d806c6ba3752bd83a94782cc65d79929e05b3d4d805a01320d86004e39daf13', secrets: ['EMAIL_ADDRESS', 'EMAIL_PASSWORD'],
    env: { IMAP_HOST: 'imap.gmail.com', IMAP_PORT: '993', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587' } },
  { id: 'calendar', name: 'Google Calendar', description: 'Events and free/busy.', package: '@cocal/google-calendar-mcp', ecosystem: 'npm', trust: 'community', needs: 'A Google OAuth client file path.',
    npm: '@cocal/google-calendar-mcp@2.8.1', bin: 'node_modules/@cocal/google-calendar-mcp/build/index.js', secrets: ['GOOGLE_OAUTH_CREDENTIALS'], note: 'First sign-in opens a Google consent page.' },
  { id: 'slack', name: 'Slack', description: 'Channels and messages.', package: 'mcp/slack', ecosystem: 'docker', trust: 'docker', needs: 'A Slack bot token and team id.',
    image: 'mcp/slack@sha256:4cc10c3f4bd988bd2dce40e3068fe38fa3b3bad1da99f9653eb5fa5cce35baa1', secrets: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'], note: 'Docker marks this reference server archived.' },
  { id: 'notion', name: 'Notion', description: 'Pages and databases.', package: 'mcp/notion', ecosystem: 'docker', trust: 'docker', needs: 'A Notion integration token.',
    image: 'mcp/notion@sha256:df0d6781d03f37bd5b962c85ae1f288382f31b7108c489473641ffc372f43dc9', secrets: ['INTERNAL_INTEGRATION_TOKEN'],
    env: { OPENAPI_MCP_HEADERS: '{"Authorization": "Bearer $INTERNAL_INTEGRATION_TOKEN", "Notion-Version": "2022-06-28"}' } },
  { id: 'linear', name: 'Linear', description: 'Issues and projects.', package: 'linear-mcp-server', ecosystem: 'npm', trust: 'community', needs: 'A Linear API key.',
    npm: 'linear-mcp-server@0.1.0', bin: 'node_modules/linear-mcp-server/build/index.js', secrets: ['LINEAR_API_KEY'] },
];

/** The install spec for a recommended connector: its pinned image, or the cached npm package run with node. */
export function recommendedSpec(item: RecommendedConnector) {
  const env: Record<string, string> = { ...(item.env ?? {}) };
  for (const name of item.secrets) env[name] = `{{secret:${name}}}`;
  return item.image
    ? { name: item.name, transport: 'stdio' as const, args: [], env, source: `recommended:${item.id}`, image: item.image }
    : { name: item.name, transport: 'stdio' as const, command: 'npm-cache', args: [item.npm!, item.bin!], env, source: `recommended:${item.id}` };
}

// ── State ────────────────────────────────────────────────────────────────────

function ensure(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS connector_state (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
}
export function connectorEnabled(store: Store, id: string): boolean {
  ensure(store);
  const row = store.db.prepare('SELECT enabled FROM connector_state WHERE id = ?').get(id) as { enabled: number } | undefined;
  return row ? Boolean(row.enabled) : true;
}
export function setConnectorEnabled(store: Store, id: string, enabled: boolean) {
  ensure(store);
  store.db.prepare('INSERT INTO connector_state (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled').run(id, enabled ? 1 : 0);
}
/** One-time markers (e.g. "already tried to start SearXNG"). */
export function connectorStateFlag(store: Store, key: string, set?: boolean): boolean {
  ensure(store);
  if (set !== undefined) { store.db.prepare('INSERT INTO connector_state (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled').run(`flag:${key}`, set ? 1 : 0); return set; }
  return Boolean((store.db.prepare('SELECT enabled FROM connector_state WHERE id = ?').get(`flag:${key}`) as { enabled: number } | undefined)?.enabled);
}
/** Tools a switched-off connector would provide; the engine drops them for every persona. */
export function disabledConnectorTools(store: Store): Set<string> {
  const off = new Set<string>();
  for (const connector of BUILTIN_CONNECTORS) if (!connectorEnabled(store, connector.id)) for (const tool of connector.tools) off.add(tool);
  return off;
}
export function connectorTools(ids: string[], member: boolean): string[] {
  return [...new Set(ids.flatMap((id) => BUILTIN_CONNECTORS.find((row) => row.id === id && !(member && row.ownerOnly))?.tools ?? []))];
}
export function recommendedConnected(store: Store, id: string): boolean {
  const item = RECOMMENDED_CONNECTORS.find((row) => row.id === id);
  if (!item) return false;
  return store.listMcp().some((server) => server.enabled && (server.source === `recommended:${item.id}` || server.args.includes(item.package) || server.name === item.id || server.name.endsWith(`/${item.id}`)));
}

export async function connectorReport(env: HealthEnv, member: boolean) {
  const builtIn = await Promise.all(BUILTIN_CONNECTORS.filter((row) => !(member && row.ownerOnly)).map(async (row) => {
    const enabled = connectorEnabled(env.store, row.id);
    const health = enabled ? await row.health(env).catch(() => ({ status: 'degraded' as const, detail: 'Health check failed.' })) : { status: 'off' as const, detail: 'Switched off.' };
    return { id: row.id, name: row.name, description: row.description, tools: row.tools, ownerOnly: Boolean(row.ownerOnly), mcpEquivalent: row.mcpEquivalent, builtIn: true, enabled, ...health };
  }));
  const servers = env.store.listMcp();
  const recommended = RECOMMENDED_CONNECTORS.map((row) => ({ ...row, builtIn: false, connected: recommendedConnected(env.store, row.id), serverId: servers.find((server) => server.source === `recommended:${row.id}`)?.id ?? null, pinned: row.image ?? row.npm ?? row.package }));
  return { builtIn, recommended };
}

// ── New tools (the rest already exist as built-in tools) ─────────────────────

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function timeTool(): Tool {
  return {
    name: 'time_now', description: 'Current date and time, optionally in other IANA time zones (e.g. Asia/Jerusalem, America/New_York), or convert a given ISO time.',
    parameters: obj({ zones: { type: 'array', items: { type: 'string' } }, at: { type: 'string' } }), mutates: () => false, approval: () => null,
    async execute(args) {
      const at = args.at ? new Date(String(args.at)) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error('at must be an ISO date-time.');
      const zones = Array.isArray(args.zones) && args.zones.length ? (args.zones as string[]).slice(0, 8) : [Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'];
      const lines = zones.map((zone) => {
        try { return `${zone}: ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(at)}`; } catch { return `${zone}: unknown time zone`; }
      });
      return `UTC: ${at.toISOString()}\n${lines.join('\n')}`;
    },
  };
}

const thoughts = new Map<string, { n: number; text: string; revises?: number }[]>();
export function thinkTool(): Tool {
  return {
    name: 'think', description: 'Sequential thinking scratchpad: record numbered thoughts (thought, thought_number, total_thoughts, revises?), see the chain so far, and set done when ready to answer. Thoughts are private to this reply.',
    parameters: obj({ thought: { type: 'string' }, thought_number: { type: 'number' }, total_thoughts: { type: 'number' }, revises: { type: 'number' }, done: { type: 'boolean' } }, ['thought', 'thought_number', 'total_thoughts']),
    mutates: () => false, approval: () => null,
    async execute(args, ctx) {
      const key = ctx.runId || ctx.sessionId || 'none';
      const chain = thoughts.get(key) ?? [];
      chain.push({ n: Number(args.thought_number) || chain.length + 1, text: String(args.thought || '').slice(0, 2000), revises: args.revises ? Number(args.revises) : undefined });
      thoughts.set(key, chain.slice(-30));
      if (thoughts.size > 200) thoughts.delete(thoughts.keys().next().value!);
      const total = Number(args.total_thoughts) || chain.length;
      const capped = chain.length >= 2 && !args.done;
      const status = args.done
        ? ' — done; write the answer now.'
        : capped
          ? ' — scratchpad limit reached; stop calling think and either call a real tool or write your final answer now.'
          : '.';
      return `Thought ${args.thought_number}/${total} recorded${status}\nChain:\n${chain.map((row) => `${row.n}${row.revises ? ` (revises ${row.revises})` : ''}. ${row.text.slice(0, 200)}`).join('\n')}`;
    },
  };
}

const READ_SQL = /^\s*(select|with|pragma\s+(table_info|index_list|table_list)|explain)\b/i;
export function sqliteTool(): Tool {
  return {
    name: 'sqlite_query', description: 'Run a read-only SQL query (SELECT/WITH/PRAGMA table_info/EXPLAIN) on a .db or .sqlite file in the chat\'s workspaces. Use "tables" as the sql to list tables. Returns up to 200 rows.',
    parameters: obj({ path: { type: 'string' }, sql: { type: 'string' } }, ['path', 'sql']), mutates: () => false, approval: () => null,
    async execute(args, ctx: ToolContext) {
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: String(args.path || '') });
      if (!hit || !fs.existsSync(hit.full)) throw new Error('That database is not in an attached workspace.');
      if (!/\.(db|sqlite3?|db3)$/i.test(hit.full)) throw new Error('Only .db/.sqlite files.');
      let sql = String(args.sql || '').trim();
      if (sql.toLowerCase() === 'tables') sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name";
      if (!READ_SQL.test(sql) || /;\s*\S/.test(sql.replace(/;\s*$/, ''))) throw new Error('Read-only: one SELECT/WITH/PRAGMA table_info/EXPLAIN statement.');
      const db = new DatabaseSync(hit.full, { readOnly: true });
      try {
        const rows = db.prepare(sql).all().slice(0, 200) as Record<string, unknown>[];
        if (!rows.length) return 'No rows.';
        const cols = Object.keys(rows[0]!);
        return [cols.join('\t'), ...rows.map((row) => cols.map((col) => String(row[col] ?? '').slice(0, 200)).join('\t'))].join('\n').slice(0, 16_000);
      } finally { db.close(); }
    },
  };
}

interface BrowseAction {
  type: 'navigate' | 'reload' | 'back' | 'click' | 'fill' | 'select' | 'hover' | 'press' | 'scroll' | 'wait' | 'submit';
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  y?: number;
  ms?: number;
}

const browserProfiles = new Map<string, { profile: string; expiresAt: number }>();
const BROWSER_PROFILE_TTL = 30 * 60_000;

function browserProfile(sessionKey: string) {
  const now = Date.now();
  for (const [key, value] of browserProfiles) if (value.expiresAt <= now) { fs.rmSync(value.profile, { recursive: true, force: true }); browserProfiles.delete(key); }
  const existing = browserProfiles.get(sessionKey);
  if (existing) { existing.expiresAt = now + BROWSER_PROFILE_TTL; return existing.profile; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'la-cdp-'));
  browserProfiles.set(sessionKey, { profile, expiresAt: now + BROWSER_PROFILE_TTL });
  return profile;
}

/** Minimal Chrome DevTools Protocol client over Node 22 built-in WebSocket (zero external deps). */
async function runCdpSession(chrome: string, url: string, actions: BrowseAction[], wantScreenshot: boolean, signal: AbortSignal, sessionKey?: string) {
  const profile = sessionKey ? browserProfile(sessionKey) : fs.mkdtempSync(path.join(os.tmpdir(), 'la-cdp-'));
  const port = 9222 + Math.floor(Math.random() * 1000);
  const flags = [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--disable-sync', '--mute-audio',
    '--window-size=1280,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ];
  if (process.getuid?.() === 0) flags.unshift('--no-sandbox');
  const child = spawn(chrome, flags, { stdio: ['ignore', 'ignore', 'ignore'] });
  const killChild = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
  signal.addEventListener('abort', killChild, { once: true });
  try {
    let wsUrl = '';
    for (let i = 0; i < 30; i += 1) {
      if (signal.aborted) throw new Error('Aborted.');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          const targets = await res.json() as { type?: string; webSocketDebuggerUrl?: string }[];
          const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
        }
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!wsUrl) throw new Error('Headless Chromium did not open a debugging socket.');

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP socket error')); }, { once: true });
    });

    let seq = 0;
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
          else p.resolve(msg.result || {});
        }
      } catch { /* ignore */ }
    });
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async <T>(expression: string): Promise<T> => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return (res.result as { value?: T } | undefined)?.value as T;
    };

    try {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 2500));

      const log: string[] = [];
      for (const act of actions.slice(0, 12)) {
        if (signal.aborted) throw new Error('Aborted.');
        if (act.type === 'navigate') {
          const target = String(act.value || act.selector || url);
          const blocked = isBlockedUrl(target);
          if (blocked) throw new Error(blocked);
          await send('Page.navigate', { url: target });
          await new Promise((r) => setTimeout(r, 2500));
          log.push(`navigated to ${target}`);
        } else if (act.type === 'reload') {
          await send('Page.reload');
          await new Promise((r) => setTimeout(r, 2500));
          log.push('reloaded the page');
        } else if (act.type === 'back') {
          await evalJs(`history.back()`);
          await new Promise((r) => setTimeout(r, 2500));
          log.push('navigated back');
        } else if (act.type === 'wait') {
          const ms = Math.min(8000, Math.max(200, Number(act.ms || 1000)));
          await new Promise((r) => setTimeout(r, ms));
          log.push(`waited ${ms}ms`);
        } else if (act.type === 'scroll') {
          const y = Number(act.y || 600);
          await evalJs(`window.scrollBy(0, ${y})`);
          await new Promise((r) => setTimeout(r, 400));
          log.push(`scrolled ${y}px`);
        } else if (act.type === 'click') {
          const sel = JSON.stringify(act.selector || '');
          const txt = JSON.stringify(act.text || '');
          const ok = await evalJs<boolean>(`(() => {
            const s = ${sel}, t = ${txt}.toLowerCase();
            let el = s ? document.querySelector(s) : null;
            if (!el && t) el = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')].find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(t));
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          })()`);
          await new Promise((r) => setTimeout(r, 1200));
          log.push(ok ? `clicked ${act.selector || act.text}` : `click target not found: ${act.selector || act.text}`);
        } else if (act.type === 'fill') {
          const sel = JSON.stringify(act.selector || 'input,textarea');
          const val = JSON.stringify(act.value ?? '');
          const ok = await evalJs<boolean>(`(() => {
            const el = document.querySelector(${sel});
            if (!el) return false;
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
            setter ? setter.call(el, ${val}) : (el.value = ${val});
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`);
          log.push(ok ? `filled ${act.selector}` : `fill target not found: ${act.selector}`);
        } else if (act.type === 'select') {
          const sel = JSON.stringify(act.selector || 'select');
          const val = JSON.stringify(act.value ?? '');
          const ok = await evalJs<boolean>(`(() => {
            const el = document.querySelector(${sel});
            if (!(el instanceof HTMLSelectElement)) return false;
            el.value = ${val};
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`);
          log.push(ok ? `selected ${act.value} in ${act.selector}` : `select target not found: ${act.selector}`);
        } else if (act.type === 'hover') {
          const sel = JSON.stringify(act.selector || '');
          const txt = JSON.stringify(act.text || '');
          const ok = await evalJs<boolean>(`(() => {
            const s = ${sel}, t = ${txt}.toLowerCase();
            let el = s ? document.querySelector(s) : null;
            if (!el && t) el = [...document.querySelectorAll('a,button,[role="button"]')].find(e => (e.innerText || e.getAttribute('aria-label') || '').toLowerCase().includes(t));
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            return true;
          })()`);
          log.push(ok ? `hovered ${act.selector || act.text}` : `hover target not found: ${act.selector || act.text}`);
        } else if (act.type === 'submit') {
          const sel = JSON.stringify(act.selector || 'form');
          const ok = await evalJs<boolean>(`(() => {
            const el = document.querySelector(${sel});
            if (!el) return false;
            if (typeof el.requestSubmit === 'function') el.requestSubmit();
            else el.submit();
            return true;
          })()`);
          await new Promise((r) => setTimeout(r, 1800));
          log.push(ok ? `submitted ${act.selector}` : `form not found: ${act.selector}`);
        } else if (act.type === 'press') {
          const key = String(act.key || 'Enter');
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key === 'Enter' ? '\r' : undefined });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
          await new Promise((r) => setTimeout(r, 1200));
          log.push(`pressed ${key}`);
        }
      }

      const snap = await evalJs<{ title: string; href: string; text: string; elements: string[] }>(`(() => {
        const els = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')]
          .filter(e => e.offsetParent !== null)
          .slice(0, 30)
          .map(e => {
            const tag = e.tagName.toLowerCase();
            const id = e.id ? '#' + e.id : '';
            const name = e.getAttribute('name') ? '[name="' + e.getAttribute('name') + '"]' : '';
            const label = (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
            return tag + (id || name) + (label ? ' — ' + label : '');
          });
        return {
          title: document.title || '',
          href: location.href || '',
          text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 10000),
          elements: els,
        };
      })()`);

      let png: Buffer | null = null;
      if (wantScreenshot) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        if (typeof shot.data === 'string' && shot.data) png = Buffer.from(shot.data, 'base64');
      }
      return { ...snap, log, png };
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  } finally {
    killChild();
    if (!sessionKey) fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Headless Chromium with throwaway profile: renders JS pages, captures screenshots ([file:<id>]), and executes interactive actions (click, fill, press, scroll). */
export function browseTool(): Tool {
  return {
    name: 'browse',
    description: 'Open a public web page in headless Chromium, inspect the rendered page and interactive controls, and perform bounded actions (navigate, reload, back, click, fill, select, hover, press, scroll, submit, wait). Screenshots are saved as [file:<id>] for understand_image. Cookie/site state is retained for this chat for up to 30 minutes. Public http(s) only.',
    parameters: obj({
      url: { type: 'string', description: 'Public http(s) URL to open.' },
      screenshot: { type: 'boolean', description: 'Capture a rendered PNG screenshot saved as [file:<id>] (pass to understand_image to see visual layout/colors).' },
      actions: {
        type: 'array',
        description: 'Optional sequence: navigate/reload/back/click/fill/select/hover/press/scroll/submit/wait, with selector, text, value, key, y or ms.',
        items: { type: 'object' },
      },
    }, ['url']),
    mutates: (args) => Array.isArray(args.actions) && args.actions.some((a) => {
      const t = String((a as { type?: string })?.type || '');
      return ['navigate', 'click', 'fill', 'select', 'press', 'submit'].includes(t);
    }),
    approval: (args) => {
      const url = String(args.url || '');
      const actions = Array.isArray(args.actions) ? (args.actions as BrowseAction[]) : [];
      if (isPaymentAction(url, actions as unknown as BrowserAction[])) {
        return `Payment or purchase action on ${url.slice(0, 120)} requires your approval.`;
      }
      const interactive = actions.filter((a) => ['navigate', 'click', 'fill', 'select', 'press', 'submit'].includes(a?.type));
      if (!interactive.length) return null;
      return `Interact with web page ${url.slice(0, 120)} (${interactive.map((a) => `${a.type} ${a.selector || a.text || a.key || ''}`.trim()).join(', ').slice(0, 140)})`;
    },
    async execute(args, ctx) {
      if (ctx.agent.ownerId !== OWNER_ID) throw new Error('The browser is only available to the owner.');
      const url = String(args.url || '');
      const blocked = isBlockedUrl(url);
      if (blocked && process.env.LA_BROWSER_ALLOW_PRIVATE !== '1') throw new Error(blocked);
      const actions = Array.isArray(args.actions) ? (args.actions as BrowseAction[]) : [];
      for (const action of actions) {
        if (isPasswordAction(action as unknown as BrowserAction)) {
          throw new Error('Refused: the agent never types passwords. Ask the owner to take over to sign in, or use request_secret.');
        }
      }
      const wantShot = Boolean(args.screenshot) || actions.length > 0;
      const vaultValues = Object.values(ctx.secretEnv?.() ?? {});

      if (ctx.browser && realBrowserEnabled() && ctx.docker.available()) {
        try {
          ctx.computer?.notifyBrowserActive(ctx.runId ?? null, ctx.agent.name, url);
          const result = await ctx.browser.browse({
            personaSlug: ctx.agent.slug || ctx.agent.id,
            runId: ctx.runId,
            url,
            actions: actions as unknown as BrowserAction[],
            screenshot: wantShot,
            signal: ctx.signal,
            vaultValues,
          });
          let fileRef = '';
          if (result.png && ctx.libraryDir) {
            const host = (() => { try { return new URL(result.href || url).hostname.replace(/[^a-z0-9.-]+/gi, '_'); } catch { return 'page'; } })();
            const saved = saveFile(ctx.store, ctx.libraryDir, {
              name: `page-${host}-${Date.now().toString(36)}.png`,
              bytes: result.png,
              sessionId: ctx.sessionId ?? null,
              agentId: ctx.agent.id,
              source: 'agent',
              mime: 'image/png',
              ownerId: ctx.agent.ownerId || 'owner',
            });
            fileRef = `Screenshot saved: [file:${saved.id}] (call understand_image with file_id="${saved.id}" to inspect its visual look, layout, and colors).\n`;
          }
          const actionSummary = result.log.length ? `Actions: ${result.log.join(' → ')}\n` : '';
          if (result.loginDetected && ctx.computer && ctx.runId) {
            await ctx.computer.pauseForLogin(ctx.runId, ctx.agent.name, result.href || url, ctx.signal);
          }
          const loginHint = result.loginDetected ? '\n[Note: a password field is on this page. Owner took over to sign in and returned control.]' : '';
          return `Title: ${result.title || '(untitled)'}\nURL: ${result.href || url}\n${fileRef}${actionSummary}\n${result.text || '(empty page)'}${loginHint}`;
        } catch (error) {
          if (/Refused:|blocked|private|loopback|Password/i.test((error as Error).message)) throw error;
          ctx.store.addLog('warn', `Managed browser unavailable, falling back to headless: ${(error as Error).message}`, undefined, 'browser');
        }
      }

      const chrome = chromePath();
      if (!chrome) return `(no browser installed; plain fetch)\n${redactVaultValues(await fetchPublicText(url, ctx.fetchImpl, ctx.signal), vaultValues)}`;
      const result = await runCdpSession(chrome, url, actions, wantShot, ctx.signal, ctx.sessionId || ctx.agent.id);
      let fileRef = '';
      if (result.png && ctx.libraryDir) {
        const host = (() => { try { return new URL(result.href || url).hostname.replace(/[^a-z0-9.-]+/gi, '_'); } catch { return 'page'; } })();
        const saved = saveFile(ctx.store, ctx.libraryDir, {
          name: `page-${host}-${Date.now().toString(36)}.png`,
          bytes: result.png,
          sessionId: ctx.sessionId ?? null,
          agentId: ctx.agent.id,
          source: 'agent',
          mime: 'image/png',
          ownerId: ctx.agent.ownerId || 'owner',
        });
        fileRef = `Screenshot saved: [file:${saved.id}] (call understand_image with file_id="${saved.id}" to inspect its visual look, layout, and colors).\n`;
      }
      const actionSummary = result.log.length ? `Actions: ${result.log.join(' → ')}\n` : '';
      const controls = result.elements.length ? `\nInteractive elements:\n${result.elements.join('\n')}` : '';
      return redactVaultValues(`Title: ${result.title || '(untitled)'}\nURL: ${result.href || url}\n${fileRef}${actionSummary}\n${result.text || '(empty page)'}${controls}`, vaultValues);
    },
  };
}

export const CONNECTOR_TOOLS = (): Tool[] => [timeTool(), thinkTool(), sqliteTool(), browseTool()];
