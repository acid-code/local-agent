import { useEffect, useRef, useState } from 'react';
import { DownloadCloud, Link2 } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { Section } from './ui';
import { pinLabel, TrustBadge, type Trust } from './Trust';
import { t } from '../i18n';

export interface BuiltinConnector { id: string; name: string; description: string; tools: string[]; mcpEquivalent: string; enabled: boolean; status: 'healthy' | 'degraded' | 'off'; detail: string; ownerOnly: boolean }
export interface RecommendedConnector { id: string; name: string; description: string; package: string; needs: string; connected: boolean; trust: Trust; pinned: string; secrets: string[]; note?: string; serverId: string | null }
interface CacheItem { id: string; kind: 'image' | 'npm'; ref: string; status: 'missing' | 'downloading' | 'ready' | 'failed'; detail?: string }

const CACHE_TEXT: Record<CacheItem['status'], string> = { missing: 'Not downloaded', downloading: 'Downloading…', ready: 'Downloaded', failed: 'Download failed' };

/** Built-in connectors (on by default, work offline) and recommended account connectors (pinned, one click, never auto-enabled). */
export function Connectors({ onReport, owner = true }: { onReport: (report: unknown, extra?: { trust?: Trust; secrets?: string[] }) => void; owner?: boolean }) {
  const [data, setData] = useState<{ builtIn: BuiltinConnector[]; recommended: RecommendedConnector[] } | null>(null);
  const [cache, setCache] = useState<{ items: CacheItem[]; running: boolean; dockerAvailable: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const poll = useRef<number | null>(null);
  const load = () => api<{ builtIn: BuiltinConnector[]; recommended: RecommendedConnector[] }>('/api/connectors').then(setData).catch(() => undefined);
  const loadCache = async () => {
    const next = await api<{ items: CacheItem[]; running: boolean; dockerAvailable: boolean }>('/api/connectors/cache').catch(() => null);
    setCache(next);
    if (poll.current) window.clearTimeout(poll.current);
    if (next?.running) poll.current = window.setTimeout(() => void loadCache(), 2000);
  };
  useEffect(() => { void load(); if (owner) void loadCache(); return () => { if (poll.current) window.clearTimeout(poll.current); }; }, [owner]);

  async function toggle(row: BuiltinConnector) {
    setBusy(row.id);
    try { setData(await api(`/api/connectors/${row.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !row.enabled }) })); }
    catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
  }
  async function connect(row: RecommendedConnector) {
    setBusy(row.id);
    try {
      const result = await api<{ report: unknown; needs: string; trust: Trust; secrets: string[] }>(`/api/connectors/${row.id}/connect`, { method: 'POST' });
      onReport(result.report, { trust: result.trust, secrets: result.secrets });
      toast(t('Vetted {0}. Review the report below, then approve.', [row.name]), 'ok');
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
  }
  async function downloadAll() {
    try { await post('/api/connectors/cache'); toast(t('Downloading the pinned connectors in the background.'), 'ok'); await loadCache(); }
    catch (error) { toast(errorText(error), 'error'); }
  }

  if (!data) return null;
  const healthy = data.builtIn.filter((row) => row.status === 'healthy').length;
  const ready = cache?.items.filter((row) => row.status === 'ready').length ?? 0;
  const cacheOf = (id: string) => cache?.items.find((row) => row.id === id);
  return (
    <>
      <Section title={t('Built-in connectors')} description={t('{0} of {1} healthy. These work offline with no accounts; personas get them automatically.', [healthy, data.builtIn.length])}>
        <div className="item-list connectors">
          {data.builtIn.map((row) => (
            <div key={row.id} className="item-row connector-row">
              <span className={`dot ${row.status === 'healthy' ? 'on' : row.status === 'degraded' ? 'warn' : 'off'}`} aria-hidden />
              <span className="grow">
                <strong>{row.name} <TrustBadge trust="built-in" />{row.ownerOnly && <span className="badge">{t('Owner only')}</span>}</strong>
                <span className="faint">{row.description}</span>
                <span className="faint connector-meta">{row.status === 'healthy' ? t('Healthy') : row.status === 'degraded' ? t('Needs attention') : t('Off')} · {row.detail}{' '}{t('· tools:')}{' '}{row.tools.join(', ')}</span>
              </span>
              <label className="toggle" title={row.enabled ? t('Turn off') : t('Turn on')}>
                <input type="checkbox" role="switch" aria-label={`${row.name} connector`} checked={row.enabled} disabled={busy === row.id || !owner} onChange={() => void toggle(row)} />
                <span className="faint">{row.enabled ? t('On') : t('Off')}</span>
              </label>
            </div>
          ))}
        </div>
      </Section>
      <Section title={t('Recommended')} description={t('Account connectors, pinned to an exact image digest or package version. Nothing is switched on until you connect it; each one is vetted and runs in its own container. Tokens go into a form, never the chat.')}
        actions={owner && cache ? <button className="btn small" disabled={cache.running || ready === cache.items.length} onClick={() => void downloadAll()} title={t('Fetch every pinned image and package now, so connectors start offline later')}>
          <DownloadCloud size={14} aria-hidden /> {cache.running ? t('Downloading…') : ready === cache.items.length ? t('All downloaded') : t('Download all recommended')}
        </button> : undefined}>
        {owner && cache && <p className="faint cache-summary" role="status">{ready} of {cache.items.length} downloaded{cache.dockerAvailable ? '' : t(' · Docker is not reachable, so images cannot be fetched yet')}.</p>}
        <div className="item-list connectors">
          {data.recommended.map((row) => {
            const cached = cacheOf(row.id);
            return (
              <div key={row.id} className="item-row connector-row">
                <span className={`dot ${row.connected ? 'on' : 'off'}`} aria-hidden />
                <span className="grow">
                  <strong>{row.name} <TrustBadge trust={row.trust} /></strong>
                  <span className="faint">{row.description} {row.needs}{row.note ? ` ${row.note}` : ''}</span>
                  <span className="faint connector-meta">{pinLabel(row.pinned)}{cached ? ` · ${CACHE_TEXT[cached.status]}` : ''}{cached?.detail ? ` (${cached.detail})` : ''}</span>
                </span>
                {row.connected ? <span className="badge ok">{t('Connected')}</span> : owner && <button className="btn small" disabled={busy === row.id} onClick={() => void connect(row)}><Link2 size={14} aria-hidden /> {busy === row.id ? t('Vetting…') : t('Connect')}</button>}
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
