import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError } from './lib/api';
import { Shell } from './components/Shell';
import { Agents } from './pages/Agents';
import { Chat } from './pages/Chat';
import { Containers } from './pages/Containers';
import { Login } from './pages/Login';
import { Models } from './pages/Models';
import { Resources } from './pages/Resources';
import { Runs } from './pages/Runs';
import { Schedules } from './pages/Schedules';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Tools } from './pages/Tools';

export interface Me { needsSetup: boolean; authenticated: boolean; username?: string }

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api<Me>('/api/auth/me').then(setMe).catch((error: ApiError) => {
      if (error.status === 401) setMe({ needsSetup: false, authenticated: false });
    });
  }, []);

  if (!me) return <div className="login"><p className="muted">Opening the workshop…</p></div>;
  if (!me.authenticated) return <Login me={me} onIn={(username) => { setMe({ needsSetup: false, authenticated: true, username }); navigate('/'); }} />;

  return (
    <Shell username={me.username || 'owner'} onLogout={async () => { await api('/api/auth/logout', { method: 'POST' }); setMe({ needsSetup: false, authenticated: false }); }}>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<Runs />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/models" element={<Models />} />
        <Route path="/containers" element={<Containers />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
