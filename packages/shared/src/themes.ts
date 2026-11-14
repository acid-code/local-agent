/** Appearance presets and the math that turns a saved choice into CSS variables. Shared so tests can check contrast. */

export type FontId = 'outfit' | 'nunito' | 'quicksand' | 'fredoka' | 'system';
export type HeadingId = 'fraunces' | 'fredoka' | 'nunito' | 'quicksand';

export interface ThemePreset {
  id: string;
  name: string;
  blurb: string;
  scheme: 'dark' | 'light';
  bg: string; bg2: string; bg3: string; bg4: string;
  text: string; muted: string; faint: string;
  /** Buttons, focus rings, active marks. */
  accent: string;
  /** Accent used as text (links, chips) on the page background. */
  accentText: string;
  moss: string; coral: string; sky: string;
  codeBg: string;
  font: FontId;
  heading: HeadingId;
  /** Corner multiplier. 1 is the original console. */
  round: number;
  cute: boolean;
  emoji: string;
  /** Two soft page glows, as "r,g,b" triplets. */
  glow: [string, string];
}

export const THEMES: ThemePreset[] = [
  {
    id: 'dark', name: 'Dark', blurb: 'The original console: ink black with brass.', scheme: 'dark',
    bg: '#090a0c', bg2: '#111318', bg3: '#181b22', bg4: '#222733', text: '#f4f0e6', muted: '#b7b1a6', faint: '#8f897f',
    accent: '#e4b56a', accentText: '#f3d7a6', moss: '#9dccb4', coral: '#e39486', sky: '#9ec0e0', codeBg: '#0c0e12',
    font: 'outfit', heading: 'fraunces', round: 1, cute: false, emoji: '✦', glow: ['228,181,106', '158,192,224'],
  },
  {
    id: 'light', name: 'Light', blurb: 'Warm paper, ink text, quiet brass.', scheme: 'light',
    bg: '#f7f5f0', bg2: '#ffffff', bg3: '#efebe3', bg4: '#e2dccf', text: '#1f1b16', muted: '#554e47', faint: '#6b635a',
    accent: '#94600f', accentText: '#7a4c06', moss: '#2f6b4f', coral: '#a83c2a', sky: '#2f5f8f', codeBg: '#f3efe7',
    font: 'outfit', heading: 'fraunces', round: 1, cute: false, emoji: '✦', glow: ['199,150,70', '120,160,200'],
  },
  {
    id: 'sakura', name: 'Sakura', blurb: 'Pastel pink, soft petals, round corners.', scheme: 'light',
    bg: '#fff5f8', bg2: '#ffffff', bg3: '#ffe9f0', bg4: '#fbd3e0', text: '#3a2230', muted: '#6b4659', faint: '#7f5a6c',
    accent: '#c43e6c', accentText: '#a32d57', moss: '#2e7356', coral: '#b8402b', sky: '#3a66a6', codeBg: '#fff0f5',
    font: 'nunito', heading: 'fredoka', round: 1.6, cute: true, emoji: '🌸', glow: ['244,154,193', '255,199,173'],
  },
  {
    id: 'lilac', name: 'Lilac', blurb: 'Lavender clouds and violet ink.', scheme: 'light',
    bg: '#f8f5ff', bg2: '#ffffff', bg3: '#efe9fc', bg4: '#ddd2f6', text: '#2a2240', muted: '#584d73', faint: '#6c6188',
    accent: '#7550c0', accentText: '#5c3aa3', moss: '#2e7356', coral: '#b23f3f', sky: '#3a63a8', codeBg: '#f4f0fe',
    font: 'nunito', heading: 'fredoka', round: 1.6, cute: true, emoji: '🪻', glow: ['184,156,240', '244,180,214'],
  },
  {
    id: 'matcha', name: 'Matcha', blurb: 'Mint, tea green and calm.', scheme: 'light',
    bg: '#f3f9f4', bg2: '#ffffff', bg3: '#e2f1e6', bg4: '#cbe4d2', text: '#1d3225', muted: '#465f4e', faint: '#587160',
    accent: '#2f7d50', accentText: '#236641', moss: '#2a6b48', coral: '#b0412c', sky: '#2f6496', codeBg: '#edf6ef',
    font: 'quicksand', heading: 'fredoka', round: 1.5, cute: true, emoji: '🍵', glow: ['140,205,160', '214,236,160'],
  },
  {
    id: 'peach', name: 'Peach', blurb: 'Apricot warmth with cream.', scheme: 'light',
    bg: '#fff7f1', bg2: '#ffffff', bg3: '#ffebdd', bg4: '#f9d6c0', text: '#3a251b', muted: '#6b4c3d', faint: '#7f5e4e',
    accent: '#b9531f', accentText: '#9c4216', moss: '#2e6f4f', coral: '#b23a2a', sky: '#33629a', codeBg: '#fff1e7',
    font: 'nunito', heading: 'fredoka', round: 1.6, cute: true, emoji: '🍑', glow: ['255,176,130', '255,214,150'],
  },
  {
    id: 'cloud', name: 'Cloud', blurb: 'Soft sky blue, airy and light.', scheme: 'light',
    bg: '#f5f8fc', bg2: '#ffffff', bg3: '#e8eef7', bg4: '#d4dfee', text: '#1e2939', muted: '#4a586d', faint: '#5d6c82',
    accent: '#3d6fbf', accentText: '#2c5aa3', moss: '#2c6c50', coral: '#ad3f37', sky: '#2f5f9c', codeBg: '#eff4fa',
    font: 'quicksand', heading: 'quicksand', round: 1.4, cute: true, emoji: '☁️', glow: ['150,186,236', '210,196,246'],
  },
  {
    id: 'night-bloom', name: 'Night Bloom', blurb: 'A cute dark: plum night with pink blossoms.', scheme: 'dark',
    bg: '#1a1220', bg2: '#22172a', bg3: '#2c1f36', bg4: '#3a2946', text: '#fbeefa', muted: '#d6c0d8', faint: '#ae98b1',
    accent: '#f49ac1', accentText: '#ffc4dd', moss: '#a7dcc0', coral: '#ffab9d', sky: '#b5ccf5', codeBg: '#150e1a',
    font: 'nunito', heading: 'fredoka', round: 1.6, cute: true, emoji: '🌙', glow: ['244,154,193', '160,140,240'],
  },
];

