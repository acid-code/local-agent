/** Settings → About & updates: the desktop bridge (apps/desktop/preload.js) and how its status reads. Pure, so tests import it. */
export type UpdateState = 'idle' | 'development' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'portable-available' | 'error';
export interface UpdateStatus { state: UpdateState; current: string; version?: string; percent?: number; error?: string; portable?: boolean }
export interface AppInfo { name: string; version: string; packaged: boolean; portable?: boolean; platform: string }
export interface DesktopBridge {
  getAppInfo?: () => Promise<AppInfo>;
  checkForUpdates?: () => Promise<{ ok: boolean; result?: UpdateStatus | { status?: string }; error?: string }>;
  getUpdateStatus?: () => Promise<UpdateStatus>;
  installUpdate?: () => Promise<{ ok: boolean }>;
  openReleasePage?: () => Promise<unknown>;
  notify?: (payload: { title: string; body: string; route?: string; flash?: boolean; silent?: boolean }) => Promise<{ ok?: boolean }>;
  onNotificationClick?: (callback: (payload: { route?: string }) => void) => () => void;
  onUpdateStatus?: (callback: (status: UpdateStatus) => void) => () => void;
}

/** Marks English keys for scripts/i18n-keys.mjs; the component translates them with t(). */
const tr = (key: string) => key;

export const RELEASES_URL = 'https://github.com/acid-code/local-agent/releases/latest';

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { localAgent?: DesktopBridge }).localAgent;
  return bridge && typeof bridge.getAppInfo === 'function' ? bridge : null;
}

/** True when the desktop app has the new status API (older desktop builds only show dialogs). */
export function hasStatusApi(bridge: DesktopBridge | null): boolean {
  return Boolean(bridge?.getUpdateStatus && bridge.onUpdateStatus && bridge.installUpdate);
}

/** English source strings; the caller passes them through t(). */
export function describeUpdate(status: UpdateStatus | null): { text: string; args?: string[]; tone: 'muted' | 'ok' | 'busy' | 'action' | 'error' } {
  if (!status) return { text: '', tone: 'muted' };
  switch (status.state) {
    case 'development': return { text: tr('Development build: updates are off.'), tone: 'muted' };
    case 'checking': return { text: tr('Checking for updates…'), tone: 'busy' };
    case 'up-to-date': return { text: tr('You are up to date.'), tone: 'ok' };
    case 'available':
    case 'downloading': return { text: tr('Downloading {0}… {1}%'), args: [status.version ?? '', String(status.percent ?? 0)], tone: 'busy' };
    case 'downloaded': return { text: tr('Version {0} is ready. Restart to install.'), args: [status.version ?? ''], tone: 'action' };
    case 'portable-available': return { text: tr('Version {0} is out. The portable app cannot update itself; download the new one.'), args: [status.version ?? ''], tone: 'action' };
    case 'error': return { text: status.error || tr('Update check failed.'), tone: 'error' };
    default: return { text: '', tone: 'muted' };
  }
}

export function checkDisabled(status: UpdateStatus | null): boolean {
  return status?.state === 'checking' || status?.state === 'downloading' || status?.state === 'development';
}
