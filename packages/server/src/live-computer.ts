import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { accountOf, OWNER_ID } from './accounts.js';
import type { ManagedBrowser } from './browser.js';
import type { Bus } from './bus.js';
import type { Store } from './db.js';
import { filePath } from './files.js';
import { nid, now } from './util.js';

export const LAST_SCREEN_TTL_MS = () => Number(process.env.LA_COMPUTER_LAST_SCREEN_TTL_MS || 60 * 60 * 1000);

export interface ShellTailEntry {
  id: string;
  runId: string | null;
  persona: string;
  command: string;
  output: string;
  code: number;
  at: string;
}

export interface BrowseStepEntry {
  id: string;
  runId: string | null;
  persona: string;
  url: string;
  title: string;
  actions: string[];
  status: 'running' | 'completed' | 'failed';
  error?: string | null;
  at: string;
}

export interface LastScreenMeta {
  available: boolean;
  url: string | null;
  title: string | null;
  persona: string | null;
  runId: string | null;
  at: string;
  ageMs: number;
}

export interface LoginPauseInfo {
  runId: string;
  personaName: string;
  url: string;
  since: string;
}

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live computer</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
    #screen { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  </style>
  <script type="module">
    import RFB from './core/rfb.js';

    function param(name, fallback) {
      const re = new RegExp('[?&]' + name + '=([^&#]*)');
      const m = re.exec(window.location.search + window.location.hash);
      return m ? decodeURIComponent(m[1]) : fallback;
    }

    const relPath = param('path', 'api/computer/vnc').replace(/^\\/+/, '');
    const viewOnlyRaw = param('view_only', '1');
    const viewOnly = viewOnlyRaw !== '0' && viewOnlyRaw !== 'false';
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = proto + '://' + window.location.host + '/' + relPath;

    let rfb = null;
    let closed = false;
    let retryTimer = null;

    function notify(status) {
      try {
        window.parent?.postMessage({ type: 'novnc', status }, window.location.origin);
      } catch {}
    }

    function connect() {
      if (closed) return;
      const screen = document.getElementById('screen');
      if (!screen) return;
      try {
        rfb = new RFB(screen, url);
        rfb.viewOnly = viewOnly;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.qualityLevel = 7;
        rfb.compressionLevel = 2;
        rfb.background = 'transparent';
        rfb.addEventListener('connect', () => notify('connected'));
        rfb.addEventListener('disconnect', () => {
          notify('disconnected');
          if (!closed && !retryTimer) {
            retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 1000);
          }
        });
      } catch {
        notify('disconnected');
        if (!closed && !retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 1000);
        }
      }
    }

    window.addEventListener('beforeunload', () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { rfb?.disconnect(); } catch {}
    });

    connect();
  </script>
</head>
<body>
  <div id="screen"></div>
