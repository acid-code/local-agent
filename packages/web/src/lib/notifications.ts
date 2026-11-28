/** Desktop + browser notification helpers (Electron native notifications when present, Web Notification API fallback). */

export const DESKTOP_NOTIFY_KEY = 'la-desktop-notify';

export function desktopNotifyEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(DESKTOP_NOTIFY_KEY) !== 'off' : true;
  } catch {
    return true;
  }
}

export function setDesktopNotifyEnabled(enabled: boolean) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DESKTOP_NOTIFY_KEY, enabled ? 'on' : 'off');
  } catch { /* ignore */ }
}

export function shouldSendNotification(input: {
  kind: 'approval' | 'secret' | 'done';
  status?: string;
  focused: boolean;
  hidden: boolean;
  muted?: boolean;
  enabled: boolean;
  samePersona?: boolean;
}): boolean {
  if (!input.enabled || input.muted) return false;
  if (input.kind === 'approval' || input.kind === 'secret') {
    return !input.focused || input.hidden || !input.samePersona;
  }
  if (!input.focused || input.hidden) {
    return input.status === 'completed' || input.status === 'failed';
  }
  return false;
}

type DesktopNotifyBridge = {
  notify?: (payload: { title: string; body: string; route?: string; flash?: boolean; silent?: boolean }) => Promise<{ ok?: boolean }>;
};

export async function requestNotificationPermission(): Promise<'granted' | 'denied' | 'default' | 'native' | 'unsupported'> {
  const bridge = typeof window !== 'undefined' ? (window as unknown as { localAgent?: DesktopNotifyBridge }).localAgent : undefined;
  if (bridge && typeof bridge.notify === 'function') return 'native';
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (window.Notification.permission === 'granted' || window.Notification.permission === 'denied') {
    return window.Notification.permission;
  }
  try {
    return await window.Notification.requestPermission();
  } catch {
    return 'default';
  }
}

export async function sendDesktopNotification(input: {
  title: string;
  body: string;
  route?: string;
  tag?: string;
  urgent?: boolean;
}): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const bridge = (window as unknown as { localAgent?: DesktopNotifyBridge }).localAgent;
  if (bridge && typeof bridge.notify === 'function') {
    try {
      const res = await bridge.notify({ title: input.title, body: input.body, route: input.route, flash: input.urgent ?? true });
      if (res?.ok) return true;
    } catch { /* fall through to Web Notification */ }
  }
  if (!('Notification' in window)) return false;
  let perm = window.Notification.permission;
  if (perm === 'default') {
    try { perm = await window.Notification.requestPermission(); } catch { return false; }
  }
  if (perm !== 'granted') return false;
  const n = new window.Notification(input.title.slice(0, 120), {
    body: input.body.slice(0, 240),
    tag: input.tag,
  });
  n.onclick = () => {
    try { window.focus(); } catch { /* ignore */ }
    if (input.route && input.route.startsWith('/')) {
      window.dispatchEvent(new CustomEvent('la:navigate', { detail: input.route }));
    }
    n.close();
  };
  return true;
}
