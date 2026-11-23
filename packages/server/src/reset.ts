import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createBackup, type BackupInfo } from './ops.js';

/**
 * Fresh start: delete every chat and what hangs off it (messages, runs and their steps, approvals, summaries,
 * plans, edit history, helper links, chat-bound timers), after a backup. Personas, skills, memory files and notes,
 * the knowledge base, settings, the vault, models, providers, files (kept in the library, unlinked from chats),
 * workspaces, rooms, triggers and accounts stay. A dry run (the default) only counts.
 */
/** Typed in the confirm dialog (and passed by the script with --yes). */
export const RESET_PHRASE = 'DELETE ALL CHATS';

interface Target { table: string; where?: string; label: string }

const TARGETS: Target[] = [
  { table: 'run_steps', label: 'run steps' },
  { table: 'checkpoints', label: 'run checkpoints' },
  { table: 'approvals', label: 'approvals' },
  { table: 'secret_requests', where: 'run_id IS NOT NULL', label: 'secret requests' },
  { table: 'effect_keys', label: 'tool side-effect keys' },
  { table: 'trigger_events', label: 'trigger events (the triggers stay)' },
  { table: 'helpers', label: 'helper links' },
  { table: 'plan_items', label: 'plan items' },
  { table: 'plans', label: 'plans' },
  { table: 'plan_history', label: 'plan history' },
  { table: 'edit_batches', label: 'edit batches' },
  { table: 'summaries', label: 'chat summaries' },
  { table: 'chunks', where: 'session_id IS NOT NULL', label: 'chat embeddings' },
  { table: 'secret_captures', where: 'message_id IS NOT NULL', label: 'secret offers in messages' },
  { table: 'session_workspaces', label: 'chat workspace links (the folders stay)' },
  { table: 'session_rules_off', label: 'chat rule switches' },
  { table: 'schedules', where: 'session_id IS NOT NULL', label: 'timers tied to a chat' },
  { table: 'prune_previews', label: 'prune previews' },
  { table: 'archived_messages', label: 'archived messages' },
  { table: 'messages', label: 'messages' },
  { table: 'runs', label: 'runs' },
  { table: 'chat_sessions', label: 'chats' },
];

export interface ResetCount { table: string; label: string; rows: number }
export interface ResetResult { dryRun: boolean; counts: ResetCount[]; total: number; filesUnlinked: number; backup?: BackupInfo; kept: string[] }

export const KEPT = ['personas', 'skills', 'memory files and notes', 'knowledge base', 'settings', 'secrets (vault)', 'models and providers', 'files (unlinked from chats)', 'workspaces and repos', 'rooms', 'triggers', 'accounts and tokens'];

