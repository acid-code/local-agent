import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { getLoadablePath } from 'sqlite-vec';
import { hashEmbed } from '@local-agent/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db.js';
import { nid, now } from './util.js';

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'h', 'hpp', 'cpp', 'cs', 'rb', 'php', 'sh', 'css', 'json', 'yml', 'yaml', 'toml', 'sql', 'xml']);
const TEXT_EXT = new Set(['md', 'txt', 'html', 'htm', ...CODE_EXT]);

export interface TextChunk {
  heading: string;
  text: string;
  ordinal: number;
}

export interface KbHit {
  collectionId: string;
  collection: string;
  documentId: string;
  document: string;
  path: string | null;
  heading: string;
  text: string;
  score: number;
}

export type EmbedFn = (texts: string[]) => Promise<{ vectors: Float32Array[]; embedder: string }>;

export function hashEmbedder(): EmbedFn {
  return async (texts) => ({ vectors: texts.map((text) => hashEmbed(text)), embedder: 'hash' });
}

export function ollamaEmbedder(fetchImpl: typeof fetch, model = 'nomic-embed-text'): EmbedFn {
  return async (texts) => {
    const base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    try {
      const response = await fetchImpl(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const json = await response.json() as { embeddings?: number[][] };
        const rows = json.embeddings ?? [];
        if (rows.length === texts.length && rows[0]?.length) {
          return { vectors: rows.map((row) => Float32Array.from(row)), embedder: model };
        }
      }
    } catch { /* the local model is optional */ }
    return hashEmbedder()(texts);
  };
}

export function chunkDocument(text: string, kind: 'markdown' | 'code' | 'prose', opts?: { size?: number; overlap?: number }): TextChunk[] {
  const size = opts?.size ?? 900;
  const overlap = opts?.overlap ?? 120;
  const sections = kind === 'markdown' ? splitMarkdown(text) : kind === 'code' ? splitCode(text) : [{ heading: '', text }];
  const out: TextChunk[] = [];
  for (const section of sections) {
    const body = section.text.trim();
    if (!body) continue;
    for (const window of windowText(body, size, overlap)) {
      out.push({
        heading: section.heading,
        text: section.heading ? `${section.heading}\n${window}` : window,
        ordinal: out.length,
      });
    }
  }
  return out;
}

function splitMarkdown(text: string): { heading: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { heading: string; text: string }[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    if (buf.join('').trim()) sections.push({ heading, text: buf.join('\n') });
    buf = [];
  };
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = `${match[1]} ${match[2].trim()}`;
    } else buf.push(line);
  }
  flush();
  return sections.length ? sections : [{ heading: '', text }];
}

function splitCode(text: string): { heading: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { heading: string; text: string }[] = [];
  let heading = '';
  let buf: string[] = [];
  const boundary = /^(export\s+)?(async\s+)?(function\s+|class\s+|def\s+|fn\s+|func\s+|type\s+|interface\s+|struct\s+)/;
  for (const line of lines) {
    if (boundary.test(line) && buf.join('').trim()) {
      sections.push({ heading, text: buf.join('\n') });
      buf = [];
      heading = line.trim().slice(0, 80);
    }
    buf.push(line);
  }
  if (buf.join('').trim()) sections.push({ heading, text: buf.join('\n') });
  return sections.length ? sections : [{ heading: '', text }];
}

export function windowText(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const step = Math.max(1, size - overlap);
  const windows: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    windows.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return windows;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

/** Okapi BM25 over the given documents. */
export function bm25Scores(docs: { id: string; text: string }[], query: string, k1 = 1.2, b = 0.75): Map<string, number> {
  const queryTerms = [...new Set(tokenize(query))];
  const scores = new Map<string, number>();
  if (!queryTerms.length || !docs.length) return scores;
  const docsTokens = docs.map((doc) => tokenize(doc.text));
  const avg = docsTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const tokens of docsTokens) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  docs.forEach((doc, index) => {
    const tokens = docsTokens[index]!;
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const f = freq.get(term) ?? 0;
      if (!f) continue;
      const documentFrequency = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (tokens.length / avg))));
    }
    scores.set(doc.id, score);
  });
  return scores;
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom ? dot / denom : 0;
}

