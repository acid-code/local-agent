import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OWNER_ID } from './accounts.js';
import type { Approval, RunRow, StepRow, Store } from './db.js';
import { redactValue } from './debug.js';

/**
 * Remote monitoring API: read-only, token-protected (no browser session), safe to poll from a phone or a cron job over
 * Tailscale. Secrets are redacted everywhere; members' chat content, tool arguments and results are hidden unless the
 * owner turns that on (LA_MONITOR_MEMBER_CONTENT=1). Every run gets a false-success check: a reply that claims success
 * after a tool error with no word about the failure.
 */
export const MONITOR_PREFIX = '/api/monitor/';
const CLIP = 600;

// ── Token ─────────────────────────────────────────────────────────────────────────────────────────────────────
const sha = (value: string) => createHash('sha256').update(value).digest();
export function ensureMonitorTable(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS monitor_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)');
}
export function createMonitorToken(store: Store, label = 'monitor'): { id: string; token: string } {
  ensureMonitorTable(store);
  const id = `mt_${randomBytes(4).toString('hex')}`;
  const token = `lam_${randomBytes(24).toString('base64url')}`;
  store.db.prepare('INSERT INTO monitor_tokens (id, hash, label, created_at) VALUES (?, ?, ?, ?)').run(id, sha(token).toString('hex'), label.slice(0, 60), new Date().toISOString());
  return { id, token };
}
export function listMonitorTokens(store: Store) {
  ensureMonitorTable(store);
  return store.db.prepare('SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM monitor_tokens ORDER BY created_at DESC').all();
}
export function revokeMonitorToken(store: Store, id: string) {
  ensureMonitorTable(store);
  return Number(store.db.prepare('DELETE FROM monitor_tokens WHERE id = ?').run(id).changes) > 0;
}
/** Bearer token from a saved monitor token or LA_MONITOR_TOKEN. Constant-time compare on hashes. */
export function checkMonitorToken(store: Store, header: string | undefined): boolean {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!token || token.length < 16) return false;
  const hash = sha(token);
  const env = process.env.LA_MONITOR_TOKEN;
  if (env && env.length >= 16 && timingSafeEqual(sha(env), hash)) return true;
  ensureMonitorTable(store);
  for (const row of store.db.prepare('SELECT id, hash FROM monitor_tokens').all() as { id: string; hash: string }[]) {
    if (timingSafeEqual(Buffer.from(row.hash, 'hex'), hash)) {
      store.db.prepare('UPDATE monitor_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      return true;
    }
  }
  return false;
}

// ── False success ─────────────────────────────────────────────────────────────────────────────────────────────
const CLAIMS = /\b(done|completed?|succeeded|success(?:fully)?|fixed|created|saved|sent|deployed|pushed|installed|all set|finished|works now)\b|✅|הושלם|בוצע|נשמר|נשלח|תוקן|סיימתי|מוכן/i;
const ADMITS = /\b(error|failed|fail(?:ure)?|couldn'?t|could not|unable|didn'?t work|not able|blocked|denied|timed? out|instead|retry|retried|another way)\b|נכשל|שגיאה|לא הצלח|לא הצלחתי|נחסם/i;

export interface FalseSuccess { flagged: boolean; reason: string; failedTools: string[] }
/** Claims success in the final reply after a failed tool call, without admitting the failure, and no later success of the same tool. */
export function falseSuccess(steps: Pick<StepRow, 'kind' | 'name' | 'status' | 'error' | 'index'>[], finalReply: string, runStatus: string): FalseSuccess {
  const tools = steps.filter((step) => step.kind === 'tool' || step.kind === 'contract');
  const failed = tools.filter((step) => step.status === 'failed' || step.status === 'error' || Boolean(step.error));
  // A failure that a later call of the same tool recovered from does not count.
  const unrecovered = failed.filter((step) => !tools.some((later) => later.name === step.name && later.index > step.index && later.status === 'completed' && !later.error));
  const names = [...new Set(unrecovered.map((step) => step.name))];
  if (!unrecovered.length) return { flagged: false, reason: '', failedTools: [] };
  if (runStatus === 'failed') return { flagged: false, reason: 'run reported failure', failedTools: names };
  if (CLAIMS.test(finalReply) && !ADMITS.test(finalReply)) return { flagged: true, reason: `Reply claims success after ${names.join(', ')} failed and never mentions it.`, failedTools: names };
  return { flagged: false, reason: 'failure acknowledged', failedTools: names };
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────────────
const clip = (value: unknown) => {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);
  return text.length > CLIP ? `${text.slice(0, CLIP)}… (${text.length} chars)` : text;
};
const ms = (from: string, to: string | null) => (to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null);

export interface MonitorDeps { store: Store; redact: (text: string) => string; health: () => Promise<unknown[]>; memory: () => Promise<unknown> }

