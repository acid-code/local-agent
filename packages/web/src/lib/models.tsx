import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Cpu, KeyRound, RefreshCw, Settings2, Sparkles } from 'lucide-react';
import { api, post } from './api';
import { errorText, toast } from './toast';
import { Menu, type MenuItem } from '../components/ui';
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
 * and the actions you need right there (refresh, add a Gemini key, set up a model).
 */
export function ModelPicker({ value, onChange, autoLabel = 'Auto', state }: { value: string | null; onChange: (id: string | null) => void; autoLabel?: string; state: ReturnType<typeof useUsableModels> }) {
  const navigate = useNavigate();
  const { models, all, loaded, refresh, refreshing } = state;
  const current = value ? all.find((model) => model.id === value) : null;
  const label = loaded && models.empty ? 'No model yet' : current ? current.name : autoLabel;
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
  if (loaded && models.empty) items.push({ label: t('Set up a model…'), icon: Cpu, separator: true, onSelect: () => navigate('/setup') });
  if (models.canManage !== false) items.push({ label: refreshing ? t('Refreshing…') : t('Refresh models'), icon: RefreshCw, separator: !(loaded && models.empty), disabled: refreshing, onSelect: () => void refresh() });
  if (models.canManage && models.geminiConnected === false) items.push({ label: t('Add a Gemini key…'), icon: KeyRound, hint: t('cloud fallback'), onSelect: () => navigate('/settings#vault') });
  if (models.canManage) items.push({ label: t('Manage models…'), icon: Settings2, onSelect: () => navigate('/models') });
  return <Menu label={t('Model')} text={label} icon={refreshing ? RefreshCw : null} busy={refreshing} className="model-trigger" align="start" trailing={<ChevronDown size={14} aria-hidden />} items={items} />;
}