export function hybridRank(
  docs: { id: string; text: string; vector: Float32Array | null }[],
  query: string,
  queryVector: Float32Array,
  k: number,
): { id: string; score: number }[] {
  const lexical = bm25Scores(docs, query);
  const lexRank = [...lexical.entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
  const vecRank = docs
    .filter((doc) => doc.vector && doc.vector.length === queryVector.length)
    .map((doc) => ({ id: doc.id, score: cosine(doc.vector!, queryVector) }))
    .sort((a, b) => b.score - a.score);
  const fused = new Map<string, number>();
  lexRank.forEach(([id], index) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + index + 1)));
  vecRank.forEach((hit, index) => fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (60 + index + 1)));
  return [...fused.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);
}

export function extractText(name: string, bytes: Buffer): { kind: 'markdown' | 'code' | 'prose'; text: string } {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === 'pdf') return { kind: 'prose', text: extractPdfText(bytes) };
  if (ext === 'docx') return { kind: 'prose', text: extractDocxText(bytes) };
  const raw = bytes.toString('utf8');
  if (ext === 'html' || ext === 'htm') return { kind: 'prose', text: raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  if (ext === 'md') return { kind: 'markdown', text: raw };
  if (CODE_EXT.has(ext)) return { kind: 'code', text: raw };
  if (TEXT_EXT.has(ext) || ext === 'txt' || ext === '') return { kind: 'prose', text: raw };
  throw new Error(`Unsupported file type .${ext || 'bin'}. Use PDF, DOCX, MD, TXT, HTML, or source code.`);
}

export function extractPdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const parts: string[] = [];
  for (const match of raw.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    parts.push(unescapePdf(match[0].replace(/\)\s*Tj$/, '').slice(1)));
  }
  for (const match of raw.matchAll(/\[(.*?)\]\s*TJ/gs)) {
    for (const piece of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) parts.push(unescapePdf(piece[0].slice(1, -1)));
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('This PDF has no extractable text. Scanned pages need OCR, which this version does not run.');
  return text;
}

function unescapePdf(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}

export function extractDocxText(bytes: Buffer): string {
  const xml = readZipEntry(bytes, 'word/document.xml');
  if (!xml) throw new Error('DOCX is missing word/document.xml.');
  return xml.toString('utf8')
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function readZipEntry(buffer: Buffer, name: string): Buffer | null {
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const entryName = buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);
    if (entryName === name) {
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    offset = dataStart + compSize;
  }
  return null;
}

class KbVectors {
  enabled = false;
  private ready = new Set<number>();

  constructor(private readonly db: DatabaseSync) {
    try {
      db.enableLoadExtension(true);
      db.loadExtension(getLoadablePath());
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  private table(dim: number) {
    const name = `kb_vec_${dim}`;
    if (!this.ready.has(dim)) {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${dim}])`);
      this.ready.add(dim);
    }
    return name;
  }

  add(dim: number, rowid: number, embedding: Float32Array) {
    if (!this.enabled || embedding.length !== dim) return;
    try {
      this.db.prepare(`INSERT INTO ${this.table(dim)}(rowid, embedding) VALUES (?, ?)`).run(
        BigInt(rowid),
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      );
    } catch { /* a rebuilt index still has the blob */ }
  }

  remove(dim: number, rowids: number[]) {
    if (!this.enabled || !rowids.length || !this.ready.has(dim)) return;
    const stmt = this.db.prepare(`DELETE FROM kb_vec_${dim} WHERE rowid = ?`);
    for (const rowid of rowids) {
      try { stmt.run(BigInt(rowid)); } catch { /* already gone */ }
    }
  }
}

const indexes = new WeakMap<DatabaseSync, KbVectors>();

function vectorsFor(store: Store): KbVectors {
  let index = indexes.get(store.db);
  if (!index) {
    index = new KbVectors(store.db);
    indexes.set(store.db, index);
  }
  return index;
}

export interface CollectionRow {
  id: string;
  name: string;
  agentId: string | null;
  rootPath: string | null;
  embedder: string;
  documents: number;
  bytes: number;
  chunks: number;
}

export function listCollections(store: Store): CollectionRow[] {
  const rows = store.db.prepare('SELECT * FROM kb_collections ORDER BY name').all() as Record<string, unknown>[];
  return rows.map((row) => {
    const id = String(row.id);
    const stats = store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM kb_documents WHERE collection_id = ?) AS documents,
      (SELECT COALESCE(SUM(bytes), 0) FROM kb_documents WHERE collection_id = ?) AS bytes,
      (SELECT COUNT(*) FROM kb_chunks WHERE collection_id = ?) AS chunks`).get(id, id, id) as { documents: number; bytes: number; chunks: number };
    return {
      id, name: String(row.name), agentId: row.agent_id ? String(row.agent_id) : null,
      rootPath: row.root_path ? String(row.root_path) : null, embedder: String(row.embedder),
      documents: Number(stats.documents), bytes: Number(stats.bytes), chunks: Number(stats.chunks),
    };
  });
}

