import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, LayoutGrid, Plus, Search, Star, Activity, Bell, BellOff, Info, MessageSquarePlus, Settings2, ArrowDown, ArrowUp, EyeOff, GitBranch, BookOpen, Box, CalendarClock, ChevronsUpDown, Cpu, Gauge, ListChecks, LogOut, Menu as MenuIcon, MessageSquare, MoreHorizontal, Palette, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Radio, Settings, Sparkles, Users, Wrench, X, type LucideIcon } from 'lucide-react';
import { Menu } from './ui';
import { Toaster } from './Toaster';
import { api, post } from '../lib/api';
import { Face, type FaceAgent } from './Face';
import { t, fmt } from '../i18n';

/** Pages a member account can open. Everything else is owner admin and the server refuses it anyway. */
const MEMBER_PAGES = new Set(['/', '/agents', '/workspace', '/runs', '/schedules', '/library', '/settings']);

interface NavItem { to: string; label: string; icon: LucideIcon; hint: string }
/** Grouped so the sidebar reads as: what you talk to, what runs on its own, and the machine. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: t('Work'), items: [
    { to: '/', label: t('Chats'), icon: MessageSquare, hint: t('Talk to your agents') },
    { to: '/agents', label: t('Agents'), icon: Users, hint: t('Personas, faces and voices') },
    { to: '/workspace', label: t('Workspaces'), icon: GitBranch, hint: t('Folders, repos and git') },
    { to: '/library', label: t('Library'), icon: BookOpen, hint: t('Knowledge and files') },
  ] },
  { title: t('Automation'), items: [
    { to: '/runs', label: t('Runs'), icon: Activity, hint: t('Every turn and its trace') },
    { to: '/schedules', label: t('Schedules'), icon: CalendarClock, hint: t('Prompts on a timer') },
    { to: '/triggers', label: t('Triggers'), icon: Radio, hint: t('Webhooks, mail and files') },
    { to: '/skills', label: t('Skills'), icon: Sparkles, hint: t('Reusable instructions') },
  ] },
  { title: t('System'), items: [
    { to: '/models', label: t('Models'), icon: Cpu, hint: t('Local and cloud models') },
    { to: '/tools', label: t('Tools'), icon: Wrench, hint: t('MCP servers') },
    { to: '/containers', label: t('Containers'), icon: Box, hint: t('Sandboxes and services') },
    { to: '/resources', label: t('Resources'), icon: Gauge, hint: t('CPU, RAM and disk') },
    { to: '/setup', label: t('Setup'), icon: ListChecks, hint: t('First-run checklist') },
    { to: '/settings', label: t('Settings'), icon: Settings, hint: t('Appearance, vault, health') },
  ] },
];

interface Persona extends FaceAgent { id: string; title?: string; pinned?: boolean; hidden?: boolean; unread?: number; notify?: 'all' | 'mute'; templateId?: string | null; lastMessage?: { text: string; role: string; at: string } | null }

/** Short relative time for the persona list ("now", "5m", "3h", "Mon", "12 Nov"). */
function when(iso?: string) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  const date = new Date(iso);
  return ms < 6 * 86_400_000 ? fmt.date(date, { weekday: 'short' }) : fmt.date(date, { day: 'numeric', month: 'short' });
}

