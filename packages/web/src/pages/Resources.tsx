import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Snapshot {
  memory: { totalGiB: number; availableGiB: number };
  disk: { freeBytes: number; totalBytes: number };
  dataBytes: number;
  gpu: { name: string; note: string; vramBytes?: number; gttBytes?: number } | null;
  agents: { id: string; name: string; messageBytes: number; summaryBytes: number; embeddingBytes: number; workspaceBytes: number; notes: number }[];
  knowledge?: { bytes: number; embeddingBytes: number; documents: number; chunks: number; collections: { id: string; name: string; bytes: number; chunks: number }[] };
  flags: { level: string; text: string }[];
  loadedModels?: { name: string; contextLength: number | null; sizeBytes: number | null }[];
}

function gb(bytes: number) { return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }

export function Resources() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [samples, setSamples] = useState<{ availableGiB?: number }[]>([]);
  const [preview, setPreview] = useState<{ id: string; items: string[]; warning: string } | null>(null);

  async function load() {
    setSnap((await api<{ current: Snapshot }>('/api/resources')).current);
    setSamples((await api<{ samples: { availableGiB?: number }[] }>('/api/resources/trends?hours=24')).samples);
  }
  useEffect(() => { void load(); }, []);
  if (!snap) return <div className="page">Measuring…</div>;
  const max = Math.max(...samples.map((sample) => sample.availableGiB || 0), 1);

  return (
    <div className="page">
      <h1>Resources</h1>
      <p className="lede">RAM, disk, and per-agent weight. Prune actions show what they will free before anything is removed. Archiving history is reversible. Deleting an image is not.</p>
      <div className="grid cards">
        <article className="card"><h3>Memory</h3><p>{snap.memory.availableGiB.toFixed(1)} GiB free of {snap.memory.totalGiB.toFixed(1)}</p><div className="meter"><span style={{ width: `${100 - (snap.memory.availableGiB / Math.max(snap.memory.totalGiB, 1)) * 100}%` }} /></div></article>
        <article className="card"><h3>Disk</h3><p>{gb(snap.disk.freeBytes)} free of {gb(snap.disk.totalBytes)}</p><p className="faint">Data directory {gb(snap.dataBytes)}</p></article>
        <article className="card"><h3>GPU / GTT</h3><p>{snap.gpu ? snap.gpu.name : 'Not visible'}</p><p className="muted">{snap.gpu?.note}</p></article>
        <article className="card"><h3>Loaded models</h3>
          {(snap.loadedModels ?? []).length === 0 && <p className="muted">No model is loaded in Ollama.</p>}
          {(snap.loadedModels ?? []).map((model) => (
            <p key={model.name} className="mono">{model.name} · context {model.contextLength ?? 'not reported'}{model.sizeBytes ? ` · ${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB` : ''}</p>
          ))}
        </article>
      </div>
      {snap.knowledge && (
        <article className="card">
          <h3>Knowledge base</h3>
          <p>{snap.knowledge.documents} files · {snap.knowledge.chunks} chunks · {gb(snap.knowledge.bytes)} source · {gb(snap.knowledge.embeddingBytes)} embeddings</p>
          {snap.knowledge.collections.map((collection) => (
            <p key={collection.id} className="mono faint">{collection.name} · {collection.chunks} chunks · {collection.bytes} B</p>
          ))}
        </article>
      )}
      {snap.flags.map((flag) => <p key={flag.text} className="badge warn">{flag.text}</p>)}
      <svg viewBox="0 0 240 48" width="100%" height="48" role="img" aria-label="Available memory trend">
        <polyline fill="none" stroke="var(--brass)" strokeWidth="2" points={samples.map((sample, index) => `${(index / Math.max(samples.length - 1, 1)) * 240},${46 - ((sample.availableGiB || 0) / max) * 40}`).join(' ')} />
      </svg>
      <div className="grid cards">
        {snap.agents.map((agent) => (
          <article key={agent.id} className="card">
            <h3>{agent.name}</h3>
            <p className="mono faint">history {agent.messageBytes} B · summaries {agent.summaryBytes} B · embeddings {agent.embeddingBytes} B · workspace {agent.workspaceBytes} B · {agent.notes} notes</p>
          </article>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={async () => setPreview((await post<{ preview: { id: string; items: string[]; warning: string } }>('/api/resources/prune/preview', { action: 'clear_logs' })).preview)}>Preview clear logs</button>
        <button className="btn" onClick={async () => setPreview((await post<{ preview: { id: string; items: string[]; warning: string } }>('/api/resources/prune/preview', { action: 'vacuum' })).preview)}>Preview compact database</button>
      </div>
      {preview && (
        <div className="card">
          {preview.items.map((item) => <p key={item}>{item}</p>)}
          <p className="muted">{preview.warning}</p>
          <button className="btn primary" onClick={async () => { await post('/api/resources/prune', { previewId: preview.id, confirm: true }); setPreview(null); await load(); }}>Confirm</button>
        </div>
      )}
    </div>
  );
}
