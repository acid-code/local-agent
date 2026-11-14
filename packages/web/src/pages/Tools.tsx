import { useEffect, useState } from 'react';
import { toast, errorText } from '../lib/toast';
import { api, post } from '../lib/api';
import { Download, FlaskConical, Plug, Plus, RefreshCw, Search, Trash2, Wrench } from 'lucide-react';
import { EmptyState, Menu, PageHeader, Section } from '../components/ui';
import { Connectors } from '../components/Connectors';

interface Server { id: string; name: string; source: string | null; enabled: boolean; riskLevel: string | null; riskScore: number | null; lastError: string | null; execution: string; network: string; tools?: { name: string }[] }
interface Report {
  id: string; score: number; level: string; packageName?: string; publisher?: string; license?: string;
  downloads?: number | null; stars?: number | null; permissions: string[]; findings: { severity: string; detail: string }[];
  repoUrl?: string;
  reputation?: { enabled: boolean; skipped: boolean; warning?: string; setupAction?: string; summary?: string; links: { title: string; url: string }[] };
}

export function Tools() {
  const [servers, setServers] = useState<Server[]>([]);
  const [query, setQuery] = useState('filesystem');
  const [registry, setRegistry] = useState<{ name?: string; description?: string; package?: string }[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [skipReputation, setSkipReputation] = useState(false);
  const [commandPreview, setCommandPreview] = useState('');
  const [adding, setAdding] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});

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
  async function search(event?: { preventDefault(): void }) {
    event?.preventDefault();
    setSearching(true);
    try { setRegistry((await api<{ servers: { name?: string; description?: string; package?: string }[] }>(`/api/mcp/registry?q=${encodeURIComponent(query)}`)).servers); } catch (error) { toast(errorText(error), 'error'); } finally { setSearching(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <PageHeader title="Tools" description="MCP servers give agents extra tools. Each one is vetted first, then runs in its own locked-down container: no host mounts, dropped capabilities, and a network mode you approve."
        actions={<>
          <button className="btn ghost" onClick={async () => { const result = await post<{ found?: number }>('/api/mcp/discover').catch((error) => { toast(errorText(error), 'error'); return null; }); await load(); if (result) toast('Imported known configs. They stay off until you vet them.', 'ok'); }}><Download size={16} aria-hidden /> Import known configs</button>
          <button className="btn primary" aria-expanded={adding} onClick={() => setAdding((value) => !value)}><Plus size={16} aria-hidden /> Add server</button>
        </>} />
      <Connectors onReport={(value) => setReport(value as Report)} />
      <Section title="Installed servers" description={servers.length ? `${servers.length} server${servers.length === 1 ? '' : 's'}.` : undefined}>
        {loaded && servers.length === 0 && <EmptyState icon={Wrench} title="No MCP servers yet" action={<button className="btn" onClick={() => setAdding(true)}>Add a server</button>}>Search the registry below, import configs from Claude or Cursor, or add one by command.</EmptyState>}
        <div className="item-list">
          {servers.map((server) => (
            <div key={server.id} className="item-row">
              <span className={server.lastError ? 'dot off' : server.enabled ? 'dot on' : 'dot'} aria-hidden />
              <span className="grow"><strong>{server.name}</strong><span className="faint">{server.enabled ? 'on' : 'off'} · {server.execution} · network {server.network} · risk {server.riskLevel || 'not vetted'}{server.source ? ` · from ${server.source}` : ''}</span>
                {server.lastError && <span className="faint" style={{ color: 'var(--coral)' }}>{server.lastError}</span>}
              </span>
              {results[server.id] && <span className={results[server.id]!.ok ? 'test-result ok' : 'test-result bad'} role="status">{results[server.id]!.text}</span>}
              <button className="btn small" disabled={testing === server.id} title="Start it and list its tools" onClick={() => void testServer(server)}><FlaskConical size={14} aria-hidden /> {testing === server.id ? 'Testing…' : 'Test'}</button>
              <Menu label={`Options for ${server.name}`} items={[
                { label: 'Connect', icon: Plug, onSelect: () => void post(`/api/mcp/${server.id}/refresh`).then(load).then(() => toast(`Connected ${server.name}.`, 'ok')).catch((error) => toast(errorText(error), 'error')) },
                { label: 'Reconnect', icon: RefreshCw, onSelect: () => void post(`/api/mcp/${server.id}/refresh`).then(load).catch((error) => toast(errorText(error), 'error')) },
                { label: 'Remove', icon: Trash2, danger: true, separator: true, onSelect: () => { if (window.confirm(`Remove ${server.name}? Its container is deleted.`)) void api(`/api/mcp/${server.id}`, { method: 'DELETE' }).then(load); } },
              ]} />
            </div>
          ))}
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
      {adding && (
        <form className="card section" onSubmit={async (event) => { event.preventDefault(); const result = await post<{ report: Report }>('/api/mcp/vet', { name, command, args: args.split(' ').filter(Boolean), source: 'ui', reputation: !skipReputation }); setReport(result.report); }}>
          <div className="card-head"><div><h3>Add a server by command</h3><p className="faint section-desc">It is vetted before anything is installed.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} required autoFocus placeholder="filesystem" /></label>
            <label className="field"><span>Command</span><input value={command} onChange={(event) => setCommand(event.target.value)} /></label>
          </div>
          <label className="field"><span>Arguments</span><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @scope/server" /></label>
          <label className="row"><input type="checkbox" checked={skipReputation} onChange={(event) => setSkipReputation(event.target.checked)} /> Skip the local web reputation search</label>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Vet before install</button><button className="btn ghost" type="button" onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      )}
      <Section title="Find a server" description="Search the public MCP registry.">
        <form className="row" onSubmit={search}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filesystem, github, calendar…" aria-label="Search the registry" style={{ flex: '1 1 260px' }} />
          <button className="btn" disabled={searching || !query.trim()}><Search size={15} aria-hidden /> {searching ? 'Searching…' : 'Search'}</button>
        </form>
        {registry.length > 0 && <div className="item-list" style={{ marginTop: 8 }}>
          {registry.map((item) => (
            <div key={item.name} className="item-row">
              <span className="grow"><strong>{item.name}</strong><span className="faint">{item.description}</span></span>
              <button className="btn small" onClick={async () => { const result = await post<{ report: Report }>('/api/mcp/vet', { name: item.name || 'server', command: 'npx', args: item.package ? ['-y', item.package] : [], source: 'registry', reputation: !skipReputation }); setReport(result.report); }}>Vet</button>
            </div>
          ))}
        </div>}
      </Section>
      {report && (
        <div className="card section">
          <h3>Risk {report.score} · {report.level}</h3>
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
          <div className="row"><button className="btn primary" onClick={async () => { await post('/api/mcp/install', { reportId: report.id, acknowledgeRisk: true, acknowledgeCritical: report.level === 'critical' }); setReport(null); setAdding(false); await load(); toast('Installed. Press Connect to start it.', 'ok'); }}>Approve and install</button><button className="btn ghost" onClick={() => setReport(null)}>Discard</button></div>
        </div>
      )}
    </div>
  );
}
