import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { api } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { Section } from './ui';

export interface BuiltinConnector { id: string; name: string; description: string; tools: string[]; mcpEquivalent: string; enabled: boolean; status: 'healthy' | 'degraded' | 'off'; detail: string; ownerOnly: boolean }
export interface RecommendedConnector { id: string; name: string; description: string; package: string; needs: string; connected: boolean }

/** Built-in connectors (on by default, work offline) and recommended account connectors (one click, never auto-enabled). */
export function Connectors({ onReport }: { onReport: (report: unknown) => void }) {
  const [data, setData] = useState<{ builtIn: BuiltinConnector[]; recommended: RecommendedConnector[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api<{ builtIn: BuiltinConnector[]; recommended: RecommendedConnector[] }>('/api/connectors').then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  async function toggle(row: BuiltinConnector) {
    setBusy(row.id);
    try { setData(await api(`/api/connectors/${row.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !row.enabled }) })); }
    catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
  }
  async function connect(row: RecommendedConnector) {
    setBusy(row.id);
    try {
      const result = await api<{ report: unknown; needs: string }>(`/api/connectors/${row.id}/connect`, { method: 'POST' });
      onReport(result.report);
      toast(`Vetted ${row.name}. Review the report below, then approve. ${result.needs}`, 'ok');
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
  }

  if (!data) return null;
  const healthy = data.builtIn.filter((row) => row.status === 'healthy').length;
  return (
    <>
      <Section title="Built-in connectors" description={`${healthy} of ${data.builtIn.length} healthy. These work offline with no accounts; personas get them automatically.`}>
        <div className="item-list connectors">
          {data.builtIn.map((row) => (
            <div key={row.id} className="item-row connector-row">
              <span className={`dot ${row.status === 'healthy' ? 'on' : row.status === 'degraded' ? 'warn' : 'off'}`} aria-hidden />
              <span className="grow">
                <strong>{row.name} <span className="badge builtin-badge">Built-in</span>{row.ownerOnly && <span className="badge">Owner only</span>}</strong>
                <span className="faint">{row.description}</span>
                <span className="faint connector-meta">{row.status === 'healthy' ? 'Healthy' : row.status === 'degraded' ? 'Needs attention' : 'Off'} · {row.detail} · tools: {row.tools.join(', ')}</span>
              </span>
              <label className="toggle" title={row.enabled ? 'Turn off' : 'Turn on'}>
                <input type="checkbox" role="switch" aria-label={`${row.name} connector`} checked={row.enabled} disabled={busy === row.id} onChange={() => void toggle(row)} />
                <span className="faint">{row.enabled ? 'On' : 'Off'}</span>
              </label>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Recommended" description="Account-based connectors. Nothing is switched on until you connect it; each one is vetted and runs in its own container.">
        <div className="item-list connectors">
          {data.recommended.map((row) => (
            <div key={row.id} className="item-row connector-row">
              <span className={`dot ${row.connected ? 'on' : 'off'}`} aria-hidden />
              <span className="grow"><strong>{row.name}</strong><span className="faint">{row.description} {row.needs}</span></span>
              {row.connected ? <span className="badge ok-badge">Connected</span> : <button className="btn small" disabled={busy === row.id} onClick={() => void connect(row)}><Link2 size={14} aria-hidden /> {busy === row.id ? 'Vetting…' : 'Connect'}</button>}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
