import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { RunCursor, StrategyName } from '@local-agent/shared';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings.js';
import { writeLog } from './debug.js';
import { nid, now, parseJson, slugify } from './util.js';

export interface Owner { username: string; createdAt: string }
export interface ProviderRow {
  id: string; kind: string; name: string; baseUrl: string | null; apiKeyEnv: string | null; enabled: boolean; createdAt: string;
}
export interface ModelRow {
  id: string; providerId: string; name: string; apiName: string; profileId: string; tokenizer: string;
  contextWindow: number; practicalBudget: number; strategy: StrategyName; sizeClass: 'small' | 'large';
  local: boolean; modalities: string[]; strengths: string[]; typicalQ4GiB: number | null;
  priceIn: number | null; priceOut: number | null; notes: string; parameterSize: string | null;
  family: string | null; source: string; embedding: boolean; freeTier: boolean | null; enabled: boolean;
}
export interface Agent {
  id: string; name: string; slug: string; title: string; description: string; systemPrompt: string; modelId: string | null;
  routing: 'auto' | 'pinned'; strategy: StrategyName | null; toolAllowlist: string[]; memoryEnabled: boolean;
  workspacePath: string; avatarKind: 'initials' | 'builtin' | 'upload'; avatarRef: string; accent: string; emoji: string;
  pinned: boolean; hidden: boolean; sortOrder: number; lastReadAt: string | null; unread: number; workshopIds: string[];
  /** 'mute' hides this persona's unread dot. */
  notify: 'all' | 'mute';
  /** Gallery persona this one was added from, if any. */
  templateId?: string | null;
  /** Reply language: auto follows the member, match follows each message, or pinned. */
  language?: 'auto' | 'match' | 'en' | 'he';
  /** Hebrew cleanup pass for this persona; inherit uses the member's setting. */
  hebrewCleanup?: 'inherit' | 'auto' | 'on' | 'off';
  /** Automatically play assistant replies aloud by voice for this persona. */
  voiceReply?: boolean;
  /** Optional voice identifier override (Piper/Kokoro/Gemini voice name). */
  voiceName?: string;
  createdAt: string; updatedAt: string; ownerId: string;
}
export interface Room { id: string; name: string; createdAt: string; agentIds: string[] }
export interface Session {
  id: string; agentId: string | null; roomId: string | null; title: string; summary: string;
  activeModelId: string | null; modelPin: string | null; archived: boolean; mode: 'chat' | 'code'; workshopId: string | null; createdAt: string; updatedAt: string; ownerId: string;
}
export interface Message {
  id: string; sessionId: string; seq: number; role: string; content: string; toolCallId: string | null;
  toolName: string | null; toolCalls: unknown; agentId: string | null; runId: string | null;
  imageUrl: string | null; routingNote: string | null; thinking?: string | null; createdAt: string;
}
export interface Note { id: string; agentId: string; content: string; pinned: boolean; createdAt: string; updatedAt: string }
export interface RunRow {
  id: string; sessionId: string; agentId: string; parentRunId: string | null; status: string; phase: string;
  cursor: RunCursor; modelId: string | null; routingNote: string | null; switched: boolean; error: string | null;
  inputTokens: number; outputTokens: number; costUsd: number; configVersion: number; leaseOwner: string | null;
  heartbeatAt: string | null; startedAt: string; endedAt: string | null;
}
export interface StepRow {
  id: string; runId: string; index: number; kind: string; name: string; status: string;
  input: unknown; output: unknown; toolCallId: string | null; turn: number | null;
  tokensIn: number; tokensOut: number; latencyMs: number; costUsd: number; error: string | null;
  startedAt: string; endedAt: string | null;
}
export interface Checkpoint { id: string; runId: string; phase: string; cursor: RunCursor; lastMessageId: string | null; note: string; createdAt: string }
export interface Approval {
  id: string; runId: string; toolCallId: string; toolName: string; args: unknown; reason: string;
  status: string; createdAt: string; resolvedAt: string | null;
}
export interface McpServer {
  id: string; name: string; transport: string; command: string | null; args: string[]; url: string | null;
  env: Record<string, string>; enabled: boolean; source: string | null; execution: string; network: string;
  grants: string[]; image: string | null; riskScore: number | null; riskLevel: string | null; reportId: string | null;
  lastError: string | null; tools: unknown[]; createdAt: string;
}
export interface Schedule {
  id: string; agentId: string; sessionId: string | null; name: string; cron: string; prompt: string;
  enabled: boolean; lastRunAt: string | null; nextRunAt: string | null; lastStatus: string | null; createdAt: string;
}
export interface SummaryRow {
  id: string; sessionId: string; level: 1 | 2; version: number; content: string; covers: string[];
  foldedInto: string | null; tokenEstimate: number; createdAt: string;
}
export interface ChunkRow {
  rowid: number; id: string; sessionId: string; agentId: string | null; text: string;
  dim: number; embedder: string; createdAt: string; embedding: Buffer | null;
}

type Raw = Record<string, SQLInputValue | bigint | null | undefined>;

