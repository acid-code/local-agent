import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError } from './lib/api';
import { Shell } from './components/Shell';
import { Gallery } from './pages/Gallery';
import { Agents } from './pages/Agents';
import { Chat } from './pages/Chat';
import { Containers } from './pages/Containers';
import { Login } from './pages/Login';
import { Models } from './pages/Models';
import { Resources } from './pages/Resources';
import { Runs } from './pages/Runs';
import { Library } from './pages/Library';
import { Schedules } from './pages/Schedules';
import { Skills } from './pages/Skills';
import { Triggers } from './pages/Triggers';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Tools } from './pages/Tools';
import { Workspace } from './pages/Workspace';
import { loadAccountTheme } from './lib/theme';

export type Role = 'owner' | 'member';
export interface Me { needsSetup: boolean; authenticated: boolean; username?: string; displayName?: string; role?: Role; limits?: { cloud: boolean; maxAgents: number } }

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api<Me>('/api/auth/me').then((data) => { setMe(data); if (data.authenticated) void loadAccountTheme(); }).catch((error: ApiError) => {
      if (error.status === 401) setMe({ needsSetup: false, authenticated: false });
    });
  }, []);

  if (!me) return <div className="login"><p className="muted">Opening the workshop…</p></div>;
  if (!me.authenticated) return <Login me={me} onIn={() => { void api<Me>('/api/auth/me').then((data) => { setMe(data); void loadAccountTheme(); }); navigate('/'); }} />;

  const owner = me.role !== 'member';
  return (
    <Shell username={me.displayName || me.username || 'owner'} role={owner ? 'owner' : 'member'} onLogout={async () => { await api('/api/auth/logout', { method: 'POST' }); setMe({ needsSetup: false, authenticated: false }); }}>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/workspace" element={<Workspace />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<Runs />} />
        {owner && <Route path="/tools" element={<Tools />} />}
        {owner && <Route path="/models" element={<Models />} />}
        {owner && <Route path="/containers" element={<Containers />} />}
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/library" element={<Library />} />
        {owner && <Route path="/skills" element={<Skills />} />}
        {owner && <Route path="/triggers" element={<Triggers />} />}
        {owner && <Route path="/setup" element={<Setup />} />}
        {owner && <Route path="/resources" element={<Resources />} />}
        <Route path="/settings" element={<Settings role={owner ? 'owner' : 'member'} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
