import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the fix for flickering live dots: live indicators never blink (no opacity keyframes on them), and the
// typing dots only move (transform), so tiny dots cannot strobe under GPU raster at fractional Windows scaling.
const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
const rule = (selector: string) => css.split('\n').filter((line) => line.startsWith(`${selector} {`)).join('\n');

describe('live indicator styles', () => {
  it('keeps live dots static', () => {
    for (const sel of ['.work-live-dot', '.head-live', '.work-step.pending .work-icon']) {
      expect(rule(sel), sel).not.toBe('');
      expect(rule(sel), sel).not.toMatch(/animation/);
    }
  });
  it('animates the typing dots with transform only', () => {
    expect(rule('.typing span')).toMatch(/animation: typing-wave/);
    const frames = /@keyframes typing-wave \{([^\n]*)\}/.exec(css)?.[1] ?? '';
    expect(frames).toMatch(/transform/);
    expect(frames).not.toMatch(/opacity|scale/);
  });
  it('turns the typing dots off for reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]{0,200}\.typing span/);
  });
});
