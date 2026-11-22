import type { RunCursor } from '@local-agent/shared';
import type { Agent, RunRow, Store } from './db.js';
import type { Bus } from './bus.js';
import { nid, now } from './util.js';

export const MAX_PERSONA_HOPS = 3;
export const MAX_AUTO_STARTS_PER_WINDOW = 3;
export const AUTO_START_WINDOW_MS = 10 * 60_000;

export interface PersonaMessageRow {
  id: string;
  kind: 'message' | 'handoff';
  fromAgentId: string;
  fromAgentName?: string;
  toAgentId: string;
  toAgentName?: string;
  fromSessionId: string | null;
  toSessionId: string | null;
  fromRunId: string | null;
  toRunId: string | null;
  text: string;
  fileIds: string[];
  hop: number;
  status: 'sent' | 'running' | 'completed' | 'failed' | 'refused';
  result: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export type StartTurnFn = (input: {
  sessionId: string;
  agentId: string;
  content?: string;
  background?: boolean;
  cursorExtras?: Partial<RunCursor>;
  onDone?: (run: RunRow) => void;
}) => Promise<RunRow>;

function mapRow(row: Record<string, unknown>, agents?: Map<string, Agent>): PersonaMessageRow {
  const fromAgentId = String(row.from_agent_id);
  const toAgentId = String(row.to_agent_id);
  let fileIds: string[] = [];
  try { fileIds = JSON.parse(String(row.file_ids_json || '[]')) as string[]; } catch { fileIds = []; }
  return {
    id: String(row.id),
    kind: row.kind === 'handoff' ? 'handoff' : 'message',
    fromAgentId,
    fromAgentName: agents?.get(fromAgentId)?.name,
    toAgentId,
    toAgentName: agents?.get(toAgentId)?.name,
    fromSessionId: row.from_session_id ? String(row.from_session_id) : null,
    toSessionId: row.to_session_id ? String(row.to_session_id) : null,
    fromRunId: row.from_run_id ? String(row.from_run_id) : null,
    toRunId: row.to_run_id ? String(row.to_run_id) : null,
    text: String(row.text),
    fileIds: Array.isArray(fileIds) ? fileIds.map(String) : [],
    hop: Number(row.hop ?? 1),
    status: String(row.status || 'sent') as PersonaMessageRow['status'],
    result: row.result != null ? String(row.result) : null,
    ownerId: String(row.owner_id || 'owner'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listPersonaMessages(store: Store, filter: { ownerId?: string; sessionId?: string; agentId?: string; since?: string; limit?: number } = {}): PersonaMessageRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.ownerId) { clauses.push('owner_id = ?'); params.push(filter.ownerId); }
  if (filter.sessionId) { clauses.push('(from_session_id = ? OR to_session_id = ?)'); params.push(filter.sessionId, filter.sessionId); }
  if (filter.agentId) { clauses.push('(from_agent_id = ? OR to_agent_id = ?)'); params.push(filter.agentId, filter.agentId); }
  if (filter.since) { clauses.push('created_at >= ?'); params.push(filter.since); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const rows = store.db.prepare(`SELECT * FROM persona_messages ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
  const agents = new Map(store.listAgents().map((a) => [a.id, a]));
  return rows.map((row) => mapRow(row, agents));
}

export function getPersonaMessage(store: Store, id: string): PersonaMessageRow | null {
  const row = store.db.prepare('SELECT * FROM persona_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const agents = new Map(store.listAgents().map((a) => [a.id, a]));
  return mapRow(row, agents);
}

/** Format the structured marker stored at the top of a persona-to-persona chat message for UI rendering. */
export function formatPersonaMessageHeader(meta: { id: string; kind: 'message' | 'handoff'; fromAgentId: string; fromName: string; fromSessionId: string | null }): string {
  const safeName = meta.fromName.replace(/[\]|]/g, '');
  return `[persona-message|${meta.id}|${meta.kind}|${meta.fromAgentId}|${safeName}|${meta.fromSessionId ?? ''}]`;
}

function resolveTargetAgent(store: Store, fromAgent: Agent, to: string): Agent {
  const needle = to.trim();
  if (!needle) throw new Error('Missing target persona name.');
  const sameOwner = store.getAgentByName(needle, fromAgent.ownerId);
  if (sameOwner) return sameOwner;
  // Check if a persona with this name exists under a different owner -> explicit isolation error.
  const anyOwner = store.listAgents().find((a) => a.name.toLowerCase() === needle.toLowerCase() || a.slug.toLowerCase() === needle.toLowerCase());
  if (anyOwner && anyOwner.ownerId !== fromAgent.ownerId) {
    throw new Error('Cannot message a persona belonging to another account.');
  }
  throw new Error(`No persona named "${needle}".`);
}

function validateFileIds(store: Store, ownerId: string, fileIds?: string[]): string[] {
  if (!fileIds?.length) return [];
  const valid: string[] = [];
  for (const raw of fileIds) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const row = store.db.prepare('SELECT id, owner_id FROM files WHERE id = ?').get(id) as { id: string; owner_id?: string } | undefined;
    if (row && (!row.owner_id || row.owner_id === ownerId)) valid.push(row.id);
  }
  return [...new Set(valid)];
}

function targetSessionFor(store: Store, target: Agent): string {
  const sessions = store.listSessions(target.ownerId).filter((s) => s.agentId === target.id && !s.roomId);
  if (sessions.length > 0) return sessions[0]!.id;
  const created = store.createSession({ agentId: target.id, title: target.name, ownerId: target.ownerId });
  return created.id;
}

function recentAutoStarts(store: Store, targetAgentId: string): number {
  const since = new Date(Date.now() - AUTO_START_WINDOW_MS).toISOString();
  const row = store.db.prepare(
    'SELECT COUNT(*) AS count FROM persona_messages WHERE to_agent_id = ? AND to_run_id IS NOT NULL AND created_at >= ?',
  ).get(targetAgentId, since) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function bumpUnread(_store: Store, _agentId: string) {
  // Unread count is computed dynamically in Store.hydrateAgent from messages newer than last_read_at
  // (including '[persona-message|...' rows).
}

function insertMessageRow(store: Store, row: Omit<PersonaMessageRow, 'fromAgentName' | 'toAgentName'>) {
  store.db.prepare(
    `INSERT INTO persona_messages (id, kind, from_agent_id, to_agent_id, from_session_id, to_session_id, from_run_id, to_run_id, text, file_ids_json, hop, status, result, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.kind, row.fromAgentId, row.toAgentId, row.fromSessionId, row.toSessionId,
    row.fromRunId, row.toRunId, row.text, JSON.stringify(row.fileIds), row.hop,
    row.status, row.result, row.ownerId, row.createdAt, row.updatedAt,
  );
}

function updateMessageRow(store: Store, id: string, patch: { toRunId?: string; status?: PersonaMessageRow['status']; result?: string | null }) {
  const sets: string[] = ['updated_at = ?'];
  const params: (string | null)[] = [now()];
  if (patch.toRunId !== undefined) { sets.push('to_run_id = ?'); params.push(patch.toRunId); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.result !== undefined) { sets.push('result = ?'); params.push(patch.result); }
  params.push(id);
  store.db.prepare(`UPDATE persona_messages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function lastReplyForRun(store: Store, sessionId: string, runId: string): string {
  const msgs = store.listMessages(sessionId);
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i]!;
    if (m.runId === runId && m.role === 'assistant' && m.content.trim()) return m.content.trim();
  }
  return '';
}

export interface PersonaDispatchInput {
  store: Store;
  bus: Bus;
  startTurn: StartTurnFn;
  isRunActive: (runId: string) => boolean;
  fromAgent: Agent;
  fromSessionId: string | null;
  fromRunId: string | null;
  currentHop: number;
  kind: 'message' | 'handoff';
  to: string;
  text: string;
  files?: string[];
  signal?: AbortSignal;
  handoffWaitMs?: number;
}

export interface PersonaDispatchResult {
  messageId: string;
  toAgentId: string;
  toAgentName: string;
  toSessionId: string;
  toRunId: string | null;
  status: PersonaMessageRow['status'];
  result: string | null;
  note: string;
}

export async function dispatchPersonaMessage(input: PersonaDispatchInput): Promise<PersonaDispatchResult> {
  const { store, bus, startTurn, isRunActive, fromAgent, fromSessionId, fromRunId, kind } = input;
  const text = input.text.trim();
  if (!text) throw new Error(kind === 'handoff' ? 'Missing task for handoff.' : 'Missing message text.');

  const target = resolveTargetAgent(store, fromAgent, input.to);
  if (target.id === fromAgent.id) throw new Error('A persona cannot message itself.');

  const hop = (input.currentHop || 0) + 1;
  const fileIds = validateFileIds(store, fromAgent.ownerId, input.files);
  const ts = now();
  const id = nid('pmsg');

  if (hop > MAX_PERSONA_HOPS) {
    insertMessageRow(store, {
      id, kind, fromAgentId: fromAgent.id, toAgentId: target.id,
      fromSessionId, toSessionId: null, fromRunId, toRunId: null,
      text, fileIds, hop, status: 'refused', result: `Hop limit (${MAX_PERSONA_HOPS}) exceeded.`,
      ownerId: fromAgent.ownerId, createdAt: ts, updatedAt: ts,
    });
    store.addLog('warn', `Refused ${kind} from ${fromAgent.name} to ${target.name}: hop ${hop} > ${MAX_PERSONA_HOPS}.`, { id, kind, hop, from: fromAgent.id, to: target.id }, 'persona-messaging');
    throw new Error(`Refused: message hop limit (${MAX_PERSONA_HOPS}) exceeded. Stop delegating between personas and report back to the user.`);
  }

  const toSessionId = targetSessionFor(store, target);
  const settings = store.getSettings();
  const autoStartAllowed = settings.personaAutoStart !== false;
  const recentCount = recentAutoStarts(store, target.id);
  const rateLimited = recentCount >= MAX_AUTO_STARTS_PER_WINDOW;

  if (kind === 'handoff' && rateLimited) {
    insertMessageRow(store, {
      id, kind, fromAgentId: fromAgent.id, toAgentId: target.id,
      fromSessionId, toSessionId, fromRunId, toRunId: null,
      text, fileIds, hop, status: 'refused', result: `Rate limit reached (${MAX_AUTO_STARTS_PER_WINDOW} auto-started runs per 10 min).`,
      ownerId: fromAgent.ownerId, createdAt: ts, updatedAt: ts,
    });
    store.addLog('warn', `Rate-limited handoff from ${fromAgent.name} to ${target.name} (${recentCount} runs in 10m).`, { id, kind, hop, from: fromAgent.id, to: target.id }, 'persona-messaging');
    throw new Error(`Rate limit reached: ${target.name} already had ${MAX_AUTO_STARTS_PER_WINDOW} auto-started runs in the last 10 minutes.`);
  }

  if (kind === 'handoff' && !autoStartAllowed) {
    insertMessageRow(store, {
      id, kind, fromAgentId: fromAgent.id, toAgentId: target.id,
      fromSessionId, toSessionId, fromRunId, toRunId: null,
      text, fileIds, hop, status: 'refused', result: 'Auto-starting other personas is disabled in Settings.',
      ownerId: fromAgent.ownerId, createdAt: ts, updatedAt: ts,
    });
    store.addLog('info', `Handoff from ${fromAgent.name} to ${target.name} skipped: personaAutoStart is off.`, { id, kind, hop }, 'persona-messaging');
    throw new Error('Personas cannot auto-start each other right now (disabled in Settings).');
  }

  const header = formatPersonaMessageHeader({ id, kind, fromAgentId: fromAgent.id, fromName: fromAgent.name, fromSessionId });
  const filesNote = fileIds.length ? `\n\nAttached file IDs: ${fileIds.join(', ')}` : '';
  const body = `${header}\n${text}${filesNote}`;

  store.insertMessage({
    sessionId: toSessionId, role: 'user', content: body,
    toolCalls: null, agentId: fromAgent.id, runId: null,
    toolCallId: null, toolName: null, imageUrl: null, routingNote: null,
  });
  bumpUnread(store, target.id);

  insertMessageRow(store, {
    id, kind, fromAgentId: fromAgent.id, toAgentId: target.id,
    fromSessionId, toSessionId, fromRunId, toRunId: null,
    text, fileIds, hop, status: 'sent', result: null,
    ownerId: fromAgent.ownerId, createdAt: ts, updatedAt: ts,
  });
  bus.publish({ type: 'persona_message', message: getPersonaMessage(store, id) } as never);
  store.addLog('info', `${fromAgent.name} sent ${kind} to ${target.name} (hop ${hop}).`, { id, kind, hop, from: fromAgent.id, to: target.id, fileIds }, 'persona-messaging');

  if (!autoStartAllowed || rateLimited) {
    const why = !autoStartAllowed
      ? `Delivered message to ${target.name} (auto-start is off in Settings).`
      : `Delivered message to ${target.name}, but did not auto-start a run (rate limit: ${MAX_AUTO_STARTS_PER_WINDOW} per 10 min).`;
    return { messageId: id, toAgentId: target.id, toAgentName: target.name, toSessionId, toRunId: null, status: 'sent', result: null, note: why };
  }

  // Start the target run through the normal engine path (MemoryBudget admission + approvals apply).
  let resolveHandoff: ((res: { status: PersonaMessageRow['status']; result: string }) => void) | null = null;
  let senderStillWaiting = kind === 'handoff';
  const handoffPromise = kind === 'handoff'
    ? new Promise<{ status: PersonaMessageRow['status']; result: string }>((resolve) => { resolveHandoff = resolve; })
    : null;

  const targetRun = await startTurn({
    sessionId: toSessionId,
    agentId: target.id,
    background: true,
    cursorExtras: {
      hop,
      sourceMessageId: id,
      sourceAgentId: fromAgent.id,
      sourceSessionId: fromSessionId ?? undefined,
      sourceRunId: fromRunId ?? undefined,
    },
    onDone: (finished) => {
      const reply = lastReplyForRun(store, toSessionId, finished.id) || (finished.error ? `Run failed: ${finished.error}` : 'Completed with no reply.');
      const finalStatus: PersonaMessageRow['status'] = finished.status === 'completed' ? 'completed' : 'failed';
      updateMessageRow(store, id, { status: finalStatus, result: reply });
      bus.publish({ type: 'persona_message', message: getPersonaMessage(store, id) } as never);
      store.addLog('info', `${kind} ${id} on ${target.name} ${finalStatus}.`, { id, kind, toRunId: finished.id, status: finalStatus }, 'persona-messaging');

      if (kind === 'handoff') {
        if (senderStillWaiting && resolveHandoff) {
          resolveHandoff({ status: finalStatus, result: reply });
          resolveHandoff = null;
        } else if (fromSessionId && (!fromRunId || !isRunActive(fromRunId))) {
          // Sender already finished: post the handoff result back into the sender's chat.
          const backHeader = formatPersonaMessageHeader({ id, kind: 'handoff', fromAgentId: target.id, fromName: target.name, fromSessionId: toSessionId });
          store.insertMessage({
            sessionId: fromSessionId, role: 'user', content: `${backHeader}\n${reply}`,
            toolCalls: null, agentId: target.id, runId: null,
            toolCallId: null, toolName: null, imageUrl: null, routingNote: null,
          });
          bumpUnread(store, fromAgent.id);
          bus.publish({ type: 'persona_message', message: getPersonaMessage(store, id) } as never);
        }
      }
    },
  });

  updateMessageRow(store, id, { toRunId: targetRun.id, status: 'running' });
  bus.publish({ type: 'persona_message', message: getPersonaMessage(store, id) } as never);

  if (kind === 'message') {
    return {
      messageId: id, toAgentId: target.id, toAgentName: target.name, toSessionId, toRunId: targetRun.id,
      status: 'running', result: null,
      note: `Sent message to ${target.name} and started run ${targetRun.id}.`,
    };
  }

  // Handoff: wait for the target run to complete (or until sender aborts / wait timeout).
  const waitMs = input.handoffWaitMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    handoffPromise!,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
      timer.unref?.();
      input.signal?.addEventListener('abort', () => resolve(null), { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    senderStillWaiting = false;
  });

  if (done) {
    return {
      messageId: id, toAgentId: target.id, toAgentName: target.name, toSessionId, toRunId: targetRun.id,
      status: done.status, result: done.result,
      note: `Handoff to ${target.name} ${done.status}:\n${done.result}`,
    };
  }

  return {
    messageId: id, toAgentId: target.id, toAgentName: target.name, toSessionId, toRunId: targetRun.id,
    status: 'running', result: null,
    note: `Handoff to ${target.name} is still running (run ${targetRun.id}). Its result will be posted back to this chat when it finishes.`,
  };
}
