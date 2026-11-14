import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Secret { id: string; name: string; handle: string; scope: string; revokedAt: string | null }
interface Audit { id: number; action: string; actor: string; createdAt: string }
interface SettingsShape { codeApproval: string; geminiTier: string; sandbox: string; autoResume: boolean; approvalForDestructive: boolean; readOnly?: boolean }

export function Settings() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [name, setName] = useState('GEMINI_API_KEY');
  const [value, setValue] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState('');
  const [clis, setClis] = useState<string[]>([]);
  const [logs, setLogs] = useState<{ id: number; level: string; component: string; message: string; createdAt: string }[]>([]);
  const [component, setComponent] = useState('');
  const [query, setQuery] = useState('');
  const [debugLevel, setDebugLevel] = useState('info');
  const [health, setHealth] = useState<{ id: string; ok: boolean; detail: string }[]>([]);
  const [toolTests, setToolTests] = useState<{ tool: string; query: string; ok: boolean; ms: number; output: string; error?: string }[]>([]);
  const [runId, setRunId] = useState('');
  const [inspection, setInspection] = useState('');

  async function load() {
    const data = await api<{ settings: SettingsShape; vault: Secret[]; audit: Audit[]; clis: string[] }>('/api/settings');
    setSettings(data.settings);
    setSecrets(data.vault);
    setAudit(data.audit);
    setClis(data.clis);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="lede">Secrets are encrypted with AES-256-GCM under a master key that lives in the data directory, mode 0600. Models receive handles. Traces are redacted. Reveal asks for your password again.</p>
      {settings && (
        <div className="card">
          <h3>Policy</h3>
          <label className="field"><span>Code edits</span>
            <select value={settings.codeApproval} onChange={async (event) => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ codeApproval: event.target.value }) }); await load(); }}>
              <option value="sandbox-auto">Auto inside the workspace, ask for host paths and push</option>
              <option value="always">Ask before every edit batch</option>
            </select>
          </label>
          <label className="field"><span>Gemini tier</span>
            <select value={settings.geminiTier} onChange={async (event) => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ geminiTier: event.target.value }) }); await load(); }}>
              <option value="free">Free tier (respect the AI Studio caps)</option>
              <option value="paid">Paid (Argon and Pro become eligible)</option>
            </select>
          </label>
          <p className="faint">Sandbox {settings.sandbox}. Destructive shell approval {settings.approvalForDestructive ? 'on' : 'off'}. Auto-resume {settings.autoResume ? 'on' : 'off'}.</p>
          <div className="row">
            <button className="btn danger" onClick={async () => { await post('/api/control/kill'); await load(); }}>Kill switch</button>
            <button className="btn" onClick={async () => { await post('/api/control/resume'); await load(); }}>Clear kill switch</button>
            <button className="btn" onClick={async () => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ readOnly: !settings.readOnly }) }); await load(); }}>{settings.readOnly ? 'Leave read-only' : 'Read-only mode'}</button>
          </div>
          <label className="field"><span>Daily token cap (blank = none)</span>
            <input type="number" placeholder="e.g. 200000" onBlur={async (event) => { const value = event.target.value ? Number(event.target.value) : null; await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ dailyTokenLimit: value }) }); }} />
          </label>
        </div>
      )}
      <form className="card" onSubmit={async (event) => { event.preventDefault(); await post('/api/vault', { name, value, scope: 'global' }); setValue(''); await load(); }}>
        <h3>Vault</h3>
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Value</span><input type="password" value={value} onChange={(event) => setValue(event.target.value)} /></label>
        <button className="btn primary">Store</button>
      </form>
      {secrets.map((secret) => (
        <article key={secret.id} className="card">
          <strong>{secret.handle}</strong> <span className="faint">{secret.scope}{secret.revokedAt ? ' · revoked' : ''}</span>
          <div className="row">
            <input type="password" placeholder="Password to reveal" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button className="btn" onClick={async () => { const data = await post<{ value: string }>(`/api/vault/${secret.id}/reveal`, { password }); setRevealed(data.value); }}>Reveal</button>
            <button className="btn danger" onClick={async () => { await post(`/api/vault/${secret.id}/revoke`); await load(); }}>Revoke</button>
          </div>
          {revealed && <p className="mono">{revealed}</p>}
        </article>
      ))}
      <h3>Audit</h3>
      {audit.map((row) => <p key={row.id} className="mono faint">{row.createdAt} · {row.action} · {row.actor}</p>)}
      <div className="card">
        <h3>Backups</h3>
        <p className="muted">A snapshot includes the database, the encrypted vault, its master key, and persona workspaces. Treat the file as private. Restore restarts the process.</p>
        <button className="btn primary" onClick={async () => { const result = await post<{ backup: { id: string }; shipped: { detail: string } }>('/api/backups'); alert(`Saved ${result.backup.id}. ${result.shipped.detail}`); }}>Take a snapshot</button>
      </div>
      <div className="card">
        <h3>Debug</h3>
        <p className="muted">Owner only. Logs stay on this machine, rotate when they grow past 2 MB, and exports are redacted. Nothing here is sent anywhere.</p>
        <label className="field"><span>Log level</span>
          <select value={debugLevel} onChange={async (event) => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ debugLevel: event.target.value }) }); setDebugLevel(event.target.value); }}>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
        </label>
        <div className="row">
          <select aria-label="Component" value={component} onChange={(event) => setComponent(event.target.value)}>
            <option value="">All components</option>
            {['engine', 'router', 'context', 'providers', 'mcp', 'docker', 'triggers', 'repos', 'kb', 'setup', 'notify'].map((item) => <option key={item}>{item}</option>)}
          </select>
          <input aria-label="Search logs" value={query} placeholder="Search" onChange={(event) => setQuery(event.target.value)} />
          <button className="btn" type="button" onClick={async () => { const data = await api<{ logs: typeof logs; debugLevel: string }>(`/api/logs?component=${component}&q=${encodeURIComponent(query)}`); setLogs(data.logs); setDebugLevel(data.debugLevel); }}>Tail</button>
        </div>
        {logs.slice(0, 40).map((row) => <p key={row.id} className="mono faint">{row.createdAt} · {row.level} · {row.component} · {row.message}</p>)}
        <h3>Run inspector</h3>
        <div className="row">
          <input aria-label="Run id" value={runId} placeholder="run id" onChange={(event) => setRunId(event.target.value)} />
          <button className="btn" type="button" onClick={async () => setInspection(JSON.stringify(await api(`/api/debug/runs/${runId}`), null, 2))}>Inspect</button>
          <button className="btn" type="button" onClick={async () => { const data = await post<{ run: { id: string } }>(`/api/debug/runs/${runId}/replay`); setInspection(`Replayed as ${data.run.id}`); }}>Replay on rehearsal</button>
        </div>
        {inspection && <pre className="command">{inspection.slice(0, 8000)}</pre>}
        <h3>System health</h3>
        <button className="btn" type="button" onClick={async () => setHealth((await api<{ checks: typeof health }>('/api/debug/health')).checks)}>Refresh health</button>
        {health.map((check) => (
          <p key={check.id} className="row"><span className={check.ok ? 'badge' : 'badge warn'}>{check.ok ? 'ok' : 'check'}</span> {check.id}: {check.detail}
            <button className="btn" type="button" onClick={async () => { const data = await post<{ check: typeof check }>(`/api/debug/health/${encodeURIComponent(check.id)}`); setHealth((items) => items.map((item) => item.id === data.check.id ? data.check : item)); }}>Test now</button>
          </p>
        ))}
        <h3>Tool test</h3>
        <button className="btn" type="button" onClick={async () => setToolTests((await post<{ results: typeof toolTests }>('/api/debug/tool-test', {})).results)}>Test web_search and kb_search</button>
        {toolTests.map((test) => (
          <div key={test.tool}>
            <p className="row"><span className={test.ok ? 'badge' : 'badge warn'}>{test.ok ? 'ok' : 'check'}</span> {test.tool} “{test.query}” in {test.ms} ms{test.error ? `: ${test.error}` : ''}</p>
            {test.output && <pre className="command">{test.output.slice(0, 1200)}</pre>}
          </div>
        ))}
        <p><a className="btn" href="/api/debug/bundle">Download redacted diagnostics</a></p>
        <p className="faint">Over SSH: <span className="mono">npm run doctor</span>. To recover a forgotten password: <span className="mono">npm run reset-owner</span>.</p>
      </div>
      <div className="card">
        <h3>Remote access</h3>
        <p>Tailscale is the path to use from university. Install it on this box and on the phone, then open <span className="mono">http://&lt;tailscale-ip&gt;:8787</span>. The login still applies. Cloudflare Tunnel works too: <span className="mono">cloudflared tunnel --url http://127.0.0.1:8787</span>. Do not publish the port on the public internet without one of those and this login.</p>
        <p className="faint">Coding CLIs on PATH: {clis.length ? clis.join(', ') : 'none detected. Built-in edit tools still run.'}</p>
      </div>
    </div>
  );
}
