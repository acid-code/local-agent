import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { rawUrl } from '../lib/files';
import { toast } from '../lib/toast';
import { t } from '../i18n';

interface CatalogRow { id: string; name: string; blurb: string; speed: string; totalBytes: number; neededBytes: number; installed: boolean; gated: boolean; ramGiB: number; licence: string }
interface Job { id: string; kind: string; status: string; received: number; total: number; file?: string; error?: string }
interface Status {
  mode: string;
  local: { ready: boolean; kind: string; detail: string; model?: string };
  gemini: { allowed: boolean; keyed: boolean; model: string; remaining: number | null; limit: number | null };
  admin?: { selected?: string; catalog: CatalogRow[]; diskFreeBytes: number | null; hfToken: boolean; jobs: Job[] };
  imageGen?: { mode: string; backend: string; httpUrl: string };
}
const gb = (bytes: number | null | undefined) => bytes == null ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Models > Image role. The owner picks the mode and downloads local models; anyone can try a prompt. */
export function ImageRole() {
  const [status, setStatus] = useState<Status | null>(null);
  const [prompt, setPrompt] = useState('a tiny cottage in a field of tulips, soft pastel watercolor');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; detail: string; ms: number } | null>(null);
  const load = () => api<Status>('/api/images/status').then(setStatus).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const running = status?.admin?.jobs.some((job) => job.status === 'running');
  useEffect(() => { if (!running) return; const timer = setInterval(load, 1500); return () => clearInterval(timer); }, [running]);
  if (!status) return null;
  const setMode = async (patch: Record<string, unknown>) => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ imageGen: patch }) }); await load(); };

  return (
    <article className="card" id="image-role">
      <div className="card-head"><h3>{t('Image role')}</h3><span className={status.local.ready || (status.gemini.allowed && status.gemini.keyed) ? 'badge ok' : 'badge warn'}>{status.mode}</span></div>
      <p className="muted">{t('Agents get a')}{' '}<code>generate_image</code>{' '}{t('tool, and')}{' '}<code>/image …</code>{' '}{t('in any chat makes a picture. Auto uses the local model first (slower on a CPU, private, free) and Gemini only for accounts allowed to use it, counted in the shared quota. Video models are not offered: they need far more memory than a mini PC has.')}</p>
      <p><strong>{t('Local:')}</strong> <span className="muted">{status.local.detail}</span></p>
      <p><strong>{t('Gemini:')}</strong> <span className="muted">{!status.gemini.allowed ? t('Not allowed for this account.') : !status.gemini.keyed ? t('Not connected.') : t('{0} · {1} of {2} left today (shared).', [status.gemini.model, status.gemini.remaining ?? '∞', status.gemini.limit ?? '∞'])}</span></p>
      {status.imageGen && (
        <div className="row" style={{ margin: '8px 0' }}>
          <label className="field"><span>{t('Mode')}</span>
            <select value={status.imageGen.mode} onChange={(event) => void setMode({ mode: event.target.value })}>
              <option value="auto">{t('Auto: local first, then Gemini')}</option>
              <option value="local">{t('Local only')}</option>
              <option value="gemini">{t('Gemini only')}</option>
              <option value="off">{t('Off')}</option>
            </select>
          </label>
          <label className="field"><span>{t('Local runner')}</span>
            <select value={status.imageGen.backend} onChange={(event) => void setMode({ backend: event.target.value })}>
              <option value="sdcpp">{t('stable-diffusion.cpp on this machine')}</option>
              <option value="http">{t('Image server (sd-webui / Forge / sd-server API)')}</option>
            </select>
          </label>
          {status.imageGen.backend === 'http' && <label className="field"><span>{t('Server URL')}</span><input defaultValue={status.imageGen.httpUrl} placeholder="http://127.0.0.1:7860" onBlur={(event) => void setMode({ httpUrl: event.target.value.trim() })} /></label>}
        </div>
      )}
      {status.admin && (
        <>
          <p className="faint">{t('Disk free')}{' '}{gb(status.admin.diskFreeBytes)}{' '}{t('· Hugging Face token')}{' '}{status.admin.hfToken ? t('saved in the vault') : t('not set (only needed for gated models)')}</p>
          <ul className="people-list">
            {status.admin.catalog.map((model) => {
              const job = status.admin!.jobs.find((item) => item.id === `model:${model.id}`);
              return (
                <li key={model.id}>
                  <span className="who"><strong>{model.name}{model.id === status.admin!.selected ? t(' · in use') : ''}</strong><span className="faint">{model.blurb} {gb(model.totalBytes)}, ~{model.ramGiB}{' '}{t('GB RAM')}{model.gated ? t(', needs HF token') : ''}.</span>
                    {job?.status === 'running' && <span className="quota-bar" style={{ marginTop: 6 }}><span style={{ width: `${job.total ? (job.received / job.total) * 100 : 0}%` }} /></span>}
                    {job?.status === 'running' && <span className="faint">{gb(job.received)} of {gb(job.total)} {job.file ? `· ${job.file}` : ''}</span>}
                    {job?.status === 'error' && <span className="badge bad wrap">{job.error}</span>}
                  </span>
                  {!model.installed && job?.status !== 'running' && <button className="btn small" type="button" onClick={async () => { try { await post('/api/images/image/download', { id: model.id }); } catch (error) { toast((error as Error).message, 'error'); } await load(); }}>{model.neededBytes < model.totalBytes ? t('Resume ({0} left)', [gb(model.neededBytes)]) : t('Download {0}', [gb(model.totalBytes)])}</button>}
                  {model.installed && model.id !== status.admin!.selected && <button className="btn small" type="button" onClick={async () => { await post('/api/images/image/select', { id: model.id }); await load(); }}>{t('Use')}</button>}
                  {model.installed && <span className="badge ok">downloaded</span>}
                </li>
              );
            })}
          </ul>
          {!status.local.ready && status.local.kind === 'sdcpp' && <button className="btn" type="button" onClick={async () => { await post('/api/images/image/runner'); await load(); }}>{t('Install stable-diffusion.cpp')}</button>}
        </>
      )}
      <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setResult(null);
        try { const data = await post<{ file: { id: string }; detail: string; ms: number }>('/api/images/generate', { prompt }); setResult({ id: data.file.id, detail: data.detail, ms: data.ms }); }
        catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); }
      }}>
        <label className="field" style={{ flex: 1 }}><span>{t('Try a prompt')}</span><input value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <button className="btn primary" disabled={busy}>{busy ? (status.local.ready ? t('Drawing locally…') : t('Drawing…')) : t('Generate')}</button>
      </form>
      {result && <figure style={{ margin: '12px 0 0' }}><img src={rawUrl(result.id)} alt={prompt} style={{ maxWidth: 'min(420px, 100%)', borderRadius: 12 }} /><figcaption className="faint">{result.detail} · {Math.round(result.ms / 1000)}{' '}{t('s · saved to your files')}</figcaption></figure>}
    </article>
  );
}
