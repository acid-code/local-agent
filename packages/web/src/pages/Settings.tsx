import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { toast } from '../lib/toast';
import { Appearance } from '../components/Appearance';
import { AccountCard, People, QuotaCard } from '../components/People';
import { ImageRole } from '../components/ImageRole';
import { EmptyState, PageHeader, useHashTab } from '../components/ui';
import { Activity, Archive, Bug, Globe, KeyRound, Palette, ScrollText, ShieldCheck, Users, type LucideIcon } from 'lucide-react';

interface Secret { id: string; name: string; handle: string; scope: string; revokedAt: string | null }
interface Audit { id: number; action: string; actor: string; createdAt: string }
interface SettingsShape { codeApproval: string; geminiTier: string; sandbox: string; autoResume: boolean; approvalForDestructive: boolean; readOnly?: boolean; dailyTokenLimit?: number | null; killSwitch?: boolean }

const TABS: { group: string; items: { id: string; label: string; icon: LucideIcon; blurb: string }[] }[] = [
  { group: 'You', items: [
    { id: 'appearance', label: 'Appearance', icon: Palette, blurb: 'Theme, bubbles and wallpaper for your account.' },
    { id: 'people', label: 'People', icon: Users, blurb: 'Member accounts and what they may use.' },
  ] },
  { group: 'System', items: [
    { id: 'health', label: 'Health', icon: Activity, blurb: 'Ollama, Docker, SearXNG, RAM budget and the rest.' },
    { id: 'policy', label: 'Safety & limits', icon: ShieldCheck, blurb: 'Approvals, read-only mode, the kill switch and token caps.' },
    { id: 'vault', label: 'Secrets', icon: KeyRound, blurb: 'API keys, encrypted with AES-256-GCM. Models only see handles.' },
    { id: 'backups', label: 'Backups', icon: Archive, blurb: 'Snapshots of the database, vault and workspaces.' },
  ] },
  { group: 'Advanced', items: [
    { id: 'audit', label: 'Audit log', icon: ScrollText, blurb: 'Who changed what, newest first.' },
    { id: 'debug', label: 'Debug', icon: Bug, blurb: 'Logs, run inspector and diagnostics. Nothing leaves this machine.' },
    { id: 'remote', label: 'Remote access', icon: Globe, blurb: 'Reach this box from your phone or laptop.' },
  ] },
];
const TAB_IDS = TABS.flatMap((group) => group.items.map((item) => item.id));

