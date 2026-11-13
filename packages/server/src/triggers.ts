import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import type { Bus } from './bus.js';
import type { Engine } from './engine.js';
import type { Store } from './db.js';
import type { Vault } from './vault.js';
import { nid, now } from './util.js';

export type TriggerKind = 'webhook' | 'github' | 'folder' | 'imap';

export interface TriggerConfig {
  debounceMs?: number;
  path?: string;
  host?: string;
  port?: number;
  mailbox?: string;
  userSecret?: string;
  passwordSecret?: string;
  lastUid?: string;
}

export interface TriggerRecord {
  id: string;
  name: string;
  kind: TriggerKind;
  agentId: string;
  prompt: string;
  config: TriggerConfig;
  enabled: boolean;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function githubSignature(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function githubSignatureOk(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  return secretEquals(githubSignature(secret, body), header.trim());
}

export function renderTriggerPrompt(template: string, event: unknown): string {
  const json = JSON.stringify(event, null, 2).slice(0, 12_000);
  if (template.includes('{{event}}')) return template.replaceAll('{{event}}', json);
  return `${template.trim()}\n\nEvent:\n${json}`;
}

const READONLY_IMAP = /^(EXAMINE \S+|UID SEARCH UNSEEN|UID FETCH \d+ \(BODY\.PEEK\[HEADER\.FIELDS \(FROM SUBJECT DATE\)\] BODY\.PEEK\[TEXT\]<0\.2000>\)|LOGOUT)$/;

export function imapCommands(mailbox: string, uids: string[] = []): string[] {
  const box = mailbox.replace(/[^A-Za-z0-9._-]/g, '') || 'INBOX';
  const commands = [`EXAMINE ${box}`, 'UID SEARCH UNSEEN'];
  for (const uid of uids) {
    if (!/^\d+$/.test(uid)) continue;
    commands.push(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.2000>)`);
  }
  return commands;
}

export function assertImapReadOnly(commands: string[]) {
  for (const command of commands) {
    if (/^LOGIN /.test(command)) continue;
    if (/\b(APPEND|STORE|EXPUNGE|CREATE|DELETE|RENAME|COPY)\b/i.test(command) || !READONLY_IMAP.test(command)) {
      throw new Error('The inbox trigger is read-only and never sends mail.');
    }
  }
}

export function parseImapFetch(raw: string): { uid: string; from: string; subject: string; snippet: string }[] {
  const messages: { uid: string; from: string; subject: string; snippet: string }[] = [];
  const blocks = raw.split(/\* \d+ FETCH /);
  for (const block of blocks) {
    const uid = block.match(/UID (\d+)/)?.[1];
    if (!uid) continue;
    const from = block.match(/From: ([^\r\n]+)/i)?.[1]?.trim() ?? '';
    const subject = block.match(/Subject: ([^\r\n]+)/i)?.[1]?.trim() ?? '(no subject)';
    const snippet = block.replace(/[\s\S]*BODY\[TEXT\]<0> \{?\d*\}?\r?\n/i, '').replace(/\)\s*$/, '').trim().slice(0, 1500);
    messages.push({ uid, from, subject, snippet });
  }
  return messages;
}

function mapTrigger(row: Record<string, unknown>): TriggerRecord {
  return {
    id: String(row.id), name: String(row.name), kind: String(row.kind) as TriggerKind, agentId: String(row.agent_id),
    prompt: String(row.prompt), config: JSON.parse(String(row.config || '{}')) as TriggerConfig,
    enabled: Boolean(row.enabled), status: String(row.status), lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function listTriggers(store: Store): TriggerRecord[] {
  return (store.db.prepare('SELECT * FROM triggers ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(mapTrigger);
}

export function getTrigger(store: Store, id: string): TriggerRecord | null {
  const row = store.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapTrigger(row) : null;
}

export function createTrigger(store: Store, vault: Vault, input: {
  name: string; kind: TriggerKind; agentId: string; prompt: string; config?: TriggerConfig; secret: string;
}): TriggerRecord {
  const sealed = vault.sealText(input.secret);
  const id = nid('trg');
  const ts = now();
  store.db.prepare(`INSERT INTO triggers (id, name, kind, agent_id, prompt, secret_nonce, secret_ciphertext, config, enabled, status, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'idle', NULL, ?, ?)`).run(
    id, input.name, input.kind, input.agentId, input.prompt, sealed.nonce, sealed.ciphertext, JSON.stringify(input.config ?? {}), ts, ts,
  );
  return getTrigger(store, id)!;
}

export function updateTrigger(store: Store, id: string, patch: Partial<Pick<TriggerRecord, 'name' | 'prompt' | 'config' | 'enabled' | 'status' | 'lastError'>>) {
  const current = getTrigger(store, id);
  if (!current) throw new Error('Trigger not found.');
  store.db.prepare('UPDATE triggers SET name = ?, prompt = ?, config = ?, enabled = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
    patch.name ?? current.name,
    patch.prompt ?? current.prompt,
    JSON.stringify(patch.config ?? current.config),
    (patch.enabled ?? current.enabled) ? 1 : 0,
    patch.status ?? current.status,
    patch.lastError === undefined ? current.lastError : patch.lastError,
    now(),
    id,
  );
  return getTrigger(store, id)!;
}

export function triggerSecret(store: Store, vault: Vault, id: string): string {
  const row = store.db.prepare('SELECT secret_nonce, secret_ciphertext FROM triggers WHERE id = ?').get(id) as { secret_nonce: string; secret_ciphertext: string } | undefined;
  if (!row?.secret_nonce) throw new Error('Trigger not found.');
  return vault.openText(row.secret_nonce, row.secret_ciphertext);
}

export function listTriggerEvents(store: Store, triggerId: string, limit = 8) {
  return (store.db.prepare('SELECT * FROM trigger_events WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?').all(triggerId, limit) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), status: String(row.status), summary: String(row.summary),
    payload: JSON.parse(String(row.payload || '{}')), runId: row.run_id ? String(row.run_id) : null, createdAt: String(row.created_at),
  }));
}

export async function fireTrigger(store: Store, engine: Engine, trigger: TriggerRecord, event: unknown, opts?: { test?: boolean; wait?: boolean }) {
  if (!trigger.enabled && !opts?.test) throw new Error('Trigger is off.');
  const content = renderTriggerPrompt(trigger.prompt, event);
  const session = store.createSession({ agentId: trigger.agentId, title: trigger.name });
  const run = await engine.startTurn({ sessionId: session.id, agentId: trigger.agentId, content, wait: opts?.wait ?? false });
  const summary = opts?.test ? 'Test fire' : summarizeEvent(trigger.kind, event);
  store.db.prepare('INSERT INTO trigger_events (id, trigger_id, status, summary, payload, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    nid('tev'), trigger.id, 'started', summary, JSON.stringify(event).slice(0, 8000), run.id, now(),
  );
  updateTrigger(store, trigger.id, { status: 'listening', lastError: null });
  return { runId: run.id, sessionId: session.id };
}

function summarizeEvent(kind: string, event: unknown): string {
  const record = event && typeof event === 'object' ? event as Record<string, unknown> : {};
  if (kind === 'github') return String(record.action || record.zen || 'GitHub event');
  if (kind === 'folder') return `Folder change ${String(record.path || '')}`.trim();
  if (kind === 'imap') return String(record.subject || 'Mail');
  return 'Webhook';
}

export class ChangeDebouncer {
  private timer: NodeJS.Timeout | null = null;
  private pending: string[] = [];

  constructor(private readonly ms: number, private readonly fire: (paths: string[]) => void) {}

  push(file: string) {
    this.pending.push(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const batch = [...new Set(this.pending)];
      this.pending = [];
      this.timer = null;
      this.fire(batch);
    }, this.ms);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}

export class TriggerRuntime {
  private watchers = new Map<string, fs.FSWatcher>();
  private debouncers = new Map<string, ChangeDebouncer>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly vault: Vault,
    bus?: Bus,
    private readonly onFolder?: (trigger: TriggerRecord, paths: string[]) => Promise<void>,
  ) {
    bus?.subscribeAll((event) => {
      if (event.type === 'trigger') this.syncWatchers();
    });
  }

  start() {
    this.syncWatchers();
    this.timer = setInterval(() => { void this.poll(); }, 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const debouncer of this.debouncers.values()) debouncer.stop();
    this.watchers.clear();
    this.debouncers.clear();
  }

  syncWatchers() {
    const wanted = new Set(listTriggers(this.store).filter((trigger) => trigger.enabled && trigger.kind === 'folder' && trigger.config.path).map((trigger) => trigger.id));
    for (const [id, watcher] of this.watchers) {
      if (!wanted.has(id)) {
        watcher.close();
        this.watchers.delete(id);
        this.debouncers.get(id)?.stop();
        this.debouncers.delete(id);
      }
    }
    for (const trigger of listTriggers(this.store)) {
      if (!wanted.has(trigger.id) || this.watchers.has(trigger.id) || !trigger.config.path) continue;
      const folder = path.resolve(trigger.config.path);
      try {
        const debouncer = new ChangeDebouncer(trigger.config.debounceMs ?? 1500, (paths) => {
          void fireTrigger(this.store, this.engine, trigger, { path: folder, files: paths }).catch((error: Error) => {
            updateTrigger(this.store, trigger.id, { status: 'error', lastError: error.message });
          });
          if (this.onFolder) void this.onFolder(trigger, paths);
        });
        const watcher = fs.watch(folder, { recursive: true }, (_event, filename) => {
          debouncer.push(filename ? String(filename) : folder);
        });
        this.debouncers.set(trigger.id, debouncer);
        this.watchers.set(trigger.id, watcher);
        updateTrigger(this.store, trigger.id, { status: 'listening', lastError: null });
      } catch (error) {
        updateTrigger(this.store, trigger.id, { status: 'error', lastError: error instanceof Error ? error.message : 'watch failed' });
      }
    }
  }

  async poll() {
    for (const trigger of listTriggers(this.store).filter((item) => item.enabled && item.kind === 'imap')) {
      try {
        const messages = await pollImap(this.vault, trigger);
        for (const message of messages) {
          await fireTrigger(this.store, this.engine, trigger, message);
        }
        if (messages.length) {
          const max = messages.map((message) => Number(message.uid)).sort((a, b) => b - a)[0];
          updateTrigger(this.store, trigger.id, { config: { ...trigger.config, lastUid: String(max) }, status: 'listening', lastError: null });
        } else updateTrigger(this.store, trigger.id, { status: 'listening', lastError: null });
      } catch (error) {
        updateTrigger(this.store, trigger.id, { status: 'error', lastError: error instanceof Error ? error.message : 'imap failed' });
      }
    }
  }
}

export async function pollImap(vault: Vault, trigger: TriggerRecord) {
  const host = trigger.config.host;
  const userName = trigger.config.userSecret;
  const passwordName = trigger.config.passwordSecret;
  if (!host || !userName || !passwordName) throw new Error('IMAP needs a host and vault secret names for the user and password.');
  const user = vault.valueByName(userName);
  const password = vault.valueByName(passwordName);
  if (!user || !password) throw new Error('IMAP credentials are missing from the vault.');
  const mailbox = trigger.config.mailbox || 'INBOX';
  const script = [`LOGIN ${quoteImap(user)} ${quoteImap(password)}`, ...imapCommands(mailbox)];
  assertImapReadOnly(script.filter((line) => !line.startsWith('LOGIN')));
  const raw = await imapExchange(host, trigger.config.port ?? 993, script);
  const found = parseImapFetch(raw).filter((message) => !trigger.config.lastUid || Number(message.uid) > Number(trigger.config.lastUid));
  return found;
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function imapExchange(host: string, port: number, commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
      let index = 0;
      const sendNext = () => {
        if (index >= commands.length) {
          socket.write('a logout\r\n');
          return;
        }
        socket.write(`a${index} ${commands[index]}\r\n`);
        index += 1;
      };
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (/^a\d+ (OK|NO|BAD)/m.test(buffer.split('\n').pop() || buffer)) sendNext();
      });
      sendNext();
    });
    let buffer = '';
    socket.setTimeout(12_000, () => { socket.destroy(); reject(new Error('IMAP timed out.')); });
    socket.on('error', reject);
    socket.on('end', () => resolve(buffer));
  });
}
