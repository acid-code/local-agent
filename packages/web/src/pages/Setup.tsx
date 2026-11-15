import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { PageHeader } from '../components/ui';
import { RefreshCw } from 'lucide-react';
import { t } from '../i18n';

interface Item { id: string; title: string; ok: boolean; detail: string; optional: boolean }
interface Preview { command: string; detail: string }

export function Setup() {
  const [items, setItems] = useState<Item[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [action, setAction] = useState('');
  const [model, setModel] = useState('gemma4:e4b');
  const [log, setLog] = useState('');

  const [scanning, setScanning] = useState(false);
  async function scan() {
    setScanning(true);
    try { setItems((await post<{ checklist: Item[] }>('/api/discovery/scan')).checklist); } finally { setScanning(false); }
  }
  async function load() {
    const data = await api<{ scan: unknown; checklist: Item[] }>('/api/discovery');
    setItems(data.checklist);
    // After a restart nothing has been scanned yet, so "needed" would be a false alarm. Scan once (read-only).
    if (!data.scan) await scan();
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <PageHeader title={t('Setup')} description={t('Nothing runs until you can read the exact command. Scan this machine, then pull a small model or start SearXNG if you want them.')} actions={<button className="btn primary" disabled={scanning} onClick={() => void scan()}><RefreshCw size={15} aria-hidden className={scanning ? 'spin' : undefined} /> {scanning ? t('Scanning…') : t('Scan again')}</button>} />
      <div className="checklist" style={{ marginTop: 16 }}>
        {items.map((item) => (
          <article key={item.id} className="card check">
            <span className={`dot ${item.ok ? 'ok' : item.optional ? 'warn' : 'bad'}`} />
            <div>
              <strong>{item.title}</strong>
              <p className="muted">{item.detail}</p>
            </div>
            <span className={`badge ${scanning ? '' : item.ok ? 'ok' : item.optional ? '' : 'bad'}`}>{scanning ? '…' : item.ok ? 'ready' : item.optional ? 'optional' : 'needed'}</span>
          </article>
        ))}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>{t('One-click actions')}</h3>
        <label className="field"><span>{t('Ollama model')}</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <div className="row">
          {[['pull-model', 'Pull model'], ['pull-embed', 'Pull nomic-embed-text'], ['start-searxng', 'Start SearXNG'], ['pull-sandbox', 'Pull sandbox image'], ['pull-mcp-runtime', 'Pull MCP runtime'], ['start-whisper', 'Start faster-whisper'], ['start-kokoro', 'Start Kokoro']].map(([id, label]) => (
            <button key={id} className="btn" onClick={async () => { setAction(id); setPreview(await post<Preview>(`/api/setup/actions/${id}/preview`, { model })); }}>{t(label)}</button>
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
            }}>{t('Run this command')}</button>
            {log && <pre className="command">{log}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
