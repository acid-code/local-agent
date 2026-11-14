import { useEffect, useState } from 'react';
import { toast, errorText } from '../lib/toast';
import { api, post } from '../lib/api';
import { Download, FlaskConical, KeyRound, Plug, Plus, Power, RefreshCw, Search, Trash2, Wrench } from 'lucide-react';
import { TrustBadge, pinLabel, type Trust } from '../components/Trust';
import { EmptyState, Menu, PageHeader, Section } from '../components/ui';
import { Connectors } from '../components/Connectors';

interface Health { status: 'connected' | 'starting' | 'idle' | 'down' | 'off'; detail: string; tools: number; restarts: number }
interface Server { id: string; name: string; source: string | null; enabled: boolean; riskLevel: string | null; riskScore: number | null; lastError: string | null; execution: string; network: string; image?: string | null; tools?: { name: string }[]; health?: Health; trust?: Trust; secrets?: { name: string; set: boolean }[] }
interface CatalogEntry { source: 'docker' | 'official'; id: string; title: string; description: string; trust: Trust; image?: string; packageName?: string; version?: string; repo?: string; secrets: { env: string; description?: string }[]; installable: boolean; note?: string }
const HEALTH_DOT: Record<Health['status'], string> = { connected: 'on', starting: 'warn', idle: '', down: 'off', off: '' };

/** Secrets for one server: password fields only, stored in the vault for that server, never shown again. */
function SecretForm({ server, onDone }: { server: Server; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const rows = server.secrets ?? [];
  return (
    <form className="secret-form" onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      try { await api(`/api/mcp/${server.id}/secrets`, { method: 'PUT', body: JSON.stringify({ values }) }); setValues({}); toast(`Saved to the vault for ${server.name}.`, 'ok'); onDone(); }
      catch (error) { toast(errorText(error), 'error'); } finally { setSaving(false); }
    }}>
      <p className="faint">Stored encrypted for this server only. Agents never see these; only {server.name}'s container gets them.</p>
      {rows.map((row) => (
        <label key={row.name} className="field"><span>{row.name} {row.set && <span className="badge ok">Set</span>}</span>
          <input type="password" autoComplete="off" spellCheck={false} placeholder={row.set ? 'Leave empty to keep the saved value' : 'Paste the value'} value={values[row.name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [row.name]: event.target.value }))} />
        </label>
      ))}
      <div className="row"><button className="btn primary small" disabled={saving || !Object.values(values).some(Boolean)}>{saving ? 'Saving…' : 'Save secrets'}</button><button className="btn ghost small" type="button" onClick={onDone}>Close</button></div>
    </form>
  );
}
interface Report {
  id: string; score: number; level: string; packageName?: string; publisher?: string; license?: string;
  downloads?: number | null; stars?: number | null; permissions: string[]; findings: { severity: string; detail: string }[];
  repoUrl?: string;
  reputation?: { enabled: boolean; skipped: boolean; warning?: string; setupAction?: string; summary?: string; links: { title: string; url: string }[] };
}