</body>
</html>`;

/** Coordinates live Computer view, Take over / Give back, login pause/resume, last-screen persistence, and browse/shell tails. */
export class ComputerControl {
  private takenOver = false;
  private takenOverAt: string | null = null;
  private loginPause: { info: LoginPauseInfo; resolve: () => void } | null = null;
  private readonly tail: ShellTailEntry[] = [];
  private readonly browseLog: BrowseStepEntry[] = [];
  private hydratedBrowse = false;
  private lastScreen: {
    url: string | null;
    title: string | null;
    persona: string | null;
    runId: string | null;
    at: string;
    png: Buffer | null;
  } | null = null;

  constructor(private readonly bus: Bus, private readonly opts: { dataDir?: string; store?: Store } = {}) {}

  private browserDir(): string | null {
    return this.opts.dataDir ? path.resolve(this.opts.dataDir, 'browser') : null;
  }

  state() {
    return {
      takenOver: this.takenOver,
      takenOverAt: this.takenOverAt,
      pausedForLogin: this.loginPause?.info ?? null,
    };
  }

  isTakenOver(): boolean {
    return this.takenOver;
  }

  takeOver() {
    this.takenOver = true;
    this.takenOverAt = now();
    this.bus.publish({ type: 'computer_takeover', takenOver: true, at: this.takenOverAt } as never);
    return this.state();
  }

  giveBack() {
    this.takenOver = false;
    this.takenOverAt = null;
    if (this.loginPause) {
      const pending = this.loginPause;
      this.loginPause = null;
      pending.resolve();
    }
    this.bus.publish({ type: 'computer_takeover', takenOver: false, at: now() } as never);
    return this.state();
  }

  /** Notify the owner (via SSE) that an agent has started using the live browser at /computer. */
  notifyBrowserActive(runId: string | null, personaName: string, url: string) {
    this.bus.publish({ type: 'computer_browser_started', runId, personaName, url, at: now() } as never);
  }

  /** Pause a run when the agent hits a login screen ("Take over to sign in") and resume after Give back. */
  pauseForLogin(runId: string, personaName: string, url: string, signal?: AbortSignal): Promise<void> {
    if (this.loginPause) {
      this.loginPause.resolve();
      this.loginPause = null;
    }
    const info: LoginPauseInfo = { runId, personaName, url, since: now() };
    return new Promise<void>((resolve) => {
      const finish = () => {
        if (this.loginPause?.info.runId === runId) this.loginPause = null;
        resolve();
      };
      this.loginPause = { info, resolve: finish };
      signal?.addEventListener('abort', finish, { once: true });
      this.bus.publish({ type: 'computer_login_pause', ...info } as never);
    });
  }

  recordShell(entry: Omit<ShellTailEntry, 'id' | 'at'>) {
    const row: ShellTailEntry = { id: nid('sh'), at: now(), ...entry, output: entry.output.slice(0, 4000) };
    this.tail.push(row);
    if (this.tail.length > 100) this.tail.splice(0, this.tail.length - 100);
    this.bus.publish({ type: 'computer_shell_tail', entry: row } as never);
    return row;
  }

  shellTail(runId?: string): ShellTailEntry[] {
    const list = runId ? this.tail.filter((e) => e.runId === runId) : this.tail;
    return list.slice(-50);
  }

  recordBrowseStart(input: { runId: string | null; persona: string; url: string; actions: string[] }): string {
    this.hydratedBrowse = true;
    const row: BrowseStepEntry = {
      id: nid('brw'),
      runId: input.runId,
      persona: input.persona,
      url: input.url,
      title: '',
      actions: input.actions,
      status: 'running',
      error: null,
      at: now(),
    };
    this.browseLog.push(row);
    if (this.browseLog.length > 100) this.browseLog.splice(0, this.browseLog.length - 100);
    this.bus.publish({ type: 'computer_browser_step', entry: row } as never);
    return row.id;
  }

  finishBrowseStep(id: string | undefined, update: { status: 'completed' | 'failed'; url?: string; title?: string; actions?: string[]; error?: string | null }) {
    if (!id) return;
    const row = this.browseLog.find((item) => item.id === id);
    if (!row) return;
    row.status = update.status;
    if (update.url !== undefined) row.url = update.url;
    if (update.title !== undefined) row.title = update.title;
    if (update.actions !== undefined) row.actions = update.actions;
    row.error = update.error ?? null;
    row.at = now();
    this.bus.publish({ type: 'computer_browser_step', entry: row } as never);
  }

  browseSteps(runId?: string): BrowseStepEntry[] {
    if (!this.hydratedBrowse && !this.browseLog.length && this.opts.store) {
      this.hydratedBrowse = true;
      try {
        const rows = this.opts.store.db.prepare(
          `SELECT s.id, s.run_id AS runId, s.status, s.input, s.error, s.started_at AS startedAt, COALESCE(a.name, 'Agent') AS persona
           FROM run_steps s
           LEFT JOIN runs r ON r.id = s.run_id
           LEFT JOIN agents a ON a.id = r.agent_id
           WHERE s.name = 'browse'
           ORDER BY s.started_at DESC LIMIT 30`,
        ).all() as Array<{ id: string; runId: string | null; status: string; input: string | null; error: string | null; startedAt: string; persona: string }>;
        const cutoff = Date.now() - LAST_SCREEN_TTL_MS();
        const hydrated: BrowseStepEntry[] = [];
        for (const r of rows) {
          const ts = new Date(r.startedAt).getTime();
          if (!Number.isFinite(ts) || ts < cutoff) continue;
          let url = '';
          let actions: string[] = [];
          try {
            const parsed = r.input ? JSON.parse(r.input) as { url?: string; actions?: Array<{ type?: string; action?: string; selector?: string; url?: string }> } : {};
            url = String(parsed.url || '');
            actions = (parsed.actions ?? []).map((a) => `${a.type || a.action || 'action'}${a.selector ? ` ${a.selector}` : a.url ? ` ${a.url}` : ''}`.trim());
          } catch { /* ignore */ }
          hydrated.push({
            id: r.id,
            runId: r.runId,
            persona: r.persona,
            url,
            title: '',
            actions,
            status: r.status === 'failed' ? 'failed' : r.status === 'running' ? 'running' : 'completed',
            error: r.error,
            at: r.startedAt,
          });
        }
        this.browseLog.push(...hydrated.reverse());
      } catch { /* table missing in partial unit tests */ }
    }
    const list = runId ? this.browseLog.filter((e) => e.runId === runId) : this.browseLog;
    return list.slice(-50);
  }

  recordScreen(input: { png?: Buffer | null; url?: string | null; title?: string | null; persona?: string | null; runId?: string | null; at?: string }) {
    const stamp = input.at || now();
    const next = {
      url: input.url !== undefined ? input.url : (this.lastScreen?.url ?? null),
      title: input.title !== undefined ? input.title : (this.lastScreen?.title ?? null),
      persona: input.persona !== undefined ? input.persona : (this.lastScreen?.persona ?? null),
      runId: input.runId !== undefined ? input.runId : (this.lastScreen?.runId ?? null),
      at: stamp,
      png: input.png !== undefined ? input.png : (this.lastScreen?.png ?? null),
    };
    this.lastScreen = next;
    const dir = this.browserDir();
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (input.png && input.png.length > 0) {
          const tmpPng = path.join(dir, '.last-screen.tmp.png');
          const destPng = path.join(dir, '.last-screen.png');
          fs.writeFileSync(tmpPng, input.png);
          fs.renameSync(tmpPng, destPng);
        }
        const tmpMeta = path.join(dir, '.last-screen.tmp.json');
        const destMeta = path.join(dir, '.last-screen.json');
        fs.writeFileSync(tmpMeta, JSON.stringify({ url: next.url, title: next.title, persona: next.persona, runId: next.runId, at: next.at }));
        fs.renameSync(tmpMeta, destMeta);
      } catch { /* best-effort persistence */ }
    }
    this.bus.publish({
      type: 'computer_browser_frame',
      url: next.url,
      title: next.title,
      persona: next.persona,
      runId: next.runId,
      at: stamp,
    } as never);
  }

  notifyFrame(meta: { url?: string | null; title?: string | null; persona?: string | null; runId?: string | null; at?: string }) {
    this.recordScreen(meta);
  }

  private dbFallbackScreenshot(): { filePath: string; persona: string | null; at: string; ageMs: number } | null {
    if (!this.opts.store || !this.opts.dataDir) return null;
    try {
      const row = this.opts.store.db.prepare(
        `SELECT id, agent_id AS agentId, created_at AS createdAt FROM files
         WHERE name LIKE 'page-%' AND mime = 'image/png' AND owner_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      ).get(OWNER_ID) as { id: string; agentId: string | null; createdAt: string } | undefined;
      if (!row) return null;
      const full = filePath(this.opts.store, this.opts.dataDir, row.id);
      if (!full) return null;
      const ageMs = Math.max(0, Date.now() - new Date(row.createdAt).getTime());
      if (ageMs > LAST_SCREEN_TTL_MS()) return null;
      const persona = row.agentId ? (this.opts.store.getAgent(row.agentId)?.name ?? null) : null;
      return { filePath: full, persona, at: row.createdAt, ageMs };
    } catch {
      return null;
    }
  }

  lastScreenMeta(): LastScreenMeta | null {
    const ttl = LAST_SCREEN_TTL_MS();
    const dir = this.browserDir();
    if (dir) {
      const pngFile = path.join(dir, '.last-screen.png');
      if (fs.existsSync(pngFile)) {
        try {
          const stat = fs.statSync(pngFile);
          let meta: { url?: string | null; title?: string | null; persona?: string | null; runId?: string | null; at?: string } = {};
          const metaFile = path.join(dir, '.last-screen.json');
          if (fs.existsSync(metaFile)) {
            try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* ignore */ }
          }
          const at = meta.at || new Date(stat.mtimeMs).toISOString();
          const atMs = new Date(at).getTime();
          const ageMs = Math.max(0, Date.now() - (Number.isFinite(atMs) ? atMs : stat.mtimeMs));
          if (ageMs <= ttl) {
            return {
              available: true,
              url: meta.url ?? this.lastScreen?.url ?? null,
              title: meta.title ?? this.lastScreen?.title ?? null,
              persona: meta.persona ?? this.lastScreen?.persona ?? null,
              runId: meta.runId ?? this.lastScreen?.runId ?? null,
              at,
              ageMs,
            };
          }
        } catch { /* fall through */ }
      }
    }
    if (this.lastScreen?.png) {
      const ageMs = Math.max(0, Date.now() - new Date(this.lastScreen.at).getTime());
      if (ageMs <= ttl) {
        return {
          available: true,
          url: this.lastScreen.url,
          title: this.lastScreen.title,
          persona: this.lastScreen.persona,
          runId: this.lastScreen.runId,
          at: this.lastScreen.at,
          ageMs,
        };
      }
    }
    const dbHit = this.dbFallbackScreenshot();
    if (dbHit) {
      return {
        available: true,
        url: null,
        title: null,
        persona: dbHit.persona,
        runId: null,
        at: dbHit.at,
        ageMs: dbHit.ageMs,
      };
    }
    return null;
  }

  readLastScreenPng(): Buffer | null {
    const meta = this.lastScreenMeta();
    if (!meta?.available) return null;
    const dir = this.browserDir();
    if (dir) {
      const pngFile = path.join(dir, '.last-screen.png');
      if (fs.existsSync(pngFile)) {
        try {
          const stat = fs.statSync(pngFile);
          const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
          if (ageMs <= LAST_SCREEN_TTL_MS() || (this.lastScreen && Date.now() - new Date(this.lastScreen.at).getTime() <= LAST_SCREEN_TTL_MS())) {
            return fs.readFileSync(pngFile);
          }
        } catch { /* fall through */ }
      }
    }
    if (this.lastScreen?.png) return this.lastScreen.png;
    const dbHit = this.dbFallbackScreenshot();
    if (dbHit) {
      try { return fs.readFileSync(dbHit.filePath); } catch { /* ignore */ }
    }
    return null;
  }
}

