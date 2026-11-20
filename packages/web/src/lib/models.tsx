import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Download, KeyRound, RefreshCw, Settings2, Sparkles, X } from 'lucide-react';
import { api, post } from './api';
import { errorText, toast } from './toast';
import { Menu, type MenuItem } from '../components/ui';
import { PullModel } from '../components/PullModel';
import { t } from '../i18n';

export interface UsableModel { id: string; name: string; local: boolean; disabled?: boolean; reason?: string }
export interface UsableModels { local: UsableModel[]; cloud: UsableModel[]; dev: UsableModel[]; empty: boolean; geminiConnected?: boolean; cloudAllowed?: boolean; canManage?: boolean }

const EMPTY: UsableModels = { local: [], cloud: [], dev: [], empty: false };

/** Models this account can pick right now: installed local ones, cloud ones with a key (and quota), never Rehearsal in production. */
export function useUsableModels() {
  const [models, setModels] = useState<UsableModels>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(() => api<UsableModels>('/api/models/usable').then((data) => { setModels(data); setLoaded(true); return data; }).catch(() => { setLoaded(true); return null; }), []);
  useEffect(() => { void reload(); }, [reload]);

  // Listen for background startup discovery completing and auto-retry while local models are empty.
  useEffect(() => {
    const onLive = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      if (detail?.type === 'models_updated') void reload();
    };
    window.addEventListener('la:live', onLive);
    return () => window.removeEventListener('la:live', onLive);
  }, [reload]);

  useEffect(() => {
    if (!loaded || models.local.length > 0) return;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      if (tries > 15) { window.clearInterval(timer); return; }
      const data = await reload();
      if (data && data.local.length > 0) window.clearInterval(timer);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [loaded, models.local.length, reload]);

  /** Rescan Ollama and providers (owner), then update the list in place. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (models.canManage !== false) await post('/api/models/scan');
      const data = await reload();
      const count = data ? data.local.length + data.cloud.filter((model) => !model.disabled).length : 0;
      toast(count ? t('Models refreshed: {0} local, {1} cloud.', [data!.local.length, data!.cloud.filter((model) => !model.disabled).length]) : t('Scan finished. No usable model found yet.'), count ? 'ok' : 'error');
    } catch (error) { toast(errorText(error), 'error'); } finally { setRefreshing(false); }
  }, [models.canManage, reload]);
  const all = [...models.local, ...models.cloud, ...models.dev];
  return { models, all, loaded, refresh, refreshing };
}

/** <option>s grouped Local / Cloud (and Dev when rehearsal is on), for plain selects in forms. */
export function ModelOptions({ models }: { models: UsableModels }) {
  const option = (model: UsableModel) => (
    <option key={model.id} value={model.id} disabled={model.disabled} title={model.reason}>{model.name}{model.disabled ? ` — ${model.reason || 'unavailable'}` : ''}</option>
  );
  return (
    <>
      {models.local.length > 0 && <optgroup label={t('Local')}>{models.local.map(option)}</optgroup>}
      {models.cloud.length > 0 && <optgroup label={t('Cloud')}>{models.cloud.map(option)}</optgroup>}
      {models.dev.length > 0 && <optgroup label={t('Dev only')}>{models.dev.map(option)}</optgroup>}
    </>
  );
}

/**
 * The chat model picker: Auto on top, then Local and Cloud, out-of-quota models disabled with the reason,
 * and inline actions (refresh, pull model, Gemini key, Settings → System).
 */
export function ModelPicker({ value, onChange, autoLabel = 'Auto', state }: { value: string | null; onChange: (id: string | null) => void; autoLabel?: string; state: ReturnType<typeof useUsableModels> }) {
  const navigate = useNavigate();
  const [pullOpen, setPullOpen] = useState(false);
  const { models, all, loaded, refresh, refreshing } = state;
  const current = value ? all.find((model) => model.id === value) : null;
  const label = loaded && models.empty ? t('No model yet') : current ? current.name : autoLabel;
  const pick = (model: UsableModel, index: number, heading: string): MenuItem => ({
    label: model.name, checked: value === model.id, disabled: model.disabled, hint: model.disabled ? model.reason?.replace(/^.*? is /, '') : undefined,
    heading: index === 0 ? heading : undefined, separator: index === 0, onSelect: () => onChange(model.id),
  });
  const items: MenuItem[] = [
    { label: t('Auto'), icon: Sparkles, hint: t('picks per message'), checked: !value, onSelect: () => onChange(null) },
    ...models.local.map((model, index) => pick(model, index, 'Local')),
    ...models.cloud.map((model, index) => pick(model, index, 'Cloud')),
    ...models.dev.map((model, index) => pick(model, index, 'Dev only')),
  ];
  if (models.canManage !== false) {
    items.push({ label: refreshing ? t('Refreshing…') : t('Refresh models'), icon: RefreshCw, separator: true, disabled: refreshing, keepOpen: true, onSelect: () => void refresh() });
    items.push({ label: t('Pull model…'), icon: Download, hint: t('Ollama'), onSelect: () => setPullOpen(true) });
  }
  if (models.canManage && models.geminiConnected === false) items.push({ label: t('Add a Gemini key…'), icon: KeyRound, hint: t('cloud fallback'), onSelect: () => navigate('/settings#vault') });
  if (models.canManage) items.push({ label: t('System settings…'), icon: Settings2, onSelect: () => navigate('/settings#system') });

  return (
    <>
      <Menu label={t('Model')} text={label} icon={refreshing ? RefreshCw : null} busy={refreshing} className="model-trigger" align="start" trailing={<ChevronDown size={14} aria-hidden />} items={items} />
      {pullOpen && createPortal(
        <div className="modal-backdrop" role="presentation" onClick={() => setPullOpen(false)}>
          <div className="modal-card" role="dialog" aria-label={t('Pull Ollama model')} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{t('Pull an Ollama model')}</h3>
              <button type="button" className="icon-btn round" aria-label={t('Close')} onClick={() => setPullOpen(false)}><X size={16} /></button>
            </div>
            <p className="faint">{t('Enter any Ollama model tag (e.g. gemma4:26b-a4b, gpt-oss:20b, gemma3:4b).')}</p>
            <PullModel suggestion="gpt-oss:20b" onDone={() => { void refresh(); }} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