function ownerOf(store: Store, run: RunRow): string {
  const row = store.db.prepare('SELECT owner_id AS ownerId FROM chat_sessions WHERE id = ?').get(run.sessionId) as { ownerId?: string } | undefined;
  return row?.ownerId || OWNER_ID;
}
const memberContent = () => process.env.LA_MONITOR_MEMBER_CONTENT === '1';
function finalReply(store: Store, run: RunRow): string {
  const messages = store.listMessages(run.sessionId).filter((message) => message.runId === run.id && message.role === 'assistant');
  return String(messages.at(-1)?.content ?? '');
}

export function runSummary(deps: MonitorDeps, run: RunRow) {
  const steps = deps.store.listSteps(run.id);
  const reply = finalReply(deps.store, run);
  const fs = falseSuccess(steps, reply, run.status);
  const model = deps.store.getModel(run.modelId ?? '')?.name ?? run.modelId;
  const owner = ownerOf(deps.store, run);
  return {
    id: run.id, status: run.status, phase: run.phase, agent: deps.store.getAgent(run.agentId)?.name ?? run.agentId, account: owner === OWNER_ID ? 'owner' : 'member',
    model, routing: run.routingNote, startedAt: run.startedAt, endedAt: run.endedAt, durationMs: ms(run.startedAt, run.endedAt),
    tokens: { in: run.inputTokens, out: run.outputTokens }, toolCalls: steps.filter((step) => step.kind === 'tool').length,
    toolErrors: steps.filter((step) => (step.kind === 'tool' || step.kind === 'contract') && (step.status === 'failed' || step.error)).length,
    error: run.error ? deps.redact(run.error).slice(0, 400) : null, falseSuccess: fs.flagged, falseSuccessReason: fs.flagged ? fs.reason : undefined,
    parentRunId: run.parentRunId,
  };
}

export function runTrace(deps: MonitorDeps, run: RunRow) {
  const { store, redact } = deps;
  const hide = ownerOf(store, run) !== OWNER_ID && !memberContent();
  const safe = (value: unknown) => (hide ? `[member content hidden: ${clip(value).length} chars]` : redact(clip(redactValue(value))));
  const steps = store.listSteps(run.id).map((step) => ({
    index: step.index, kind: step.kind, name: step.name, status: step.status, turn: step.turn, startedAt: step.startedAt, durationMs: step.latencyMs || ms(step.startedAt, step.endedAt),
    tokens: step.kind === 'model' ? { in: step.tokensIn, out: step.tokensOut } : undefined,
    // Model steps carry the prompt budget and estimate, not the prompt itself.
    prompt: step.kind === 'model' ? redactValue(step.input) : undefined,
    args: step.kind !== 'model' ? safe(step.input) : undefined,
    result: step.kind !== 'model' ? safe(step.output) : undefined,
    error: step.error ? redact(step.error).slice(0, 600) : null,
  }));
  const approvals = (store.listApprovals() as Approval[]).filter((item) => item.runId === run.id).map((item) => ({ tool: item.toolName, status: item.status, reason: redact(item.reason), args: safe(item.args), createdAt: item.createdAt, resolvedAt: item.resolvedAt }));
  const reply = finalReply(store, run);
  const flags = falseSuccess(store.listSteps(run.id), reply, run.status);
  return {
    run: runSummary(deps, run), steps, approvals,
    finalReply: hide ? `[member content hidden: ${reply.length} chars]` : redact(clip(reply)),
    falseSuccess: flags, memberContentHidden: hide,
  };
}

export function sinceOf(raw: unknown, fallbackHours = 24): string {
  const text = String(raw ?? '');
  const rel = /^(\d+)([hd])$/.exec(text);
  if (rel) return new Date(Date.now() - Number(rel[1]) * (rel[2] === 'd' ? 86_400_000 : 3_600_000)).toISOString();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(Date.now() - fallbackHours * 3_600_000).toISOString();
}

function runsSince(store: Store, since: string, limit = 500): RunRow[] {
  return store.listRuns(5000).filter((run) => run.startedAt >= since).slice(0, limit);
}

export function errorsSince(deps: MonitorDeps, since: string) {
  const logs = deps.store.db.prepare("SELECT level, component, message, created_at AS at FROM logs WHERE level IN ('error','warn') AND created_at >= ? ORDER BY id DESC LIMIT 200").all(since) as { level: string; component: string; message: string; at: string }[];
  const runs = runsSince(deps.store, since);
  const failedRuns = runs.filter((run) => run.status === 'failed' || run.error).map((run) => ({ runId: run.id, at: run.startedAt, error: deps.redact(run.error ?? run.status).slice(0, 400) }));
  const toolErrors = runs.flatMap((run) => deps.store.listSteps(run.id).filter((step) => step.error && step.kind !== 'model').map((step) => ({ runId: run.id, tool: step.name, at: step.startedAt, error: deps.redact(step.error!).slice(0, 300) })));
  return { since, logs: logs.map((row) => ({ ...row, message: deps.redact(row.message) })), failedRuns, toolErrors: toolErrors.slice(0, 200) };
}