export function kbUsage(store: Store) {
  const row = store.db.prepare(`SELECT
    (SELECT COUNT(*) FROM kb_documents) AS documents,
    (SELECT COUNT(*) FROM kb_chunks) AS chunks,
    (SELECT COALESCE(SUM(bytes), 0) FROM kb_documents) AS bytes,
    (SELECT COALESCE(SUM(LENGTH(embedding)), 0) FROM kb_chunks) AS embeddingBytes`).get() as { documents: number; chunks: number; bytes: number; embeddingBytes: number };
  return {
    documents: Number(row.documents),
    chunks: Number(row.chunks),
    bytes: Number(row.bytes),
    embeddingBytes: Number(row.embeddingBytes),
    collections: listCollections(store).map((collection) => ({ id: collection.id, name: collection.name, bytes: collection.bytes, chunks: collection.chunks, agentId: collection.agentId })),
  };
}

export function createCollection(store: Store, input: { name: string; agentId?: string | null; rootPath?: string | null }): CollectionRow {
  const id = nid('kbc');
  const ts = now();
  store.db.prepare('INSERT INTO kb_collections (id, name, agent_id, root_path, embedder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, input.name.trim(), input.agentId || null, input.rootPath || null, 'pending', ts, ts,
  );
  return listCollections(store).find((collection) => collection.id === id)!;
}

export async function ingestBuffer(
  store: Store,
  collectionId: string,
  file: { name: string; bytes: Buffer; path?: string | null },
  embed: EmbedFn,
): Promise<{ id: string; status: string; chunks: number; skipped: boolean }> {
  const collection = store.db.prepare('SELECT id FROM kb_collections WHERE id = ?').get(collectionId);
  if (!collection) throw new Error('Collection not found.');
  if (file.bytes.length > 8_000_000) throw new Error(`${file.name} is over 8 MB.`);
  const sha = createHash('sha256').update(file.bytes).digest('hex');
  const existing = store.db.prepare('SELECT id, sha256 FROM kb_documents WHERE collection_id = ? AND name = ? AND IFNULL(path, \'\') = ?').get(
    collectionId, file.name, file.path ?? '',
  ) as { id: string; sha256: string } | undefined;
  if (existing && existing.sha256 === sha) return { id: existing.id, status: 'indexed', chunks: 0, skipped: true };
  const extracted = extractText(file.name, file.bytes);
  const pieces = chunkDocument(extracted.text, extracted.kind);
  if (!pieces.length) throw new Error(`${file.name} had no text to index.`);
  const embedded = await embed(pieces.map((piece) => piece.text));
  const index = vectorsFor(store);
  const ts = now();
  const docId = existing?.id ?? nid('kbd');
  if (existing) {
    const old = store.db.prepare('SELECT rowid, dim FROM kb_chunks WHERE document_id = ?').all(existing.id) as { rowid: number; dim: number }[];
    for (const dim of new Set(old.map((row) => row.dim))) index.remove(dim, old.filter((row) => row.dim === dim).map((row) => Number(row.rowid)));
    store.db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(existing.id);
    store.db.prepare('UPDATE kb_documents SET bytes = ?, sha256 = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?').run(file.bytes.length, sha, 'indexed', ts, existing.id);
  } else {
    store.db.prepare('INSERT INTO kb_documents (id, collection_id, name, path, mime, bytes, sha256, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(
      docId, collectionId, file.name, file.path ?? null, path.extname(file.name).slice(1), file.bytes.length, sha, 'indexed', ts, ts,
    );
  }
  const insert = store.db.prepare('INSERT INTO kb_chunks (id, document_id, collection_id, ordinal, heading, text, embedding, dim, embedder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  pieces.forEach((piece, ordinal) => {
    const vector = embedded.vectors[ordinal] ?? hashEmbed(piece.text);
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const result = insert.run(nid('kbk'), docId, collectionId, ordinal, piece.heading, piece.text, blob, vector.length, embedded.embedder, ts);
    index.add(vector.length, Number(result.lastInsertRowid), vector);
  });
  store.db.prepare('UPDATE kb_collections SET embedder = ?, updated_at = ? WHERE id = ?').run(embedded.embedder, ts, collectionId);
  return { id: docId, status: 'indexed', chunks: pieces.length, skipped: false };
}

