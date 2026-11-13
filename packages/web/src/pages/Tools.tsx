import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Server { id: string; name: string; source: string | null; enabled: boolean; riskLevel: string | null; riskScore: number | null; lastError: string | null; execution: string; network: string }
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

  async function load() { setServers((await api<{ servers: Server[] }>('/api/mcp')).servers); }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Tools and MCP</h1>
      <p className="lede">Imported servers stay off until you vet them. Stdio servers run in their own container: no host mounts, dropped capabilities, and a network mode you can see before you approve. A container is the right boundary because an MCP server is someone else's code with your files and your keys one environment variable away.</p>
      <div className="row">
        <button className="btn" onClick={async () => { await post('/api/mcp/discover'); await load(); }}>Import known configs</button>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the registry" />
        <button className="btn" onClick={async () => setRegistry((await api<{ servers: { name?: string; description?: string; package?: string }[] }>(`/api/mcp/registry?q=${encodeURIComponent(query)}`)).servers)}>Browse</button>
      </div>
      <div className="grid cards" style={{ marginTop: 12 }}>
        {registry.map((item) => (
          <article key={item.name} className="card">
            <h3>{item.name}</h3>
            <p className="muted">{item.description}</p>
            <button className="btn" onClick={async () => { const result = await post<{ report: Report }>('/api/mcp/vet', { name: item.name || 'server', command: 'npx', args: item.package ? ['-y', item.package] : [], source: 'registry', reputation: !skipReputation }); setReport(result.report); }}>Vet</button>
          </article>
        ))}
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={async (event) => { event.preventDefault(); const result = await post<{ report: Report }>('/api/mcp/vet', { name, command, args: args.split(' ').filter(Boolean), source: 'ui', reputation: !skipReputation }); setReport(result.report); }}>
        <h3>Add a server</h3>
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label className="field"><span>Command</span><input value={command} onChange={(event) => setCommand(event.target.value)} /></label>
        <label className="field"><span>Args</span><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @scope/server" /></label>
        <label className="row"><input type="checkbox" checked={skipReputation} onChange={(event) => setSkipReputation(event.target.checked)} /> Skip the local web reputation search for this install</label>
        <button className="btn primary">Vet before install</button>
      </form>
      {report && (
        <div className="card" style={{ marginTop: 12 }}>
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
          <button className="btn primary" onClick={async () => { await post('/api/mcp/install', { reportId: report.id, acknowledgeRisk: true, acknowledgeCritical: report.level === 'critical' }); setReport(null); await load(); }}>Approve and install</button>
        </div>
      )}
      <div className="grid" style={{ marginTop: 16 }}>
        {servers.map((server) => (
          <article key={server.id} className="card">
            <h3>{server.name}</h3>
            <p className="faint">{server.source} · {server.execution} · network {server.network} · risk {server.riskLevel || 'unvetted'}</p>
            {server.lastError && <p className="badge bad">{server.lastError}</p>}
            <div className="row">
              <button className="btn" onClick={() => post(`/api/mcp/${server.id}/refresh`).then(load).catch((error) => alert(error.message))}>Connect</button>
              <button className="btn danger" onClick={() => api(`/api/mcp/${server.id}`, { method: 'DELETE' }).then(load)}>Remove</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
