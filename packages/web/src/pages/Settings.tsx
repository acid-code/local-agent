import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, post } from '../lib/api';
import { toast } from '../lib/toast';
import { Appearance } from '../components/Appearance';
import { AccountCard, People, QuotaCard } from '../components/People';
import { ImageRole } from '../components/ImageRole';
import { EmptyState, PageHeader } from '../components/ui';
import { useUsableModels } from '../lib/models';
import { Activity, Archive, Bot, Bug, Check, Cpu, FolderGit2, Globe, KeyRound, Palette, ScrollText, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import { useWorkspaces } from '../components/PersonaPanel';
import { Face, type FaceAgent } from '../components/Face';

interface Secret { id: string; name: string; handle: string; scope: string; revokedAt: string | null }
interface Audit { id: number; action: string; actor: string; createdAt: string }
interface SettingsShape { codeApproval: string; geminiTier: string; sandbox: string; autoResume: boolean; approvalForDestructive: boolean; readOnly?: boolean; dailyTokenLimit?: number | null; killSwitch?: boolean }

interface Def { id: string; label: string; icon: LucideIcon; blurb: string; words: string; owner?: boolean; group: 'General' | 'Admin' }
/** One page, in this order. Old deep links (#vault, #policy, #backups…) land on the matching section. */
const SECTIONS: Def[] = [
  { id: 'appearance', group: 'General', label: 'Appearance', icon: Palette, blurb: 'Theme, font, bubbles and wallpaper for your account.', words: 'theme dark light font wallpaper color bubbles density accent' },
  { id: 'models', group: 'General', label: 'Models', icon: Cpu, blurb: 'What answers, and which model draws images.', words: 'models ollama gemini image pull refresh limits quota tier' },
  { id: 'personas', group: 'General', label: 'Personas', icon: Bot, blurb: 'Who you talk to. Edit one from the chat with its name.', words: 'personas agents prompt instructions tools skills face' },
  { id: 'workspaces', group: 'General', label: 'Workspaces', icon: FolderGit2, blurb: 'Folders and repos chats can attach.', words: 'workspaces folders repos git clone sets' },
  { id: 'data', group: 'General', label: 'Data', icon: Archive, blurb: 'Your account, backups and exports.', words: 'backups snapshot restore export password account diagnostics' },
  { id: 'people', group: 'Admin', owner: true, label: 'People', icon: Users, blurb: 'Member accounts and what they may use.', words: 'members accounts users invite quota' },
  { id: 'health', group: 'Admin', owner: true, label: 'Health', icon: Activity, blurb: 'Ollama, Docker, SearXNG, RAM budget and the rest.', words: 'ollama docker searxng ram memory status doctor' },
  { id: 'policy', group: 'Admin', owner: true, label: 'Safety & limits', icon: ShieldCheck, blurb: 'Approvals, read-only mode, the kill switch and token caps.', words: 'approvals read-only kill switch tokens caps limits safety emergency gemini tier' },
  { id: 'vault', group: 'Admin', owner: true, label: 'Secrets', icon: KeyRound, blurb: 'API keys, encrypted with AES-256-GCM. Models only see handles.', words: 'keys api gemini openrouter secrets token github' },
  { id: 'audit', group: 'Admin', owner: true, label: 'Audit log', icon: ScrollText, blurb: 'Who changed what, newest first.', words: 'history log changes' },
  { id: 'debug', group: 'Admin', owner: true, label: 'Debug', icon: Bug, blurb: 'Logs, run inspector and diagnostics. Nothing leaves this machine.', words: 'logs inspector replay tool test diagnostics' },
  { id: 'remote', group: 'Admin', owner: true, label: 'Remote access', icon: Globe, blurb: 'Reach this box from your phone or laptop.', words: 'tailscale phone lan network access cloudflare' },
];
const ALIASES: Record<string, string> = { backups: 'data', account: 'data', quota: 'models', images: 'models' };

/** Autosave feedback: a "Saved" tick in the header for a moment after any change lands. */
function useSavedTick() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return {
    state,
    track: async <T,>(work: Promise<T>): Promise<T> => {
      setState('saving');
      try { const result = await work; setState('saved'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 2200); return result; }
      catch (error) { setState('idle'); toast((error as Error).message, 'error'); throw error; }
    },
  };
}
function SavedTick({ state }: { state: 'idle' | 'saving' | 'saved' }) {
  return <span className="saved-tick page-tick" aria-live="polite">{state === 'saving' ? 'Saving…' : state === 'saved' ? <><Check size={14} aria-hidden /> Saved</> : ''}</span>;
}

