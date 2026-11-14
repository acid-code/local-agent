import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { toast } from '../lib/toast';
import { Appearance } from '../components/Appearance';
import { AccountCard, People, QuotaCard } from '../components/People';
import { ImageRole } from '../components/ImageRole';

interface Secret { id: string; name: string; handle: string; scope: string; revokedAt: string | null }
interface Audit { id: number; action: string; actor: string; createdAt: string }
interface SettingsShape { codeApproval: string; geminiTier: string; sandbox: string; autoResume: boolean; approvalForDestructive: boolean; readOnly?: boolean }

export function Settings({ role = 'owner' }: { role?: 'owner' | 'member' }) {
  if (role === 'member') {
    return (
      <div className="page">
        <h1>Settings</h1>
        <p className="lede">Make it yours. Your look, chats, personas and files belong to your account only.</p>
        <Appearance />
        <ImageRole />
        <QuotaCard />
        <AccountCard />
      </div>
    );
  }
  return <OwnerSettings />;
}

function OwnerSettings() {
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
  const [allAudit, setAllAudit] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  async function refreshHealth() {
    setChecking('all');
    try { setHealth((await api<{ checks: typeof health }>('/api/debug/health')).checks); } finally { setChecking(null); }
  }
  useEffect(() => {
    void load();
    void refreshHealth().catch(() => undefined);
    if (window.location.hash) setTimeout(() => document.querySelector(window.location.hash)?.scrollIntoView({ block: 'start' }), 300);
  }, []);

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="lede">Secrets are encrypted with AES-256-GCM under a master key that lives in the data directory, mode 0600. Models receive handles. Traces are redacted. Reveal asks for your password again.</p>
      <nav className="section-tabs" aria-label="Settings sections">
        {[['appearance', 'Appearance'], ['people', 'People'], ['health', 'Health'], ['policy', 'Policy'], ['vault', 'Vault'], ['audit', 'Audit'], ['backups', 'Backups'], ['debug', 'Debug'], ['remote', 'Remote']].map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(event) => { event.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#${id}`); }}>{label}</a>
        ))}
      </nav>
      <Appearance />
      <People />
      <div className="card" id="health">
        <div className="card-head"><h3>System health</h3><button className="btn" type="button" disabled={checking === 'all'} onClick={() => void refreshHealth()}>{checking === 'all' ? 'Checking…' : 'Refresh health'}</button></div>
        {health.length === 0 && <p className="faint">{checking ? 'Checking Ollama, Docker, SearXNG and the rest…' : 'No results yet.'}</p>}
        <ul className="health-list">
          {health.map((check) => (
            <li key={check.id}>
              <span className={check.ok ? 'badge ok' : 'badge warn'}>{check.ok ? 'ok' : 'check'}</span>
              <span className="health-detail"><strong>{check.id}</strong> <span className="muted">{check.detail}</span></span>
              <button className="btn ghost small" type="button" disabled={checking === check.id} onClick={async () => { setChecking(check.id); try { const data = await post<{ check: typeof check }>(`/api/debug/health/${encodeURIComponent(check.id)}`); setHealth((items) => items.map((item) => item.id === data.check.id ? data.check : item)); } finally { setChecking(null); } }}>{checking === check.id ? 'Testing…' : 'Test'}</button>
            </li>
          ))}
        </ul>
      </div>
      {settings && (
        <div className="card" id="policy">
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
      <form className="card" id="vault" onSubmit={async (event) => { event.preventDefault(); await post('/api/vault', { name, value, scope: 'global' }); setValue(''); await load(); }}>
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
      <div className="card" id="audit">
        <h3>Audit</h3>
        {audit.length === 0 && <p className="faint">Nothing logged yet.</p>}
        {(allAudit ? audit : audit.slice(0, 12)).map((row) => <p key={row.id} className="mono faint wrap">{row.createdAt} · {row.action} · {row.actor}</p>)}
        {audit.length > 12 && <button className="btn ghost" onClick={() => setAllAudit((value) => !value)}>{allAudit ? 'Show fewer' : `Show all ${audit.length}`}</button>}
      </div>
      <div className="card" id="backups">
        <h3>Backups</h3>
        <p className="muted">A snapshot includes the database, the encrypted vault, its master key, and persona workspaces. Treat the file as private. Restore restarts the process.</p>
        <button className="btn primary" onClick={async () => { const result = await post<{ backup: { id: string }; shipped: { detail: string } }>('/api/backups'); toast(`Saved ${result.backup.id}. ${result.shipped.detail}`, 'ok'); }}>Take a snapshot</button>
      </div>
      <div className="card" id="debug">
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
        {logs.slice(0, 40).map((row) => <p key={row.id} className="mono faint wrap">{row.createdAt} · {row.level} · {row.component} · {row.message}</p>)}
        <h3>Run inspector</h3>
        <div className="row">
          <input aria-label="Run id" value={runId} placeholder="run id" onChange={(event) => setRunId(event.target.value)} />
          <button className="btn" type="button" onClick={async () => setInspection(JSON.stringify(await api(`/api/debug/runs/${runId}`), null, 2))}>Inspect</button>
          <button className="btn" type="button" onClick={async () => { const data = await post<{ run: { id: string } }>(`/api/debug/runs/${runId}/replay`); setInspection(`Replayed as ${data.run.id}`); }}>Replay on rehearsal</button>
        </div>
        {inspection && <pre className="command">{inspection.slice(0, 8000)}</pre>}
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
      <div className="card" id="remote">
        <h3>Remote access</h3>
        <p>Tailscale is the path to use from university. Install it on this box and on the phone, then open <span className="mono">http://&lt;tailscale-ip&gt;:8787</span>. The login still applies. Cloudflare Tunnel works too: <span className="mono">cloudflared tunnel --url http://127.0.0.1:8787</span>. Do not publish the port on the public internet without one of those and this login.</p>
        <p className="faint">Coding CLIs on PATH: {clis.length ? clis.join(', ') : 'none detected. Built-in edit tools still run.'}</p>
      </div>
    </div>
  );
}