export interface ThemeChoice {
  preset?: string;
  followSystem?: boolean;
  lightPreset?: string;
  darkPreset?: string;
  accent?: string | null;
  fontScale?: number;
  roundness?: number;
  density?: 'compact' | 'cozy' | 'roomy';
  bubbles?: 'classic' | 'soft' | 'minimal';
  font?: string;
  decor?: boolean;
  /** 'none', a bundled wallpaper id, or 'upload' for the account's own photo. */
  wallpaper?: string;
  wallpaperMode?: 'pattern' | 'scene';
  wallpaperOpacity?: number;
  wallpaperBlur?: number;
  wallpaperDim?: number;
  /** Bumped on each upload so caches pick up the new photo. */
  wallpaperVersion?: number;
}

export const DEFAULT_THEME: ThemeChoice = { preset: 'dark', followSystem: false, lightPreset: 'light', darkPreset: 'dark', accent: null, fontScale: 1, density: 'cozy', bubbles: 'classic' };

const HEX = /^#([0-9a-f]{6})$/i;

export function hexToRgb(hex: string): [number, number, number] {
  const match = HEX.exec(hex);
  if (!match) return [0, 0, 0];
  const n = parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v!))).toString(16).padStart(2, '0')).join('')}`;
}

export function luminance(hex: string) {
  const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix toward black (amount < 0) or white (amount > 0). */
function shade(hex: string, amount: number) {
  const target = amount < 0 ? 0 : 255;
  return rgbToHex(hexToRgb(hex).map((v) => v + (target - v) * Math.abs(amount)));
}

/** Darken or lighten `color` until it reaches `ratio` against `bg`. */
export function ensureContrast(color: string, bg: string, ratio: number) {
  if (contrast(color, bg) >= ratio) return color;
  const lighter = luminance(bg) < 0.4;
  let current = color;
  for (let step = 1; step <= 20 && contrast(current, bg) < ratio; step++) current = shade(color, (lighter ? 1 : -1) * step * 0.05);
  return current;
}

/** White or near-black, whichever reads better on `bg`. */
export function onColor(bg: string) {
  return contrast('#ffffff', bg) >= contrast('#1a140c', bg) ? '#ffffff' : '#1a140c';
}

export function themeById(id: string | undefined) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

export function pickPreset(choice: ThemeChoice, systemDark: boolean): ThemePreset {
  if (choice.followSystem) return themeById(systemDark ? choice.darkPreset || 'dark' : choice.lightPreset || 'light');
  return themeById(choice.preset);
}

const FONT_STACKS: Record<FontId | HeadingId, string> = {
  outfit: '"Outfit Variable", "Outfit", "Avenir Next", system-ui, sans-serif',
  nunito: '"Nunito Variable", "Nunito", "Avenir Next", system-ui, sans-serif',
  quicksand: '"Quicksand Variable", "Quicksand", "Avenir Next", system-ui, sans-serif',
  fredoka: '"Fredoka Variable", "Fredoka", "Nunito", system-ui, sans-serif',
  fraunces: '"Fraunces Variable", "Fraunces", "Iowan Old Style", Georgia, serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
export const FONT_OPTIONS: { id: FontId; name: string }[] = [
  { id: 'outfit', name: 'Outfit' }, { id: 'nunito', name: 'Nunito (rounded)' }, { id: 'quicksand', name: 'Quicksand (airy)' }, { id: 'fredoka', name: 'Fredoka (bubbly)' }, { id: 'system', name: 'System' },
];

/** CSS custom properties for a choice. Accent overrides keep AA contrast for text and buttons. */
export function themeVars(choice: ThemeChoice, systemDark: boolean): { preset: ThemePreset; vars: Record<string, string>; scheme: 'dark' | 'light'; decor: boolean } {
  const preset = pickPreset(choice, systemDark);
  const custom = choice.accent && HEX.test(choice.accent) ? choice.accent : null;
  const accent = custom ? ensureContrast(custom, preset.bg, 3) : preset.accent;
  const accentText = custom ? ensureContrast(custom, preset.bg, 4.5) : preset.accentText;
  const font = (choice.font && choice.font in FONT_STACKS ? choice.font : preset.font) as FontId;
  const round = choice.roundness ?? preset.round;
  const light = preset.scheme === 'light';
  const vars: Record<string, string> = {
    '--bg': preset.bg, '--bg-2': preset.bg2, '--bg-3': preset.bg3, '--bg-4': preset.bg4,
    '--bg-rgb': hexToRgb(preset.bg).join(','), '--bg-2-rgb': hexToRgb(preset.bg2).join(','), '--bg-3-rgb': hexToRgb(preset.bg3).join(','),
    '--text': preset.text, '--text-rgb': hexToRgb(preset.text).join(','), '--muted': preset.muted, '--faint': preset.faint,
    '--line': `rgba(${hexToRgb(preset.text).join(',')}, ${light ? 0.11 : 0.08})`,
    '--line-strong': `rgba(${hexToRgb(preset.text).join(',')}, ${light ? 0.2 : 0.16})`,
    '--brass': accent, '--brass-rgb': hexToRgb(accent).join(','), '--brass-2': accentText, '--ink': onColor(accent),
    '--moss': preset.moss, '--moss-rgb': hexToRgb(preset.moss).join(','), '--coral': preset.coral, '--coral-rgb': hexToRgb(preset.coral).join(','),
    '--sky': preset.sky, '--sky-rgb': hexToRgb(preset.sky).join(','), '--code-bg': preset.codeBg,
    '--shadow': light ? '0 18px 50px rgba(60, 40, 60, 0.12)' : '0 24px 80px rgba(0, 0, 0, 0.45)',
    '--glow-1': preset.glow[0], '--glow-2': preset.glow[1],
    '--sans': FONT_STACKS[font], '--serif': FONT_STACKS[preset.heading],
    '--round': String(Math.max(0, Math.min(2, round))),
    '--fs': String(Math.max(0.85, Math.min(1.3, choice.fontScale ?? 1))),
    '--emoji': JSON.stringify(preset.emoji),
  };
  return { preset, vars, scheme: preset.scheme, decor: choice.decor ?? preset.cute };
}
