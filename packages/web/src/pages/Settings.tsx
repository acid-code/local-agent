import { LanguageSettings } from '../components/LanguagePicker';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, post } from '../lib/api';
import { toast } from '../lib/toast';
import { Appearance } from '../components/Appearance';
import { AccountCard, People, QuotaCard } from '../components/People';
import { ImageRole } from '../components/ImageRole';
import { PullModel } from '../components/PullModel';
import { EmptyState, PageHeader } from '../components/ui';
import { useUsableModels } from '../lib/models';
import { Activity, Archive, Bot, Bug, Check, Cpu, FolderGit2, Globe, KeyRound, Palette, RefreshCw, ScrollText, Search, Server, ShieldCheck, Users, type LucideIcon, Languages } from 'lucide-react';
import { useWorkspaces } from '../components/PersonaPanel';
import { Face, type FaceAgent } from '../components/Face';
import { t as tr } from '../i18n';
import { UpdatesBlock } from '../components/Updates';

interface Secret { id: string; name: string; handle: string; scope: string; revokedAt: string | null }
interface Audit { id: number; action: string; actor: string; createdAt: string }
interface SecretRequest { id: string; name: string; reason: string; status: string; createdAt: string }
interface SettingsShape { codeApproval: string; geminiTier: string; sandbox: string; autoResume: boolean; approvalForDestructive: boolean; approvalMode?: string; readOnly?: boolean; dailyTokenLimit?: number | null; killSwitch?: boolean; searxngUrl?: string }
interface ProviderItem { id: string; kind: string; name: string; baseUrl: string | null; enabled: boolean }
interface ModelItem { id: string; name: string; apiName: string; local: boolean; enabled: boolean; providerId: string; parameterSize?: string | null; practicalBudget?: number }

interface Def { id: string; label: string; icon: LucideIcon; blurb: string; words: string; owner?: boolean; group: 'General' | 'Admin' }
/** One page, in this order. Old deep links (#models, #setup, #vault, #policy, #backups…) land on the matching section. */
const SECTIONS: Def[] = [
  { id: 'appearance', group: 'General', label: tr('Appearance'), icon: Palette, blurb: tr('Theme, font, bubbles and wallpaper for your account.'), words: 'theme dark light font wallpaper color bubbles density accent' },
  { id: 'language', group: 'General', label: tr('Language'), icon: Languages, blurb: tr('Interface language and Hebrew polishing.'), words: 'language hebrew עברית english rtl locale translate' },
  { id: 'system', group: 'General', label: tr('System'), icon: Cpu, blurb: tr('Models, Ollama pulls, llama-server, SearXNG web search, and image generation.'), words: 'system models ollama llama-server pull refresh searxng search url gemini image limits quota tier setup' },
  { id: 'personas', group: 'General', label: tr('Personas'), icon: Bot, blurb: tr('Who you talk to. Edit one from the chat with its name.'), words: 'personas agents prompt instructions tools skills face voice' },
  { id: 'workspaces', group: 'General', label: tr('Workspaces'), icon: FolderGit2, blurb: tr('Folders and repos chats can attach.'), words: 'workspaces folders repos git clone sets' },
  { id: 'data', group: 'General', label: tr('Data'), icon: Archive, blurb: tr('Your account, backups and exports.'), words: 'backups snapshot restore export password account diagnostics' },
  { id: 'updates', group: 'General', label: tr('About & updates'), icon: RefreshCw, blurb: tr('App and server versions. Check for a new Windows app.'), words: 'about version update updates upgrade check download release installer apk windows desktop' },
  { id: 'people', group: 'Admin', owner: true, label: tr('People'), icon: Users, blurb: tr('Member accounts and what they may use.'), words: 'members accounts users invite quota' },
  { id: 'health', group: 'Admin', owner: true, label: tr('Health'), icon: Activity, blurb: tr('Ollama, Docker, SearXNG, RAM budget and the rest.'), words: 'ollama docker searxng ram memory status doctor' },
  { id: 'policy', group: 'Admin', owner: true, label: tr('Safety & limits'), icon: ShieldCheck, blurb: tr('Approvals, read-only mode, the kill switch and token caps.'), words: 'approvals read-only kill switch tokens caps limits safety emergency gemini tier' },
  { id: 'vault', group: 'Admin', owner: true, label: tr('Secrets'), icon: KeyRound, blurb: tr('API keys, encrypted with AES-256-GCM. Models only see handles.'), words: 'keys api gemini openrouter secrets token github' },
  { id: 'audit', group: 'Admin', owner: true, label: tr('Audit log'), icon: ScrollText, blurb: tr('Who changed what, newest first.'), words: 'history log changes' },
  { id: 'debug', group: 'Admin', owner: true, label: tr('Debug'), icon: Bug, blurb: tr('Logs, run inspector and diagnostics. Nothing leaves this machine.'), words: 'logs inspector replay tool test diagnostics' },
  { id: 'remote', group: 'Admin', owner: true, label: tr('Remote access'), icon: Globe, blurb: tr('Reach this box from your phone or laptop.'), words: 'tailscale phone lan network access cloudflare' },
];
const ALIASES: Record<string, string> = { about: 'updates', version: 'updates', backups: 'data', account: 'data', models: 'system', setup: 'system', quota: 'system', images: 'system', searxng: 'system' };