export function Settings({ role = 'owner' }: { role?: 'owner' | 'member' }) {
  if (role === 'member') {
    return (
      <div className="page">
        <PageHeader title="Settings" description="Make it yours. Your look, chats, personas and files belong to your account only." />
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
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [tab, setTab] = useHashTab(TAB_IDS, 'appearance');
  const current = TABS.flatMap((group) => group.items).find((item) => item.id === tab)!;
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
  }, []);

  return (
    <div className="page">
      <PageHeader title="Settings" description="Your look, the people who use this box, and how the system behaves." />
      <div className="settings-layout">
        <nav className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const next = TAB_IDS[(TAB_IDS.indexOf(tab) + (event.key === 'ArrowDown' ? 1 : -1) + TAB_IDS.length) % TAB_IDS.length]!;
          setTab(next);
          setTimeout(() => document.getElementById(`tab-${next}`)?.focus(), 0);
        }}>
          {TABS.map((group) => (
            <div key={group.group} role="presentation">
              <span className="nav-heading">{group.group}</span>
              {group.items.map((item) => (
                <button key={item.id} id={`tab-${item.id}`} role="tab" type="button" aria-selected={tab === item.id} aria-controls="settings-panel" tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>
                  <item.icon aria-hidden /> {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-body" id="settings-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <h2>{current.label}</h2>
          <p className="faint page-sub">{current.blurb}</p>
      {tab === 'appearance' && <Appearance />}
      {tab === 'people' && <People />}
      {tab === 'health' && <div className="card" id="health">
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
      </div>}
      {tab === 'policy' && settings && (
        <div className="card" id="policy">
          <h3>Approvals</h3>
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
          <p className="faint">Sandbox: {settings.sandbox}. Destructive shell commands ask first: {settings.approvalForDestructive ? 'yes' : 'no'}. Interrupted runs resume on restart: {settings.autoResume ? 'yes' : 'no'}.</p>
          <h3 style={{ marginTop: 18 }}>Limits</h3>
          <label className="field"><span>Daily token cap</span>
            <input type="number" min={1} placeholder="No cap" defaultValue={settings.dailyTokenLimit ?? ''} onBlur={async (event) => { const value = event.target.value ? Number(event.target.value) : null; await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ dailyTokenLimit: value }) }); toast(value ? `Daily cap set to ${value.toLocaleString()} tokens.` : 'Daily cap removed.', 'ok'); }} />
          </label>
          <h3 style={{ marginTop: 18 }}>Emergency</h3>
          <p className="faint">Read-only blocks every write and tool that changes something. The kill switch stops all running turns and refuses new ones until you clear it.</p>
          <div className="row">
            <button className="btn" onClick={async () => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ readOnly: !settings.readOnly }) }); await load(); toast(settings.readOnly ? 'Read-only is off.' : 'Read-only is on.', 'ok'); }}>{settings.readOnly ? 'Turn off read-only' : 'Turn on read-only'}</button>
            <button className="btn danger" onClick={async () => { if (!window.confirm('Stop every running turn now?')) return; await post('/api/control/kill'); await load(); toast('Kill switch on. Nothing runs until you clear it.', 'ok'); }}>Kill switch</button>
            <button className="btn ghost" onClick={async () => { await post('/api/control/resume'); await load(); toast('Kill switch cleared.', 'ok'); }}>Clear kill switch</button>
          </div>
        </div>
      )}
      {tab === 'vault' && <>
      <form className="card" id="vault" onSubmit={async (event) => { event.preventDefault(); await post('/api/vault', { name, value, scope: 'global' }); setValue(''); await load(); toast(`Saved ${name}.`, 'ok'); }}>
        <h3>Add a secret</h3>
        <div className="row">
          <label className="field" style={{ flex: '1 1 220px' }}><span>Name</span><input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="GEMINI_API_KEY" /></label>
          <label className="field" style={{ flex: '2 1 280px' }}><span>Value</span><input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} /></label>
        </div>
        <button className="btn primary" disabled={!name || !value}>Save secret</button>
      </form>
      <div className="card">
        <h3>Stored secrets</h3>
        {secrets.length === 0 && <EmptyState icon={KeyRound} title="No secrets yet">Add GEMINI_API_KEY to use Gemini, or GITHUB_TOKEN to push to GitHub.</EmptyState>}
        <div className="item-list">
          {secrets.map((secret) => (
            <div key={secret.id} className="item-row">
              <span className={secret.revokedAt ? 'dot off' : 'dot on'} aria-hidden />
              <span className="grow"><strong className="mono">{secret.handle}</strong><span className="faint">{secret.scope}{secret.revokedAt ? ' · revoked' : ''}</span>
                {revealed?.id === secret.id && <span className="mono wrap">{revealed.value}</span>}
              </span>
              {revealing === secret.id ? (
                <form className="row" onSubmit={async (event) => { event.preventDefault(); const data = await post<{ value: string }>(`/api/vault/${secret.id}/reveal`, { password }); setRevealed({ id: secret.id, value: data.value }); setPassword(''); setRevealing(null); }}>
                  <input type="password" autoFocus aria-label="Your password" placeholder="Your password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRevealing(null); }} />
                  <button className="btn small">Reveal</button>
                </form>
              ) : revealed?.id === secret.id ? <button className="btn ghost small" onClick={() => setRevealed(null)}>Hide</button>
                : <button className="btn ghost small" disabled={Boolean(secret.revokedAt)} onClick={() => { setRevealing(secret.id); setPassword(''); }}>Reveal…</button>}
              <button className="btn danger small" disabled={Boolean(secret.revokedAt)} onClick={async () => { if (!window.confirm(`Revoke ${secret.handle}? Tools using it stop working.`)) return; await post(`/api/vault/${secret.id}/revoke`); await load(); }}>Revoke</button>
            </div>
          ))}
        </div>
      </div>
      </>}
      {tab === 'audit' && <div className="card" id="audit">
        <h3>Audit</h3>
        {audit.length === 0 && <p className="faint">Nothing logged yet.</p>}
        {(allAudit ? audit : audit.slice(0, 12)).map((row) => <p key={row.id} className="mono faint wrap">{row.createdAt} · {row.action} · {row.actor}</p>)}
        {audit.length > 12 && <button className="btn ghost" onClick={() => setAllAudit((value) => !value)}>{allAudit ? 'Show fewer' : `Show all ${audit.length}`}</button>}
      </div>}
      {tab === 'backups' && <div className="card" id="backups">
        <h3>Backups</h3>
        <p className="muted">A snapshot includes the database, the encrypted vault, its master key, and persona workspaces. Treat the file as private. Restore restarts the process.</p>
        <button className="btn primary" onClick={async () => { const result = await post<{ backup: { id: string }; shipped: { detail: string } }>('/api/backups'); toast(`Saved ${result.backup.id}. ${result.shipped.detail}`, 'ok'); }}>Take a snapshot</button>
        <p className="faint">Schedule and target live in the setup site (Defaults → Backup cron, Backup target).</p>
      </div>}
      {tab === 'debug' && <div className="card" id="debug">
        <h3>Logs</h3>
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
      </div>}
      {tab === 'remote' && <div className="card" id="remote">
        <h3>Tailscale (recommended)</h3>
        <p>Tailscale is the path to use from university. Install it on this box and on the phone, then open <span className="mono">http://&lt;tailscale-ip&gt;:8787</span>. The login still applies. Cloudflare Tunnel works too: <span className="mono">cloudflared tunnel --url http://127.0.0.1:8787</span>. Do not publish the port on the public internet without one of those and this login.</p>
        <p className="faint">Coding CLIs on PATH: {clis.length ? clis.join(', ') : 'none detected. Built-in edit tools still run.'}</p>
      </div>}
        </div>
      </div>
    </div>
  );
}
