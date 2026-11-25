import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.js';
import type { Tool } from './tools.js';
import { extractDocxText, extractPdfText, readZipEntry } from './kb.js';
import { locatePath } from './workshops.js';
import { nid, now } from './util.js';
import { OWNER_ID, accountDir } from './accounts.js';

/** A file the owner uploaded or an agent produced. Stored under <data>/files/<id>/<name>. */
export interface FileRow {
  id: string; sessionId: string | null; messageId: string | null; agentId: string | null;
  name: string; mime: string; size: number; source: 'upload' | 'agent'; createdAt: string; ownerId: string;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', log: 'text/plain',
  js: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript', py: 'text/x-python', sh: 'text/x-shellscript',
  java: 'text/x-java', kt: 'text/x-kotlin', go: 'text/x-go', rs: 'text/x-rust', c: 'text/x-c', cpp: 'text/x-c++', css: 'text/css', sql: 'text/x-sql',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive', exe: 'application/vnd.microsoft.portable-executable',
};

export function mimeFor(name: string): string {
  return MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function ensureFilesTable(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, agent_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, source TEXT NOT NULL, rel_path TEXT NOT NULL, text_index TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  )`);
  const cols = (store.db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((row) => row.name);
  if (!cols.includes('owner_id')) store.db.exec(`ALTER TABLE files ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'owner'`);
}

function safeName(name: string) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return (base || 'file').slice(0, 160);
}

/** Text the agent and the search can read: plain text, PDF and Office text, zip listings. Pages are marked as "--- page N ---" where known. */
export function indexText(name: string, bytes: Buffer): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  try {
    if (ext === 'pdf') return extractPdfText(bytes).slice(0, 200_000);
    if (ext === 'docx') return extractDocxText(bytes).slice(0, 200_000);
    if (ext === 'pptx') return pptxText(bytes).map((slide, i) => `--- slide ${i + 1} ---\n${slide}`).join('\n').slice(0, 200_000);
    if (ext === 'xlsx') return xlsxSharedStrings(bytes).join(' ').slice(0, 200_000);
    if (ext === 'zip' || ext === 'apk') return zipNames(bytes).slice(0, 400).join('\n');
    if (bytes.subarray(0, 8000).includes(0)) return '';
    return bytes.toString('utf8').slice(0, 200_000);
  } catch {
    return '';
  }
}

const unxml = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function pptxText(bytes: Buffer): string[] {
  const slides: string[] = [];
  for (let i = 1; i <= 300; i += 1) {
    const xml = readZipEntry(bytes, `ppt/slides/slide${i}.xml`);
    if (!xml) break;
    const paragraphs = xml.toString('utf8').split(/<\/a:p>/).map((part) => [...part.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unxml(m[1]!)).join('')).filter(Boolean);
    slides.push(paragraphs.join('\n'));
  }
  return slides;
}

function xlsxSharedStrings(bytes: Buffer): string[] {
  const xml = readZipEntry(bytes, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1]!));
}

/** Names in a zip central directory (also works for APKs). */
export function zipNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return names;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

export function filesDir(dataDir: string) {
  const dir = path.join(dataDir, 'files');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveFile(store: Store, dataDir: string, input: { name: string; bytes: Buffer; sessionId?: string | null; messageId?: string | null; agentId?: string | null; source: 'upload' | 'agent'; mime?: string; ownerId?: string }): FileRow {
  if (!input.bytes.length) throw new Error('That file is empty.');
  if (input.bytes.length > MAX_FILE_BYTES) throw new Error(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const id = nid('file');
  const name = safeName(input.name);
  // The file belongs to the chat's (or persona's) account. Members' files sit in their own folder.
  const owner = input.ownerId
    ?? (input.sessionId ? (store.db.prepare('SELECT owner_id FROM chat_sessions WHERE id = ?').get(input.sessionId) as { owner_id?: string } | undefined)?.owner_id : undefined)
    ?? (input.agentId ? (store.db.prepare('SELECT owner_id FROM agents WHERE id = ?').get(input.agentId) as { owner_id?: string } | undefined)?.owner_id : undefined)
    ?? OWNER_ID;
  const rel = owner === OWNER_ID ? path.join(id, name) : path.join('users', owner, 'files', id, name);
  const full = owner === OWNER_ID ? path.join(filesDir(dataDir), rel) : path.join(accountDir(dataDir, owner), 'files', id, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, input.bytes);
  store.db.prepare('INSERT INTO files (id, session_id, message_id, agent_id, name, mime, size, source, rel_path, text_index, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, input.sessionId ?? null, input.messageId ?? null, input.agentId ?? null, name, input.mime || mimeFor(name), input.bytes.length, input.source, rel, indexText(name, input.bytes), now(), owner,
  );
  return getFile(store, id)!;
}

const mapFile = (row: Record<string, unknown>): FileRow => ({
  id: String(row.id), sessionId: (row.session_id as string) ?? null, messageId: (row.message_id as string) ?? null, agentId: (row.agent_id as string) ?? null,
  name: String(row.name), mime: String(row.mime), size: Number(row.size), source: row.source === 'agent' ? 'agent' : 'upload', createdAt: String(row.created_at),
  ownerId: String(row.owner_id || OWNER_ID),
});

function fileRow(store: Store, id: string, columns = '*'): Record<string, unknown> | undefined {
  const clean = String(id || '').replace(/^file:/, '').trim();
  if (!clean) return undefined;
  const direct = store.db.prepare(`SELECT ${columns} FROM files WHERE id = ?`).get(clean) as Record<string, unknown> | undefined;
  if (direct) return direct;
  if (!clean.startsWith('file_')) {
    return store.db.prepare(`SELECT ${columns} FROM files WHERE id = ?`).get(`file_${clean}`) as Record<string, unknown> | undefined;
  }
  return undefined;
}

export function getFile(store: Store, id: string): FileRow | null {
  const row = fileRow(store, id, '*');
  return row ? mapFile(row) : null;
}

export function filePath(store: Store, dataDir: string, id: string): string | null {
  const row = fileRow(store, id, 'rel_path, owner_id') as { rel_path: string; owner_id?: string } | undefined;
  if (!row) return null;
  const owner = row.owner_id || OWNER_ID;
  const root = owner === OWNER_ID ? filesDir(dataDir) : path.resolve(accountDir(dataDir, owner), 'files');
  const full = owner === OWNER_ID ? path.resolve(root, row.rel_path) : path.resolve(dataDir, row.rel_path);
  return full.startsWith(root + path.sep) && fs.existsSync(full) ? full : null;
}

/**
 * Copy an uploaded chat file into `<workspacePath>/uploads/` (mounted in the Docker workbench)
 * under a shell-safe filename, avoiding collisions across same-named uploads of different sizes.
 */
export function stageFileIntoWorkspace(store: Store, dataDir: string, fileId: string, workspacePath: string): string | null {
  const file = getFile(store, fileId);
  const src = filePath(store, dataDir, fileId);
  if (!file || !src || !workspacePath) return null;
  const srcStat = fs.statSync(src);
  const rawBase = path.basename(file.name);
  const safe = rawBase.replace(/^\$+/, '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || file.id;
  const uploadsDir = path.join(workspacePath, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  let finalName = safe;
  const candidate = path.join(uploadsDir, safe);
  if (fs.existsSync(candidate)) {
    try {
      const existing = fs.statSync(candidate);
      if (existing.size !== srcStat.size) finalName = `${file.id}_${safe}`;
    } catch {
      finalName = `${file.id}_${safe}`;
    }
  }
  const dest = path.join(uploadsDir, finalName);
  const needCopy = !fs.existsSync(dest) || (() => {
    try { return fs.statSync(dest).size !== srcStat.size; } catch { return true; }
  })();
  if (needCopy) fs.copyFileSync(src, dest);
  return `uploads/${finalName}`;
}

export function fileText(store: Store, id: string): string {
  const row = fileRow(store, id, 'text_index') as { text_index: string } | undefined;
  return row?.text_index ?? '';
}

export function listFiles(store: Store, opts: { sessionId?: string | null; query?: string; limit?: number; ownerId: string; source?: 'upload' | 'agent' }): (FileRow & { snippet?: string })[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = (opts.query || '').trim();
  const where: string[] = ['owner_id = ?'];
  const args: (string | number)[] = [opts.ownerId];
  if (opts.sessionId) { where.push('session_id = ?'); args.push(opts.sessionId); }
  if (opts.source) { where.push(opts.source === 'upload' ? "source = 'upload'" : "source <> 'upload'"); }
  if (q) { where.push('(name LIKE ? ESCAPE \'\\\' OR text_index LIKE ? ESCAPE \'\\\')'); const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; args.push(like, like); }
  const rows = store.db.prepare(`SELECT * FROM files ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as Record<string, unknown>[];
  return rows.map((row) => ({ ...mapFile(row), snippet: q ? snippetOf(String(row.text_index || ''), q) : undefined }));
}

