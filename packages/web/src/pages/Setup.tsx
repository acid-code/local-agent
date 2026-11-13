import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Item { id: string; title: string; ok: boolean; detail: string; optional: boolean }
interface Preview { command: string; detail: string }

export function Setup() {
  const [items, setItems] = useState<Item[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [action, setAction] = useState('');
  const [model, setModel] = useState('gemma4:e4b');
  const [log, setLog] = useState('');

  async function load() {
    const data = await api<{ checklist: Item[] }>('/api/discovery');
    setItems(data.checklist);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Setup</h1>
      <p className="lede">Nothing runs until you can read the exact command. Scan first, then pull a small model or start SearXNG if you want them.</p>
      <button className="btn primary" onClick={async () => { const data = await post<{ checklist: Item[] }>('/api/discovery/scan'); setItems(data.checklist); }}>Scan this machine</button>
      <div className="checklist" style={{ marginTop: 16 }}>
        {items.map((item) => (
          <article key={item.id} className="card check">
            <span className={`dot ${item.ok ? 'ok' : item.optional ? 'warn' : 'bad'}`} />
            <div>
              <strong>{item.title}</strong>
              <p className="muted">{item.detail}</p>
            </div>
            <span className="badge">{item.ok ? 'ready' : item.optional ? 'optional' : 'needed'}</span>
          </article>
        ))}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>One-click actions</h3>
        <label className="field"><span>Ollama model</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <div className="row">
          {[['pull-model', 'Pull model'], ['pull-embed', 'Pull nomic-embed-text'], ['start-searxng', 'Start SearXNG'], ['pull-sandbox', 'Pull sandbox image'], ['pull-mcp-runtime', 'Pull MCP runtime'], ['start-whisper', 'Start faster-whisper'], ['start-kokoro', 'Start Kokoro']].map(([id, label]) => (
            <button key={id} className="btn" onClick={async () => { setAction(id); setPreview(await post<Preview>(`/api/setup/actions/${id}/preview`, { model })); }}>{label}</button>
          ))}
        </div>
        {preview && (
          <div>
            <pre className="command">{preview.command}</pre>
            <p className="muted">{preview.detail}</p>
            <button className="btn primary" onClick={async () => {
              const job = await post<{ job: { id: string } }>(`/api/setup/actions/${action}/run`, { confirm: true, model });
              const timer = setInterval(async () => {
                const data = await api<{ job: { status: string; output: string } }>(`/api/jobs/${job.job.id}`);
                setLog(data.job.output);
                if (data.job.status !== 'running') clearInterval(timer);
              }, 1000);
            }}>Run this command</button>
            {log && <pre className="command">{log}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
