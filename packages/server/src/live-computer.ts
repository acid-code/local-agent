import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { accountOf, OWNER_ID } from './accounts.js';
import type { ManagedBrowser } from './browser.js';
import type { Bus } from './bus.js';
import { nid, now } from './util.js';

export interface ShellTailEntry {
  id: string;
  runId: string | null;
  persona: string;
  command: string;
  output: string;
  code: number;
  at: string;
}

export interface LoginPauseInfo {
  runId: string;
  personaName: string;
  url: string;
  since: string;
}

/** Coordinates live Computer view, Take over / Give back, login pause/resume, and read-only shell tail. */
export class ComputerControl {
  private takenOver = false;
  private takenOverAt: string | null = null;
  private loginPause: { info: LoginPauseInfo; resolve: () => void } | null = null;
  private readonly tail: ShellTailEntry[] = [];

  constructor(private readonly bus: Bus) {}

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
  const upstreamUrl = deps.vncUpstreamUrl ?? (() => process.env.LA_NOVNC_WS_URL || 'ws://127.0.0.1:6080/websockify');

  app.get('/api/computer/state', async (req, reply) => {
    if (accountOf(req).role !== 'owner' || accountOf(req).id !== OWNER_ID) {
      return reply.code(403).send({ error: 'Only the owner can view the live computer.' });
    }
    return {
      ...deps.control.state(),
      browser: deps.browser ? await deps.browser.status() : null,
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
    const upstream = new WebSocket(upstreamUrl());
    upstream.on('open', () => {
      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        // In view-only mode, block RFB KeyEvent (type 4) and PointerEvent (type 5) frames from client.
        if (!deps.control.isTakenOver() && isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
          if (buf.length > 0 && (buf[0] === 4 || buf[0] === 5)) return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
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