export class Store {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename === ':memory:' ? path.join('/tmp', 'la') : filename), { recursive: true });
    this.db = new DatabaseSync(filename, { allowExtension: true });
    this.db.exec('PRAGMA foreign_keys = ON');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, snapshot TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT, api_key_env TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL, api_name TEXT NOT NULL, profile_id TEXT NOT NULL,
        tokenizer TEXT NOT NULL, context_window INTEGER NOT NULL, practical_budget INTEGER NOT NULL, strategy TEXT NOT NULL,
        size_class TEXT NOT NULL, is_local INTEGER NOT NULL, modalities TEXT NOT NULL, strengths TEXT NOT NULL,
        typical_q4_gib REAL, price_in REAL, price_out REAL, notes TEXT NOT NULL, parameter_size TEXT, family TEXT,
        source TEXT NOT NULL, embedding INTEGER NOT NULL DEFAULT 0, free_tier INTEGER, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL, model_id TEXT, routing TEXT NOT NULL DEFAULT 'auto', strategy TEXT,
        tool_allowlist TEXT NOT NULL, memory_enabled INTEGER NOT NULL DEFAULT 1, workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (room_id, agent_id));
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY, agent_id TEXT, room_id TEXT, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        active_model_id TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        tool_call_id TEXT, tool_name TEXT, tool_calls TEXT, agent_id TEXT, run_id TEXT, image_url TEXT, routing_note TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archived_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, payload TEXT NOT NULL, archived_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_notes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, parent_run_id TEXT, status TEXT NOT NULL,
        phase TEXT NOT NULL, cursor TEXT NOT NULL, model_id TEXT, routing_note TEXT, switched INTEGER NOT NULL DEFAULT 0,
        error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        config_version INTEGER NOT NULL DEFAULT 1, lease_owner TEXT, heartbeat_at TEXT, started_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS run_steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, index_num INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        input TEXT, output TEXT, tool_call_id TEXT, turn INTEGER, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, error TEXT, started_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL, cursor TEXT NOT NULL, last_message_id TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, args TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, command TEXT, args TEXT, url TEXT, env_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 0, source TEXT, execution TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'none',
        grants TEXT NOT NULL DEFAULT '[]', image TEXT, risk_score INTEGER, risk_level TEXT, report_id TEXT, last_error TEXT, tools_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vetting_reports (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, name TEXT NOT NULL, cron TEXT NOT NULL, prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, next_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, meta TEXT, component TEXT NOT NULL DEFAULT 'engine', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, level INTEGER NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
        covers TEXT NOT NULL, folded_into TEXT, token_estimate INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, agent_id TEXT,
        text TEXT NOT NULL, embedding BLOB, dim INTEGER NOT NULL, embedder TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_use (
        model_api TEXT NOT NULL, day TEXT NOT NULL, rpm_window TEXT NOT NULL DEFAULT '', rpm INTEGER NOT NULL DEFAULT 0,
        tpm_window TEXT NOT NULL DEFAULT '', tpm INTEGER NOT NULL DEFAULT 0, rpd INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model_api, day)
      );
      CREATE TABLE IF NOT EXISTS prune_previews (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL,
        scope TEXT NOT NULL, scope_id TEXT, created_at TEXT NOT NULL, rotated_at TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS secret_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, secret_id TEXT, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secret_requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT,
        reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS secret_captures (id TEXT PRIMARY KEY, message_id TEXT, kind TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_items (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, note TEXT);
      CREATE TABLE IF NOT EXISTS plan_history (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edit_batches (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, label TEXT NOT NULL, files TEXT NOT NULL, diff TEXT NOT NULL, created_at TEXT NOT NULL, reverted_at TEXT);
      CREATE TABLE IF NOT EXISTS folder_grants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workshops (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workshop_projects (
        id TEXT PRIMARY KEY, workshop_id TEXT NOT NULL, label TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shared_repos (
        id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, path TEXT NOT NULL, remote TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_workshops (
        agent_id TEXT NOT NULL, workshop_id TEXT NOT NULL, PRIMARY KEY (agent_id, workshop_id)
      );
      CREATE TABLE IF NOT EXISTS kb_collections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_id TEXT, root_path TEXT, embedder TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT, mime TEXT,
        bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL,
        collection_id TEXT NOT NULL, ordinal INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL,
        embedding BLOB, dim INTEGER NOT NULL, embedder TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
        version INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_id TEXT NOT NULL, slug TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (agent_id, slug)
      );
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
        secret_nonce TEXT, secret_ciphertext TEXT, config TEXT NOT NULL, enabled INTEGER NOT NULL,
        status TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trigger_events (
        id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
        payload TEXT NOT NULL, run_id TEXT, delivery_key TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_keys (
        key TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_call_id TEXT, action TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL
      );
    `);
    const sessionCols = this.many<Raw>('PRAGMA table_info(chat_sessions)').map((row) => String(row.name));
    if (!sessionCols.includes('mode')) this.db.exec(`ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'`);
    if (!sessionCols.includes('workshop_id')) this.db.exec(`ALTER TABLE chat_sessions ADD COLUMN workshop_id TEXT`);
    if (!sessionCols.includes('model_pin')) this.db.exec(`ALTER TABLE chat_sessions ADD COLUMN model_pin TEXT`);
    const triggerCols = this.many<Raw>('PRAGMA table_info(trigger_events)').map((row) => String(row.name));
    if (!triggerCols.includes('delivery_key')) this.db.exec('ALTER TABLE trigger_events ADD COLUMN delivery_key TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS trigger_delivery ON trigger_events(trigger_id, delivery_key)');
    const logCols = this.many<Raw>('PRAGMA table_info(logs)').map((row) => String(row.name));
    if (!logCols.includes('component')) this.db.exec(`ALTER TABLE logs ADD COLUMN component TEXT NOT NULL DEFAULT 'engine'`);
    const agentCols = this.many<Raw>('PRAGMA table_info(agents)').map((row) => String(row.name));
    const addAgentCol = (name: string, ddl: string) => { if (!agentCols.includes(name)) this.db.exec(`ALTER TABLE agents ADD COLUMN ${ddl}`); };
    addAgentCol('title', `title TEXT NOT NULL DEFAULT ''`);
    addAgentCol('avatar_kind', `avatar_kind TEXT NOT NULL DEFAULT 'initials'`);
    addAgentCol('avatar_ref', `avatar_ref TEXT NOT NULL DEFAULT ''`);
    addAgentCol('accent', `accent TEXT NOT NULL DEFAULT '#e4b56a'`);
    addAgentCol('emoji', `emoji TEXT NOT NULL DEFAULT ''`);
    addAgentCol('pinned', `pinned INTEGER NOT NULL DEFAULT 0`);
    addAgentCol('hidden', `hidden INTEGER NOT NULL DEFAULT 0`);
    addAgentCol('sort_order', `sort_order INTEGER NOT NULL DEFAULT 0`);
    addAgentCol('last_read_at', `last_read_at TEXT`);
    addAgentCol('notify', `notify TEXT NOT NULL DEFAULT 'all'`);
    addAgentCol('template_id', 'template_id TEXT');
    addAgentCol('language', `language TEXT NOT NULL DEFAULT 'auto'`);
    addAgentCol('hebrew_cleanup', `hebrew_cleanup TEXT NOT NULL DEFAULT 'inherit'`);
    addAgentCol('voice_reply', `voice_reply INTEGER NOT NULL DEFAULT 0`);
    addAgentCol('voice_name', `voice_name TEXT NOT NULL DEFAULT ''`);
    // Agent self-management and background helpers.
    const colsOf = (table: string) => this.many<Raw>(`PRAGMA table_info(${table})`).map((row) => String(row.name));
    const addCol = (table: string, name: string, ddl: string) => { if (!colsOf(table).includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); };
    addCol('messages', 'thinking', 'thinking TEXT');
    addCol('schedules', 'origin_session_id', 'origin_session_id TEXT');
    addCol('schedules', 'created_by', `created_by TEXT NOT NULL DEFAULT 'user'`);
    addCol('triggers', 'origin_session_id', 'origin_session_id TEXT');
    addCol('triggers', 'created_by', `created_by TEXT NOT NULL DEFAULT 'user'`);
    addCol('chat_sessions', 'helper_of', 'helper_of TEXT');
    addCol('edit_batches', 'kept_at', 'kept_at TEXT');
    addCol('edit_batches', 'kept_files', `kept_files TEXT NOT NULL DEFAULT '[]'`);
    addCol('edit_batches', 'reverted_files', `reverted_files TEXT NOT NULL DEFAULT '[]'`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS helpers (
      id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, parent_run_id TEXT, child_session_id TEXT NOT NULL, child_run_id TEXT,
      agent_id TEXT NOT NULL, owner_id TEXT NOT NULL, task TEXT NOT NULL, cli TEXT, status TEXT NOT NULL, result TEXT, error TEXT,
      max_steps INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, tools TEXT, delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, ended_at TEXT
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS helpers_parent ON helpers(parent_session_id, created_at)');
    const repoCols = this.many<Raw>('PRAGMA table_info(shared_repos)').map((row) => String(row.name));
    if (!repoCols.includes('lock_run_id')) this.db.exec(`ALTER TABLE shared_repos ADD COLUMN lock_run_id TEXT`);
    if (!repoCols.includes('lock_agent_id')) this.db.exec(`ALTER TABLE shared_repos ADD COLUMN lock_agent_id TEXT`);
    if (!repoCols.includes('lock_at')) this.db.exec(`ALTER TABLE shared_repos ADD COLUMN lock_at TEXT`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_notes (
        id TEXT PRIMARY KEY, repo_label TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, sha TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_views (
        repo_label TEXT NOT NULL, agent_id TEXT NOT NULL, last_sha TEXT NOT NULL, seen_at TEXT NOT NULL,
        PRIMARY KEY (repo_label, agent_id)
      );
    `);
    // Accounts: the owner plus optional members. Every user-owned row carries owner_id ('owner' for the owner).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        limits TEXT NOT NULL DEFAULT '{}', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_prefs (account_id TEXT PRIMARY KEY, theme TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
    `);
    for (const table of ['agents', 'chat_sessions', 'rooms', 'kb_collections', 'workshops', 'shared_repos', 'schedules', 'triggers', 'auth_sessions']) {
      const cols = this.many<Raw>(`PRAGMA table_info(${table})`).map((row) => String(row.name));
      const col = table === 'auth_sessions' ? 'account_id' : 'owner_id';
      if (cols.length && !cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT NOT NULL DEFAULT 'owner'`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_owner ON chat_sessions(owner_id, archived, updated_at)');
    if (!this.one('SELECT id FROM settings WHERE id = 1')) {
      this.db.prepare('INSERT INTO settings (id, json, version, updated_at) VALUES (1, ?, 1, ?)').run(JSON.stringify(DEFAULT_SETTINGS), now());
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  }

  private one<T extends Raw>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private many<T extends Raw>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  getOwner(): (Owner & { passwordHash: string }) | null {
    const row = this.one<Raw>('SELECT username, password_hash, created_at FROM owner WHERE id = 1');
    if (!row) return null;
    return { username: String(row.username), passwordHash: String(row.password_hash), createdAt: String(row.created_at) };
  }

  createOwner(username: string, passwordHash: string) {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM owner WHERE id = 1').get();
      if (existing) {
        const error = new Error('An owner already exists.') as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      }
      this.db.prepare('INSERT INTO owner (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)').run(username, passwordHash, now());
    });
  }

  claimEffect(key: string, runId: string, toolCallId: string, action: string): { state: 'new' } | { state: 'done'; result: string } | { state: 'started' } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT result FROM effect_keys WHERE key = ?').get(key) as { result: string | null } | undefined;
      if (existing) return existing.result != null ? { state: 'done' as const, result: existing.result } : { state: 'started' as const };
      this.db.prepare('INSERT INTO effect_keys (key, run_id, tool_call_id, action, result, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(key, runId, toolCallId, action, now());
      return { state: 'new' as const };
    });
  }

  finishEffect(key: string, result: string) {
    this.db.prepare('UPDATE effect_keys SET result = ? WHERE key = ?').run(result, key);
  }

  lookupEffect(key: string): { result: string | null } | null {
    const row = this.db.prepare('SELECT result FROM effect_keys WHERE key = ?').get(key) as { result: string | null } | undefined;
    return row ? { result: row.result } : null;
  }

  createAuthSession(id: string, expiresAt: string, accountId = 'owner') {
    this.db.prepare('INSERT INTO auth_sessions (id, created_at, expires_at, account_id) VALUES (?, ?, ?, ?)').run(id, now(), expiresAt, accountId);
  }

  getAuthSession(id: string) {
    const row = this.one<Raw>('SELECT id, expires_at, account_id FROM auth_sessions WHERE id = ?', id);
    return row ? { id: String(row.id), expiresAt: String(row.expires_at), accountId: String(row.account_id || 'owner') } : null;
  }

  deleteAuthSession(id: string) {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
  }

  createToken(name: string, tokenHash: string) {
    const id = nid('tok');
    this.db.prepare('INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, tokenHash, now());
    return id;
  }

  listTokens() {
    return this.many<Raw>('SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC').map((row) => ({
      id: String(row.id), name: String(row.name), createdAt: String(row.created_at), lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    }));
  }

  findToken(tokenHash: string) {
    const row = this.one<Raw>('SELECT id FROM api_tokens WHERE token_hash = ?', tokenHash);
    return row ? String(row.id) : null;
  }

  touchToken(id: string) {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  deleteToken(id: string) {
    this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  }

  getSettings(): Settings {
    const row = this.one<Raw>('SELECT json, version FROM settings WHERE id = 1');
    const parsed = normalizeSettings(parseJson(String(row?.json ?? ''), DEFAULT_SETTINGS));
    parsed.version = Number(row?.version ?? parsed.version);
    return parsed;
  }

  saveSettings(next: Settings, note: string, snapshot: unknown) {
    const version = this.getSettings().version + 1;
    const stored = { ...next, version };
    this.transaction(() => {
      this.db.prepare('UPDATE settings SET json = ?, version = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(stored), version, now());
      this.db.prepare('INSERT INTO config_versions (version, snapshot, note, created_at) VALUES (?, ?, ?, ?)').run(version, JSON.stringify(snapshot), note, now());
    });
    return stored;
  }

  listConfigVersions() {
    return this.many<Raw>('SELECT id, version, note, created_at FROM config_versions ORDER BY id DESC LIMIT 40').map((row) => ({
      id: Number(row.id), version: Number(row.version), note: String(row.note), createdAt: String(row.created_at),
    }));
  }

  getConfigVersion(id: number) {
    const row = this.one<Raw>('SELECT id, version, snapshot, note, created_at FROM config_versions WHERE id = ?', id);
    if (!row) return null;
    return { id: Number(row.id), version: Number(row.version), snapshot: parseJson(String(row.snapshot), {}), note: String(row.note), createdAt: String(row.created_at) };
  }

  upsertProvider(input: { id: string; kind: string; name: string; baseUrl?: string | null; apiKeyEnv?: string | null; enabled?: boolean }) {
    const existing = this.getProvider(input.id);
    if (!existing) {
      this.db.prepare('INSERT INTO providers (id, kind, name, base_url, api_key_env, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        input.id, input.kind, input.name, input.baseUrl ?? null, input.apiKeyEnv ?? null, input.enabled === false ? 0 : 1, now(),
      );
    } else {
      this.db.prepare('UPDATE providers SET kind = ?, name = ?, base_url = ?, api_key_env = ?, enabled = ? WHERE id = ?').run(
        input.kind, input.name, input.baseUrl ?? existing.baseUrl, input.apiKeyEnv ?? existing.apiKeyEnv, input.enabled === false ? 0 : 1, input.id,
      );
    }
    return this.getProvider(input.id)!;
  }

  updateProvider(id: string, patch: Partial<Pick<ProviderRow, 'name' | 'baseUrl' | 'apiKeyEnv' | 'enabled'>>) {
    const current = this.getProvider(id);
    if (!current) return null;
    return this.upsertProvider({
      id, kind: current.kind, name: patch.name ?? current.name, baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
      apiKeyEnv: patch.apiKeyEnv === undefined ? current.apiKeyEnv : patch.apiKeyEnv, enabled: patch.enabled ?? current.enabled,
    });
  }

  listProviders(): ProviderRow[] {
    return this.many<Raw>('SELECT * FROM providers ORDER BY name').map(mapProvider);
  }

  getProvider(id: string): ProviderRow | null {
    const row = this.one<Raw>('SELECT * FROM providers WHERE id = ?', id);
    return row ? mapProvider(row) : null;
  }

  upsertModel(input: Omit<ModelRow, 'enabled'> & { enabled?: boolean }) {
    const existing = this.getModel(input.id);
    const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled;
    const values = [
      input.providerId, input.name, input.apiName, input.profileId, input.tokenizer, input.contextWindow, input.practicalBudget,
      input.strategy, input.sizeClass, input.local ? 1 : 0, JSON.stringify(input.modalities), JSON.stringify(input.strengths),
      input.typicalQ4GiB, input.priceIn, input.priceOut, input.notes, input.parameterSize, input.family, input.source,
      input.embedding ? 1 : 0, input.freeTier == null ? null : input.freeTier ? 1 : 0, enabled ? 1 : 0, input.id,
    ];
    if (!existing) {
      this.db.prepare(`INSERT INTO models (
        provider_id, name, api_name, profile_id, tokenizer, context_window, practical_budget, strategy, size_class, is_local,
        modalities, strengths, typical_q4_gib, price_in, price_out, notes, parameter_size, family, source, embedding, free_tier, enabled, id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...(values as SQLInputValue[]));
    } else {
      this.db.prepare(`UPDATE models SET provider_id=?, name=?, api_name=?, profile_id=?, tokenizer=?, context_window=?, practical_budget=?,
        strategy=?, size_class=?, is_local=?, modalities=?, strengths=?, typical_q4_gib=?, price_in=?, price_out=?, notes=?, parameter_size=?,
        family=?, source=?, embedding=?, free_tier=?, enabled=? WHERE id=?`).run(...(values as SQLInputValue[]));
    }
    return this.getModel(input.id)!;
  }

  updateModel(id: string, patch: Partial<Pick<ModelRow, 'practicalBudget' | 'strategy' | 'enabled'>>) {
    const current = this.getModel(id);
    if (!current) return null;
    if (patch.practicalBudget != null) this.db.prepare('UPDATE models SET practical_budget = ? WHERE id = ?').run(patch.practicalBudget, id);
    if (patch.strategy) this.db.prepare('UPDATE models SET strategy = ? WHERE id = ?').run(patch.strategy, id);
    if (patch.enabled != null) this.db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    return this.getModel(id);
  }

  listModels(): ModelRow[] {
    return this.many<Raw>('SELECT * FROM models ORDER BY is_local DESC, name').map(mapModel);
  }

  getModel(id: string): ModelRow | null {
    const row = this.one<Raw>('SELECT * FROM models WHERE id = ?', id);
    return row ? mapModel(row) : null;
  }

  createAgent(input: { name: string; description?: string; systemPrompt: string; modelId?: string | null; routing?: 'auto' | 'pinned'; strategy?: StrategyName | null; toolAllowlist: string[]; memoryEnabled?: boolean; workspacePath: string; ownerId?: string }): Agent {
    const id = nid('agt');
    let slug = slugify(input.name);
    if (this.one('SELECT id FROM agents WHERE slug = ?', slug)) slug = `${slug}-${id.slice(-4)}`;
    const ts = now();
    this.db.prepare(`INSERT INTO agents (id, name, slug, description, system_prompt, model_id, routing, strategy, tool_allowlist, memory_enabled, workspace_path, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name, slug, input.description ?? '', input.systemPrompt, input.modelId ?? null, input.routing ?? 'auto', input.strategy ?? null,
      JSON.stringify(input.toolAllowlist), input.memoryEnabled === false ? 0 : 1, input.workspacePath, ts, ts, input.ownerId ?? 'owner',
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, patch: Partial<Omit<Agent, 'id' | 'slug' | 'workspacePath' | 'createdAt' | 'updatedAt'>>) {
    const current = this.getAgent(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE agents SET name=?, title=?, description=?, system_prompt=?, model_id=?, routing=?, strategy=?, tool_allowlist=?, memory_enabled=?, avatar_kind=?, avatar_ref=?, accent=?, emoji=?, pinned=?, hidden=?, sort_order=?, notify=?, template_id=?, language=?, hebrew_cleanup=?, voice_reply=?, voice_name=?, updated_at=? WHERE id=?`).run(
      next.name, next.title, next.description, next.systemPrompt, next.modelId, next.routing, next.strategy, JSON.stringify(next.toolAllowlist), next.memoryEnabled ? 1 : 0,
      next.avatarKind, next.avatarRef, next.accent, next.emoji, next.pinned ? 1 : 0, next.hidden ? 1 : 0, next.sortOrder, next.notify === 'mute' ? 'mute' : 'all', next.templateId ?? null, next.language || 'auto', next.hebrewCleanup || 'inherit', next.voiceReply ? 1 : 0, next.voiceName || '', next.updatedAt, id,
    );
    if (patch.workshopIds) this.setAgentWorkshops(id, patch.workshopIds);
    return this.getAgent(id);
  }

  setAgentWorkshops(agentId: string, workshopIds: string[]) {
    this.db.prepare('DELETE FROM agent_workshops WHERE agent_id = ?').run(agentId);
    const insert = this.db.prepare('INSERT INTO agent_workshops (agent_id, workshop_id) VALUES (?, ?)');
    for (const workshopId of [...new Set(workshopIds)]) insert.run(agentId, workshopId);
  }

  reorderAgents(ids: string[]) {
    ids.forEach((id, index) => this.db.prepare('UPDATE agents SET sort_order = ? WHERE id = ?').run(index, id));
  }

  markAgentRead(id: string) {
    this.db.prepare('UPDATE agents SET last_read_at = ? WHERE id = ?').run(now(), id);
  }

  /** Pass an account id to list only that account's personas. */
  listAgents(ownerId?: string): Agent[] {
    if (ownerId) return this.many<Raw>('SELECT * FROM agents WHERE owner_id = ? ORDER BY pinned DESC, sort_order ASC, name', ownerId).map((row) => this.hydrateAgent(row));
    return this.many<Raw>('SELECT * FROM agents ORDER BY pinned DESC, sort_order ASC, name').map((row) => this.hydrateAgent(row));
  }

  private hydrateAgent(row: Raw): Agent {
    const agent = mapAgent(row);
    const workshops = this.many<Raw>('SELECT workshop_id FROM agent_workshops WHERE agent_id = ?', agent.id);
    agent.workshopIds = workshops.map((item) => String(item.workshop_id));
    const since = agent.lastReadAt ?? '1970-01-01T00:00:00.000Z';
    const unread = this.one<Raw>(`SELECT COUNT(*) AS n FROM messages m JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.agent_id = ? AND m.role = 'assistant' AND m.created_at > ?`, agent.id, since);
    agent.unread = Number(unread?.n ?? 0);
    return agent;
  }

  getAgent(id: string): Agent | null {
    const row = this.one<Raw>('SELECT * FROM agents WHERE id = ?', id);
    return row ? this.hydrateAgent(row) : null;
  }

  getAgentByName(name: string, ownerId?: string): Agent | null {
    const row = ownerId
      ? this.one<Raw>('SELECT * FROM agents WHERE owner_id = ? AND (lower(name) = lower(?) OR slug = ?)', ownerId, name, slugify(name))
      : this.one<Raw>('SELECT * FROM agents WHERE lower(name) = lower(?) OR slug = ?', name, slugify(name));
    return row ? this.hydrateAgent(row) : null;
  }

  deleteAgent(id: string) {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  createRoom(name: string, agentIds: string[], ownerId = 'owner'): Room {
    const id = nid('room');
    this.transaction(() => {
      this.db.prepare('INSERT INTO rooms (id, name, created_at, owner_id) VALUES (?, ?, ?, ?)').run(id, name, now(), ownerId);
      for (const agentId of agentIds) this.db.prepare('INSERT INTO room_members (room_id, agent_id) VALUES (?, ?)').run(id, agentId);
    });
    return this.getRoom(id)!;
  }

  listRooms(ownerId?: string): Room[] {
    if (ownerId) return this.many<Raw>('SELECT * FROM rooms WHERE owner_id = ? ORDER BY created_at DESC', ownerId).map((row) => this.hydrateRoom(row));
    return this.many<Raw>('SELECT * FROM rooms ORDER BY created_at DESC').map((row) => this.hydrateRoom(row));
  }

  getRoom(id: string): Room | null {
    const row = this.one<Raw>('SELECT * FROM rooms WHERE id = ?', id);
    return row ? this.hydrateRoom(row) : null;
  }

  private hydrateRoom(row: Raw): Room {
    const members = this.many<Raw>('SELECT agent_id FROM room_members WHERE room_id = ?', String(row.id));
    return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at), agentIds: members.map((member) => String(member.agent_id)) };
  }

  createSession(input: { agentId?: string | null; roomId?: string | null; title?: string; ownerId?: string }): Session {
    const id = nid('ses');
    const ts = now();
    // A chat belongs to whoever owns its persona or room.
    this.db.prepare(`INSERT INTO chat_sessions (id, agent_id, room_id, title, summary, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT owner_id FROM agents WHERE id = ?), (SELECT owner_id FROM rooms WHERE id = ?), 'owner'))`).run(
      id, input.agentId ?? null, input.roomId ?? null, input.title || 'New chat', '', ts, ts, input.ownerId ?? null, input.agentId ?? null, input.roomId ?? null,
    );
    return this.getSession(id)!;
  }

  listSessions(ownerId?: string): Session[] {
    return this.pageSessions({ limit: 200, ownerId }).sessions;
  }

  /** Newest first. `cursor` is the nextCursor of the previous page. */
  pageSessions(opts: { limit?: number; cursor?: string | null; ownerId?: string } = {}): { sessions: Session[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
    const [updatedAt, id] = opts.cursor ? String(opts.cursor).split('|') : [];
    const owner = opts.ownerId ? 'AND owner_id = ?' : '';
    const ownerArg = opts.ownerId ? [opts.ownerId] : [];
    const rows = updatedAt && id
      ? this.many<Raw>(`SELECT * FROM chat_sessions WHERE archived = 0 AND helper_of IS NULL ${owner} AND (updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?`, ...ownerArg, updatedAt, updatedAt, id, limit + 1)
      : this.many<Raw>(`SELECT * FROM chat_sessions WHERE archived = 0 AND helper_of IS NULL ${owner} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...ownerArg, limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { sessions: page.map(mapSession), nextCursor: more && last ? `${String(last.updated_at)}|${String(last.id)}` : null };
  }

  /** The persona's most recently active one-to-one chat for this account, if any. */
  latestSessionForAgent(agentId: string, ownerId: string): Session | null {
    const row = this.one<Raw>('SELECT * FROM chat_sessions WHERE archived = 0 AND helper_of IS NULL AND agent_id = ? AND room_id IS NULL AND owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', agentId, ownerId);
    return row ? mapSession(row) : null;
  }

  getSession(id: string): Session | null {
    const row = this.one<Raw>('SELECT * FROM chat_sessions WHERE id = ?', id);
    return row ? mapSession(row) : null;
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'summary' | 'activeModelId' | 'modelPin' | 'archived' | 'mode' | 'workshopId' | 'agentId'>>) {
    const current = this.getSession(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: now() };
    this.db.prepare('UPDATE chat_sessions SET title=?, summary=?, active_model_id=?, model_pin=?, archived=?, mode=?, workshop_id=?, agent_id=?, updated_at=? WHERE id=?').run(
      next.title, next.summary, next.activeModelId, next.modelPin, next.archived ? 1 : 0, next.mode, next.workshopId, next.agentId, next.updatedAt, id,
    );
    return this.getSession(id);
  }

  insertMessage(input: Omit<Message, 'id' | 'seq' | 'createdAt'>): Message {
    const id = nid('msg');
    const seqRow = this.one<Raw>('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id = ?', input.sessionId);
    const seq = Number(seqRow?.seq ?? 0) + 1;
    const ts = now();
    this.db.prepare(`INSERT INTO messages (id, session_id, seq, role, content, tool_call_id, tool_name, tool_calls, agent_id, run_id, image_url, routing_note, thinking, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.sessionId, seq, input.role, input.content, input.toolCallId, input.toolName,
      input.toolCalls ? JSON.stringify(input.toolCalls) : null, input.agentId, input.runId, input.imageUrl, input.routingNote, input.thinking ?? null, ts,
    );
    this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(ts, input.sessionId);
    return this.getMessage(id)!;
  }

  getMessage(id: string): Message | null {
    const row = this.one<Raw>('SELECT * FROM messages WHERE id = ?', id);
    return row ? mapMessage(row) : null;
  }

  /** The newest `limit` messages before `beforeId` (oldest first), and whether older ones exist. */
  pageMessages(sessionId: string, limit: number, beforeId?: string | null): { messages: Message[]; hasMore: boolean } {
    const before = beforeId ? this.one<Raw>('SELECT seq FROM messages WHERE id = ? AND session_id = ?', beforeId, sessionId) : undefined;
    if (beforeId && !before) return { messages: [], hasMore: false };
    const rows = before
      ? this.many<Raw>('SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', sessionId, Number(before.seq), limit + 1)
      : this.many<Raw>('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?', sessionId, limit + 1);
    return { messages: rows.slice(0, limit).reverse().map(mapMessage), hasMore: rows.length > limit };
  }

  listMessages(sessionId: string): Message[] {
    return this.many<Raw>('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC', sessionId).map(mapMessage);
  }

  updateMessageContent(id: string, content: string) {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
    try { this.db.prepare('UPDATE messages_tri SET content = ? WHERE message_id = ?').run(content.slice(0, 20_000).replace(/[\u0591-\u05C7]/g, ''), id); } catch { /* search index not built yet */ }
  }

  archiveMessagesAfter(sessionId: string, messageId: string) {
    const message = this.getMessage(messageId);
    if (!message) return 0;
    const rows = this.many<Raw>('SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq', sessionId, message.seq);
    this.transaction(() => {
      for (const row of rows) {
        this.db.prepare('INSERT OR REPLACE INTO archived_messages (id, session_id, seq, role, content, payload, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          String(row.id), sessionId, Number(row.seq), String(row.role), String(row.content), JSON.stringify(row), now(),
        );
        this.db.prepare('DELETE FROM messages WHERE id = ?').run(String(row.id));
      }
    });
    return rows.length;
  }

  listArchived(sessionId: string) {
    return this.many<Raw>('SELECT id, role, content, archived_at FROM archived_messages WHERE session_id = ? ORDER BY seq', sessionId).map((row) => ({
      id: String(row.id), role: String(row.role), content: String(row.content), archivedAt: String(row.archived_at),
    }));
  }

  createNote(agentId: string, content: string, pinned = false): Note {
    const id = nid('mem');
    const ts = now();
    this.db.prepare('INSERT INTO memory_notes (id, agent_id, content, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, agentId, content, pinned ? 1 : 0, ts, ts);
    return this.listNotes(agentId).find((note) => note.id === id)!;
  }

  listNotes(agentId: string): Note[] {
    return this.many<Raw>('SELECT * FROM memory_notes WHERE agent_id = ? ORDER BY pinned DESC, updated_at DESC', agentId).map((row) => ({
      id: String(row.id), agentId: String(row.agent_id), content: String(row.content), pinned: Boolean(row.pinned), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  deleteNote(id: string) {
    this.db.prepare('DELETE FROM memory_notes WHERE id = ?').run(id);
  }

  createRun(input: { sessionId: string; agentId: string; parentRunId?: string | null; configVersion: number; cursor: RunCursor }): RunRow {
    const id = nid('run');
    const ts = now();
    this.db.prepare(`INSERT INTO runs (id, session_id, agent_id, parent_run_id, status, phase, cursor, config_version, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(id, input.sessionId, input.agentId, input.parentRunId ?? null, input.cursor.phase, JSON.stringify(input.cursor), input.configVersion, ts, ts);
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | null {
    const row = this.one<Raw>('SELECT * FROM runs WHERE id = ?', id);
    return row ? mapRun(row) : null;
  }

  /** Newest runs of one chat first. */
  listSessionRuns(sessionId: string, limit = 20): RunRow[] {
    return this.many<Raw>('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?', sessionId, limit).map(mapRun);
  }

  listRuns(limit = 100): RunRow[] {
    return this.many<Raw>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', limit).map(mapRun);
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, 'id' | 'sessionId' | 'agentId' | 'startedAt' | 'cursor'>> & { cursor?: RunCursor }) {
    const current = this.getRun(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE runs SET status=?, phase=?, cursor=?, model_id=?, routing_note=?, switched=?, error=?, input_tokens=?, output_tokens=?, cost_usd=?, config_version=?, lease_owner=?, heartbeat_at=?, ended_at=? WHERE id=?`).run(
      next.status, next.cursor.phase, JSON.stringify(next.cursor), next.modelId, next.routingNote, next.switched ? 1 : 0, next.error,
      next.inputTokens, next.outputTokens, next.costUsd, next.configVersion, next.leaseOwner, next.heartbeatAt, next.endedAt, id,
    );
    return this.getRun(id);
  }

  staleRuns(instanceId: string, staleBeforeIso: string): RunRow[] {
    return this.many<Raw>(
      `SELECT * FROM runs WHERE status IN ('running', 'awaiting_approval', 'paused') AND (lease_owner IS NULL OR lease_owner != ? OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
      instanceId, staleBeforeIso,
    ).map(mapRun);
  }

  addStep(input: Omit<StepRow, 'id' | 'index' | 'endedAt'>): StepRow {
    const id = nid('step');
    const indexRow = this.one<Raw>('SELECT COALESCE(MAX(index_num), 0) AS n FROM run_steps WHERE run_id = ?', input.runId);
    const index = Number(indexRow?.n ?? 0) + 1;
    this.db.prepare(`INSERT INTO run_steps (id, run_id, index_num, kind, name, status, input, output, tool_call_id, turn, tokens_in, tokens_out, latency_ms, cost_usd, error, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.runId, index, input.kind, input.name, input.status, input.input == null ? null : JSON.stringify(input.input),
      input.output == null ? null : JSON.stringify(input.output), input.toolCallId, input.turn, input.tokensIn, input.tokensOut, input.latencyMs, input.costUsd, input.error, input.startedAt,
    );
    return this.getStep(id)!;
  }

  updateStep(id: string, patch: Partial<Pick<StepRow, 'status' | 'output' | 'tokensIn' | 'tokensOut' | 'latencyMs' | 'costUsd' | 'error' | 'endedAt'>>) {
    const current = this.getStep(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE run_steps SET status=?, output=?, tokens_in=?, tokens_out=?, latency_ms=?, cost_usd=?, error=?, ended_at=? WHERE id=?').run(
      next.status, next.output == null ? null : JSON.stringify(next.output), next.tokensIn, next.tokensOut, next.latencyMs, next.costUsd, next.error, next.endedAt, id,
    );
    return this.getStep(id);
  }

  getStep(id: string): StepRow | null {
    const row = this.one<Raw>('SELECT * FROM run_steps WHERE id = ?', id);
    return row ? mapStep(row) : null;
  }

  listSteps(runId: string): StepRow[] {
    return this.many<Raw>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY index_num', runId).map(mapStep);
  }

  findToolStep(runId: string, toolCallId: string): StepRow | null {
    const row = this.one<Raw>('SELECT * FROM run_steps WHERE run_id = ? AND tool_call_id = ? ORDER BY index_num DESC LIMIT 1', runId, toolCallId);
    return row ? mapStep(row) : null;
  }

  addCheckpoint(runId: string, cursor: RunCursor, note: string, lastMessageId: string | null): Checkpoint {
    const id = nid('cp');
    const ts = now();
    this.db.prepare('INSERT INTO checkpoints (id, run_id, phase, cursor, last_message_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, runId, cursor.phase, JSON.stringify(cursor), lastMessageId, note, ts,
    );
    return { id, runId, phase: cursor.phase, cursor, lastMessageId, note, createdAt: ts };
  }

  listCheckpoints(runId: string): Checkpoint[] {
    return this.many<Raw>('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at', runId).map(mapCheckpoint);
  }

  getCheckpoint(id: string): Checkpoint | null {
    const row = this.one<Raw>('SELECT * FROM checkpoints WHERE id = ?', id);
    return row ? mapCheckpoint(row) : null;
  }

  createApproval(input: { runId: string; toolCallId: string; toolName: string; args: unknown; reason: string }): Approval {
    const id = nid('apr');
    const ts = now();
    this.db.prepare('INSERT INTO approvals (id, run_id, tool_call_id, tool_name, args, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, input.runId, input.toolCallId, input.toolName, JSON.stringify(input.args), input.reason, 'pending', ts,
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const row = this.one<Raw>('SELECT * FROM approvals WHERE id = ?', id);
    return row ? mapApproval(row) : null;
  }

  listApprovals(status?: string): Approval[] {
    const rows = status
      ? this.many<Raw>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', status)
      : this.many<Raw>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100');
    return rows.map(mapApproval);
  }

  resolveApproval(id: string, status: 'approved' | 'denied' | 'expired') {
    this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), id);
    return this.getApproval(id);
  }

  upsertMcp(input: McpServer): McpServer {
    const existing = this.getMcp(input.id);
    const values = [
      input.name, input.transport, input.command, JSON.stringify(input.args), input.url, JSON.stringify(input.env), input.enabled ? 1 : 0,
      input.source, input.execution, input.network, JSON.stringify(input.grants), input.image, input.riskScore, input.riskLevel, input.reportId,
      input.lastError, JSON.stringify(input.tools), existing ? input.id : input.id,
    ];
    if (!existing) {
      this.db.prepare(`INSERT INTO mcp_servers (name, transport, command, args, url, env_json, enabled, source, execution, network, grants, image, risk_score, risk_level, report_id, last_error, tools_json, created_at, id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...(values.slice(0, -1) as SQLInputValue[]), now(), input.id);
    } else {
      this.db.prepare(`UPDATE mcp_servers SET name=?, transport=?, command=?, args=?, url=?, env_json=?, enabled=?, source=?, execution=?, network=?, grants=?, image=?, risk_score=?, risk_level=?, report_id=?, last_error=?, tools_json=? WHERE id=?`).run(...(values as SQLInputValue[]));
    }
    return this.getMcp(input.id)!;
  }

  listMcp(): McpServer[] {
    return this.many<Raw>('SELECT * FROM mcp_servers ORDER BY name').map(mapMcp);
  }

  getMcp(id: string): McpServer | null {
    const row = this.one<Raw>('SELECT * FROM mcp_servers WHERE id = ?', id);
    return row ? mapMcp(row) : null;
  }

  deleteMcp(id: string) {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  saveVetting(id: string, payload: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO vetting_reports (id, payload, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(payload), now());
  }

  getVetting<T>(id: string): T | null {
    const row = this.one<Raw>('SELECT payload FROM vetting_reports WHERE id = ?', id);
    return row ? parseJson<T>(String(row.payload), null as T) : null;
  }

  createSchedule(input: { agentId: string; name: string; cron: string; prompt: string; nextRunAt: string }): Schedule {
    const id = nid('sch');
    this.db.prepare('INSERT INTO schedules (id, agent_id, name, cron, prompt, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
      id, input.agentId, input.name, input.cron, input.prompt, input.nextRunAt, now(),
    );
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'prompt' | 'enabled' | 'sessionId' | 'lastRunAt' | 'nextRunAt' | 'lastStatus'>>) {
    const current = this.getSchedule(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE schedules SET name=?, cron=?, prompt=?, enabled=?, session_id=?, last_run_at=?, next_run_at=?, last_status=? WHERE id=?').run(
      next.name, next.cron, next.prompt, next.enabled ? 1 : 0, next.sessionId, next.lastRunAt, next.nextRunAt, next.lastStatus, id,
    );
    return this.getSchedule(id);
  }

  listSchedules(): Schedule[] {
    return this.many<Raw>('SELECT * FROM schedules ORDER BY name').map(mapSchedule);
  }

  getSchedule(id: string): Schedule | null {
    const row = this.one<Raw>('SELECT * FROM schedules WHERE id = ?', id);
    return row ? mapSchedule(row) : null;
  }

  deleteSchedule(id: string) {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  dueSchedules(iso: string): Schedule[] {
    return this.many<Raw>('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', iso).map(mapSchedule);
  }

  addLog(level: string, message: string, meta?: unknown, component = 'engine') {
    writeLog(this, level, message, meta, component as 'engine');
  }

  listLogs(limit = 200) {
    return this.many<Raw>('SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit).map((row) => ({
      id: Number(row.id), level: String(row.level), component: String(row.component || 'engine'), message: String(row.message), meta: parseJson(row.meta ? String(row.meta) : '', null), createdAt: String(row.created_at),
    }));
  }

  clearLogs() {
    const row = this.one<Raw>('SELECT COUNT(*) AS n FROM logs');
    this.db.exec('DELETE FROM logs');
    return Number(row?.n ?? 0);
  }

  createJob(kind: string, command: string) {
    const id = nid('job');
    this.db.prepare('INSERT INTO jobs (id, kind, command, status, output, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, command, 'running', '', now());
    return this.getJob(id)!;
  }

  appendJob(id: string, chunk: string) {
    const job = this.getJob(id);
    if (!job) return;
    this.db.prepare('UPDATE jobs SET output = ? WHERE id = ?').run(`${job.output}${chunk}`.slice(-50_000), id);
  }

  finishJob(id: string, status: string) {
    this.db.prepare('UPDATE jobs SET status = ?, ended_at = ? WHERE id = ?').run(status, now(), id);
    return this.getJob(id);
  }

  getJob(id: string) {
    const row = this.one<Raw>('SELECT * FROM jobs WHERE id = ?', id);
    if (!row) return null;
    return { id: String(row.id), kind: String(row.kind), command: String(row.command), status: String(row.status), output: String(row.output), createdAt: String(row.created_at), endedAt: row.ended_at ? String(row.ended_at) : null };
  }

  addSummary(input: Omit<SummaryRow, 'id' | 'createdAt'>): SummaryRow {
    const id = nid('sum');
    const ts = now();
    this.db.prepare('INSERT INTO summaries (id, session_id, level, version, content, covers, folded_into, token_estimate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, input.sessionId, input.level, input.version, input.content, JSON.stringify(input.covers), input.foldedInto, input.tokenEstimate, ts,
    );
    return { ...input, id, createdAt: ts };
  }

  listSummaries(sessionId: string): SummaryRow[] {
    return this.many<Raw>('SELECT * FROM summaries WHERE session_id = ? ORDER BY version, level', sessionId).map((row) => ({
      id: String(row.id), sessionId: String(row.session_id), level: Number(row.level) as 1 | 2, version: Number(row.version),
      content: String(row.content), covers: parseJson<string[]>(String(row.covers), []), foldedInto: row.folded_into ? String(row.folded_into) : null,
      tokenEstimate: Number(row.token_estimate), createdAt: String(row.created_at),
    }));
  }

  markSummariesFolded(ids: string[], into: string) {
    for (const id of ids) this.db.prepare('UPDATE summaries SET folded_into = ? WHERE id = ?').run(into, id);
  }

  addChunk(input: { id: string; sessionId: string; agentId: string | null; text: string; embedding: Buffer; dim: number; embedder: string }): number {
    const result = this.db.prepare('INSERT INTO chunks (id, session_id, agent_id, text, embedding, dim, embedder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.id, input.sessionId, input.agentId, input.text, input.embedding, input.dim, input.embedder, now(),
    );
    return Number(result.lastInsertRowid);
  }

  listChunks(sessionId?: string): ChunkRow[] {
    const rows = sessionId
      ? this.many<Raw>('SELECT rowid, id, session_id, agent_id, text, embedding, dim, embedder, created_at FROM chunks WHERE session_id = ?', sessionId)
      : this.many<Raw>('SELECT rowid, id, session_id, agent_id, text, embedding, dim, embedder, created_at FROM chunks');
    return rows.map((row) => ({
      rowid: Number(row.rowid), id: String(row.id), sessionId: String(row.session_id), agentId: row.agent_id ? String(row.agent_id) : null,
      text: String(row.text), dim: Number(row.dim), embedder: String(row.embedder), createdAt: String(row.created_at),
      embedding: row.embedding instanceof Buffer ? row.embedding : row.embedding ? Buffer.from(row.embedding as Uint8Array) : null,
    }));
  }

  deleteSessionChunks(sessionId: string) {
    this.db.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
  }

  addSample(payload: unknown) {
    this.db.prepare('INSERT INTO resource_samples (json, created_at) VALUES (?, ?)').run(JSON.stringify(payload), now());
    this.db.prepare('DELETE FROM resource_samples WHERE created_at < ?').run(new Date(Date.now() - 7 * 86400_000).toISOString());
  }

  listSamples(sinceIso: string) {
    return this.many<Raw>('SELECT json, created_at FROM resource_samples WHERE created_at >= ? ORDER BY id', sinceIso).map((row) => ({
      at: String(row.created_at), ...(parseJson<Record<string, unknown>>(String(row.json), {})),
    }));
  }

  quotaUse(modelApi: string, day: string) {
    const row = this.one<Raw>('SELECT * FROM quota_use WHERE model_api = ? AND day = ?', modelApi, day);
    if (!row) return { rpmWindow: '', rpm: 0, tpmWindow: '', tpm: 0, rpd: 0 };
    return { rpmWindow: String(row.rpm_window), rpm: Number(row.rpm), tpmWindow: String(row.tpm_window), tpm: Number(row.tpm), rpd: Number(row.rpd) };
  }

  bumpQuota(modelApi: string, day: string, minute: string, tokens: number) {
    const current = this.quotaUse(modelApi, day);
    const sameMinute = current.rpmWindow === minute;
    const rpm = (sameMinute ? current.rpm : 0) + 1;
    const tpm = (sameMinute ? current.tpm : 0) + tokens;
    const rpd = current.rpd + 1;
    this.db.prepare(`INSERT INTO quota_use (model_api, day, rpm_window, rpm, tpm_window, tpm, rpd) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_api, day) DO UPDATE SET rpm_window=excluded.rpm_window, rpm=excluded.rpm, tpm_window=excluded.tpm_window, tpm=excluded.tpm, rpd=excluded.rpd`).run(
      modelApi, day, minute, rpm, minute, tpm, rpd,
    );
  }

  savePreview(id: string, payload: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO prune_previews (id, payload, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(payload), now());
  }

  getPreview<T>(id: string): { payload: T; createdAt: string } | null {
    const row = this.one<Raw>('SELECT payload, created_at FROM prune_previews WHERE id = ?', id);
    if (!row) return null;
    return { payload: parseJson<T>(String(row.payload), null as T), createdAt: String(row.created_at) };
  }

  messageStats(agentId: string) {
    const row = this.one<Raw>(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.agent_id = ?`, agentId);
    const summaries = this.one<Raw>(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM summaries sm JOIN chat_sessions s ON s.id = sm.session_id WHERE s.agent_id = ?`, agentId);
    const notes = this.one<Raw>('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM memory_notes WHERE agent_id = ?', agentId);
    const chunks = this.one<Raw>('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(embedding)), 0) AS bytes FROM chunks WHERE agent_id = ?', agentId);
    return {
      messages: Number(row?.n ?? 0), messageBytes: Number(row?.bytes ?? 0),
      summaries: Number(summaries?.n ?? 0), summaryBytes: Number(summaries?.bytes ?? 0),
      notes: Number(notes?.n ?? 0), noteBytes: Number(notes?.bytes ?? 0),
      chunks: Number(chunks?.n ?? 0), embeddingBytes: Number(chunks?.bytes ?? 0),
    };
  }

  isOpen = true;

  close() {
    this.isOpen = false;
    this.db.close();
  }
}

function mapProvider(row: Raw): ProviderRow {
  return { id: String(row.id), kind: String(row.kind), name: String(row.name), baseUrl: row.base_url ? String(row.base_url) : null, apiKeyEnv: row.api_key_env ? String(row.api_key_env) : null, enabled: Boolean(row.enabled), createdAt: String(row.created_at) };
}

function mapModel(row: Raw): ModelRow {
  return {
    id: String(row.id), providerId: String(row.provider_id), name: String(row.name), apiName: String(row.api_name), profileId: String(row.profile_id),
    tokenizer: String(row.tokenizer), contextWindow: Number(row.context_window), practicalBudget: Number(row.practical_budget), strategy: String(row.strategy) as StrategyName,
    sizeClass: String(row.size_class) as 'small' | 'large', local: Boolean(row.is_local), modalities: parseJson<string[]>(String(row.modalities), []),
    strengths: parseJson<string[]>(String(row.strengths), []), typicalQ4GiB: row.typical_q4_gib == null ? null : Number(row.typical_q4_gib),
    priceIn: row.price_in == null ? null : Number(row.price_in), priceOut: row.price_out == null ? null : Number(row.price_out),
    notes: String(row.notes), parameterSize: row.parameter_size ? String(row.parameter_size) : null, family: row.family ? String(row.family) : null,
    source: String(row.source), embedding: Boolean(row.embedding), freeTier: row.free_tier == null ? null : Boolean(row.free_tier), enabled: Boolean(row.enabled),
  };
}

function mapAgent(row: Raw): Agent {
  const kind = String(row.avatar_kind || 'initials');
  return {
    id: String(row.id), name: String(row.name), slug: String(row.slug), title: String(row.title || ''), description: String(row.description), systemPrompt: String(row.system_prompt),
    modelId: row.model_id ? String(row.model_id) : null, routing: String(row.routing) as 'auto' | 'pinned', strategy: row.strategy ? String(row.strategy) as StrategyName : null,
    toolAllowlist: parseJson<string[]>(String(row.tool_allowlist), []), memoryEnabled: Boolean(row.memory_enabled), workspacePath: String(row.workspace_path),
    avatarKind: kind === 'builtin' || kind === 'upload' ? kind : 'initials', avatarRef: String(row.avatar_ref || ''), accent: String(row.accent || '#e4b56a'), emoji: String(row.emoji || ''),
    pinned: Boolean(row.pinned), hidden: Boolean(row.hidden), sortOrder: Number(row.sort_order || 0), lastReadAt: row.last_read_at ? String(row.last_read_at) : null,
    unread: 0, workshopIds: [], notify: row.notify === 'mute' ? 'mute' : 'all', templateId: row.template_id ? String(row.template_id) : null,
    language: (['match', 'en', 'he'].includes(String(row.language)) ? String(row.language) : 'auto') as Agent['language'], hebrewCleanup: (['auto', 'on', 'off'].includes(String(row.hebrew_cleanup)) ? String(row.hebrew_cleanup) : 'inherit') as Agent['hebrewCleanup'],
    voiceReply: Boolean(row.voice_reply), voiceName: row.voice_name ? String(row.voice_name) : '',
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), ownerId: String(row.owner_id || 'owner'),
  };
}

function mapSession(row: Raw): Session {
  return {
    id: String(row.id), agentId: row.agent_id ? String(row.agent_id) : null, roomId: row.room_id ? String(row.room_id) : null,
    title: String(row.title), summary: String(row.summary ?? ''), activeModelId: row.active_model_id ? String(row.active_model_id) : null,
    modelPin: row.model_pin ? String(row.model_pin) : null,
    archived: Boolean(row.archived), mode: row.mode === 'code' ? 'code' : 'chat', workshopId: row.workshop_id ? String(row.workshop_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ownerId: String(row.owner_id || 'owner'),
  };
}

function mapMessage(row: Raw): Message {
  return {
    id: String(row.id), sessionId: String(row.session_id), seq: Number(row.seq), role: String(row.role), content: String(row.content),
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null, toolName: row.tool_name ? String(row.tool_name) : null,
    toolCalls: parseJson(row.tool_calls ? String(row.tool_calls) : '', null), agentId: row.agent_id ? String(row.agent_id) : null,
    runId: row.run_id ? String(row.run_id) : null, imageUrl: row.image_url ? String(row.image_url) : null,
    routingNote: row.routing_note ? String(row.routing_note) : null,
    thinking: row.thinking ? String(row.thinking) : null,
    createdAt: String(row.created_at),
  };
}

function mapRun(row: Raw): RunRow {
  return {
    id: String(row.id), sessionId: String(row.session_id), agentId: String(row.agent_id), parentRunId: row.parent_run_id ? String(row.parent_run_id) : null,
    status: String(row.status), phase: String(row.phase), cursor: parseJson<RunCursor>(String(row.cursor), { phase: 'route', turn: 0 }),
    modelId: row.model_id ? String(row.model_id) : null, routingNote: row.routing_note ? String(row.routing_note) : null, switched: Boolean(row.switched),
    error: row.error ? String(row.error) : null, inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0), configVersion: Number(row.config_version ?? 1), leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : null, startedAt: String(row.started_at), endedAt: row.ended_at ? String(row.ended_at) : null,
  };
}

function mapStep(row: Raw): StepRow {
  return {
    id: String(row.id), runId: String(row.run_id), index: Number(row.index_num), kind: String(row.kind), name: String(row.name), status: String(row.status),
    input: parseJson(row.input ? String(row.input) : '', null), output: parseJson(row.output ? String(row.output) : '', null),
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null, turn: row.turn == null ? null : Number(row.turn),
    tokensIn: Number(row.tokens_in ?? 0), tokensOut: Number(row.tokens_out ?? 0), latencyMs: Number(row.latency_ms ?? 0),
    costUsd: Number(row.cost_usd ?? 0), error: row.error ? String(row.error) : null, startedAt: String(row.started_at), endedAt: row.ended_at ? String(row.ended_at) : null,
  };
}

function mapCheckpoint(row: Raw): Checkpoint {
  return { id: String(row.id), runId: String(row.run_id), phase: String(row.phase), cursor: parseJson<RunCursor>(String(row.cursor), { phase: 'route', turn: 0 }), lastMessageId: row.last_message_id ? String(row.last_message_id) : null, note: String(row.note), createdAt: String(row.created_at) };
}

function mapApproval(row: Raw): Approval {
  return { id: String(row.id), runId: String(row.run_id), toolCallId: String(row.tool_call_id), toolName: String(row.tool_name), args: parseJson(String(row.args), {}), reason: String(row.reason), status: String(row.status), createdAt: String(row.created_at), resolvedAt: row.resolved_at ? String(row.resolved_at) : null };
}

function mapMcp(row: Raw): McpServer {
  return {
    id: String(row.id), name: String(row.name), transport: String(row.transport), command: row.command ? String(row.command) : null,
    args: parseJson<string[]>(String(row.args ?? '[]'), []), url: row.url ? String(row.url) : null, env: parseJson<Record<string, string>>(String(row.env_json ?? '{}'), {}),
    enabled: Boolean(row.enabled), source: row.source ? String(row.source) : null, execution: String(row.execution), network: String(row.network),
    grants: parseJson<string[]>(String(row.grants ?? '[]'), []), image: row.image ? String(row.image) : null, riskScore: row.risk_score == null ? null : Number(row.risk_score),
    riskLevel: row.risk_level ? String(row.risk_level) : null, reportId: row.report_id ? String(row.report_id) : null, lastError: row.last_error ? String(row.last_error) : null,
    tools: parseJson<unknown[]>(String(row.tools_json ?? '[]'), []), createdAt: String(row.created_at),
  };
}

function mapSchedule(row: Raw): Schedule {
  return {
    id: String(row.id), agentId: String(row.agent_id), sessionId: row.session_id ? String(row.session_id) : null, name: String(row.name),
    cron: String(row.cron), prompt: String(row.prompt), enabled: Boolean(row.enabled), lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null, lastStatus: row.last_status ? String(row.last_status) : null, createdAt: String(row.created_at),
  };
}
