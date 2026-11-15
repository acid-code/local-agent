import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cloud, Cpu, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { ImageRole } from '../components/ImageRole';
import { EmptyState, PageHeader, Section } from '../components/ui';
import { PullModel } from '../components/PullModel';
import { t } from '../i18n';

interface Model { id: string; name: string; apiName: string; contextWindow: number; practicalBudget: number; strategy: string; tokenizer: string; sizeClass: string; local: boolean; notes: string; source: string; freeTier: boolean | null; providerId?: string }
interface Provider { id: string; name: string; enabled: boolean }
interface Limit { used: number; limit: number | null }
interface Quota { displayName: string; apiName: string; category: string; chat: boolean; rpm: Limit; tpm: Limit; rpd: Limit; availability: { open: boolean; reason?: string } }

function fmt(value: number | null) { if (value == null) return '∞'; if (value >= 1000) return `${Math.round(value / 100) / 10}K`; return String(value); }
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export function Models() {
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [quota, setQuota] = useState<Quota[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await api<{ models: Model[]; providers: Provider[]; quota: Quota[]; geminiConnected: boolean }>('/api/models');
    setModels(data.models); setProviders(data.providers || []); setQuota(data.quota); setConnected(data.geminiConnected);
  }
  useEffect(() => { void load(); }, []);
  async function scan() {
    setBusy(true);
    try { await post('/api/models/scan'); await load(); toast(t('Models refreshed.'), 'ok'); } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(false); }
  }

  const enabled = new Set(providers.filter((p) => p.enabled).map((p) => p.id));
  const local = models.filter((m) => m.local && !/embed/i.test(m.name) && (!m.providerId || enabled.has(m.providerId)));
  const cloud = models.filter((m) => !m.local && !/embed/i.test(m.name) && (!m.providerId || enabled.has(m.providerId)));
  const chatQuota = quota.filter((row) => row.chat || row.category === 'Text-out models');

  return (
    <div className="page">
      <PageHeader title={t('Models')} description={t('Local models answer by default. Gemini, when connected, takes only hard questions, oversized syntheses, or repeated local failures, within its limits.')}
        actions={<button className="btn primary" onClick={() => void scan()} disabled={busy}><RefreshCw size={15} aria-hidden className={busy ? 'spin' : undefined} /> {busy ? t('Refreshing…') : t('Refresh models')}</button>} />

      <Section title={t('On this machine')} description={t('Models served by Ollama or another local server. Refresh after pulling one by hand.')}>
        {local.length === 0
          ? <EmptyState icon={Cpu} title={t('No local model yet')} action={<PullModel onDone={() => void load()} />}>{t('Pull one with Ollama to start chatting. gemma4:e4b fits most laptops.')}</EmptyState>
          : <>
              <div className="item-list">
                {local.map((model) => (
                  <div key={model.id} className="item-row">
                    <span className="dot ok" aria-hidden />
                    <span className="grow"><strong>{model.name}</strong><small className="faint">{model.sizeClass} · {k(model.practicalBudget)}{' '}{t('usable context of')}{' '}{k(model.contextWindow)}</small></span>
                  </div>
                ))}
              </div>
              <details className="more"><summary>{t('Pull another model')}</summary><PullModel onDone={() => void load()} compact suggestion="" /></details>
            </>}
      </Section>

      <Section title={t('Cloud')} description={t('Optional fallback. Keys live in the vault and are never shown to the model.')}>
        {connected === false ? (
          <EmptyState icon={Cloud} title={t('Gemini not connected')} action={<Link className="btn" to="/setup"><KeyRound size={15} aria-hidden />{' '}{t('Add a key in setup')}</Link>}>
            {t('Add a GEMINI_API_KEY to use Gemini as a fallback. Until then everything stays local.')}
          </EmptyState>
        ) : (
          <>
            {cloud.length > 0 && <p className="muted">{cloud.length}{' '}{t('cloud model')}{cloud.length === 1 ? '' : 's'} available: {cloud.slice(0, 4).map((m) => m.name).join(', ')}{cloud.length > 4 ? '…' : ''}</p>}
            <table className="limits">
              <caption className="faint">{t('Usage counts only requests this install sent. Limits are Google\'s documented free-tier defaults; your key\'s real limits may differ.')}</caption>
              <thead><tr><th scope="col">{t('Model')}</th><th scope="col">{t('Requests / min')}</th><th scope="col">{t('Tokens / min')}</th><th scope="col">{t('Requests / day')}</th><th scope="col">{t('Status')}</th></tr></thead>
              <tbody>
                {chatQuota.map((row) => (
                  <tr key={row.displayName}>
                    <th scope="row">{row.displayName}</th>
                    <td>{row.rpm.used} <span className="faint">of {fmt(row.rpm.limit)}</span></td>
                    <td>{fmt(row.tpm.used)} <span className="faint">of {fmt(row.tpm.limit)}</span></td>
                    <td>{row.rpd.used} <span className="faint">of {fmt(row.rpd.limit)}</span></td>
                    <td title={row.availability.reason}>{row.availability.open ? <span className="badge ok">{t('Available')}</span> : <span className="badge bad">{row.rpd.limit === 0 ? t('Not on free tier') : t('Limit reached')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title={t('Images')} description={t('Which model draws pictures for /image.')}><ImageRole /></Section>

      <Section title={t('Advanced')} description={t('Add a model by id from OpenRouter (needs its key in the vault).')}>
        <form className="row" onSubmit={async (event) => { event.preventDefault(); try { await post('/api/models', { providerId: 'prov_openrouter', name: custom }); setCustom(''); await load(); toast(t('Model added.'), 'ok'); } catch (error) { toast(errorText(error), 'error'); } }}>
          <input className="input" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="vendor/model-id" aria-label={t('OpenRouter model id')} />
          <button className="btn" disabled={!custom.trim()}><Plus size={15} aria-hidden />{' '}{t('Add model')}</button>
        </form>
      </Section>
    </div>
  );
}
