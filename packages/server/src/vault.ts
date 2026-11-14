import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '@local-agent/shared';
import type { Store } from './db.js';
import { nid, now } from './util.js';

const PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'google', pattern: /AIza[0-9A-Za-z\-_]{20,}/g },
  { kind: 'openai', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'token', pattern: /\bla_[A-Za-z0-9_\-]{20,}\b/g },
  { kind: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
];

export interface SecretMeta {
  id: string;
  name: string;
  handle: string;
  scope: string;
  scopeId: string | null;
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
}

export interface SecretRequest {
  id: string;
  runId: string;
  name: string;
  scope: string;
  scopeId: string | null;
  reason: string;
  status: string;
  createdAt: string;
}

export function loadMasterKey(dataDir: string): Buffer {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const key = randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return key;
}

export function seal(key: Buffer, plaintext: string): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64url'), ciphertext: body.toString('base64url') };
}

export function open(key: Buffer, nonce: string, ciphertext: string): string {
  const raw = Buffer.from(ciphertext, 'base64url');
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function findSecretCandidates(text: string): { kind: string; value: string }[] {
  const found: { kind: string; value: string }[] = [];
  for (const pattern of PATTERNS) {
    pattern.pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern.pattern)) {
      if (match[0]) found.push({ kind: pattern.kind, value: match[0] });
    }
  }
  return found;
}