export function summarySince(deps: MonitorDeps, since: string) {
  const runs = runsSince(deps.store, since, 5000);
  const summaries = runs.map((run) => runSummary(deps, run));
  const byStatus: Record<string, number> = {};
  for (const row of summaries) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  const toolFailures: Record<string, number> = {};
  for (const run of runs) for (const step of deps.store.listSteps(run.id)) if (step.kind === 'tool' && (step.status === 'failed' || step.error)) toolFailures[step.name] = (toolFailures[step.name] ?? 0) + 1;
  const durations = summaries.map((row) => row.durationMs).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  const approvals = (deps.store.listApprovals() as Approval[]).filter((item) => item.createdAt >= since);
  const models: Record<string, number> = {};
  for (const row of summaries) if (row.model) models[row.model] = (models[row.model] ?? 0) + 1;
  return {
    since, runs: runs.length, byStatus, models,
    falseSuccess: summaries.filter((row) => row.falseSuccess).map((row) => ({ runId: row.id, reason: row.falseSuccessReason })),
    toolFailures, durationMs: { p50: durations[Math.floor(durations.length / 2)] ?? null, p90: durations[Math.floor(durations.length * 0.9)] ?? null, max: durations.at(-1) ?? null },
    tokens: { in: summaries.reduce((sum, row) => sum + row.tokens.in, 0), out: summaries.reduce((sum, row) => sum + row.tokens.out, 0) },
    approvals: { total: approvals.length, pending: approvals.filter((item) => item.status === 'pending').length, denied: approvals.filter((item) => item.status === 'denied').length },
    errors: deps.store.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE level = 'error' AND created_at >= ?").get(since),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Token shapes the shared redactor does not know (GitHub, Slack, bearer headers, our own monitor tokens). */
export function scrub(text: string): string {
  return text
    .replace(/\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}\b/g, '$1_[redacted]').replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[redacted]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'xox-[redacted]').replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\blam_[A-Za-z0-9_-]{12,}\b/g, 'lam_[redacted]').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key redacted]');
}

export function registerMonitor(app: FastifyInstance, raw: MonitorDeps & { ownerOnly: (req: FastifyRequest) => void }) {
  const deps = { ...raw, redact: (text: string) => scrub(raw.redact(text)) };
  const { store } = deps;
  ensureMonitorTable(store);
  const notFound = () => Object.assign(new Error('Run not found.'), { statusCode: 404 });
  app.get('/api/monitor/runs', async (req) => {
    const query = req.query as { since?: string; status?: string; limit?: string; flagged?: string };
    let rows = runsSince(store, sinceOf(query.since, 72), Math.min(500, Number(query.limit) || 50)).map((run) => runSummary(deps, run));
    if (query.status) rows = rows.filter((row) => row.status === query.status);
    if (query.flagged === '1') rows = rows.filter((row) => row.falseSuccess || row.toolErrors || row.error);
    return { runs: rows };
  });
  app.get('/api/monitor/runs/:id/trace', async (req) => {
    const run = store.getRun((req.params as { id: string }).id);
    if (!run) throw notFound();
    return runTrace(deps, run);
  });
  app.get('/api/monitor/errors', async (req) => errorsSince(deps, sinceOf((req.query as { since?: string }).since)));
  app.get('/api/monitor/summary', async (req) => summarySince(deps, sinceOf((req.query as { since?: string }).since)));
  app.get('/api/monitor/health', async () => {
    const [checks, memory] = await Promise.all([deps.health().catch((error: Error) => [{ id: 'health', ok: false, detail: error.message }]), deps.memory().catch(() => null)]);
    const active = store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('running','queued','awaiting_approval')").get() as { n: number };
    return { at: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), checks: redactValue(checks), memory, activeRuns: Number(active.n), ok: (checks as { ok?: boolean; optional?: boolean }[]).every((check) => check.ok !== false || check.optional) };
  });
  // Token management: owner session only (these are under /api/monitor-tokens so the bearer gate never covers them).
  app.get('/api/monitor-tokens', async (req) => { deps.ownerOnly(req); return { tokens: listMonitorTokens(store) }; });
  app.post('/api/monitor-tokens', async (req) => {
    deps.ownerOnly(req);
    const label = String((req.body as { label?: string } | undefined)?.label || 'monitor');
    return createMonitorToken(store, label);
  });
  app.delete('/api/monitor-tokens/:id', async (req) => { deps.ownerOnly(req); return { revoked: revokeMonitorToken(store, (req.params as { id: string }).id) }; });
}