export function deleteFile(store: Store, dataDir: string, id: string): boolean {
  const full = filePath(store, dataDir, id);
  const result = store.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  if (full) fs.rmSync(path.dirname(full), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'previews', id.replace(/[^\w-]/g, '')), { recursive: true, force: true });
  return Number(result.changes) > 0;
}

export function snippetOf(text: string, query: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, width);
  const start = Math.max(0, at - width / 2);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width)}${start + width < flat.length ? '…' : ''}`;
}

/** Search earlier messages: this chat first, then every chat when scope is "all". */
export function searchMessages(store: Store, opts: { sessionId?: string | null; query: string; scope?: 'session' | 'all'; limit?: number; ownerId: string }) {
  const q = opts.query.trim();
  if (!q) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const limit = Math.min(opts.limit ?? 8, 30);
  const rows = (opts.scope === 'all' || !opts.sessionId
    ? store.db.prepare(`SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title FROM messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.owner_id = ? AND m.role IN ('user','assistant') AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?`).all(opts.ownerId, like, limit)
    : store.db.prepare(`SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title FROM messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.session_id = ? AND s.owner_id = ? AND m.role IN ('user','assistant') AND m.content LIKE ? ESCAPE '\\' ORDER BY m.seq DESC LIMIT ?`).all(opts.sessionId, opts.ownerId, like, limit)) as Record<string, unknown>[];
  return rows.map((row) => ({ id: String(row.id), sessionId: String(row.session_id), role: String(row.role), title: String(row.title || ''), createdAt: String(row.created_at), snippet: snippetOf(String(row.content), q) }));
}

export function getMessageRow(store: Store, id: string, ownerId: string) {
  const row = store.db.prepare('SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title FROM messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.id = ? AND s.owner_id = ?').get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? { id: String(row.id), sessionId: String(row.session_id), role: String(row.role), content: String(row.content), createdAt: String(row.created_at), title: String(row.title || '') } : null;
}

export const CITE_HINT = '\n\nTo point at an earlier message write [msg:<id>]. To point at a file write [file:<id>] or [file:<id>#page=3] / [file:<id>#slide=2]. Use find_context to look up ids by text. The owner sees these as links. Quoted text from the owner arrives as a block that starts with "> **Quote** [msg:…]" or "[file:…]".';

/** Lets the agent look up earlier messages and files so it can quote and cite them. */
export function findContextTool(): Tool {
  return {
    name: 'find_context',
    description: 'Look up earlier messages and files (uploads and agent outputs) by text or by id, to quote or cite them. Pass query to search, or id (msg_… or file_…) to read one. scope "all" searches every chat. Cite results as [msg:<id>] or [file:<id>#page=N].',
    parameters: { type: 'object', properties: { query: { type: 'string' }, id: { type: 'string' }, scope: { type: 'string', enum: ['session', 'all'] } }, additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const owner = ctx.agent.ownerId || OWNER_ID;
      const id = String(args.id || '').trim().replace(/^\[?(msg|file):/, '').replace(/[\]#].*$/, '');
      if (id) {
        if (id.startsWith('file_')) {
          const file = getFile(ctx.store, id);
          if (!file || file.ownerId !== owner) return `No file ${id}.`;
          const text = fileText(ctx.store, id);
          return `[file:${file.id}] ${file.name} (${file.mime}, ${file.size} bytes)\n${text ? text.slice(0, 12_000) : 'No readable text in this file. Describe it by name and type.'}`;
        }
        const message = getMessageRow(ctx.store, id, owner);
        if (!message) return `No message ${id}.`;
        return `[msg:${message.id}] ${message.role} in "${message.title}" at ${message.createdAt}\n${message.content.slice(0, 12_000)}`;
      }
      const query = String(args.query || '').trim();
      if (!query) throw new Error('Pass query or id.');
      const scope = args.scope === 'all' ? 'all' : 'session';
      const messages = searchMessages(ctx.store, { sessionId: ctx.sessionId, query, scope, ownerId: owner });
      const files = listFiles(ctx.store, { query, limit: 8, ownerId: owner });
      const lines = [
        ...messages.map((row) => `[msg:${row.id}] ${row.role}${row.sessionId !== ctx.sessionId ? ` in "${row.title}"` : ''}: ${row.snippet}`),
        ...files.map((file) => `[file:${file.id}] ${file.name}: ${file.snippet || file.mime}`),
      ];
      return lines.length ? lines.join('\n') : `Nothing earlier matches "${query}".`;
    },
  };
}

/** Publishes a file the agent wrote so the owner can preview and download it from the chat. */
export function shareFileTool(dataDir: () => string): Tool {
  return {
    name: 'share_file',
    description: 'Show a file from the workspace or an open project to the owner in the chat, with a preview and a download button. Returns a [file:<id>] reference to put in the reply.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } }, required: ['path'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const hit = locatePath({ workspace: ctx.workspace, roots: ctx.roots, target: String(args.path || '') });
      if (!hit) throw new Error('That path is outside the workspace and the open projects.');
      const stat = fs.statSync(hit.full);
      if (!stat.isFile()) throw new Error('That is not a file.');
      if (stat.size > MAX_FILE_BYTES) throw new Error('That file is over 50 MB.');
      const file = saveFile(ctx.store, dataDir(), { name: String(args.name || path.basename(hit.full)), bytes: fs.readFileSync(hit.full), sessionId: ctx.sessionId, agentId: ctx.agent.id, source: 'agent', ownerId: ctx.agent.ownerId || OWNER_ID });
      return `Shared [file:${file.id}] ${file.name} (${file.size} bytes). Mention [file:${file.id}] in the reply.`;
    },
  };
}