export function maskSecret(value: string) {
  if (value.length < 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export class Vault {
  constructor(private readonly store: Store, private readonly key: Buffer) {}

  list(): SecretMeta[] {
    const rows = this.store.db.prepare('SELECT * FROM secrets ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(mapSecret);
  }

  put(input: { name: string; value: string; scope?: string; scopeId?: string | null; actor: string }): SecretMeta {
    const name = normalizeName(input.name);
    const sealed = seal(this.key, input.value);
    const existing = this.findRow(name, input.scope ?? 'global', input.scopeId ?? null);
    if (existing && !existing.revoked_at) {
      this.store.db.prepare('UPDATE secrets SET nonce = ?, ciphertext = ?, rotated_at = ? WHERE id = ?').run(sealed.nonce, sealed.ciphertext, now(), String(existing.id));
      this.audit(String(existing.id), 'rotate', input.actor);
      return this.must(String(existing.id));
    }
    const id = nid('sec');
    this.store.db.prepare('INSERT INTO secrets (id, name, handle, nonce, ciphertext, scope, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, name, `secret:${name}`, sealed.nonce, sealed.ciphertext, input.scope ?? 'global', input.scopeId ?? null, now(),
    );
    this.audit(id, 'create', input.actor);
    return this.must(id);
  }

  reveal(id: string, actor: string): string {
    const row = this.row(id);
    if (!row || row.revoked_at) throw new Error('That secret is revoked or missing.');
    this.audit(id, 'reveal', actor);
    return open(this.key, String(row.nonce), String(row.ciphertext));
  }

  revoke(id: string, actor: string) {
    this.store.db.prepare('UPDATE secrets SET revoked_at = ? WHERE id = ?').run(now(), id);
    this.audit(id, 'revoke', actor);
  }

  envFor(agentId: string, actor: string): Record<string, string> {
    const rows = this.store.db.prepare(`SELECT * FROM secrets WHERE revoked_at IS NULL AND (
      scope = 'global' OR (scope = 'agent' AND scope_id = ?) OR scope = 'mcp'
    )`).all(agentId) as Record<string, unknown>[];
    const env: Record<string, string> = {};
    for (const row of rows) {
      if (row.scope === 'mcp') continue;
      env[String(row.name)] = open(this.key, String(row.nonce), String(row.ciphertext));
      this.audit(String(row.id), 'inject', actor);
    }
    return env;
  }

  /** Secrets typed into an MCP server's form: only that server's container gets them, never a model. */
  mcpEnv(serverId: string): Record<string, string> {
    const rows = this.store.db.prepare(`SELECT * FROM secrets WHERE revoked_at IS NULL AND scope = 'mcp' AND scope_id = ?`).all(serverId) as Record<string, unknown>[];
    const env: Record<string, string> = {};
    for (const row of rows) { env[String(row.name)] = open(this.key, String(row.nonce), String(row.ciphertext)); this.audit(String(row.id), 'inject', `mcp:${serverId}`); }
    return env;
  }

  /** Names (never values) of the secrets an MCP server has. */
  mcpSecretNames(serverId: string): string[] {
    return (this.store.db.prepare(`SELECT name FROM secrets WHERE revoked_at IS NULL AND scope = 'mcp' AND scope_id = ?`).all(serverId) as { name: string }[]).map((row) => row.name);
  }

  sealText(value: string) {
    return seal(this.key, value);
  }

  openText(nonce: string, ciphertext: string) {
    return open(this.key, nonce, ciphertext);
  }

  valueByName(name: string, agentId?: string): string | null {
    const meta = this.active(name, agentId);
    if (!meta) return null;
    return this.reveal(meta.id, 'trigger');
  }

  active(name: string, agentId?: string): SecretMeta | null {
    const row = this.findRow(normalizeName(name), 'agent', agentId ?? null) ?? this.findRow(normalizeName(name), 'global', null);
    if (!row || row.revoked_at) return null;
    return mapSecret(row);
  }

  redact(text: string): string {
    let next = redact(text);
    const rows = this.store.db.prepare('SELECT nonce, ciphertext FROM secrets').all() as { nonce: string; ciphertext: string }[];
    for (const row of rows) {
      try {
        const value = open(this.key, row.nonce, row.ciphertext);
        if (value.length >= 6) next = next.split(value).join('[redacted]');
      } catch { /* skip a corrupt row */ }
    }
    for (const pattern of PATTERNS) {
      pattern.pattern.lastIndex = 0;
      next = next.replace(pattern.pattern, '[redacted]');
    }
    return next;
  }

  capture(messageId: string | null, text: string): { id: string; kind: string; masked: string }[] {
    return findSecretCandidates(text).map((candidate) => {
      const sealed = seal(this.key, candidate.value);
      const id = nid('cap');
      this.store.db.prepare('INSERT INTO secret_captures (id, message_id, kind, nonce, ciphertext, created_at, consumed) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
        id, messageId, candidate.kind, sealed.nonce, sealed.ciphertext, now(),
      );
      return { id, kind: candidate.kind, masked: maskSecret(candidate.value) };
    });
  }

  acceptCapture(id: string, name: string, actor: string, scope = 'global', scopeId: string | null = null) {
    const row = this.store.db.prepare('SELECT * FROM secret_captures WHERE id = ? AND consumed = 0').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('That capture is gone.');
    const value = open(this.key, String(row.nonce), String(row.ciphertext));
    const secret = this.put({ name, value, scope, scopeId, actor });
    this.store.db.prepare('UPDATE secret_captures SET consumed = 1 WHERE id = ?').run(id);
    return secret;
  }

  createRequest(input: { runId: string; name: string; scope: string; scopeId?: string | null; reason: string }): SecretRequest {
    const id = nid('srq');
    const ts = now();
    this.store.db.prepare('INSERT INTO secret_requests (id, run_id, name, scope, scope_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, input.runId, normalizeName(input.name), input.scope, input.scopeId ?? null, input.reason, 'pending', ts,
    );
    return { id, runId: input.runId, name: normalizeName(input.name), scope: input.scope, scopeId: input.scopeId ?? null, reason: input.reason, status: 'pending', createdAt: ts };
  }

  listRequests(status?: string): SecretRequest[] {
    const rows = (status
      ? this.store.db.prepare('SELECT * FROM secret_requests WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.store.db.prepare('SELECT * FROM secret_requests ORDER BY created_at DESC LIMIT 50').all()) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), name: String(row.name), scope: String(row.scope),
      scopeId: row.scope_id ? String(row.scope_id) : null, reason: String(row.reason), status: String(row.status), createdAt: String(row.created_at),
    }));
  }

  resolveRequest(id: string, status: 'provided' | 'denied') {
    this.store.db.prepare('UPDATE secret_requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), id);
  }

  auditLog(limit = 40) {
    return (this.store.db.prepare('SELECT * FROM secret_audit ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id), secretId: row.secret_id ? String(row.secret_id) : null, action: String(row.action), actor: String(row.actor), createdAt: String(row.created_at),
    }));
  }

  private audit(secretId: string, action: string, actor: string) {
    this.store.db.prepare('INSERT INTO secret_audit (secret_id, action, actor, created_at) VALUES (?, ?, ?, ?)').run(secretId, action, actor, now());
  }

  private findRow(name: string, scope: string, scopeId: string | null) {
    if (scopeId) {
      return this.store.db.prepare('SELECT * FROM secrets WHERE name = ? AND scope = ? AND scope_id = ? ORDER BY created_at DESC LIMIT 1').get(name, scope, scopeId) as Record<string, unknown> | undefined;
    }
    return this.store.db.prepare('SELECT * FROM secrets WHERE name = ? AND scope = ? AND scope_id IS NULL ORDER BY created_at DESC LIMIT 1').get(name, scope) as Record<string, unknown> | undefined;
  }

  private row(id: string) {
    return this.store.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  private must(id: string): SecretMeta {
    const row = this.row(id);
    if (!row) throw new Error('Secret disappeared.');
    return mapSecret(row);
  }
}

function normalizeName(name: string) {
  const clean = name.trim().replace(/^secret:/, '').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,64}$/.test(clean)) throw new Error('Secret names look like GEMINI_API_KEY.');
  return clean;
}

function mapSecret(row: Record<string, unknown>): SecretMeta {
  return {
    id: String(row.id), name: String(row.name), handle: String(row.handle), scope: String(row.scope),
    scopeId: row.scope_id ? String(row.scope_id) : null, createdAt: String(row.created_at),
    rotatedAt: row.rotated_at ? String(row.rotated_at) : null, revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}
