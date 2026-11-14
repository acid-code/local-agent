import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Activity, ArrowDown, ArrowUp, EyeOff, GitBranch, BookOpen, Box, CalendarClock, ChevronsUpDown, Cpu, Gauge, ListChecks, LogOut, Menu as MenuIcon, MessageSquare, MoreHorizontal, Palette, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Radio, Settings, Sparkles, Users, Wrench, X, type LucideIcon } from 'lucide-react';
import { Menu } from './ui';
import { Toaster } from './Toaster';
import { api, post } from '../lib/api';
import { Face, type FaceAgent } from './Face';

/** Pages a member account can open. Everything else is owner admin and the server refuses it anyway. */
const MEMBER_PAGES = new Set(['/', '/agents', '/workspace', '/runs', '/schedules', '/library', '/settings']);

interface NavItem { to: string; label: string; icon: LucideIcon; hint: string }
/** Grouped so the sidebar reads as: what you talk to, what runs on its own, and the machine. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: 'Work', items: [
    { to: '/', label: 'Chats', icon: MessageSquare, hint: 'Talk to your agents' },
    { to: '/agents', label: 'Agents', icon: Users, hint: 'Personas, faces and voices' },
    { to: '/workspace', label: 'Workspace', icon: GitBranch, hint: 'Folders, repos and git' },
    { to: '/library', label: 'Library', icon: BookOpen, hint: 'Knowledge and files' },
  ] },
  { title: 'Automation', items: [
    { to: '/runs', label: 'Runs', icon: Activity, hint: 'Every turn and its trace' },
    { to: '/schedules', label: 'Schedules', icon: CalendarClock, hint: 'Prompts on a timer' },
    { to: '/triggers', label: 'Triggers', icon: Radio, hint: 'Webhooks, mail and files' },
    { to: '/skills', label: 'Skills', icon: Sparkles, hint: 'Reusable instructions' },
  ] },
  { title: 'System', items: [
    { to: '/models', label: 'Models', icon: Cpu, hint: 'Local and cloud models' },
    { to: '/tools', label: 'Tools', icon: Wrench, hint: 'MCP servers' },
    { to: '/containers', label: 'Containers', icon: Box, hint: 'Sandboxes and services' },
    { to: '/resources', label: 'Resources', icon: Gauge, hint: 'CPU, RAM and disk' },
    { to: '/setup', label: 'Setup', icon: ListChecks, hint: 'First-run checklist' },
    { to: '/settings', label: 'Settings', icon: Settings, hint: 'Appearance, vault, health' },
  ] },
];

interface Persona extends FaceAgent { id: string; title?: string; pinned?: boolean; hidden?: boolean; unread?: number }

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
  useEffect(() => { localStorage.setItem('la-sidebar', collapsed ? 'collapsed' : 'open'); }, [collapsed]);
  const isWide = () => window.matchMedia('(min-width: 981px)').matches;
  const toggleSidebar = () => { if (isWide()) setCollapsed((value) => !value); else setOpen((value) => !value); };
  const navigate = useNavigate();

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
      if (event.key === 'Escape') { setPalette(false); setOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (role !== 'owner') return;
    const tick = () => api<{ approvals: unknown[]; requests?: unknown[] }>('/api/vault').then((data) => setPending((data.requests?.length || 0))).catch(() => undefined);
    tick();
    const id = setInterval(tick, 8000);
    let socket: WebSocket | null = null;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/api/live`);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'secret' || data.type === 'approval') tick();
      };
    } catch { /* live channel is optional */ }
    return () => { clearInterval(id); socket?.close(); };
  }, []);

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
  const initials = username.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className={collapsed ? 'app collapsed' : 'app'}>
      {open && <div className="scrim drawer-scrim" onClick={() => setOpen(false)} />}
      <aside id="main-sidebar" className={open ? 'sidebar open' : 'sidebar'} aria-label="Main menu">
        <div className="brand">
          <svg className="mark" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="18" fill="none" stroke="var(--brass)" strokeWidth="4"/><circle cx="32" cy="32" r="5" fill="var(--brass)"/></svg>
          <div className="word"><i>local</i><span>agent</span></div>
          <button className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        <nav className="nav" aria-label="Pages">
          {groups.map((group) => (
            <div key={group.title} className="nav-group" role="group" aria-label={group.title}>
              <span className="nav-heading" aria-hidden>{group.title}</span>
              {group.items.map(({ to, label, icon: Icon, hint }) => (
                <NavLink key={to} to={to} end={to === '/'} title={collapsed ? `${label} — ${hint}` : hint} className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setOpen(false)}>
                  <Icon aria-hidden /> <span className="label">{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {personas.length > 0 && (
          <div className="persona-head">
            <span className="nav-heading">Quick chat</span>
          </div>
        )}
        <div className="persona-list">
          {personas.map((persona, index) => (
            <div key={persona.id} className="persona-row" style={{ ['--accent' as string]: persona.accent || 'var(--brass)' }}>
              <button className="persona-open" title={persona.name} onClick={() => { navigate(`/?persona=${persona.id}`); setOpen(false); }}>
                <Face agent={persona} size={28} />
                <span className="label">
                  <strong dir="auto">{persona.emoji ? `${persona.emoji} ` : ''}{persona.name}</strong>
                  {persona.title && <small>{persona.title}</small>}
                </span>
                {persona.unread ? <em className="badge" style={{ borderColor: persona.accent }}>{persona.unread}</em> : null}
              </button>
              <Menu label={`Options for ${persona.name}`} items={[
                { label: persona.pinned ? 'Unpin' : 'Pin to top', icon: persona.pinned ? PinOff : Pin, onSelect: () => void api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !persona.pinned }) }).then(loadPersonas) },
                { label: 'Move up', icon: ArrowUp, disabled: index === 0, onSelect: () => void move(index, -1) },
                { label: 'Move down', icon: ArrowDown, disabled: index === personas.length - 1, onSelect: () => void move(index, 1) },
                { label: 'Edit agent', icon: Users, separator: true, onSelect: () => { navigate(`/agents?edit=${persona.id}`); setOpen(false); } },
                { label: 'Hide from sidebar', icon: EyeOff, onSelect: () => void api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) }).then(loadPersonas) },
              ]} />
            </div>
          ))}
        </div>
        <div className="side-foot">
          <span className="user-chip" title={username}>
            <span className="avatar" aria-hidden>{initials || '?'}</span>
            <span className="who label"><span className="ellipsis">{username}</span><small>{role === 'member' ? 'Member' : 'Owner'}</small></span>
          </span>
          <Menu label="Account menu" icon={ChevronsUpDown} items={[
            { label: 'Appearance', icon: Palette, onSelect: () => { navigate('/settings#appearance'); setOpen(false); } },
            { label: 'Settings', icon: Settings, onSelect: () => { navigate('/settings'); setOpen(false); } },
            { label: 'Sign out', icon: LogOut, separator: true, danger: true, onSelect: onLogout },
          ]} />
        </div>
      </aside>
      <div className="main">
        {restartKeys.length > 0 && <p className="restart-note">Restart needed. secrets.env changed for {restartKeys.join(', ')}. This process is still using the values it loaded at startup.</p>}
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MenuIcon size={20} /></button>
          <button className="icon-btn collapse-btn" aria-controls="main-sidebar" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'} title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button>
          <button className="palette-btn" onClick={() => setPalette(true)}><span>Search or jump</span> <span className="kbd">Ctrl K</span></button>
          {pending > 0 && <button className="btn" onClick={() => navigate('/settings#vault')}>{pending} secret request{pending === 1 ? '' : 's'}</button>}
        </header>
        {children}
        <nav className="bottom-nav" aria-label="Quick navigation">
          <NavLink to="/" end><MessageSquare size={18} /><span>Chat</span></NavLink>
          <NavLink to="/runs"><Activity size={18} /><span>Runs</span></NavLink>
          {role === 'owner' ? <NavLink to="/setup"><ListChecks size={18} /><span>Setup</span></NavLink> : <NavLink to="/agents"><Users size={18} /><span>Agents</span></NavLink>}
          <button type="button" className={open ? 'active' : ''} onClick={() => setOpen(true)}><MoreHorizontal size={18} /><span>More</span></button>
        </nav>
        <Toaster />
      </div>
      {palette && (
        <div className="palette" onClick={() => setPalette(false)}>
          <div className="card" role="dialog" aria-label="Go to a page" onClick={(event) => event.stopPropagation()}>
            <input autoFocus placeholder="Go to a page…" aria-label="Search pages" aria-controls="palette-list" aria-activedescendant={filtered[selected] ? `pal-${selected}` : undefined} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(filtered.length - 1, value + 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
              if (event.key === 'Enter' && filtered[selected]) go(filtered[selected].to);
            }} />
            <div className="palette-list" id="palette-list" role="listbox">
              {filtered.length === 0 && <p className="faint" style={{ padding: '8px 12px' }}>No page matches “{query}”.</p>}
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
