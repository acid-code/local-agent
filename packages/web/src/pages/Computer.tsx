import { useEffect, useState } from 'react';
import { Hand, Monitor, Play, Terminal } from 'lucide-react';
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

interface ComputerState {
  takenOver: boolean;
  takenOverAt: string | null;
  pausedForLogin: { runId: string; personaName: string; url: string; since: string } | null;
  browser: {
    enabled: boolean;
    state: string;
    activePersona: string | null;
    activeRunId: string | null;
  } | null;
  shellTail: ShellTailEntry[];
}

export function Computer() {
  const [state, setState] = useState<ComputerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<string>('');

  const load = () => {
    void api<ComputerState>('/api/computer/state')
      .then((data) => { setState(data); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

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
  const takenOver = Boolean(state?.takenOver);
  const driving = state?.browser?.activePersona;
  const entries = (state?.shellTail ?? []).filter((e) => !runFilter || e.runId === runFilter);

  return (
    <div className="page computer-page">
      <header className="page-head">
        <div>
          <h1><Monitor size={20} aria-hidden /> {t('Live computer')}</h1>
          <p className="faint">
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
        </div>
      </header>

      {error && <p className="error-note">{error}</p>}

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
          {state?.browser?.state && <span className="faint">{state.browser.state}</span>}
          {state?.browser?.activeRunId && <span className="faint mono">{state.browser.activeRunId}</span>}
        </div>
        <div className={`computer-viewport${takenOver ? ' interactive' : ' view-only'}`} data-vnc-ws={wsPath}>
          <iframe
            title={t('Live computer')}
            src={`/novnc/vnc_lite.html?path=${encodeURIComponent('api/computer/vnc')}&autoconnect=1&resize=scale&view_only=${takenOver ? '0' : '1'}`}
            className="computer-iframe"
            style={{ pointerEvents: takenOver ? 'auto' : 'none' }}
          />
        </div>
      </section>

      <section className="shell-tail-sec">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2><Terminal size={16} aria-hidden /> {t('Workbench shell tail')}</h2>
          <input
            type="search"
            value={runFilter}
            onChange={(e) => setRunFilter(e.target.value)}
            placeholder={t('Filter by run ID')}
            style={{ maxWidth: 220 }}
          />
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