export async function ingestFolder(store: Store, collectionId: string, root: string, embed: EmbedFn) {
  const absolute = path.resolve(root);
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) throw new Error('That path is not a folder.');
  store.db.prepare('UPDATE kb_collections SET root_path = ?, updated_at = ? WHERE id = ?').run(absolute, now(), collectionId);
  const files = await walk(absolute);
  const results = [];
  for (const file of files) {
    const bytes = await fs.readFile(file);
    const relative = path.relative(absolute, file);
    try {
      results.push({ file: relative, ...(await ingestBuffer(store, collectionId, { name: path.basename(file), bytes, path: relative }, embed)) });
    } catch (error) {
      results.push({ file: relative, id: '', status: 'error', chunks: 0, skipped: false, error: error instanceof Error ? error.message : 'failed' });
    }
  }
  return results;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (TEXT_EXT.has(path.extname(entry.name).slice(1).toLowerCase()) || ['pdf', 'docx'].includes(path.extname(entry.name).slice(1).toLowerCase())) out.push(full);
    if (out.length > 400) break;
  }
  return out;
}

export async function reindexRoots(store: Store, embed: EmbedFn) {
  const rows = store.db.prepare('SELECT id, root_path FROM kb_collections WHERE root_path IS NOT NULL').all() as { id: string; root_path: string }[];
  const reports = [];
  for (const row of rows) {
    try {
      reports.push({ id: row.id, files: await ingestFolder(store, row.id, row.root_path, embed) });
    } catch (error) {
      reports.push({ id: row.id, error: error instanceof Error ? error.message : 'failed' });
    }
  }
  return reports;
}

export async function searchKnowledge(store: Store, query: string, opts: { agentId?: string | null; collectionId?: string | null; k?: number; embed?: EmbedFn }): Promise<KbHit[]> {
  const k = opts.k ?? 6;
  const collections = listCollections(store).filter((collection) => {
    if (opts.collectionId) return collection.id === opts.collectionId;
    if (!opts.agentId) return true;
    return collection.agentId === null || collection.agentId === opts.agentId;
  });
  if (!collections.length) return [];
  const ids = collections.map((collection) => collection.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = store.db.prepare(`SELECT c.id, c.collection_id, c.document_id, c.heading, c.text, c.embedding, c.dim, c.embedder, d.name AS document, d.path
    FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
    WHERE c.collection_id IN (${placeholders})`).all(...ids) as Record<string, unknown>[];
  const embedderName = String(rows[0]?.embedder ?? 'hash');
  const embed = opts.embed ?? (embedderName === 'hash' ? hashEmbedder() : ollamaEmbedder(fetch));
  const queryEmbedded = await embed([query]);
  const queryVector = queryEmbedded.vectors[0] ?? hashEmbed(query);
  const docs = rows.map((row) => {
    const blob = row.embedding as Buffer | null;
    const dim = Number(row.dim);
    const vector = blob && blob.length >= dim * 4 ? new Float32Array(blob.buffer, blob.byteOffset, dim) : null;
    return { id: String(row.id), text: String(row.text), vector: vector && vector.length === queryVector.length ? vector : null, row };
  });
  const ranked = hybridRank(docs, query, queryVector, k);
  const byId = new Map(docs.map((doc) => [doc.id, doc.row]));
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  return ranked.map((hit) => {
    const row = byId.get(hit.id)!;
    return {
      collectionId: String(row.collection_id),
      collection: names.get(String(row.collection_id)) ?? '',
      documentId: String(row.document_id),
      document: String(row.document),
      path: row.path ? String(row.path) : null,
      heading: String(row.heading),
      text: String(row.text),
      score: hit.score,
    };
  });
}

export function formatCitations(hits: KbHit[]): string {
  if (!hits.length) return 'No knowledge-base passages matched.';
  return hits.map((hit, index) => {
    const where = [hit.collection, hit.path || hit.document, hit.heading].filter(Boolean).join(' · ');
    return `[${index + 1}] ${where}\n${hit.text}`;
  }).join('\n\n');
}