export function Shell({ username, role = 'owner', onLogout, children }: { username: string; role?: 'owner' | 'member'; onLogout: () => void; children: ReactNode }) {
  const groups = GROUPS.map((group) => ({ ...group, items: role === 'owner' ? group.items : group.items.filter((item) => MEMBER_PAGES.has(item.to)) })).filter((group) => group.items.length);
  const links = groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.title })));
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(0);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [restartKeys, setRestartKeys] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('la-sidebar') === 'collapsed');
  // Admin pages stay folded away; personas come first.
  const [pagesOpen, setPagesOpen] = useState(() => localStorage.getItem('la-pages') === 'open');
  useEffect(() => { localStorage.setItem('la-pages', pagesOpen ? 'open' : 'closed'); }, [pagesOpen]);
  const [apps, setApps] = useState(false);
  useEffect(() => { localStorage.setItem('la-sidebar', collapsed ? 'collapsed' : 'open'); }, [collapsed]);
  const isWide = () => window.matchMedia('(min-width: 981px)').matches;
  const toggleSidebar = () => { if (isWide()) setCollapsed((value) => !value); else setOpen((value) => !value); };
  const navigate = useNavigate();
  const location = useLocation();
  const chatRoute = location.pathname === '/';
  // The chat page reports whose chat is open, so that persona's row reads as selected.
  const [activePersona, setActivePersona] = useState<string | null>(null);
  useEffect(() => {
    const onActive = (event: Event) => setActivePersona((event as CustomEvent<string | null>).detail ?? null);
    const onOpen = () => setOpen(true);
    window.addEventListener('la:active-persona', onActive);
    window.addEventListener('la:open-sidebar', onOpen);
    return () => { window.removeEventListener('la:active-persona', onActive); window.removeEventListener('la:open-sidebar', onOpen); };
  }, []);

  async function loadPersonas() {
    const data = await api<{ agents: Persona[] }>('/api/agents');
    setPersonas(data.agents.filter((agent) => !agent.hidden));
  }
  useEffect(() => { void loadPersonas().catch(() => undefined); }, []);
  useEffect(() => {
    api<{ restartKeys?: string[] }>('/api/auth/me').then((me) => setRestartKeys(me.restartKeys || [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
      if (event.key === 'Escape') { setPalette(false); setOpen(false); setApps(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const owner = role === 'owner';
    const tick = () => { if (owner) void api<{ approvals: unknown[]; requests?: unknown[] }>('/api/vault').then((data) => setPending((data.requests?.length || 0))).catch(() => undefined); };
    tick();
    const id = owner ? setInterval(tick, 8000) : undefined;
    let socket: WebSocket | null = null;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/api/live`);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'secret' || data.type === 'approval') tick();
        // Pages listen for runs starting in the chat they show (the server only sends this account's runs).
        window.dispatchEvent(new CustomEvent('la:live', { detail: data }));
      };
    } catch { /* live channel is optional */ }
    return () => { if (id) clearInterval(id); socket?.close(); };
  }, [role]);

  async function move(index: number, delta: number) {
    const next = personas.slice();
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(index + delta, 0, row);
    setPersonas(next);
    await post('/api/agents/reorder', { ids: next.map((persona) => persona.id) });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return links.filter((item) => !q || item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q));
  }, [query, role]);
  useEffect(() => setSelected(0), [query, palette]);
  const go = (to: string) => { navigate(to); setPalette(false); setQuery(''); };
  // Big faces on top: pinned personas, or the first few when none are pinned. The default assistant wears the star.
  const pinned = (personas.some((persona) => persona.pinned) ? personas.filter((persona) => persona.pinned) : personas.slice(0, 4)).slice(0, 8);
  const primaryId = (personas.find((persona) => persona.templateId === 'assistant') ?? personas[0])?.id;
  // Refresh previews when a reply lands or the open chat changes.
  useEffect(() => { void loadPersonas().catch(() => undefined); }, [activePersona]);
  useEffect(() => {
    const reload = () => void loadPersonas().catch(() => undefined);
    window.addEventListener('la-personas-changed', reload);
    return () => window.removeEventListener('la-personas-changed', reload);
  }, []);
  const initials = username.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}${chatRoute ? ' route-chat' : ''}`}>
      {open && <div className="scrim drawer-scrim" onClick={() => setOpen(false)} />}
      <aside id="main-sidebar" className={open ? 'sidebar open' : 'sidebar'} aria-label={t('Main menu')}>
        <div className="side-top">
          <span className="sr-only">{t('local agent')}</span>
          <span className="grow" />
          <button className="icon-btn round" aria-label={t('Search (Ctrl+K)')} title={t('Search or jump (Ctrl+K)')} onClick={() => setPalette(true)}><Search size={17} /></button>
          <Menu label={t('New')} icon={Plus} className="icon-btn round menu-trigger" items={[
            { label: t('New chat'), icon: MessageSquarePlus, hint: activePersona ? t('with this persona') : undefined, onSelect: () => { navigate(activePersona ? `/?persona=${activePersona}&new=1` : '/'); setOpen(false); } },
            { label: t('Add a persona from the gallery'), icon: LayoutGrid, onSelect: () => { navigate('/gallery'); setOpen(false); } },
            { label: t('Create a persona'), icon: Users, onSelect: () => { navigate('/agents?new=1'); setOpen(false); } },
          ]} />
          <button className="icon-btn drawer-close" aria-label={t('Close menu')} onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        {pinned.length > 0 && (
          <div className="pin-faces" role="list" aria-label={t('Pinned personas')}>
            {pinned.map((persona) => (
              <button key={persona.id} role="listitem" className={activePersona === persona.id ? 'pin-face on' : 'pin-face'} title={persona.title ? `${persona.name} · ${persona.title}` : persona.name}
                onClick={() => { navigate(`/?persona=${persona.id}`); setOpen(false); }}>
                <span className="pin-face-art"><Face agent={persona} size={58} />{persona.id === primaryId && <span className="star-badge" role="img" aria-label={t('Primary')}><Star size={10} /></span>}{persona.unread && persona.notify !== 'mute' ? <span className="unread-dot" role="img" aria-label="unread" /> : null}</span>
                <span className="pin-face-name ellipsis" dir="auto">{persona.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="persona-list" role="list" aria-label={t('Personas')}>
          {personas.map((persona, index) => (
            <div key={persona.id} role="listitem" className={activePersona === persona.id ? 'persona-row on' : 'persona-row'} style={{ ['--accent' as string]: persona.accent || 'var(--brass)' }}
              onContextMenu={(event) => { event.preventDefault(); (event.currentTarget.querySelector('.menu-trigger') as HTMLButtonElement | null)?.click(); }}>
              <button className="persona-open" aria-current={activePersona === persona.id ? 'true' : undefined} title={persona.title ? `${persona.name} · ${persona.title}` : persona.name} onClick={() => { navigate(`/?persona=${persona.id}`); setOpen(false); }}>
                <Face agent={persona} size={36} />
                <span className="label persona-text">
                  <span className="row persona-line"><span className="ellipsis persona-row-name" dir="auto">{persona.emoji ? `${persona.emoji} ` : ''}{persona.name}</span><span className="faint persona-when">{when(persona.lastMessage?.at)}</span></span>
                  <span className="ellipsis faint persona-preview" dir="auto">{persona.lastMessage ? `${persona.lastMessage.role === 'user' ? 'You: ' : ''}${persona.lastMessage.text}` : (persona.title || t('Say hi'))}</span>
                </span>
                {persona.unread && persona.notify !== 'mute' ? <span className="unread-dot" role="status" aria-label={`${persona.unread} unread`} /> : null}
              </button>
              <Menu label={t('Options for {0}', [persona.name])} items={[
                { label: t('Open chat'), icon: MessageSquare, onSelect: () => { navigate(`/?persona=${persona.id}`); setOpen(false); } },
                { label: t('New chat'), icon: MessageSquarePlus, onSelect: () => { navigate(`/?persona=${persona.id}&new=1`); setOpen(false); } },
                { label: t('Info'), icon: Info, onSelect: () => { navigate(`/?persona=${persona.id}&pane=info`); setOpen(false); } },
                { label: t('Settings'), icon: Settings2, onSelect: () => { navigate(`/?persona=${persona.id}&pane=settings`); setOpen(false); } },
                { label: persona.notify === 'mute' ? t('Show unread dot') : t('Mute unread dot'), icon: persona.notify === 'mute' ? Bell : BellOff, onSelect: () => void api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ notify: persona.notify === 'mute' ? 'all' : 'mute' }) }).then(loadPersonas) },
                { label: persona.pinned ? t('Unpin') : t('Pin to top'), separator: true, icon: persona.pinned ? PinOff : Pin, onSelect: () => void api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !persona.pinned }) }).then(loadPersonas) },
                { label: t('Move up'), icon: ArrowUp, disabled: index === 0, onSelect: () => void move(index, -1) },
                { label: t('Move down'), icon: ArrowDown, disabled: index === personas.length - 1, onSelect: () => void move(index, 1) },
                { label: t('Hide from sidebar'), icon: EyeOff, onSelect: () => void api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) }).then(loadPersonas) },
              ]} />
            </div>
          ))}
        </div>
        {pending > 0 && <button className="side-alert" onClick={() => navigate('/settings#vault')}>{pending}{' '}{t('secret request')}{pending === 1 ? '' : 's'} waiting</button>}
        <div className="side-foot">
          <span className="user-chip" title={`${username} · ${role === 'member' ? 'Member' : 'Owner'}`}>
            <span className="avatar" aria-hidden>{initials || '?'}</span>
            <span className="who label"><span className="ellipsis">{username}</span></span>
          </span>
          <button className="icon-btn round apps-btn" aria-label={t('All apps and pages')} title={t('All apps and pages')} aria-expanded={apps} aria-controls="apps-pop" onClick={() => setApps((value) => !value)}><LayoutGrid size={17} /></button>
          {apps && (
            <div className="apps-pop" id="apps-pop" role="dialog" aria-label={t('All apps and pages')} onKeyDown={(event) => { if (event.key === 'Escape') setApps(false); }}>
              <div className="apps-group">
                <span className="nav-heading">{t('Personas')}</span>
                <div className="apps-grid">
                  <button className="app-tile" onClick={() => { navigate('/gallery'); setApps(false); setOpen(false); }}><LayoutGrid size={20} aria-hidden /><span>{t('Gallery')}</span></button>
                </div>
              </div>
              {groups.map((group) => (
                <div key={group.title} className="apps-group" role="group" aria-label={group.title}>
                  <span className="nav-heading" aria-hidden>{group.title}</span>
                  <div className="apps-grid">
                    {group.items.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.to === '/'} title={item.hint} className={({ isActive }) => isActive ? 'app-tile active' : 'app-tile'} onClick={() => { setApps(false); setOpen(false); }}><item.icon size={20} aria-hidden /><span>{item.label}</span></NavLink>
                    ))}
                  </div>
                </div>
              ))}
              <div className="apps-foot">
                <button className="btn ghost small" onClick={() => { navigate('/settings#appearance'); setApps(false); setOpen(false); }}><Palette size={14} aria-hidden />{' '}{t('Appearance')}</button>
                <button className="btn ghost small collapse-toggle" onClick={() => { toggleSidebar(); setApps(false); }}>{collapsed ? <PanelLeftOpen size={14} aria-hidden /> : <PanelLeftClose size={14} aria-hidden />} {collapsed ? t('Expand') : t('Collapse')}</button>
                <button className="btn ghost small danger" onClick={onLogout}><LogOut size={14} aria-hidden />{' '}{t('Sign out')}</button>
              </div>
            </div>
          )}
        </div>
      </aside>
      <div className="main">
        {restartKeys.length > 0 && <p className="restart-note">{t('Restart needed. secrets.env changed for')}{' '}{restartKeys.join(', ')}. This process is still using the values it loaded at startup.</p>}
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label={t('Menu')} aria-expanded={open} onClick={() => setOpen((value) => !value)}><MenuIcon size={20} /></button>
          <button className="icon-btn collapse-btn" aria-controls="main-sidebar" aria-expanded={!collapsed} aria-label={collapsed ? t('Expand sidebar (Ctrl+B)') : t('Collapse sidebar (Ctrl+B)')} title={collapsed ? t('Expand sidebar (Ctrl+B)') : t('Collapse sidebar (Ctrl+B)')} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button>
          <button className="palette-btn" onClick={() => setPalette(true)}><span>{t('Search or jump')}</span> <span className="kbd">{t('Ctrl K')}</span></button>
        </header>
        {children}
        <nav className="bottom-nav" aria-label={t('Quick navigation')}>
          <NavLink to="/" end><MessageSquare size={18} /><span>{t('Chat')}</span></NavLink>
          <NavLink to="/runs"><Activity size={18} /><span>{t('Runs')}</span></NavLink>
          {role === 'owner' ? <NavLink to="/setup"><ListChecks size={18} /><span>{t('Setup')}</span></NavLink> : <NavLink to="/agents"><Users size={18} /><span>{t('Agents')}</span></NavLink>}
          <button type="button" className={open ? 'active' : ''} onClick={() => setOpen(true)}><MoreHorizontal size={18} /><span>{t('More')}</span></button>
        </nav>
        <Toaster />
      </div>
      {palette && (
        <div className="palette" onClick={() => setPalette(false)}>
          <div className="card" role="dialog" aria-label={t('Go to a page')} onClick={(event) => event.stopPropagation()}>
            <input autoFocus placeholder={t('Go to a page…')} aria-label={t('Search pages')} aria-controls="palette-list" aria-activedescendant={filtered[selected] ? `pal-${selected}` : undefined} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(filtered.length - 1, value + 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
              if (event.key === 'Enter' && filtered[selected]) go(filtered[selected].to);
            }} />
            <div className="palette-list" id="palette-list" role="listbox">
              {filtered.length === 0 && <p className="faint" style={{ padding: '8px 12px' }}>{t('No page matches “')}{query}”.</p>}
              {filtered.map((item, index) => (
                <div key={item.to} role="none">
                  {(index === 0 || filtered[index - 1]!.group !== item.group) && <div className="palette-group">{item.group}</div>}
                  <button id={`pal-${index}`} role="option" aria-selected={index === selected} className={index === selected ? 'active' : ''} onMouseEnter={() => setSelected(index)} onClick={() => go(item.to)}>
                    <item.icon aria-hidden /> {item.label} <small>{item.hint}</small>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
