import { getLoadablePath } from 'sqlite-vec';
import { hashEmbed, topK } from '@local-agent/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { ChunkRow, Store } from './db.js';

export class VectorIndex {
  enabled = false;

  constructor(private readonly db: DatabaseSync) {
    try {
      db.enableLoadExtension(true);
      db.loadExtension(getLoadablePath());
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[256])');
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  add(rowid: number, embedding: Float32Array) {
    if (!this.enabled || embedding.length !== 256) return;
    this.db.prepare('INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)').run(
      BigInt(rowid),
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    );
  }

  search(query: Float32Array, k: number): { rowid: number; distance: number }[] {
    if (!this.enabled) return [];
    const rows = this.db.prepare('SELECT rowid, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ?').all(
      Buffer.from(query.buffer, query.byteOffset, query.byteLength),
      k,
    ) as { rowid: number | bigint; distance: number }[];
    return rows.map((row) => ({ rowid: Number(row.rowid), distance: Number(row.distance) }));
  }
}

export function indexText(store: Store, index: VectorIndex, input: { sessionId: string; agentId: string | null; text: string }) {
  const embedding = hashEmbed(input.text);
  const id = `chunk_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const rowid = store.addChunk({
    id,
    sessionId: input.sessionId,
    agentId: input.agentId,
    text: input.text.slice(0, 4000),
    embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    dim: embedding.length,
    embedder: 'hash',
  });
  index.add(rowid, embedding);
  return id;
}

export function retrieve(store: Store, index: VectorIndex, sessionId: string, query: string, k = 4) {
  const queryVector = hashEmbed(query);
  const chunks = store.listChunks(sessionId).filter((chunk) => chunk.embedder === 'hash' && chunk.embedding);
  if (index.enabled) {
    const hits = index.search(queryVector, k);
    const byRow = new Map(chunks.map((chunk) => [chunk.rowid, chunk]));
    const ranked = hits.map((hit) => byRow.get(hit.rowid)).filter((chunk): chunk is ChunkRow => Boolean(chunk));
    if (ranked.length) return ranked.map((chunk) => ({ id: chunk.id, text: chunk.text, score: 1 }));
  }
  return topK(chunks, (chunk) => new Float32Array(chunk.embedding!.buffer, chunk.embedding!.byteOffset, chunk.dim), queryVector, k)
    .map((hit) => ({ id: hit.item.id, text: hit.item.text, score: hit.score }));
}
