import { syncAccountLanguage } from './components/LanguagePicker';
import { useCallback, useEffect, useState } from 'react';
import { setRole } from './lib/role';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError } from './lib/api';
import { Shell } from './components/Shell';
import { Gallery } from './pages/Gallery';
import { Agents } from './pages/Agents';
import { Chat } from './pages/Chat';
import { Containers } from './pages/Containers';
import { Login } from './pages/Login';
import { Resources } from './pages/Resources';
import { Runs } from './pages/Runs';
import { Library } from './pages/Library';
import { Schedules } from './pages/Schedules';
import { Skills } from './pages/Skills';
import { Triggers } from './pages/Triggers';
import { Settings } from './pages/Settings';
import { Tools } from './pages/Tools';
import { Workspace } from './pages/Workspace';
import { loadAccountTheme } from './lib/theme';
import { t } from './i18n';

export type Role = 'owner' | 'member';
export interface Me { needsSetup: boolean; authenticated: boolean; username?: string; displayName?: string; role?: Role; limits?: { cloud: boolean; maxAgents: number } }

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [bootError, setBootError] = useState<string>('');
  const navigate = useNavigate();

  const loadMe = useCallback(() => {
    setBootError('');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    api<Me>('/api/auth/me', { signal: controller.signal })
      .then((data) => {
        setMe(data);
        if (data.authenticated) {
          void loadAccountTheme();
          void syncAccountLanguage();
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          setMe({ needsSetup: false, authenticated: false });
          return;
        }
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        const message = aborted
          ? t('The server took too long to answer.')
          : error instanceof Error && error.message && !/failed to fetch/i.test(error.message)
            ? error.message
            : t('Could not reach the server.');
        setBootError(message);
      })
      .finally(() => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const desktopBridge = (window as unknown as { localAgent?: { openSetup?: (msg?: string) => void } }).localAgent;

  if (!me) {
    if (bootError) {
      return (
        <div className="login">
          <div className="card" style={{ maxWidth: 420, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0 }}>{bootError}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={loadMe}>{t('Retry')}</button>
              {desktopBridge?.openSetup && (
                <button type="button" className="btn" onClick={() => desktopBridge.openSetup?.(bootError)}>{t('Change server…')}</button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return <div className="login"><p className="muted">{t('Opening the workshop…')}</p></div>;
  }
  if (!me.authenticated) return <Login me={me} onIn={() => { void api<Me>('/api/auth/me').then((data) => { setMe(data); void loadAccountTheme(); void syncAccountLanguage(); }); navigate('/'); }} />;

  const owner = me.role !== 'member';
  setRole(owner ? 'owner' : 'member');
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
        {owner && <Route path="/models" element={<Navigate to="/settings#system" replace />} />}
        {owner && <Route path="/containers" element={<Containers />} />}
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/library" element={<Library />} />
        {owner && <Route path="/skills" element={<Skills />} />}
        {owner && <Route path="/triggers" element={<Triggers />} />}
        {owner && <Route path="/setup" element={<Navigate to="/settings#system" replace />} />}
        {owner && <Route path="/resources" element={<Resources />} />}
        <Route path="/settings" element={<Settings role={owner ? 'owner' : 'member'} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