/**
 * Registers authenticated owner-only Computer endpoints and the noVNC WebSocket proxy (/api/computer/vnc).
 * No token / non-owner -> 401/403, stream is never opened.
 */
export function registerLiveComputer(app: FastifyInstance, deps: {
  control: ComputerControl;
  browser: ManagedBrowser | null;
  vncUpstreamUrl?: () => string;
}) {
  const defaultHost = process.env.LA_COMPOSE_PROJECT ? 'la-browser:6080' : '127.0.0.1:6080';
  const upstreamUrl = deps.vncUpstreamUrl ?? (() => process.env.LA_NOVNC_WS_URL || `ws://${defaultHost}/websockify`);
  const novncHttpBase = () => (process.env.LA_NOVNC_HTTP_URL || `http://${defaultHost}`).replace(/\/+$/, '');

  // Authenticated owner-only HTTP proxy for noVNC static assets served inside la-browser (plus clean viewer.html).
  app.get('/api/computer/novnc/*', async (req, reply) => {
    if (accountOf(req).role !== 'owner' || accountOf(req).id !== OWNER_ID) {
      return reply.code(403).send({ error: 'Only the owner can view the live computer.' });
    }
    const rel = String((req.params as { '*': string })['*'] || 'viewer.html').replace(/^\/+/, '');
    if (rel.includes('..')) return reply.code(400).send({ error: 'Invalid path.' });
    if (rel === 'viewer.html' || rel === 'vnc_lite.html') {
      reply.header('cache-control', 'no-store');
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.code(200).send(VIEWER_HTML);
    }
    try {
      const res = await fetch(`${novncHttpBase()}/${rel}`, { signal: AbortSignal.timeout(5000) });
      const ct = res.headers.get('content-type');
      if (ct) reply.header('content-type', ct);
      return reply.code(res.status).send(Buffer.from(await res.arrayBuffer()));
    } catch {
      return reply.code(502).send('noVNC is not reachable yet (start a browse task first).');
    }
  });

  app.get('/api/computer/last-screen', async (req, reply) => {
    if (accountOf(req).role !== 'owner' || accountOf(req).id !== OWNER_ID) {
      return reply.code(403).send({ error: 'Only the owner can view the live computer.' });
    }
    const png = deps.control.readLastScreenPng();
    if (!png) return reply.code(404).send({ error: 'No recent screen available.' });
    reply.header('cache-control', 'no-store');
    reply.header('content-type', 'image/png');
    return reply.code(200).send(png);
  });

  app.get('/api/computer/state', async (req, reply) => {
    if (accountOf(req).role !== 'owner' || accountOf(req).id !== OWNER_ID) {
      return reply.code(403).send({ error: 'Only the owner can view the live computer.' });
    }
    return {
      ...deps.control.state(),
      browser: deps.browser ? await deps.browser.status() : null,
      lastScreen: deps.control.lastScreenMeta(),
      browseSteps: deps.control.browseSteps(),
      shellTail: deps.control.shellTail(),
    };
  });

  app.post('/api/computer/takeover', async (req, reply) => {
    if (accountOf(req).role !== 'owner') return reply.code(403).send({ error: 'Only the owner can take over.' });
    return deps.control.takeOver();
  });

  app.post('/api/computer/giveback', async (req, reply) => {
    if (accountOf(req).role !== 'owner') return reply.code(403).send({ error: 'Only the owner can give back control.' });
    return deps.control.giveBack();
  });

  app.get('/api/computer/shell-tail', async (req, reply) => {
    if (accountOf(req).role !== 'owner') return reply.code(403).send({ error: 'Only the owner can read the shell tail.' });
    const runId = (req.query as { runId?: string }).runId;
    return { entries: deps.control.shellTail(runId) };
  });

  // Authenticated noVNC WebSocket proxy: view-only by default unless owner clicked "Take over".
  app.get('/api/computer/vnc', { websocket: true }, (socket, req) => {
    const account = accountOf(req);
    if (!account || account.role !== 'owner') {
      socket.close(1008, 'Unauthorized');
      return;
    }
    const protoHeader = req.headers['sec-websocket-protocol'];
    const protocols = typeof protoHeader === 'string'
      ? protoHeader.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const upstream = protocols.length ? new WebSocket(upstreamUrl(), protocols) : new WebSocket(upstreamUrl());
    const pending: Array<{ data: Buffer | ArrayBuffer | Buffer[]; isBinary: boolean }> = [];

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // In view-only mode, block RFB KeyEvent (type 4) and PointerEvent (type 5) frames from client.
      if (!deps.control.isTakenOver() && isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (buf.length > 0 && (buf[0] === 4 || buf[0] === 5)) return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 64) {
        pending.push({ data, isBinary });
      }
    });

    upstream.on('open', () => {
      for (const frame of pending.splice(0)) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame.data, { binary: frame.isBinary });
      }
    });
    upstream.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (socket.readyState === 1) socket.send(data, { binary: isBinary });
    });
    const closeBoth = () => {
      try { upstream.close(); } catch { /* ignore */ }
      try { socket.close(); } catch { /* ignore */ }
    };
    upstream.on('close', closeBoth);
    upstream.on('error', closeBoth);
    socket.on('close', closeBoth);
    socket.on('error', closeBoth);
  });
}
