import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../i18n';
import { RELEASES_URL, checkDisabled, describeUpdate, desktopBridge, hasStatusApi, type AppInfo, type UpdateStatus } from '../lib/updates';

/** Settings → About & updates: app and server versions, and Check for updates on the Windows app. */
export function UpdatesBlock() {
  const bridge = desktopBridge();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [server, setServer] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [legacyNote, setLegacyNote] = useState('');

  useEffect(() => {
    void api<{ version?: string }>('/api/health').then((h) => setServer(h.version ?? null)).catch(() => setServer(null));
    if (!bridge) return;
    void bridge.getAppInfo?.().then(setInfo).catch(() => {});
    if (!hasStatusApi(bridge)) return;
    void bridge.getUpdateStatus?.().then(setStatus).catch(() => {});
    return bridge.onUpdateStatus?.(setStatus);
    // The bridge object is stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async () => {
    if (!bridge?.checkForUpdates) return;
    if (!hasStatusApi(bridge)) setLegacyNote(t('Checking for updates…'));
    const result = await bridge.checkForUpdates();
    if (!result.ok) setStatus((s) => ({ state: 'error', current: s?.current ?? info?.version ?? '', error: result.error || t('Update check failed.') }));
    else if (result.result && 'state' in result.result) setStatus(result.result as UpdateStatus);
    else setLegacyNote(t('This app version shows the result in a window. Update the app to see it here.'));
  };

  const line = describeUpdate(status);
  return (
    <div className="card updates-card">
      <dl className="version-list">
        {bridge && <><dt>{t('Windows app')}</dt><dd className="mono">{info ? `${info.version}${info.portable ? ` · ${t('portable')}` : ''}${info.packaged ? '' : ` · ${t('development')}`}` : '…'}</dd></>}
        <dt>{t('Server')}</dt><dd className="mono">{server ?? '…'}</dd>
      </dl>
      {bridge ? (
        <>
          <div className="update-row">
            <button className="btn" type="button" disabled={checkDisabled(status)} onClick={() => void check()}>
              <RefreshCw size={15} aria-hidden className={status?.state === 'checking' ? 'spin' : undefined} /> {t('Check for updates')}
            </button>
            {status?.state === 'downloaded' && (
              <button className="btn primary" type="button" onClick={() => void bridge.installUpdate?.()}><RotateCw size={15} aria-hidden /> {t('Restart to install')}</button>
            )}
            {status?.state === 'portable-available' && (
              <button className="btn primary" type="button" onClick={() => void bridge.openReleasePage?.()}><ExternalLink size={15} aria-hidden /> {t('Open download page')}</button>
            )}
          </div>
          {line.text && <p className={`update-status ${line.tone}`} role="status">{t(line.text, line.args)}</p>}
          {status?.state === 'downloading' && <progress className="update-progress" max={100} value={status.percent ?? 0} aria-label={t('Download progress')} />}
          {legacyNote && !line.text && <p className="update-status muted" role="status">{legacyNote}</p>}
        </>
      ) : (
        <p className="faint">
          {t('The Windows app and the Android app update from GitHub releases.')}{' '}
          <a href={RELEASES_URL} target="_blank" rel="noreferrer"><Download size={13} aria-hidden /> {t('Latest release')}</a>
        </p>
      )}
    </div>
  );
}
