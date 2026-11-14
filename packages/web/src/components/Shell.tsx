import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Activity, GitBranch, BookOpen, Box, CalendarClock, Cpu, Gauge, ListChecks, LogOut, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Radio, Settings, Sparkles, Users, Wrench, X } from 'lucide-react';
import { Toaster } from './Toaster';
import { api, post } from '../lib/api';
import { Face, type FaceAgent } from './Face';

/** Pages a member account can open. Everything else is owner admin and the server refuses it anyway. */
const MEMBER_PAGES = new Set(['/', '/agents', '/workspace', '/runs', '/schedules', '/library', '/settings']);

const LINKS = [
  ['/', 'Chats', MessageSquare],
  ['/agents', 'Agents', Users],
  ['/workspace', 'Workspace', GitBranch],
  ['/runs', 'Runs', Activity],
  ['/tools', 'Tools', Wrench],
  ['/models', 'Models', Cpu],
  ['/containers', 'Containers', Box],
  ['/schedules', 'Schedules', CalendarClock],
  ['/library', 'Library', BookOpen],
  ['/skills', 'Skills', Sparkles],
  ['/triggers', 'Triggers', Radio],
  ['/resources', 'Resources', Gauge],
  ['/setup', 'Setup', ListChecks],
  ['/settings', 'Settings', Settings],
] as const;

interface Persona extends FaceAgent { id: string; title?: string; pinned?: boolean; hidden?: boolean; unread?: number }

export function Shell({ username, role = 'owner', onLogout, children }: { username: string; role?: 'owner' | 'member'; onLogout: () => void; children: ReactNode }) {
  const links = role === 'owner' ? LINKS : LINKS.filter(([to]) => MEMBER_PAGES.has(to));
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(0);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [restartKeys, setRestartKeys] = useState<string[]>([]);
  const [arrange, setArrange] = useState(false);
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

  const actions = useMemo(() => links.map(([to, label]) => ({ to, label })), [role]);
  const filtered = actions.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className={collapsed ? 'app collapsed' : 'app'}>
      {open && <div className="scrim drawer-scrim" onClick={() => setOpen(false)} />}
      <aside id="main-sidebar" className={open ? 'sidebar open' : 'sidebar'} aria-label="Main menu">
        <div className="brand">
          <svg className="mark" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="18" fill="none" stroke="var(--brass)" strokeWidth="4"/><circle cx="32" cy="32" r="5" fill="var(--brass)"/></svg>
          <div className="word"><i>local</i><span>agent</span></div>
          <button className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        <nav className="nav">
          {links.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} title={collapsed ? label : undefined} aria-label={label} className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon aria-hidden /> <span className="label">{label}</span>
            </NavLink>
          ))}
        </nav>
        {personas.length > 0 && (
          <div className="persona-head">
            <span className="faint">Personas</span>
            <button className="btn ghost small" aria-pressed={arrange} onClick={() => setArrange((value) => !value)}>{arrange ? 'Done' : 'Arrange'}</button>
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
              {arrange && <span className="persona-ops">
                <button className="btn ghost" onClick={() => api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !persona.pinned }) }).then(loadPersonas)}>{persona.pinned ? 'Unpin' : 'Pin'}</button>
                <button className="btn ghost" onClick={() => api(`/api/agents/${persona.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) }).then(loadPersonas)}>Hide</button>
                <button className="btn ghost" disabled={index === 0} onClick={() => move(index, -1)}>Up</button>
                <button className="btn ghost" disabled={index === personas.length - 1} onClick={() => move(index, 1)}>Down</button>
              </span>}
            </div>
          ))}
        </div>
        <div className="side-foot">
          <span className="ellipsis" title={username}>{username}{role === 'member' && <small className="faint"> · member</small>}</span>
          <button className="btn ghost small" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={15} aria-hidden /><span className="label">Sign out</span></button>
        </div>
      </aside>
      <div className="main">
        {restartKeys.length > 0 && <p className="restart-note">Restart needed. secrets.env changed for {restartKeys.join(', ')}. This process is still using the values it loaded at startup.</p>}
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Menu size={20} /></button>
          <button className="icon-btn collapse-btn" aria-controls="main-sidebar" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'} title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button>
          <button className="palette-btn" onClick={() => setPalette(true)}><span>Search or jump</span> <span className="kbd">Ctrl K</span></button>
          {pending > 0 && <button className="btn" onClick={() => navigate('/settings')}>{pending} secret request{pending === 1 ? '' : 's'}</button>}
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
          <div className="card" onClick={(event) => event.stopPropagation()}>
            <input autoFocus placeholder="Go to…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && filtered[0]) { navigate(filtered[0].to); setPalette(false); setQuery(''); } }} />
            {filtered.length === 0 && <p className="faint" style={{ padding: '8px 12px' }}>No page matches “{query}”.</p>}
            {filtered.map((item, index) => (
              <button key={item.to} className={index === 0 ? 'active' : ''} onClick={() => { navigate(item.to); setPalette(false); setQuery(''); }}>{item.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
