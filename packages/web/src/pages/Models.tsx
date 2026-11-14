import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { ImageRole } from '../components/ImageRole';

interface Model { id: string; name: string; apiName: string; contextWindow: number; practicalBudget: number; strategy: string; tokenizer: string; sizeClass: string; local: boolean; notes: string; source: string; freeTier: boolean | null }
interface Quota { displayName: string; category: string; chat: boolean; rpm: { used: number; limit: number | null }; tpm: { used: number; limit: number | null }; rpd: { used: number; limit: number | null }; availability: { open: boolean; reason?: string } }

function fmt(value: number | null) { if (value == null) return '∞'; if (value >= 1000) return `${Math.round(value / 100) / 10}K`; return String(value); }

export function Models() {
  const [models, setModels] = useState<Model[]>([]);
  const [quota, setQuota] = useState<Quota[]>([]);
  const [observed, setObserved] = useState('');
  const [custom, setCustom] = useState('');

  async function load() {
    const data = await api<{ models: Model[]; quota: Quota[]; quotaObservedAt: string }>('/api/models');
    setModels(data.models);
    setQuota(data.quota);
    setObserved(data.quotaObservedAt);
  }
  useEffect(() => { void load(); }, []);

  const chatQuota = quota.filter((row) => row.chat || row.category === 'Text-out models' || row.displayName.includes('Embedding'));

  return (
    <div className="page">
      <h1>Models</h1>
      <p className="lede">The default is the local model. Gemini is used only for a hard question, a synthesis that does not fit the local budget, or after repeated local failures. Daily and per-minute caps are enforced. When a cap is hit, the turn stays local. Argon and Carbon are closed on the free tier.</p>
      {observed && <p className="faint">Reading captured {new Date(observed).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })} Asia/Jerusalem.</p>}
      <button className="btn" onClick={async () => { await post('/api/models/scan'); await load(); }}>Scan local servers</button>
      <div style={{ marginTop: 16 }}><ImageRole /></div>
      <div className="grid" style={{ marginTop: 16 }}>
        {chatQuota.map((row) => (
          <article key={row.displayName} className="card">
            <div className="row"><h3>{row.displayName}</h3><span className={row.availability.open ? 'badge ok' : 'badge bad'}>{row.availability.open ? 'open' : 'closed'}</span></div>
            <p className="faint">{row.category}</p>
            <p className="mono">RPM {row.rpm.used}/{fmt(row.rpm.limit)} · TPM {fmt(row.tpm.used)}/{fmt(row.tpm.limit)} · RPD {row.rpd.used}/{fmt(row.rpd.limit)}</p>
            <div className="meter"><span style={{ width: `${row.tpm.limit ? Math.min(100, (row.tpm.used / row.tpm.limit) * 100) : 0}%` }} /></div>
            {row.availability.reason && <p className="muted">{row.availability.reason}</p>}
          </article>
        ))}
      </div>
      <h2 style={{ fontFamily: 'var(--serif)' }}>Catalog and discovered</h2>
      <div className="grid cards">
        {models.filter((model) => !model.name.toLowerCase().includes('embedding')).map((model) => (
          <article key={model.id} className="card">
            <h3>{model.name}</h3>
            <p className="faint">{model.local ? 'local' : 'cloud'} · {model.sizeClass} · {model.strategy} · {model.tokenizer}</p>
            <p className="mono">{model.contextWindow.toLocaleString()} theoretical · {model.practicalBudget.toLocaleString()} practical</p>
            <p className="muted">{model.notes}</p>
          </article>
        ))}
      </div>
      <form className="row" style={{ marginTop: 16 }} onSubmit={async (event) => { event.preventDefault(); await post('/api/models', { providerId: 'prov_openrouter', name: custom }); setCustom(''); await load(); }}>
        <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="OpenRouter model id" />
        <button className="btn">Add</button>
      </form>
    </div>
  );
}
