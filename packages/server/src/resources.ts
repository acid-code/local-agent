import fs from 'node:fs';
import path from 'node:path';
import { readGpu, readMem } from './discovery.js';
import type { DockerCtl } from './docker.js';
import type { Store } from './db.js';
import { nid } from './util.js';
import { kbUsage } from './kb.js';

export interface ResourceSnapshot {
  at: string;
  memory: { totalGiB: number; availableGiB: number };
  gpu: ReturnType<typeof readGpu>;
  disk: { path: string; totalBytes: number; freeBytes: number };
  dataBytes: number;
  logBytes: number;
  agents: { id: string; name: string; messages: number; messageBytes: number; summaries: number; summaryBytes: number; notes: number; noteBytes: number; chunks: number; embeddingBytes: number; workspaceBytes: number }[];
  knowledge: ReturnType<typeof kbUsage>;
  flags: { level: 'ok' | 'warn'; text: string }[];
  loadedModels?: { name: string; contextLength: number | null; sizeBytes: number | null }[];
}

export function snapshotResources(store: Store, dataDir: string): ResourceSnapshot {
  const total = osTotal();
  const available = readMem();
  const disk = diskOf(dataDir);
  const agents = store.listAgents().map((agent) => {
    const stats = store.messageStats(agent.id);
    return { id: agent.id, name: agent.name, ...stats, workspaceBytes: directorySize(agent.workspacePath, 4000) };
  });
  const dataBytes = directorySize(dataDir, 8000);
  const flags: ResourceSnapshot['flags'] = [];
  if (available < 8) flags.push({ level: 'warn', text: `Only ${available.toFixed(1)} GiB of RAM is available.` });
  if (disk.freeBytes < 20 * 1024 ** 3) flags.push({ level: 'warn', text: 'Less than 20 GB free on the data disk.' });
  for (const agent of agents) {
    if (agent.workspaceBytes > 2 * 1024 ** 3) flags.push({ level: 'warn', text: `${agent.name}'s workspace is over 2 GB.` });
  }
  if (dataBytes > 8 * 1024 ** 3) flags.push({ level: 'warn', text: 'The local-agent data directory is over 8 GB.' });
  const knowledge = kbUsage(store);
  if (knowledge.bytes > 2 * 1024 ** 3) flags.push({ level: 'warn', text: 'The knowledge base is over 2 GB.' });
  const body: ResourceSnapshot = { at: new Date().toISOString(), memory: { totalGiB: total, availableGiB: available }, gpu: readGpu(), disk, dataBytes, logBytes: logBytes(store), agents, knowledge, flags };
  store.addSample({ availableGiB: available, freeBytes: disk.freeBytes, dataBytes });
  return body;
}

export function previewPrune(store: Store, dataDir: string, action: string, target?: string) {
  const id = nid('prv');
  let bytes = 0;
  const items: string[] = [];
  let warning = 'This preview does nothing until you confirm it.';
  if (action === 'clear_logs') {
    bytes = logBytes(store);
    items.push('Delete log rows. Runs and chats stay.');
  } else if (action === 'vacuum') {
    items.push('VACUUM the SQLite file. This reclaims free pages and does not delete chats.');
    bytes = 0;
  } else if (action === 'archive_session' && target) {
    const messages = store.listMessages(target);
    const old = messages.slice(0, Math.max(0, messages.length - 8));
    bytes = old.reduce((sum, message) => sum + message.content.length, 0);
    items.push(`Archive ${old.length} older messages from this chat. Summaries stay. You can still read the archive.`);
    warning = 'Archived messages leave the live context. They are not deleted.';
  } else if (action === 'unload_model' && target) {
    items.push(`Ask Ollama to unload ${target} (keep_alive 0). Weights can be loaded again.`);
    warning = 'Unloading is reversible.';
  } else if (action === 'remove_image' && target) {
    items.push(`docker rmi ${target}`);
    warning = 'Removing an image is not reversible without pulling it again.';
  } else throw new Error('Unknown prune action.');
  const payload = { id, action, target: target ?? null, bytes, items, warning, createdAt: new Date().toISOString() };
  store.savePreview(id, payload);
  return payload;
}

export async function runPrune(store: Store, dataDir: string, previewId: string, docker: DockerCtl, fetchImpl: typeof fetch) {
  const saved = store.getPreview<{ action: string; target: string | null; items: string[] }>(previewId);
  if (!saved) throw new Error('Preview expired. Ask for a new one.');
  if (Date.now() - Date.parse(saved.createdAt) > 10 * 60_000) throw new Error('Preview expired. Ask for a new one.');
  const { action, target } = saved.payload;
  if (action === 'clear_logs') {
    const n = store.clearLogs();
    return { removed: n, detail: `Removed ${n} log rows.` };
  }
  if (action === 'vacuum') {
    store.db.exec('VACUUM');
    return { removed: 0, detail: 'Database compacted.' };
  }
  if (action === 'archive_session' && target) {
    const messages = store.listMessages(target);
    if (messages.length <= 8) return { removed: 0, detail: 'Nothing old enough to archive.' };
    const pivot = messages[messages.length - 9];
    const count = pivot ? store.archiveMessagesAfter(target, pivot.id) : 0;
    return { removed: count, detail: `Archived ${count} messages.` };
  }
  if (action === 'unload_model' && target) {
    const base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const response = await fetchImpl(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: target, keep_alive: 0 }) });
    if (!response.ok) throw new Error(`Ollama refused the unload (${response.status}).`);
    return { removed: 0, detail: `Asked Ollama to unload ${target}.` };
  }
  if (action === 'remove_image' && target) {
    if (!docker.available()) throw new Error('Docker is not available.');
    await docker.removeImage(target);
    return { removed: 1, detail: `Removed image ${target}.` };
  }
  throw new Error('Unknown prune action.');
}

function osTotal() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/MemTotal:\s+(\d+)/);
    if (match) return Number(match[1]) / 1024 / 1024;
  } catch { /* ignore */ }
  return 0;
}

function diskOf(dir: string) {
  const stat = fs.statfsSync(dir);
  return { path: dir, totalBytes: Number(stat.blocks) * Number(stat.bsize), freeBytes: Number(stat.bavail) * Number(stat.bsize) };
}

function directorySize(root: string, cap: number) {
  let total = 0;
  let seen = 0;
  const walk = (dir: string) => {
    if (seen > cap) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen++ > cap) return;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      } catch { /* skip */ }
    }
  };
  walk(root);
  return total;
}

function logBytes(store: Store) {
  return store.listLogs(1000).reduce((sum, row) => sum + row.message.length, 0);
}
