import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe, Hand, Monitor, Play, Terminal, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { fmt, t } from '../i18n';

interface ShellTailEntry {
  id: string;
  runId: string | null;
  persona: string;
  command: string;
  output: string;
  code: number;
  at: string;
}

interface BrowseStepEntry {
  id: string;
  runId: string | null;
  persona: string;
  url: string;
  title: string;
  actions: string[];
  status: 'running' | 'completed' | 'failed';
  error?: string | null;
  at: string;
}

interface LastScreenMeta {
  available: boolean;
  url: string | null;
  title: string | null;
  persona: string | null;
  runId: string | null;
  at: string;
  ageMs: number;
}

interface ComputerState {
  takenOver: boolean;
  takenOverAt: string | null;
  pausedForLogin: { runId: string; personaName: string; url: string; since: string } | null;
  browser: {
    enabled: boolean;
    state: string;
    activePersona: string | null;
    activeRunId: string | null;
    activeTabOpen?: boolean;
    lastUrl?: string | null;
    lastTitle?: string | null;
  } | null;
  lastScreen?: LastScreenMeta | null;
  browseSteps?: BrowseStepEntry[];
  shellTail: ShellTailEntry[];
}

export function Computer() {
  const navigate = useNavigate();
  const [state, setState] = useState<ComputerState | null>(null);
  const closeView = () => { if (window.history.length > 1) navigate(-1); else navigate('/'); };
  const [error, setError] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<string>('');
  const [frameTick, setFrameTick] = useState(0);
  const [vncConnected, setVncConnected] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(() => {
    void api<ComputerState>('/api/computer/state')
      .then((data) => {
        if (!mounted.current) return;
        setState(data);
        setError(null);
      })
      .catch((err) => {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);

  const browserState = state?.browser?.state;
  useEffect(() => {
    const ms = browserState === 'running' ? 1000 : 3000;
    const timer = window.setInterval(load, ms);
    return () => window.clearInterval(timer);
  }, [browserState, load]);

  useEffect(() => {
    const onLive = (event: Event) => {
      const detail = (event as CustomEvent<{
        type?: string;
        url?: string | null;
        title?: string | null;
        persona?: string | null;
        runId?: string | null;
        at?: string;
      }>).detail;
      if (!detail?.type) return;
      if (detail.type === 'computer_browser_frame') {
        setFrameTick((v) => v + 1);
        setState((prev) => prev ? {
          ...prev,
          lastScreen: {
            available: true,
            url: detail.url ?? prev.lastScreen?.url ?? null,
            title: detail.title ?? prev.lastScreen?.title ?? null,
            persona: detail.persona ?? prev.lastScreen?.persona ?? null,
            runId: detail.runId ?? prev.lastScreen?.runId ?? null,
            at: detail.at || new Date().toISOString(),
            ageMs: 0,
          },
        } : prev);
        return;
      }
      if (detail.type.startsWith('computer_') || detail.type === 'done' || detail.type === 'stopped' || detail.type === 'failed') {
        load();
      }
    };
    const onMsg = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; status?: string } | null;
      if (data?.type === 'novnc') {
        setVncConnected(data.status === 'connected');
      }
    };
    window.addEventListener('la:live', onLive);
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('la:live', onLive);
      window.removeEventListener('message', onMsg);
    };
  }, [load]);

  const takenOver = Boolean(state?.takenOver);
  const driving = state?.browser?.activePersona;
  const containerRunning = state?.browser?.state === 'running' || state?.browser?.state === 'idle';
  const showVnc = Boolean(containerRunning && (takenOver || state?.browser?.activeTabOpen));
  const showLastScreen = Boolean(state?.lastScreen?.available);

  useEffect(() => {
    if (!showVnc) setVncConnected(false);
  }, [showVnc]);

  const takeOver = async () => {
    await post('/api/computer/takeover', {});
    load();
  };

  const giveBack = async () => {
    await post('/api/computer/giveback', {});
    load();
  };

  const wsProto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsPath = typeof window !== 'undefined' ? `${wsProto}//${window.location.host}/api/computer/vnc` : '';
  const entries = (state?.shellTail ?? []).filter((e) => !runFilter || e.runId === runFilter);
  const browseEntries = (state?.browseSteps ?? []).filter((e) => !runFilter || e.runId === runFilter);
  const overlayLabel = state?.lastScreen?.title || state?.browser?.lastTitle || state?.lastScreen?.url || state?.browser?.lastUrl;

  return (
    <div className="page computer-page">
      <header className="page-head page-head-row">
        <div className="page-head-text">
          <h1><Monitor size={20} aria-hidden /> {t('Live computer')}</h1>
          <p className="lede">
            {driving
              ? t('Driven by {0}', [driving])
              : t('View-only by default. Click Take over to interact or sign in.')}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {!takenOver ? (
            <button type="button" className="btn primary" onClick={() => void takeOver()}>
              <Hand size={15} aria-hidden /> {t('Take over')}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => void giveBack()}>
              <Play size={15} aria-hidden /> {t('Give back')}
            </button>
          )}
          <button type="button" className="icon-btn round" aria-label={t('Close')} title={t('Close')} onClick={closeView}>
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>

      {error && <p className="banner err">{error}</p>}

      {state?.pausedForLogin && (
        <div className="login-pause-banner" role="alert">
          <div className="grow">
            <strong>{t('Take over to sign in')}</strong>
            <p className="faint">
              {state.pausedForLogin.personaName} · {state.pausedForLogin.url}
            </p>
          </div>
          {!takenOver ? (
            <button type="button" className="btn primary" onClick={() => void takeOver()}>{t('Take over')}</button>
          ) : (
            <button type="button" className="btn primary" onClick={() => void giveBack()}>{t('Give back')}</button>
          )}
        </div>
      )}

      <section className="computer-viewport-wrap">
        <div className="computer-viewport-bar">
          <span className={`pill small${takenOver ? ' on' : ''}`}>
            {takenOver ? t('Interactive (you have control)') : t('View-only')}
          </span>
          {state?.browser?.state && (
            <span className="faint">
              {state.browser.state === 'running' ? t('Running') : state.browser.state === 'idle' ? t('Idle') : t('Stopped')}
            </span>
          )}
          {state?.browser?.state === 'running' && !state?.browser?.activeTabOpen && (
            <span className="faint">· {t('Agent is reasoning between steps…')}</span>
          )}
          {state?.lastScreen?.at && state?.browser?.state !== 'running' && (
            <span className="faint">· {t('Last seen {0}', [fmt.ago(state.lastScreen.at)])}</span>
          )}
          {state?.browser?.activeRunId && <span className="faint mono">{state.browser.activeRunId}</span>}
        </div>
        <div className={`computer-viewport${takenOver ? ' interactive' : ' view-only'}`} data-vnc-ws={wsPath}>
          {showLastScreen && (
            <img
              src={`/api/computer/last-screen?t=${frameTick}`}
              alt={overlayLabel || t('Last captured screen')}
              className="computer-last-screen"
            />
          )}
          {showVnc && (
            <iframe
              title={t('Live computer')}
              src={`/api/computer/novnc/viewer.html?path=${encodeURIComponent('api/computer/vnc')}&view_only=${takenOver ? '0' : '1'}`}
              className={`computer-iframe${showLastScreen && !vncConnected ? ' connecting' : ''}`}
              style={{ pointerEvents: takenOver ? 'auto' : 'none', opacity: vncConnected || !showLastScreen ? 1 : 0 }}
            />
          )}
          {(showVnc || showLastScreen) && overlayLabel && (
            <div className="computer-overlay-meta" dir="auto">
              <span className="ellipsis">{overlayLabel}</span>
            </div>
          )}
          {!showVnc && !showLastScreen && (
            <div className="computer-viewport-empty">
              <Monitor size={32} aria-hidden />
              <p className="faint">{t('Browser is not running yet. Start a browse task to see the live view.')}</p>
            </div>
          )}
        </div>
      </section>

      <section className="shell-tail-sec">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2><Globe size={16} aria-hidden /> {t('Recent browse steps')}</h2>
          <input
            type="search"
            value={runFilter}
            onChange={(e) => setRunFilter(e.target.value)}
            placeholder={t('Filter by run ID')}
            style={{ maxWidth: 220 }}
          />
        </div>
        {browseEntries.length === 0 ? (
          <p className="faint">{t('No recent browse steps yet.')}</p>
        ) : (
          <ul className="shell-tail-list">
            {browseEntries.slice().reverse().map((step) => (
              <li key={step.id} className="shell-tail-item">
                <div className="shell-tail-head">
                  <strong>{step.persona}</strong>
                  <span className={`pill small${step.status === 'failed' ? ' bad' : step.status === 'running' ? ' on' : ''}`}>
                    {step.status === 'running' ? t('Running') : step.status === 'failed' ? t('Failed') : t('Done')}
                  </span>
                  <span className="ellipsis" dir="auto" style={{ flex: 1, minWidth: 0 }}>{step.title ? `${step.title} · ` : ''}{step.url}</span>
                  <span className="faint">{fmt.ago(step.at)}</span>
                </div>
                {step.actions.length > 0 && (
                  <p className="mono faint browse-actions" dir="ltr">{step.actions.join(' → ')}</p>
                )}
                {step.error && <pre className="mono shell-tail-out" dir="ltr">{step.error.slice(0, 600)}</pre>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="shell-tail-sec">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2><Terminal size={16} aria-hidden /> {t('Workbench shell tail')}</h2>
        </div>
        {entries.length === 0 ? (
          <p className="faint">{t('No recent shell commands yet.')}</p>
        ) : (
          <ul className="shell-tail-list">
            {entries.slice().reverse().map((entry) => (
              <li key={entry.id} className="shell-tail-item">
                <div className="shell-tail-head">
                  <strong>{entry.persona}</strong>
                  <code className="mono" dir="ltr">$ {entry.command}</code>
                  <span className={`pill small${entry.code === 0 ? '' : ' bad'}`}>exit {entry.code}</span>
                  <span className="faint">{fmt.ago(entry.at)}</span>
                </div>
                {entry.output && <pre className="mono shell-tail-out" dir="ltr">{entry.output.slice(0, 1000)}</pre>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
