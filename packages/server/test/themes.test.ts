import { describe, expect, it } from 'vitest';
import { THEMES, contrast, onColor, themeVars } from '@local-agent/shared';

describe('themes', () => {
  it('ships light, dark and cute presets', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(expect.arrayContaining(['dark', 'light', 'sakura', 'lilac', 'matcha', 'peach', 'cloud']));
    expect(THEMES.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps WCAG AA contrast in every preset', () => {
    for (const theme of THEMES) {
      for (const surface of [theme.bg, theme.bg2, theme.bg3]) {
        for (const [name, color] of Object.entries({ text: theme.text, muted: theme.muted, faint: theme.faint, accentText: theme.accentText, coral: theme.coral, moss: theme.moss, sky: theme.sky })) {
          expect(contrast(color, surface), `${theme.id} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(onColor(theme.accent), theme.accent), `${theme.id} button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.accent, theme.bg), `${theme.id} accent ui`).toBeGreaterThanOrEqual(3);
    }
  });

  it('fixes a custom accent that would be unreadable', () => {
    const { vars } = themeVars({ preset: 'sakura', accent: '#ffd1e0' }, false);
    expect(contrast(vars['--brass-2']!, '#fff5f8')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars['--ink']!, vars['--brass']!)).toBeGreaterThanOrEqual(3);
  });

  it('follows the system scheme when asked', () => {
    expect(themeVars({ followSystem: true, lightPreset: 'matcha', darkPreset: 'night-bloom' }, true).preset.id).toBe('night-bloom');
    expect(themeVars({ followSystem: true, lightPreset: 'matcha', darkPreset: 'night-bloom' }, false).preset.id).toBe('matcha');
    expect(themeVars({ preset: 'nope' }, false).preset.id).toBe('dark');
  });
});