/** Autosave feedback: a "Saved" tick in the header for a moment after any change lands. */
function useSavedTick() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const flash = () => { setState('saved'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 2200); };
    window.addEventListener('la:saved', flash);
    return () => window.removeEventListener('la:saved', flash);
  }, []);
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
  return <span className="saved-tick page-tick" aria-live="polite">{state === 'saving' ? tr('Saving…') : state === 'saved' ? <><Check size={14} aria-hidden />{' '}{tr('Saved')}</> : ''}</span>;
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
      <PageHeader title={tr('Settings')} description={tr('Everything on one page. Changes save as you make them.')} actions={<SavedTick state={saved.state} />} />
      <div className="settings-one">
        <nav className="settings-nav" aria-label={tr('Settings sections')}>
          <input type="search" className="settings-find" placeholder={tr('Search settings')} aria-label={tr('Search settings')} value={find} onChange={(event) => setFind(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setFind(''); if (event.key === 'Enter' && visible[0]) document.getElementById(`s-${visible[0].id}`)?.scrollIntoView({ block: 'start' }); }} />
          {(['General', 'Admin'] as const).map((group) => {
            const items = visible.filter((def) => def.group === group);
            if (!items.length) return null;
            return (
              <div key={group}>
                {owner && <span className="nav-heading">{group === 'Admin' ? tr('Admin (owner only)') : tr('General')}</span>}
                {items.map((def) => (
                  <a key={def.id} href={`#${def.id}`} onClick={(event) => { event.preventDefault(); document.getElementById(`s-${def.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActive(def.id); window.history.replaceState(window.history.state, '', `#${def.id}`); }} className={active === def.id ? 'on' : undefined} aria-current={active === def.id ? 'true' : undefined}><def.icon size={15} aria-hidden /> {def.label}</a>
                ))}
              </div>
            );
          })}
          {visible.length === 0 && <p className="faint settings-none">{tr('Nothing matches “')}{find}”.</p>}
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
  if (!agents.length) return <EmptyState icon={Bot} title={tr('No personas yet')} action={<Link className="btn primary" to="/agents?new=1">{tr('New persona')}</Link>}>{tr('A persona is a name, a model and the tools it may use.')}</EmptyState>;
  return (
    <div className="item-list">
      {agents.map((agent) => (
        <div key={agent.id} className="item-row">
          <Face agent={agent} size={28} />
          <span className="grow"><strong>{agent.name}</strong><span className="faint">{agent.title || (agent.hidden ? tr('hidden from the sidebar') : 'persona')}</span></span>
          <Link className="btn small ghost" to={`/?persona=${agent.id}`}>{tr('Chat')}</Link>
          <Link className="btn small" to={`/agents?edit=${agent.id}`}>{tr('Edit')}</Link>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}><Link className="btn small ghost" to="/agents?new=1">{tr('New persona')}</Link><Link className="btn small ghost" to="/agents">{tr('Manage personas')}</Link></div>
    </div>
  );
}

function WorkspacesBlock() {
  const ws = useWorkspaces();
  return (
    <>
      {ws.workspaces.length === 0 ? <EmptyState icon={FolderGit2} title={tr('No workspaces yet')} action={<Link className="btn" to="/">{tr('Add one from a chat')}</Link>}>{tr('Attach a folder or repo from the strip at the top of any chat.')}</EmptyState> : (
        <div className="item-list">
          {ws.workspaces.map((row) => (
            <div key={row.id} className="item-row"><span className={row.dirty ? 'dot warn' : 'dot ok'} aria-hidden /><span className="grow"><strong>{row.label}</strong><span className="faint mono">{row.kind === 'repo' ? `${row.branch || 'detached'} · ` : tr('folder · ')}{row.path}</span></span>
              <a className="btn small ghost" href={`/workspace?root=${encodeURIComponent(row.id)}`}>{tr('Open')}</a></div>
          ))}
        </div>
      )}
      <p className="faint" style={{ marginTop: 8 }}>{tr('Each chat keeps its own workspaces. A persona\'s default sets pre-fill its new chats (set them in the persona panel).')}{' '}{ws.sets.length ? tr('Sets: {0}.', [ws.sets.map((set) => set.name).join(', ')]) : ''}</p>
    </>
  );
}

function SystemBlock({ owner, settings, patchSettings }: { owner: boolean; settings: SettingsShape | null; patchSettings?: (body: Record<string, unknown>) => Promise<void> }) {
  const usable = useUsableModels();
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [allModels, setAllModels] = useState<ModelItem[]>([]);
  const [resident, setResident] = useState<string[]>([]);
  const [llamaUrl, setLlamaUrl] = useState('http://host.docker.internal:8080/v1');
  const [savingLlama, setSavingLlama] = useState(false);
  const [searxUrl, setSearxUrl] = useState('');
  const [searxNote, setSearxNote] = useState('');
  const [testingSearx, setTestingSearx] = useState(false);
  const [sysInfo, setSysInfo] = useState<{ version: string; commit: string | null; backupsCount: number; inDocker: boolean } | null>(null);

  useEffect(() => {
    if (settings?.searxngUrl !== undefined) setSearxUrl(settings.searxngUrl || '');
  }, [settings?.searxngUrl]);

  const loadModels = () => {
    if (!owner) return;
    void api<{ models: ModelItem[]; providers: ProviderItem[]; resident: string[] }>('/api/models').then((data) => {
      setAllModels(data.models || []);
      setProviders(data.providers || []);
      setResident(data.resident || []);
      const llama = (data.providers || []).find((p) => p.id === 'prov_llama');
      if (llama?.baseUrl) setLlamaUrl(llama.baseUrl);
    }).catch(() => undefined);
  };

  useEffect(() => {
    loadModels();
    if (owner) void api<{ version: string; commit: string | null; backupsCount: number; inDocker: boolean }>('/api/system/update-status').then(setSysInfo).catch(() => undefined);
  }, [owner]);

  const count = usable.models.local.length + usable.models.cloud.filter((m) => !m.disabled).length;
  const localModels = allModels.filter((m) => m.local && m.enabled && m.providerId !== 'prov_rehearsal');

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>{tr('Models')}</h3>
            <p className="faint">{usable.loaded ? (count ? tr('{0} model{1} ready', [count, count === 1 ? '' : 's']) : tr('No model yet')) : tr('Checking…')}{usable.models.geminiConnected ? tr(' · Gemini connected') : ''}</p>
          </div>
          {owner && (
            <button className="btn small" disabled={usable.refreshing} onClick={async () => { await usable.refresh(); loadModels(); }}>
              <RefreshCw size={14} className={usable.refreshing ? 'spin' : undefined} aria-hidden />{' '}{usable.refreshing ? tr('Refreshing…') : tr('Refresh models')}
            </button>
          )}
        </div>
        {owner && (
          <>
            <div style={{ marginBottom: 12 }}>
              <PullModel suggestion="gpt-oss:20b" onDone={() => { void usable.refresh().then(loadModels); }} />
            </div>
            {localModels.length > 0 && (
              <div className="item-list" style={{ marginBottom: 12 }}>
                {localModels.map((model) => {
                  const prov = providers.find((p) => p.id === model.providerId);
                  const loadedNow = resident.includes(model.apiName) || resident.includes(model.name);
                  return (
                    <div key={model.id} className="item-row">
                      <span className={loadedNow ? 'dot ok' : 'dot'} aria-hidden />
                      <span className="grow">
                        <strong>{model.name}</strong>
                        <span className="faint mono">
                          {prov?.name || 'Local'}{model.parameterSize ? ` · ${model.parameterSize}` : ''}{model.practicalBudget ? ` · ${Math.round(model.practicalBudget / 1024)}K ctx` : ''}{loadedNow ? ' · loaded' : ''}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        {owner && settings && patchSettings && (
          <label className="field settings-line"><span>{tr('Gemini tier')}</span>
            <select value={settings.geminiTier} onChange={(event) => void patchSettings({ geminiTier: event.target.value })}>
              <option value="free">{tr('Free tier (respect the documented limits)')}</option>
              <option value="paid">{tr('Paid (Argon and Pro become eligible)')}</option>
            </select>
          </label>
        )}
      </div>

      {owner && (
        <div className="card">
          <h3><Server size={15} aria-hidden />{' '}{tr('llama-server (OpenAI-compatible provider)')}</h3>
          <p className="faint">{tr('Connect a local llama-server instance (with DFlash2 draft sidecar under /opt/llama-server). Inside Docker use http://host.docker.internal:8080/v1; natively use http://127.0.0.1:8080/v1.')}</p>
          <form className="row" onSubmit={async (e) => {
            e.preventDefault();
            if (!llamaUrl.trim()) return;
            setSavingLlama(true);
            try {
              await post('/api/providers', { id: 'prov_llama', name: 'llama-server', kind: 'openai_compat', baseUrl: llamaUrl.trim(), enabled: true });
              await usable.refresh();
              loadModels();
              toast(tr('llama-server saved and scanned.'), 'ok');
            } catch (error) { toast((error as Error).message, 'error'); } finally { setSavingLlama(false); }
          }}>
            <input className="mono grow" type="url" value={llamaUrl} onChange={(e) => setLlamaUrl(e.target.value)} placeholder="http://127.0.0.1:8080/v1" aria-label={tr('llama-server base URL')} />
            <button className="btn primary small" disabled={savingLlama}>{savingLlama ? tr('Connecting…') : tr('Save & scan')}</button>
          </form>
        </div>
      )}

      {owner && settings && patchSettings && (
        <div className="card">
          <h3><Search size={15} aria-hidden />{' '}{tr('SearXNG web search URL')}</h3>
          <p className="faint">{tr('Inside Docker bridge networking use http://local-agent-searxng:8080 or http://host.docker.internal:8088 (never 127.0.0.1). Leave blank to auto-detect.')}</p>
          <div className="row">
            <input className="mono grow" type="url" value={searxUrl} onChange={(e) => setSearxUrl(e.target.value)} placeholder="http://local-agent-searxng:8080" aria-label={tr('SearXNG URL')} />
            <button type="button" className="btn small" onClick={() => void patchSettings({ searxngUrl: searxUrl.trim() })}>{tr('Save')}</button>
            <button type="button" className="btn ghost small" disabled={testingSearx} onClick={async () => {
              setTestingSearx(true); setSearxNote('');
              try {
                const res = await post<{ ok: boolean; url: string | null; detail: string }>('/api/settings/searxng/test', { url: searxUrl.trim() });
                setSearxNote(res.detail);
                if (res.ok && res.url) {
                  setSearxUrl(res.url);
                  await patchSettings({ searxngUrl: res.url });
                  toast(res.detail, 'ok');
                } else toast(res.detail, 'error');
              } catch (error) { toast((error as Error).message, 'error'); } finally { setTestingSearx(false); }
            }}>{testingSearx ? tr('Testing…') : tr('Auto-detect & test')}</button>
          </div>
          {searxNote && <p className="faint" style={{ marginTop: 6 }}>{searxNote}</p>}
        </div>
      )}

      <ImageRole />
      {sysInfo && (
        <p className="faint mono" style={{ marginTop: 8 }}>
          v{sysInfo.version}{sysInfo.commit ? ` (${sysInfo.commit})` : ''} · {sysInfo.inDocker ? 'Docker' : 'Native'} · {sysInfo.backupsCount} backup{sysInfo.backupsCount === 1 ? '' : 's'}
        </p>
      )}
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
          {show('language') && <Block id="language"><LanguageSettings /></Block>}
          {show('system') && <Block id="system"><SystemBlock owner={false} settings={null} /></Block>}
          {show('personas') && <Block id="personas"><PersonasBlock /></Block>}
          {show('workspaces') && <Block id="workspaces"><WorkspacesBlock /></Block>}
          {show('data') && <Block id="data"><AccountCard /></Block>}
          {show('updates') && <Block id="updates"><UpdatesBlock /></Block>}
        </>}
      </SettingsPage>
    );
  }
  return <OwnerSettings />;
}

function OwnerSettings() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [secretRequests, setSecretRequests] = useState<SecretRequest[]>([]);
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
    try {
      const vaultData = await api<{ requests: SecretRequest[] }>('/api/vault');
      setSecretRequests(vaultData.requests);
    } catch {
      setSecretRequests([]);
    }
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
          {show('language') && <Block id="language"><LanguageSettings /></Block>}
      {show('system') && <Block id="system"><SystemBlock owner settings={settings} patchSettings={patchSettings} /></Block>}
      {show('personas') && <Block id="personas"><PersonasBlock /></Block>}
      {show('workspaces') && <Block id="workspaces"><WorkspacesBlock /></Block>}
      {show('data') && <Block id="data">
        <div className="card" id="backups">
          <h3>{tr('Backups')}</h3>
          <p className="muted">{tr('A snapshot includes the database, the encrypted vault, its master key, and persona workspaces. Treat the file as private. Restore restarts the process.')}</p>
          <button className="btn" onClick={async () => { const result = await track(post<{ backup: { id: string }; shipped: { detail: string } }>('/api/backups')); toast(tr('Saved {0}. {1}', [result.backup.id, result.shipped.detail]), 'ok'); }}>{tr('Take a snapshot')}</button>
          <p className="faint">{tr('Schedule and target live in the setup site (Defaults → Backup cron, Backup target).')}</p>
        </div>
        <AccountCard />
      </Block>}
      {show('people') && <Block id="people"><People /></Block>}
      {show('health') && <Block id="health">{null}</Block>}
      {show('health') && <div className="card" id="health">
        <div className="card-head"><h3>{tr('System health')}</h3><button className="btn" type="button" disabled={checking === 'all'} onClick={() => void refreshHealth()}>{checking === 'all' ? tr('Checking…') : tr('Refresh health')}</button></div>
        {health.length === 0 && <p className="faint">{checking ? tr('Checking Ollama, Docker, SearXNG and the rest…') : tr('No results yet.')}</p>}
        <ul className="health-list">
          {health.map((check) => (
            <li key={check.id}>
              <span className={check.ok ? 'badge ok' : 'badge warn'}>{check.ok ? 'ok' : 'check'}</span>
              <span className="health-detail"><strong>{check.id}</strong> <span className="muted">{check.detail}</span></span>
              <button className="btn ghost small" type="button" disabled={checking === check.id} onClick={async () => { setChecking(check.id); try { const data = await post<{ check: typeof check }>(`/api/debug/health/${encodeURIComponent(check.id)}`); setHealth((items) => items.map((item) => item.id === data.check.id ? data.check : item)); } finally { setChecking(null); } }}>{checking === check.id ? tr('Testing…') : tr('Test')}</button>
            </li>
          ))}
        </ul>
      </div>}
      {show('policy') && <Block id="policy">{null}</Block>}
      {show('policy') && settings && (
        <div className="card" id="policy">
          <h3>{tr('Approvals')}</h3>
          <label className="field"><span>{tr('Ask before')}</span>
            <select value={settings.approvalMode ?? (settings.approvalForDestructive ? 'balanced' : 'autonomous')} onChange={async (event) => { await patchSettings({ approvalMode: event.target.value }); await load(); }}>
              <option value="cautious">{tr('Cautious: any change, even inside the workspace')}</option>
              <option value="balanced">{tr('Balanced: deleting, containers, scripts and anything risky')}</option>
              <option value="autonomous">{tr('Autonomous: only high risk (push, send, pay, delete, sudo)')}</option>
            </select>
          </label>
          <p className="faint">{tr('High-risk actions always ask, in every mode. Reading and searching never ask.')}</p>
          <label className="field"><span>{tr('Code edits')}</span>
            <select value={settings.codeApproval} onChange={async (event) => { await patchSettings({ codeApproval: event.target.value }); await load(); }}>
              <option value="sandbox-auto">{tr('Auto inside the workspace, ask for host paths and push')}</option>
              <option value="always">{tr('Ask before every edit batch')}</option>
            </select>
          </label>
          <p className="faint">{tr('Sandbox:')}{' '}{settings.sandbox}. Destructive shell commands ask first: {settings.approvalForDestructive ? 'yes' : 'no'}. Interrupted runs resume on restart: {settings.autoResume ? 'yes' : 'no'}.</p>
          <h3 style={{ marginTop: 18 }}>{tr('Limits')}</h3>
          <label className="field"><span>{tr('Daily token cap')}</span>
            <input type="number" min={1} placeholder={tr('No cap')} defaultValue={settings.dailyTokenLimit ?? ''} onChange={(event) => { const raw = event.target.value; debounce('cap', () => void patchSettings({ dailyTokenLimit: raw ? Number(raw) : null })); }} />
          </label>
          <h3 style={{ marginTop: 18 }}>{tr('Emergency')}</h3>
          <p className="faint">{tr('Read-only blocks every write and tool that changes something. The kill switch stops all running turns and refuses new ones until you clear it.')}</p>
          <div className="row">
            <button className="btn" onClick={async () => { await patchSettings({ readOnly: !settings.readOnly }); await load(); toast(settings.readOnly ? tr('Read-only is off.') : tr('Read-only is on.'), 'ok'); }}>{settings.readOnly ? tr('Turn off read-only') : tr('Turn on read-only')}</button>
            <button className="btn danger" onClick={async () => { if (!window.confirm(tr('Stop every running turn now?'))) return; await post('/api/control/kill'); await load(); toast(tr('Kill switch on. Nothing runs until you clear it.'), 'ok'); }}>{tr('Kill switch')}</button>
            <button className="btn ghost" onClick={async () => { await post('/api/control/resume'); await load(); toast(tr('Kill switch cleared.'), 'ok'); }}>{tr('Clear kill switch')}</button>
          </div>
        </div>
      )}
      {show('vault') && <Block id="vault">{null}</Block>}
      {show('vault') && <>
      {secretRequests.length > 0 && (
        <div className="card" id="pending-secrets">
          <h3>{tr('Pending secret requests')}</h3>
          {secretRequests.map((request) => (
            <div key={request.id} className="item-row">
              <span className="dot off" aria-hidden />
              <span className="grow">
                <strong className="mono">{request.name}</strong>
                <span className="muted">{request.reason}</span>
              </span>
              <button className="btn" type="button" onClick={() => { setName(request.name); setValue(''); document.getElementById('vault')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>{tr('Provide')}</button>
            </div>
          ))}
        </div>
      )}
      <form className="card" id="vault" onSubmit={async (event) => { event.preventDefault(); await post('/api/vault', { name, value, scope: 'global' }); setValue(''); await load(); toast(tr('Saved {0}.', [name]), 'ok'); }}>
        <h3>{tr('Add a secret')}</h3>
        <div className="row">
          <label className="field" style={{ flex: '1 1 220px' }}><span>{tr('Name')}</span><input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder={tr('GEMINI_API_KEY')} /></label>
          <label className="field" style={{ flex: '2 1 280px' }}><span>{tr('Value')}</span><input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} /></label>
        </div>
        <button className="btn primary" disabled={!name || !value}>{tr('Save secret')}</button>
      </form>
      <div className="card">
        <h3>{tr('Stored secrets')}</h3>
        {secrets.length === 0 && <EmptyState icon={KeyRound} title={tr('No secrets yet')}>{tr('Add GEMINI_API_KEY to use Gemini, or GITHUB_TOKEN to push to GitHub.')}</EmptyState>}
        <div className="item-list">
          {secrets.map((secret) => (
            <div key={secret.id} className="item-row">
              <span className={secret.revokedAt ? 'dot off' : 'dot on'} aria-hidden />
              <span className="grow"><strong className="mono">{secret.handle}</strong><span className="faint">{secret.scope}{secret.revokedAt ? tr(' · revoked') : ''}</span>
                {revealed?.id === secret.id && <span className="mono wrap">{revealed.value}</span>}
              </span>
              {revealing === secret.id ? (
                <form className="row" onSubmit={async (event) => { event.preventDefault(); const data = await post<{ value: string }>(`/api/vault/${secret.id}/reveal`, { password }); setRevealed({ id: secret.id, value: data.value }); setPassword(''); setRevealing(null); }}>
                  <input type="password" autoFocus aria-label={tr('Your password')} placeholder={tr('Your password')} value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRevealing(null); }} />
                  <button className="btn small">{tr('Reveal')}</button>
                </form>
              ) : revealed?.id === secret.id ? <button className="btn ghost small" onClick={() => setRevealed(null)}>{tr('Hide')}</button>
                : <button className="btn ghost small" disabled={Boolean(secret.revokedAt)} onClick={() => { setRevealing(secret.id); setPassword(''); }}>{tr('Reveal…')}</button>}
              <button className="btn danger small" disabled={Boolean(secret.revokedAt)} onClick={async () => { if (!window.confirm(tr('Revoke {0}? Tools using it stop working.', [secret.handle]))) return; await post(`/api/vault/${secret.id}/revoke`); await load(); }}>{tr('Revoke')}</button>
            </div>
          ))}
        </div>
      </div>
      </>}
      {show('audit') && <Block id="audit">{null}</Block>}
      {show('audit') && <div className="card" id="audit">
        <h3>{tr('Audit')}</h3>
        {audit.length === 0 && <p className="faint">{tr('Nothing logged yet.')}</p>}
        {(allAudit ? audit : audit.slice(0, 12)).map((row) => <p key={row.id} className="mono faint wrap">{row.createdAt} · {row.action} · {row.actor}</p>)}
        {audit.length > 12 && <button className="btn ghost" onClick={() => setAllAudit((value) => !value)}>{allAudit ? tr('Show fewer') : tr('Show all {0}', [audit.length])}</button>}
      </div>}
      {show('debug') && <Block id="debug">{null}</Block>}
      {show('debug') && <div className="card" id="debug">
        <h3>{tr('Logs')}</h3>
        <p className="muted">{tr('Owner only. Logs stay on this machine, rotate when they grow past 2 MB, and exports are redacted. Nothing here is sent anywhere.')}</p>
        <label className="field"><span>{tr('Log level')}</span>
          <select value={debugLevel} onChange={async (event) => { await patchSettings({ debugLevel: event.target.value }); setDebugLevel(event.target.value); }}>
            <option value="info">{tr('Info')}</option>
            <option value="debug">{tr('Debug')}</option>
          </select>
        </label>
        <div className="row">
          <select aria-label={tr('Component')} value={component} onChange={(event) => setComponent(event.target.value)}>
            <option value="">{tr('All components')}</option>
            {['engine', 'router', 'context', 'providers', 'mcp', 'docker', 'triggers', 'repos', 'kb', 'setup', 'notify'].map((item) => <option key={item}>{item}</option>)}
          </select>
          <input aria-label={tr('Search logs')} value={query} placeholder={tr('Search')} onChange={(event) => setQuery(event.target.value)} />
          <button className="btn" type="button" onClick={async () => { const data = await api<{ logs: typeof logs; debugLevel: string }>(`/api/logs?component=${component}&q=${encodeURIComponent(query)}`); setLogs(data.logs); setDebugLevel(data.debugLevel); }}>{tr('Tail')}</button>
        </div>
        {logs.slice(0, 40).map((row) => <p key={row.id} className="mono faint wrap">{row.createdAt} · {row.level} · {row.component} · {row.message}</p>)}
        <h3>{tr('Run inspector')}</h3>
        <div className="row">
          <input aria-label={tr('Run id')} value={runId} placeholder={tr('run id')} onChange={(event) => setRunId(event.target.value)} />
          <button className="btn" type="button" onClick={async () => setInspection(JSON.stringify(await api(`/api/debug/runs/${runId}`), null, 2))}>{tr('Inspect')}</button>
          {devModels && <button className="btn" type="button" onClick={async () => { try { const data = await post<{ run: { id: string } }>(`/api/debug/runs/${runId}/replay`); setInspection(`Replayed as ${data.run.id}`); } catch (error) { toast((error as Error).message, 'error'); } }}>{tr('Replay (dev)')}</button>}
        </div>
        {inspection && <pre className="command">{inspection.slice(0, 8000)}</pre>}
        <h3>{tr('Tool test')}</h3>
        <button className="btn" type="button" onClick={async () => setToolTests((await post<{ results: typeof toolTests }>('/api/debug/tool-test', {})).results)}>{tr('Test web_search and kb_search')}</button>
        {toolTests.map((test) => (
          <div key={test.tool}>
            <p className="row"><span className={test.ok ? 'badge' : 'badge warn'}>{test.ok ? 'ok' : 'check'}</span> {test.tool} “{test.query}{tr('” in')}{' '}{test.ms} ms{test.error ? `: ${test.error}` : ''}</p>
            {test.output && <pre className="command">{test.output.slice(0, 1200)}</pre>}
          </div>
        ))}
        <p><a className="btn" href="/api/debug/bundle">{tr('Download redacted diagnostics')}</a></p>
        <p className="faint">{tr('Over SSH:')}{' '}<span className="mono">{tr('npm run doctor')}</span>. To recover a forgotten password: <span className="mono">{tr('npm run reset-owner')}</span>.</p>
      </div>}
      {show('updates') && <Block id="updates"><UpdatesBlock /></Block>}
      {show('remote') && <Block id="remote">{null}</Block>}
      {show('remote') && <div className="card" id="remote">
        <h3>{tr('Tailscale (recommended)')}</h3>
        <p>{tr('Tailscale is the path to use from university. Install it on this box and on the phone, then open')}{' '}<span className="mono">http://&lt;tailscale-ip&gt;:8787</span>. The login still applies. Cloudflare Tunnel works too: <span className="mono">{tr('cloudflared tunnel --url http://127.0.0.1:8787')}</span>. Do not publish the port on the public internet without one of those and this login.</p>
        <p className="faint">{tr('Coding CLIs on PATH:')}{' '}{clis.length ? clis.join(', ') : tr('none detected. Built-in edit tools still run.')}</p>
      </div>}
      </>; }}
    </SettingsPage>
  );
}
