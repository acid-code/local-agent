import { crc32 } from 'node:zlib';
import { redact } from '@local-agent/shared';
import type { Store } from './db.js';

export const LOG_COMPONENTS = ['engine', 'router', 'context', 'providers', 'mcp', 'docker', 'triggers', 'repos', 'kb', 'setup', 'notify'] as const;
export type LogComponent = (typeof LOG_COMPONENTS)[number];
export const LOG_CAP_BYTES = 2_000_000;

const RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /password|secret|token|authorization|api[_-]?key|cookie|ciphertext|master/i;

export function levelEnabled(level: string, floor: string): boolean {
  return (RANK[level] ?? 20) >= (RANK[floor] ?? 20);
}

export function writeLog(store: Store, level: string, message: string, meta?: unknown, component: LogComponent = 'engine') {
  const floor = store.getSettings().debugLevel || 'info';
  if (!levelEnabled(level, floor)) return;
  const safe = redact(message).slice(0, 4000);
  const safeMeta = meta === undefined ? null : JSON.stringify(redactValue(meta)).slice(0, 4000);
  store.db.prepare('INSERT INTO logs (level, message, meta, component, created_at) VALUES (?, ?, ?, ?, ?)').run(
    level, safe, safeMeta, component, new Date().toISOString(),
  );
  const size = store.db.prepare('SELECT COALESCE(SUM(LENGTH(message) + LENGTH(COALESCE(meta, \'\'))), 0) AS n FROM logs').get() as { n: number };
  if (Number(size?.n ?? 0) <= LOG_CAP_BYTES) return;
  const count = store.db.prepare('SELECT COUNT(*) AS n FROM logs').get() as { n: number };
  store.db.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)').run(Math.max(1, Math.floor(Number(count?.n ?? 2) / 2)));
}

export function searchLogs(store: Store, opts: { component?: string; level?: string; q?: string; limit?: number }) {
  const component = opts.component && LOG_COMPONENTS.includes(opts.component as LogComponent) ? opts.component : '';
  const level = opts.level && RANK[opts.level] ? opts.level : '';
  const q = (opts.q || '').replace(/[%_]/g, '').slice(0, 80);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  return (store.db.prepare(`SELECT * FROM logs
    WHERE (? = '' OR component = ?)
      AND (? = '' OR level = ?)
      AND (? = '' OR message LIKE ?)
    ORDER BY id DESC LIMIT ?`).all(component, component, level, level, q, `%${q}%`, limit) as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id),
    level: String(row.level),
    component: String(row.component || 'engine'),
    message: String(row.message),
    meta: row.meta ? JSON.parse(String(row.meta)) : null,
    createdAt: String(row.created_at),
  }));
}

export function redactValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key) && key !== 'debugLevel') return '[redacted]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [child, inner] of Object.entries(value as Record<string, unknown>)) out[child] = redactValue(inner, child);
    return out;
  }
  return value;
}

export interface DoctorInput {
  ollamaOk: boolean;
  loaded: { name: string; contextLength: number | null }[];
  dockerOk: boolean;
  mcpErrors: number;
  mcpCount: number;
  searxngOk: boolean;
  tailscaleOk: boolean;
  telegramQueued: number;
  dbBytes: number;
  diskFreeBytes: number;
  memAvailableGiB: number;
  geminiOpen: boolean | null;
  /** off: the provider is disabled or has no API key. */
  geminiState?: 'open' | 'quota' | 'off' | 'unknown';
  lastBackupAt: string | null;
}

export function doctorChecks(input: DoctorInput): { id: string; ok: boolean; detail: string }[] {
  return [
    { id: 'ollama', ok: input.ollamaOk, detail: input.ollamaOk ? `${input.loaded.length} model${input.loaded.length === 1 ? '' : 's'} loaded.` : 'Ollama did not answer /api/ps.' },
    ...input.loaded.map((model) => ({ id: `ctx:${model.name}`, ok: (model.contextLength ?? 0) >= 8192, detail: model.contextLength ? `${model.name} num_ctx ${model.contextLength}.` : `${model.name} did not report num_ctx.` })),
    { id: 'docker', ok: input.dockerOk, detail: input.dockerOk ? 'Docker answered.' : 'Docker is not available.' },
    { id: 'mcp', ok: input.mcpErrors === 0, detail: input.mcpErrors ? `${input.mcpErrors} of ${input.mcpCount} MCP servers are in error.` : `${input.mcpCount} MCP servers.` },
    { id: 'searxng', ok: input.searxngOk, detail: input.searxngOk ? 'SearXNG answered.' : 'SearXNG did not answer.' },
    { id: 'tailscale', ok: input.tailscaleOk, detail: input.tailscaleOk ? 'Tailscale is up.' : 'Tailscale was not detected. The LAN URL still works at home.' },
    { id: 'telegram', ok: true, detail: input.telegramQueued ? `${input.telegramQueued} notification${input.telegramQueued === 1 ? '' : 's'} waiting to send.` : 'Telegram queue is empty.' },
    { id: 'db', ok: input.dbBytes < 2 * 1024 ** 3, detail: `Database is ${input.dbBytes} bytes.` },
    { id: 'disk', ok: input.diskFreeBytes > 5 * 1024 ** 3, detail: input.diskFreeBytes > 5 * 1024 ** 3 ? 'Disk has room.' : 'Less than 5 GB free. A model pull will fail.' },
    { id: 'ram', ok: input.memAvailableGiB >= 4, detail: `${input.memAvailableGiB.toFixed(1)} GiB available.` },
    geminiCheck(input),
    { id: 'backup', ok: Boolean(input.lastBackupAt), detail: input.lastBackupAt ? `Last backup ${input.lastBackupAt}.` : 'No backup has been taken.' },
  ];
}

function geminiCheck(input: DoctorInput) {
  const state = input.geminiState ?? (input.geminiOpen === false ? 'quota' : input.geminiOpen === true ? 'open' : 'unknown');
  if (state === 'off') return { id: 'gemini', ok: true, detail: 'Gemini is off (disabled or no GEMINI_API_KEY). Turns stay local.' };
  if (state === 'quota') return { id: 'gemini', ok: false, detail: 'Gemini free-tier quota is used up. Turns stay local.' };
  return { id: 'gemini', ok: true, detail: 'Gemini quota is open or unused.' };
}

/** Gemini state from the provider row and the environment. */
export function geminiStateOf(provider: { enabled: boolean; apiKeyEnv: string | null } | undefined | null, env: NodeJS.ProcessEnv = process.env): 'open' | 'off' {
  if (!provider?.enabled) return 'off';
  return env[provider.apiKeyEnv || 'GEMINI_API_KEY'] ? 'open' : 'off';
}

export function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, file.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