export function Tools() {
  const [servers, setServers] = useState<Server[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [skipReputation, setSkipReputation] = useState(false);
  const [commandPreview, setCommandPreview] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [reportMeta, setReportMeta] = useState<{ trust?: Trust; secrets?: string[] }>({});
  const [trustOk, setTrustOk] = useState(false);
  const [secretsFor, setSecretsFor] = useState<string | null>(null);
  const [tab, setTab] = useState<'docker' | 'official' | 'command'>('docker');
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [vetting, setVetting] = useState<string | null>(null);
  function showReport(value: Report | null, meta: { trust?: Trust; secrets?: string[] } = {}) { setReport(value); setReportMeta(meta); setTrustOk(false); }
  async function browse(source: 'docker' | 'official', q = catalogQuery) {
    setSearching(true);
    try { setCatalog((await api<{ entries: CatalogEntry[] }>(`/api/mcp/catalog?source=${source}&q=${encodeURIComponent(q)}`)).entries); }
    catch (error) { toast(errorText(error), 'error'); setCatalog([]); } finally { setSearching(false); }
  }
  async function vetEntry(entry: CatalogEntry) {
    setVetting(entry.id);
    try { const result = await post<{ report: Report; trust: Trust; secrets: string[] }>('/api/mcp/catalog/vet', { source: entry.source, id: entry.id }); showReport(result.report, { trust: result.trust, secrets: result.secrets }); }
    catch (error) { toast(errorText(error), 'error'); } finally { setVetting(null); }
  }
  async function install() {
    if (!report) return;
    try {
      const result = await post<{ server: Server }>('/api/mcp/install', { reportId: report.id, acknowledgeRisk: true, acknowledgeCritical: report.level === 'critical', acknowledgeCommunity: trustOk });
      showReport(null); await load();
      if (result.server.secrets?.some((row) => !row.set)) { setSecretsFor(result.server.id); toast('Installed. Add its secrets below, then press Test.', 'ok'); }
      else toast('Installed. Press Test to start it.', 'ok');
    } catch (error) { toast(errorText(error), 'error'); }
  }

  async function testServer(server: Server) {
    setTesting(server.id);
    try {
      const data = await post<{ server: Server | null }>(`/api/mcp/${server.id}/refresh`);
      const tools = data.server?.tools || [];
      setResults((rows) => ({ ...rows, [server.id]: { ok: true, text: `Works · ${tools.length} tool${tools.length === 1 ? '' : 's'}${tools.length ? `: ${tools.slice(0, 6).map((t) => t.name).join(', ')}${tools.length > 6 ? '…' : ''}` : ''}` } }));
      await load();
    } catch (error) { setResults((rows) => ({ ...rows, [server.id]: { ok: false, text: errorText(error) } })); }
    finally { setTesting(null); }
  }
  async function testBuiltin(tool: 'web_search' | 'kb_search') {
    setTesting(tool);
    try {
      const data = await post<{ results: { ok: boolean; ms: number; output?: string; error?: string }[] }>('/api/debug/tool-test', { tool });
      const r = data.results[0];
      setResults((rows) => ({ ...rows, [tool]: { ok: Boolean(r?.ok), text: r?.ok ? `Works · ${r.ms} ms` : (r?.error || r?.output || 'No results').slice(0, 160) } }));
    } catch (error) { setResults((rows) => ({ ...rows, [tool]: { ok: false, text: errorText(error) } })); }
    finally { setTesting(null); }
  }

  async function load() { setServers((await api<{ servers: Server[] }>('/api/mcp')).servers); setLoaded(true); }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (tab !== 'command') void browse(tab); }, [tab]);

  return (
    <div className="page">
      <PageHeader title="Tools" description="MCP servers give agents extra tools. Each one is vetted first, then runs in its own locked-down container: no host mounts, dropped capabilities, and a network mode you approve."
        actions={<>
          <button className="btn ghost" onClick={async () => { const result = await post<{ found?: number }>('/api/mcp/discover').catch((error) => { toast(errorText(error), 'error'); return null; }); await load(); if (result) toast('Imported known configs. They stay off until you vet them.', 'ok'); }}><Download size={16} aria-hidden /> Import known configs</button>
          <button className="btn primary" onClick={() => { setTab('command'); document.getElementById('find-server')?.scrollIntoView({ behavior: 'smooth' }); }}><Plus size={16} aria-hidden /> Add server</button>
        </>} />
      <Connectors onReport={(value, meta) => showReport(value as Report, meta)} />
      <Section title="Installed servers" description={servers.length ? `${servers.length} server${servers.length === 1 ? '' : 's'}.` : undefined}>
        {loaded && servers.length === 0 && <EmptyState icon={Wrench} title="No MCP servers yet" action={<button className="btn" onClick={() => document.getElementById('find-server')?.scrollIntoView({ behavior: 'smooth' })}>Browse servers</button>}>Connect a recommended one above, browse the catalogs below, or import configs from Claude or Cursor.</EmptyState>}
        <div className="item-list">
          {servers.map((server) => {
            const health = server.health;
            const missing = (server.secrets ?? []).filter((row) => !row.set);
            return (
            <div key={server.id} className="item-row mcp-row">
              <span className={`dot ${health ? HEALTH_DOT[health.status] : server.lastError ? 'off' : server.enabled ? 'on' : ''}`} aria-hidden title={health?.status} />
              <span className="grow"><strong>{server.name} <TrustBadge trust={server.trust} /></strong>
                <span className="faint">{health ? health.detail : server.enabled ? 'on' : 'off'}{health?.restarts ? ` · reconnected ${health.restarts}×` : ''} · network {server.network} · risk {server.riskLevel || 'not vetted'}{server.image ? ` · ${pinLabel(server.image)}` : ''}</span>
                {missing.length > 0 && <span className="faint warn-text">Needs {missing.map((row) => row.name).join(', ')}.</span>}
                {secretsFor === server.id && <SecretForm server={server} onDone={() => { setSecretsFor(null); void load(); }} />}
              </span>
              {results[server.id] && <span className={results[server.id]!.ok ? 'test-result ok' : 'test-result bad'} role="status">{results[server.id]!.text}</span>}
              {(server.secrets?.length ?? 0) > 0 && <button className="btn small" aria-expanded={secretsFor === server.id} onClick={() => setSecretsFor(secretsFor === server.id ? null : server.id)}><KeyRound size={14} aria-hidden /> Secrets</button>}
              <button className="btn small" disabled={testing === server.id || !server.enabled} title="Start it and list its tools" onClick={() => void testServer(server)}><FlaskConical size={14} aria-hidden /> {testing === server.id ? 'Testing…' : 'Test'}</button>
              <Menu label={`Options for ${server.name}`} items={[
                { label: 'Reconnect', icon: RefreshCw, onSelect: () => void post(`/api/mcp/${server.id}/refresh`).then(load).catch((error) => toast(errorText(error), 'error')) },
                { label: server.enabled ? 'Turn off' : 'Turn on', icon: server.enabled ? Power : Plug, onSelect: () => void api(`/api/mcp/${server.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !server.enabled }) }).then(load).catch((error) => toast(errorText(error), 'error')) },
                { label: 'Remove', icon: Trash2, danger: true, separator: true, onSelect: () => { if (window.confirm(`Remove ${server.name}? Its container and saved secrets are deleted.`)) void api(`/api/mcp/${server.id}`, { method: 'DELETE' }).then(load); } },
              ]} />
            </div>
            );
          })}
        </div>
      </Section>
      <Section title="Built-in tools" description="Always available to agents that allow them.">
        <div className="item-list">
          {([['web_search', 'Web search', 'Through your local SearXNG'], ['kb_search', 'Knowledge base', 'Your Library documents']] as const).map(([id, label, hint]) => (
            <div key={id} className="item-row">
              <span className="dot on" aria-hidden />
              <span className="grow"><strong>{label}</strong><span className="faint">{hint}</span></span>
              {results[id] && <span className={results[id]!.ok ? 'test-result ok' : 'test-result bad'} role="status">{results[id]!.text}</span>}
              <button className="btn small" disabled={testing === id} onClick={() => void testBuiltin(id)}><FlaskConical size={14} aria-hidden /> {testing === id ? 'Testing…' : 'Test'}</button>
            </div>
          ))}
        </div>
      </Section>
      <Section id="find-server" title="Find a server" description="Browse Docker's MCP catalog (images pinned by digest) or the official MCP registry. Everything is vetted first; community servers need your explicit OK.">
        <div className="seg" role="tablist" aria-label="Server source">
          {([['docker', 'Docker catalog'], ['official', 'Official registry'], ['command', 'By command']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        {tab !== 'command' && <>
          <form className="row" style={{ marginTop: 10 }} onSubmit={(event) => { event.preventDefault(); void browse(tab); }}>
            <input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="github, notion, time…" aria-label="Search servers" style={{ flex: '1 1 260px' }} />
            <button className="btn" disabled={searching}><Search size={15} aria-hidden /> {searching ? 'Searching…' : 'Search'}</button>
          </form>
          {catalog && catalog.length === 0 && !searching && <p className="faint" style={{ marginTop: 8 }}>Nothing found{tab === 'official' ? ' (the registry needs internet)' : ''}.</p>}
          {catalog && catalog.length > 0 && <div className="item-list catalog-list" style={{ marginTop: 8 }}>
            {catalog.map((entry) => (
              <div key={`${entry.source}:${entry.id}`} className="item-row">
                <span className="grow"><strong>{entry.title} <TrustBadge trust={entry.trust} /></strong><span className="faint">{entry.description}</span>
                  <span className="faint connector-meta">{entry.image ? pinLabel(entry.image) : entry.packageName ? `${entry.packageName}${entry.version ? `@${entry.version}` : ''}` : entry.note}{entry.secrets.length ? ` · needs ${entry.secrets.map((row) => row.env).join(', ')}` : ''}</span>
                </span>
                <button className="btn small" disabled={!entry.installable || vetting === entry.id} title={entry.note} onClick={() => void vetEntry(entry)}>{vetting === entry.id ? 'Vetting…' : 'Vet'}</button>
              </div>
            ))}
          </div>}
        </>}
        {tab === 'command' && (
          <form onSubmit={async (event) => { event.preventDefault(); try { const result = await post<{ report: Report }>('/api/mcp/vet', { name, command, args: args.split(' ').filter(Boolean), source: 'ui', reputation: !skipReputation }); showReport(result.report, { trust: 'community' }); } catch (error) { toast(errorText(error), 'error'); } }}>
            <p className="faint section-desc">A server you add by command counts as community: it is vetted, and installing needs your explicit OK.</p>
            <div className="form-grid">
              <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="filesystem" /></label>
              <label className="field"><span>Command</span><input value={command} onChange={(event) => setCommand(event.target.value)} /></label>
            </div>
            <label className="field"><span>Arguments</span><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @scope/server@1.2.3" /></label>
            <label className="row"><input type="checkbox" checked={skipReputation} onChange={(event) => setSkipReputation(event.target.checked)} /> Skip the local web reputation search</label>
            <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Vet before install</button></div>
          </form>
        )}
      </Section>
      {report && (
        <div className="card section">
          <h3>Risk {report.score} · {report.level} <TrustBadge trust={reportMeta.trust} /></h3>
          <p className="muted">{report.packageName} · {report.publisher || 'publisher unknown'} · {report.license || 'no license'} · {report.downloads ?? '—'} downloads · {report.stars ?? '—'} stars</p>
          <p>Permissions: {report.permissions.join(', ') || 'none declared'}</p>
          {report.reputation?.warning && (
            <div className="banner">
              <p>{report.reputation.warning}</p>
              {commandPreview && <pre className="command">{commandPreview}</pre>}
              <button className="btn" type="button" onClick={async () => {
                const preview = await post<{ command: string; detail: string }>('/api/setup/actions/start-searxng/preview');
                setCommandPreview(`${preview.command}\n${preview.detail}`);
              }}>Show the SearXNG command</button>
              {commandPreview && <button className="btn primary" type="button" onClick={async () => { await post('/api/setup/actions/start-searxng/run', { confirm: true }); setCommandPreview('SearXNG start requested. Vet again once it answers on port 8088.'); }}>Run this command</button>}
            </div>
          )}
          {report.reputation?.summary && <p>{report.reputation.summary}</p>}
          {report.reputation?.links?.map((link) => <p key={link.url}><a href={link.url}>{link.title}</a></p>)}
          {report.findings.map((finding, index) => <p key={index} className="faint">{finding.severity}: {finding.detail}</p>)}
          {reportMeta.secrets && reportMeta.secrets.length > 0 && <p className="faint">After installing, enter {reportMeta.secrets.join(', ')} in its secret form. Never paste tokens into a chat.</p>}
          {reportMeta.trust === 'community' && <label className="row community-ack"><input type="checkbox" checked={trustOk} onChange={(event) => setTrustOk(event.target.checked)} /> This is a community server. I have checked who publishes it and trust it.</label>}
          <div className="row"><button className="btn primary" disabled={reportMeta.trust === 'community' && !trustOk} onClick={() => void install()}>Approve and install</button><button className="btn ghost" onClick={() => showReport(null)}>Discard</button></div>
        </div>
      )}
    </div>
  );
}
