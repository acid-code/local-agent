import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Activity, BookOpen, Box, CalendarClock, Cpu, Gauge, ListChecks, Menu, MessageSquare, Radio, Settings, Sparkles, Users, Wrench } from 'lucide-react';
import { api } from '../lib/api';

const LINKS = [
  ['/', 'Chats', MessageSquare],
  ['/agents', 'Agents', Users],
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

export function Shell({ username, onLogout, children }: { username: string; onLogout: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      }
      if (event.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
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

  const actions = useMemo(() => LINKS.map(([to, label]) => ({ to, label })), []);
  const filtered = actions.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="app">
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <svg className="mark" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="18" fill="none" stroke="#e4b56a" strokeWidth="4"/><circle cx="32" cy="32" r="5" fill="#e4b56a"/></svg>
          <div className="word"><i>local</i><span>agent</span></div>
        </div>
        <nav className="nav">
          {LINKS.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div>{username}</div>
          <button className="btn ghost" onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost" aria-label="Menu" onClick={() => setOpen((value) => !value)}><Menu size={16} /></button>
          <button className="palette-btn" onClick={() => setPalette(true)}>Search or jump <span className="kbd">Ctrl K</span></button>
          {pending > 0 && <button className="btn" onClick={() => navigate('/settings')}>{pending} secret request{pending === 1 ? '' : 's'}</button>}
        </header>
        {children}
        <nav className="bottom-nav">
          <NavLink to="/">Chat</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/setup">Setup</NavLink>
          <NavLink to="/settings">More</NavLink>
        </nav>
      </div>
      {palette && (
        <div className="palette" onClick={() => setPalette(false)}>
          <div className="card" onClick={(event) => event.stopPropagation()}>
            <input autoFocus placeholder="Go to…" value={query} onChange={(event) => setQuery(event.target.value)} />
            {filtered.map((item, index) => (
              <button key={item.to} className={index === 0 ? 'active' : ''} onClick={() => { navigate(item.to); setPalette(false); setQuery(''); }}>{item.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
