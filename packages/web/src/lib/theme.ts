import { useEffect, useState } from 'react';
import { DEFAULT_THEME, themeVars, type ThemeChoice } from '@local-agent/shared';
import { api } from './api';
import { renderWallpaper } from './wallpapers';

const KEY = 'la-theme';
const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');
let current: ThemeChoice = readLocal();
const listeners = new Set<(choice: ThemeChoice) => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function readLocal(): ThemeChoice {
  try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT_THEME }; }
}

/** Write the theme onto <html>. Works before sign-in from the local copy. */
export function applyTheme(choice: ThemeChoice) {
  const { vars, scheme, decor, preset } = themeVars(choice, Boolean(darkQuery()?.matches));
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.scheme = scheme;
  root.dataset.theme = preset.id;
  root.dataset.density = choice.density || 'cozy';
  root.dataset.bubbles = choice.bubbles || 'classic';
  root.dataset.decor = decor ? 'on' : 'off';
  root.style.colorScheme = scheme;
  applyWallpaper(choice, scheme === 'dark');
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', preset.bg));
  // The desktop shell paints its window background to match, so there is no dark flash on a light theme.
  (window as unknown as { localAgent?: { setBackground?: (color: string) => void } }).localAgent?.setBackground?.(preset.bg);
}

let lastWallpaper = '';
/** A fixed layer behind the app: the picture, then blur and a dim veil in the theme's background colour. */
function applyWallpaper(choice: ThemeChoice, dark: boolean) {
  const root = document.documentElement;
  const id = choice.wallpaper || 'none';
  let layer = document.getElementById('wallpaper');
  if (id === 'none') { layer?.remove(); root.dataset.wallpaper = 'off'; lastWallpaper = ''; return; }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'wallpaper';
    layer.setAttribute('aria-hidden', 'true');
    document.body.prepend(layer);
  }
  const mode = choice.wallpaperMode || 'scene';
  const key = `${id}|${mode}|${dark}|${choice.wallpaperVersion || 0}`;
  if (key !== lastWallpaper) {
    const art = id === 'upload' ? { image: `url("/api/me/wallpaper?v=${choice.wallpaperVersion || 0}")`, size: mode === 'pattern' ? '360px auto' : 'cover', repeat: mode === 'pattern' ? 'repeat' : 'no-repeat' } : renderWallpaper(id, mode, dark);
    if (!art) { layer.remove(); root.dataset.wallpaper = 'off'; return; }
    layer.style.backgroundImage = art.image;
    layer.style.backgroundSize = art.size;
    layer.style.backgroundRepeat = art.repeat;
    lastWallpaper = key;
  }
  root.dataset.wallpaper = 'on';
  root.style.setProperty('--wp-opacity', String(choice.wallpaperOpacity ?? 0.85));
  root.style.setProperty('--wp-blur', `${choice.wallpaperBlur ?? 0}px`);
  root.style.setProperty('--wp-dim', String(choice.wallpaperDim ?? 0.3));
}

export function bootTheme() {
  applyTheme(current);
  darkQuery()?.addEventListener?.('change', () => { if (current.followSystem) applyTheme(current); });
}

/** After sign-in: the account's saved theme wins over this device's copy. */
export async function loadAccountTheme() {
  try {
    const data = await api<{ theme: ThemeChoice | null }>('/api/me/theme');
    if (data.theme) setTheme({ ...DEFAULT_THEME, ...data.theme }, false);
  } catch { /* keep the local copy */ }
}

export function getTheme() { return current; }

export function setTheme(next: ThemeChoice, save = true) {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  applyTheme(next);
  listeners.forEach((listener) => listener(next));
  if (!save) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) if (value !== undefined) body[key] = value;
    void api('/api/me/theme', { method: 'PUT', body: JSON.stringify(body) }).catch(() => undefined);
  }, 400);
}

export function useTheme(): [ThemeChoice, (patch: Partial<ThemeChoice>) => void] {
  const [choice, setChoice] = useState(current);
  useEffect(() => { listeners.add(setChoice); return () => { listeners.delete(setChoice); }; }, []);
  return [choice, (patch) => setTheme({ ...current, ...patch })];
}