function exists(db: DatabaseSync, table: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function resetCounts(db: DatabaseSync): { counts: ResetCount[]; filesUnlinked: number } {
  const counts = TARGETS.filter((target) => exists(db, target.table)).map((target) => ({
    table: target.table, label: target.label,
    rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${target.table}${target.where ? ` WHERE ${target.where}` : ''}`).get() as { n: number }).n),
  }));
  const filesUnlinked = exists(db, 'files') ? Number((db.prepare('SELECT COUNT(*) AS n FROM files WHERE session_id IS NOT NULL OR message_id IS NOT NULL').get() as { n: number }).n) : 0;
  return { counts, filesUnlinked };
}

/** Counts by default; deletes only with confirm: true, after a backup into data/backups. */
export async function resetChats(db: DatabaseSync, dataDir: string, opts: { confirm?: boolean; backup?: (dir: string) => Promise<BackupInfo> } = {}): Promise<ResetResult> {
  const before = resetCounts(db);
  const total = before.counts.reduce((sum, row) => sum + row.rows, 0);
  if (!opts.confirm) return { dryRun: true, ...before, total, kept: KEPT };
  const backup = await (opts.backup ?? ((dir) => createBackup(dir, 'pre-reset')))(dataDir);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (exists(db, 'files')) db.exec('UPDATE files SET session_id = NULL, message_id = NULL WHERE session_id IS NOT NULL OR message_id IS NOT NULL');
    for (const target of TARGETS) if (exists(db, target.table)) db.exec(`DELETE FROM ${target.table}${target.where ? ` WHERE ${target.where}` : ''}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { dryRun: false, ...before, total, backup, kept: KEPT };
}

function hasColumn(db: DatabaseSync, table: string, col: string) {
  if (!exists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

/** Permanently delete a single chat session, everything hanging off it (messages, runs, steps, plans, summaries), and any files attached to it. */
export function deleteSessionPermanently(db: DatabaseSync, sessionId: string, dataDir?: string): void {
  const runIds = hasColumn(db, 'runs', 'session_id')
    ? (db.prepare('SELECT id FROM runs WHERE session_id = ?').all(sessionId) as { id: string }[]).map((r) => r.id)
    : [];
  const msgIds = hasColumn(db, 'messages', 'session_id')
    ? (db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId) as { id: string }[]).map((r) => r.id)
    : [];
  const planIds = hasColumn(db, 'plans', 'session_id')
    ? (db.prepare('SELECT id FROM plans WHERE session_id = ?').all(sessionId) as { id: string }[]).map((r) => r.id)
    : [];
  const attachedFiles = new Map<string, { relPath: string; ownerId: string }>();
  const hasOwnerCol = hasColumn(db, 'files', 'owner_id');
  const fileCols = hasOwnerCol ? 'id, rel_path, owner_id' : 'id, rel_path';
  if (hasColumn(db, 'files', 'session_id') && hasColumn(db, 'files', 'rel_path')) {
    const bySession = db.prepare(`SELECT ${fileCols} FROM files WHERE session_id = ?`).all(sessionId) as { id: string; rel_path: string; owner_id?: string }[];
    for (const row of bySession) attachedFiles.set(row.id, { relPath: row.rel_path, ownerId: row.owner_id || 'owner' });
  }
  if (msgIds.length && hasColumn(db, 'files', 'message_id') && hasColumn(db, 'files', 'rel_path')) {
    const byMsg = db.prepare(`SELECT ${fileCols} FROM files WHERE message_id = ?`);
    for (const msgId of msgIds) {
      for (const row of byMsg.all(msgId) as { id: string; rel_path: string; owner_id?: string }[]) {
        attachedFiles.set(row.id, { relPath: row.rel_path, ownerId: row.owner_id || 'owner' });
      }
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (attachedFiles.size && exists(db, 'files')) {
      const delFile = db.prepare('DELETE FROM files WHERE id = ?');
      for (const fileId of attachedFiles.keys()) delFile.run(fileId);
    }
    for (const runId of runIds) {
      if (hasColumn(db, 'run_steps', 'run_id')) db.prepare('DELETE FROM run_steps WHERE run_id = ?').run(runId);
      if (hasColumn(db, 'checkpoints', 'run_id')) db.prepare('DELETE FROM checkpoints WHERE run_id = ?').run(runId);
      if (hasColumn(db, 'approvals', 'run_id')) db.prepare('DELETE FROM approvals WHERE run_id = ?').run(runId);
      if (hasColumn(db, 'secret_requests', 'run_id')) db.prepare('DELETE FROM secret_requests WHERE run_id = ?').run(runId);
      if (hasColumn(db, 'effect_keys', 'run_id')) db.prepare('DELETE FROM effect_keys WHERE run_id = ?').run(runId);
      if (hasColumn(db, 'helpers', 'parent_run_id')) db.prepare('DELETE FROM helpers WHERE parent_run_id = ? OR child_run_id = ?').run(runId, runId);
    }
    for (const planId of planIds) {
      if (hasColumn(db, 'plan_items', 'plan_id')) db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(planId);
    }
    for (const msgId of msgIds) {
      if (hasColumn(db, 'secret_captures', 'message_id')) db.prepare('DELETE FROM secret_captures WHERE message_id = ?').run(msgId);
    }
    for (const table of ['plans', 'plan_history', 'edit_batches', 'summaries', 'chunks', 'session_workspaces', 'session_rules_off', 'schedules', 'archived_messages', 'messages', 'runs']) {
      if (hasColumn(db, table, 'session_id')) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    if (exists(db, 'chat_sessions')) db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (dataDir && attachedFiles.size) {
    const ownerFilesRoot = path.resolve(dataDir, 'files');
    const dataRoot = path.resolve(dataDir);
    for (const [fileId, info] of attachedFiles) {
      const full = info.ownerId === 'owner'
        ? path.resolve(ownerFilesRoot, info.relPath)
        : path.resolve(dataRoot, info.relPath);
      const allowedRoot = info.ownerId === 'owner' ? ownerFilesRoot : path.resolve(dataRoot, 'accounts', info.ownerId, 'files');
      if (full.startsWith(`${allowedRoot}${path.sep}`)) {
        fs.rmSync(path.dirname(full), { recursive: true, force: true });
      }
      fs.rmSync(path.join(dataRoot, 'previews', fileId.replace(/[^\w-]/g, '')), { recursive: true, force: true });
    }
  }
}