function SettingsPage({ owner, children }: { owner: boolean; children: (show: (id: string) => boolean, track: ReturnType<typeof useSavedTick>['track']) => ReactNode }) {
  const [find, setFind] = useState('');
  const saved = useSavedTick();
  const location = useLocation();
  const defs = SECTIONS.filter((def) => owner || !def.owner);
  const match = (def: Def) => !find.trim() || find.trim().toLowerCase().split(/\s+/).every((word) => `${def.label} ${def.blurb} ${def.words}`.toLowerCase().includes(word));
  const visible = defs.filter(match);
  const show = (id: string) => visible.some((def) => def.id === id);
  const [active, setActive] = useState(defs[0]!.id);
  // Deep links: #vault, #policy, #backups… scroll to their section (also after in-app navigation).
  useEffect(() => {
    const raw = location.hash.replace('#', '');
    if (!raw) return;
    const id = ALIASES[raw] ?? raw;
    setFind('');
    const go = () => { const el = document.getElementById(raw) ?? document.getElementById(`s-${id}`); if (el) { el.scrollIntoView({ block: 'start' }); setActive(id); } };
    const t = setTimeout(go, 60); const t2 = setTimeout(go, 600);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [location.hash]);
  // Highlight the section in view.
  useEffect(() => {
    const scroller = document.querySelector('.page.settings-page');
    if (!scroller) return;
    const onScroll = () => {
      let current = visible[0]?.id;
      for (const def of visible) { const el = document.getElementById(`s-${def.id}`); if (el && el.getBoundingClientRect().top < 160) current = def.id; }
      if (current) setActive(current);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [visible.map((def) => def.id).join()]);
  return (
    <div className="page settings-page">
      <PageHeader title="Settings" description="Everything on one page. Changes save as you make them." actions={<SavedTick state={saved.state} />} />
      <div className="settings-one">
        <nav className="settings-nav" aria-label="Settings sections">
          <input type="search" className="settings-find" placeholder="Search settings" aria-label="Search settings" value={find} onChange={(event) => setFind(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setFind(''); if (event.key === 'Enter' && visible[0]) document.getElementById(`s-${visible[0].id}`)?.scrollIntoView({ block: 'start' }); }} />
          {(['General', 'Admin'] as const).map((group) => {
            const items = visible.filter((def) => def.group === group);
            if (!items.length) return null;
            return (
              <div key={group}>
                {owner && <span className="nav-heading">{group === 'Admin' ? 'Admin (owner only)' : group}</span>}
                {items.map((def) => (
                  <a key={def.id} href={`#${def.id}`} onClick={(event) => { event.preventDefault(); document.getElementById(`s-${def.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActive(def.id); window.history.replaceState(window.history.state, '', `#${def.id}`); }} className={active === def.id ? 'on' : undefined} aria-current={active === def.id ? 'true' : undefined}><def.icon size={15} aria-hidden /> {def.label}</a>
                ))}
              </div>
            );
          })}
          {visible.length === 0 && <p className="faint settings-none">Nothing matches “{find}”.</p>}
        </nav>
        <div className="settings-flow">
          {children(show, saved.track)}
        </div>
      </div>
    </div>
  );
}

function Block({ id, children }: { id: string; children: ReactNode }) {
  const def = SECTIONS.find((item) => item.id === id)!;
  return (
    <section className="settings-block" id={`s-${id}`} aria-labelledby={`s-${id}-title`}>
      <h2 id={`s-${id}-title`}><def.icon size={17} aria-hidden /> {def.label}</h2>
      <p className="faint page-sub">{def.blurb}</p>
      {children}
    </section>
  );
}

function PersonasBlock() {
  const [agents, setAgents] = useState<(FaceAgent & { id: string; name: string; title?: string; hidden?: boolean })[] | null>(null);
  useEffect(() => { api<{ agents: (FaceAgent & { id: string; name: string; title?: string })[] }>('/api/agents').then((data) => setAgents(data.agents)).catch(() => setAgents([])); }, []);
  if (!agents) return <div className="skeleton-lines"><span /><span /></div>;
  if (!agents.length) return <EmptyState icon={Bot} title="No personas yet" action={<Link className="btn primary" to="/agents?new=1">New persona</Link>}>A persona is a name, a model and the tools it may use.</EmptyState>;
  return (
    <div className="item-list">
      {agents.map((agent) => (
        <div key={agent.id} className="item-row">
          <Face agent={agent} size={28} />
          <span className="grow"><strong>{agent.name}</strong><span className="faint">{agent.title || (agent.hidden ? 'hidden from the sidebar' : 'persona')}</span></span>
          <Link className="btn small ghost" to={`/?persona=${agent.id}`}>Chat</Link>
          <Link className="btn small" to={`/agents?edit=${agent.id}`}>Edit</Link>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}><Link className="btn small ghost" to="/agents?new=1">New persona</Link><Link className="btn small ghost" to="/agents">Manage personas</Link></div>
    </div>
  );
}

function WorkspacesBlock() {
  const ws = useWorkspaces();
  return (
    <>
      {ws.workspaces.length === 0 ? <EmptyState icon={FolderGit2} title="No workspaces yet" action={<Link className="btn" to="/">Add one from a chat</Link>}>Attach a folder or repo from the strip at the top of any chat.</EmptyState> : (
        <div className="item-list">
          {ws.workspaces.map((row) => (
            <div key={row.id} className="item-row"><span className={row.dirty ? 'dot warn' : 'dot ok'} aria-hidden /><span className="grow"><strong>{row.label}</strong><span className="faint mono">{row.kind === 'repo' ? `${row.branch || 'detached'} · ` : 'folder · '}{row.path}</span></span>
              <a className="btn small ghost" href={`/workspace?root=${encodeURIComponent(row.id)}`}>Open</a></div>
          ))}
        </div>
      )}
      <p className="faint" style={{ marginTop: 8 }}>Each chat keeps its own workspaces. A persona's default sets pre-fill its new chats (set them in the persona panel). {ws.sets.length ? `Sets: ${ws.sets.map((set) => set.name).join(', ')}.` : ''}</p>
    </>
  );
}

function ModelsBlock({ owner, settings, patchSettings }: { owner: boolean; settings: SettingsShape | null; patchSettings?: (body: Record<string, unknown>) => Promise<void> }) {
  const usable = useUsableModels();
  const count = usable.models.local.length + usable.models.cloud.filter((m) => !m.disabled).length;
  return (
    <>
      <div className="item-row settings-line">
        <span className="grow"><strong>{usable.loaded ? (count ? `${count} model${count === 1 ? '' : 's'} ready` : 'No model yet') : 'Checking…'}</strong>
          <span className="faint">{usable.models.local.map((m) => m.name).slice(0, 4).join(', ') || 'Pull one with Ollama'}{usable.models.geminiConnected ? ' · Gemini connected' : ' · Gemini not connected'}</span></span>
        {owner && <button className="btn small" disabled={usable.refreshing} onClick={() => void usable.refresh()}>{usable.refreshing ? 'Refreshing…' : 'Refresh models'}</button>}
        <Link className="btn small ghost" to="/models">Open Models</Link>
      </div>
      {owner && settings && patchSettings && (
        <label className="field settings-line"><span>Gemini tier</span>
          <select value={settings.geminiTier} onChange={(event) => void patchSettings({ geminiTier: event.target.value })}>
            <option value="free">Free tier (respect the documented limits)</option>
            <option value="paid">Paid (Argon and Pro become eligible)</option>
          </select>
        </label>
      )}
      {usable.models.empty && usable.loaded && <p className="faint">Without a model nothing can answer. <Link to="/setup">Set one up</Link>.</p>}
      <ImageRole />
      {!owner && <QuotaCard />}
    </>
  );
}

export function Settings({ role = 'owner' }: { role?: 'owner' | 'member' }) {
  if (role === 'member') {
    return (
      <SettingsPage owner={false}>
        {(show) => <>
          {show('appearance') && <Block id="appearance"><Appearance /></Block>}
          {show('models') && <Block id="models"><ModelsBlock owner={false} settings={null} /></Block>}
          {show('personas') && <Block id="personas"><PersonasBlock /></Block>}
          {show('workspaces') && <Block id="workspaces"><WorkspacesBlock /></Block>}
          {show('data') && <Block id="data"><AccountCard /></Block>}
        </>}
      </SettingsPage>
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
  const [clis, setClis] = useState<string[]>([]);
  const [logs, setLogs] = useState<{ id: number; level: string; component: string; message: string; createdAt: string }[]>([]);
  const [component, setComponent] = useState('');
  const [query, setQuery] = useState('');
  const [debugLevel, setDebugLevel] = useState('info');
  const [health, setHealth] = useState<{ id: string; ok: boolean; detail: string }[]>([]);
  const [toolTests, setToolTests] = useState<{ tool: string; query: string; ok: boolean; ms: number; output: string; error?: string }[]>([]);
  const [runId, setRunId] = useState('');
  const [inspection, setInspection] = useState('');
  const devModels = useUsableModels().models.dev.length > 0;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debounce = (key: string, fn: () => void, ms = 700) => { clearTimeout(timers.current[key]); timers.current[key] = setTimeout(fn, ms); };
  const trackRef = useRef<(<T>(work: Promise<T>) => Promise<T>) | null>(null);

  async function load() {
    const data = await api<{ settings: SettingsShape; vault: Secret[]; audit: Audit[]; clis: string[] }>('/api/settings');
    setSettings(data.settings);
    setSecrets(data.vault);
    setAudit(data.audit);
    setClis(data.clis);
  }
  /** Every settings change autosaves through here and shows the "Saved" tick. */
  async function patchSettings(body: Record<string, unknown>) {
    const work = api('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
    await (trackRef.current ? trackRef.current(work) : work);
    await load();
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
    <SettingsPage owner>
      {(show, track) => { trackRef.current = track; return <>
      {show('appearance') && <Block id="appearance"><Appearance /></Block>}
      {show('models') && <Block id="models"><ModelsBlock owner settings={settings} patchSettings={patchSettings} /></Block>}
      {show('personas') && <Block id="personas"><PersonasBlock /></Block>}
      {show('workspaces') && <Block id="workspaces"><WorkspacesBlock /></Block>}
      {show('data') && <Block id="data">
        <div className="card" id="backups">
          <h3>Backups</h3>
          <p className="muted">A snapshot includes the database, the encrypted vault, its master key, and persona workspaces. Treat the file as private. Restore restarts the process.</p>
          <button className="btn" onClick={async () => { const result = await track(post<{ backup: { id: string }; shipped: { detail: string } }>('/api/backups')); toast(`Saved ${result.backup.id}. ${result.shipped.detail}`, 'ok'); }}>Take a snapshot</button>
          <p className="faint">Schedule and target live in the setup site (Defaults → Backup cron, Backup target).</p>
        </div>
        <AccountCard />
      </Block>}
      {show('people') && <Block id="people"><People /></Block>}
      {show('health') && <Block id="health">{null}</Block>}
      {show('health') && <div className="card" id="health">
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
      {show('policy') && <Block id="policy">{null}</Block>}
      {show('policy') && settings && (
        <div className="card" id="policy">
          <h3>Approvals</h3>
          <label className="field"><span>Code edits</span>
            <select value={settings.codeApproval} onChange={async (event) => { await patchSettings({ codeApproval: event.target.value }); await load(); }}>
              <option value="sandbox-auto">Auto inside the workspace, ask for host paths and push</option>
              <option value="always">Ask before every edit batch</option>
            </select>
          </label>
          <p className="faint">Sandbox: {settings.sandbox}. Destructive shell commands ask first: {settings.approvalForDestructive ? 'yes' : 'no'}. Interrupted runs resume on restart: {settings.autoResume ? 'yes' : 'no'}.</p>
          <h3 style={{ marginTop: 18 }}>Limits</h3>
          <label className="field"><span>Daily token cap</span>
            <input type="number" min={1} placeholder="No cap" defaultValue={settings.dailyTokenLimit ?? ''} onChange={(event) => { const raw = event.target.value; debounce('cap', () => void patchSettings({ dailyTokenLimit: raw ? Number(raw) : null })); }} />
          </label>
          <h3 style={{ marginTop: 18 }}>Emergency</h3>
          <p className="faint">Read-only blocks every write and tool that changes something. The kill switch stops all running turns and refuses new ones until you clear it.</p>
          <div className="row">
            <button className="btn" onClick={async () => { await patchSettings({ readOnly: !settings.readOnly }); await load(); toast(settings.readOnly ? 'Read-only is off.' : 'Read-only is on.', 'ok'); }}>{settings.readOnly ? 'Turn off read-only' : 'Turn on read-only'}</button>
            <button className="btn danger" onClick={async () => { if (!window.confirm('Stop every running turn now?')) return; await post('/api/control/kill'); await load(); toast('Kill switch on. Nothing runs until you clear it.', 'ok'); }}>Kill switch</button>
            <button className="btn ghost" onClick={async () => { await post('/api/control/resume'); await load(); toast('Kill switch cleared.', 'ok'); }}>Clear kill switch</button>
          </div>
        </div>
      )}
      {show('vault') && <Block id="vault">{null}</Block>}
      {show('vault') && <>
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
      {show('audit') && <Block id="audit">{null}</Block>}
      {show('audit') && <div className="card" id="audit">
        <h3>Audit</h3>
        {audit.length === 0 && <p className="faint">Nothing logged yet.</p>}
        {(allAudit ? audit : audit.slice(0, 12)).map((row) => <p key={row.id} className="mono faint wrap">{row.createdAt} · {row.action} · {row.actor}</p>)}
        {audit.length > 12 && <button className="btn ghost" onClick={() => setAllAudit((value) => !value)}>{allAudit ? 'Show fewer' : `Show all ${audit.length}`}</button>}
      </div>}
      {show('debug') && <Block id="debug">{null}</Block>}
      {show('debug') && <div className="card" id="debug">
        <h3>Logs</h3>
        <p className="muted">Owner only. Logs stay on this machine, rotate when they grow past 2 MB, and exports are redacted. Nothing here is sent anywhere.</p>
        <label className="field"><span>Log level</span>
          <select value={debugLevel} onChange={async (event) => { await patchSettings({ debugLevel: event.target.value }); setDebugLevel(event.target.value); }}>
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
          {devModels && <button className="btn" type="button" onClick={async () => { try { const data = await post<{ run: { id: string } }>(`/api/debug/runs/${runId}/replay`); setInspection(`Replayed as ${data.run.id}`); } catch (error) { toast((error as Error).message, 'error'); } }}>Replay (dev)</button>}
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
      {show('remote') && <Block id="remote">{null}</Block>}
      {show('remote') && <div className="card" id="remote">
        <h3>Tailscale (recommended)</h3>
        <p>Tailscale is the path to use from university. Install it on this box and on the phone, then open <span className="mono">http://&lt;tailscale-ip&gt;:8787</span>. The login still applies. Cloudflare Tunnel works too: <span className="mono">cloudflared tunnel --url http://127.0.0.1:8787</span>. Do not publish the port on the public internet without one of those and this login.</p>
        <p className="faint">Coding CLIs on PATH: {clis.length ? clis.join(', ') : 'none detected. Built-in edit tools still run.'}</p>
      </div>}
      </>; }}
    </SettingsPage>
  );
}
