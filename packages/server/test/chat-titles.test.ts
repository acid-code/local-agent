import { describe, expect, it } from 'vitest';
import { cleanText, fallbackTitle, needsTitle, parseTitle, previewOf } from '../src/chat-titles';
import { shellTimeoutMs } from '../src/tools';
import { humanDuration, pairSteps, traceLabel, traceSummary } from '../../web/src/lib/trace';

describe('chat titles and previews', () => {
  it('strips action markers and markdown from previews', () => {
    expect(cleanText('[action: search vercel docs] **Found** it')).toBe('Found it');
    expect(cleanText('Hi\n\n<!--la:context-->\nsecret context')).toBe('Hi');
  });
  it('skips our own notices and uses the latest clean text', () => {
    const p = previewOf([{ role: 'user', content: 'im working on the site' }, { role: 'assistant', content: '⚠️ This reply stopped before finishing' }]);
    expect(p).toEqual({ role: 'user', text: 'im working on the site' });
  });
  it('parses model titles (Hebrew kept) and rejects junk', () => {
    expect(parseTitle('Title: "Connect Vercel deployment."')).toBe('Connect Vercel deployment');
    expect(parseTitle('חיבור לחשבון ורסל')).toBe('חיבור לחשבון ורסל');
    expect(parseTitle('')).toBeNull();
    expect(parseTitle('one two three four five six seven eight nine ten eleven')).toBeNull();
  });
  it('falls back to the first words and never replaces a user title', () => {
    expect(fallbackTitle('you you connect to my vercel for the deploy please now')).toBe('you you connect to my vercel');
    expect(needsTitle('user')).toBe(false);
    expect(needsTitle('auto')).toBe(false);
    expect(needsTitle('fallback')).toBe(true);
    expect(needsTitle('')).toBe(true);
  });
});

describe('trace', () => {
  it('formats durations for people', () => {
    expect(humanDuration(402)).toBe('402 ms');
    expect(humanDuration(8500)).toBe('8.5 s');
    expect(humanDuration(384_319)).toBe('6m 24s');
  });
  it('labels and pairs steps', () => {
    const steps = [
      { id: '1', kind: 'model', name: 'Inkling 2 Mini', status: 'completed', latencyMs: 1000 },
      { id: '2', kind: 'tool', name: 'shell', status: 'failed', input: { command: 'npm install\nmore' }, latencyMs: 30301, error: 'Container timed out.' },
      { id: '3', kind: 'model', name: 'Inkling 2 Mini', status: 'completed', latencyMs: 500 },
    ];
    expect(traceLabel(steps[0]!).label).toBe('Thinking · Inkling 2 Mini');
    expect(traceLabel(steps[1]!)).toEqual({ label: 'Ran shell command', detail: 'npm install' });
    expect(pairSteps(steps).map((p) => p.tools.length)).toEqual([1, 0]);
    expect(traceSummary(steps)).toMatchObject({ steps: 3, failures: 1, totalMs: 31801 });
  });
  it('gives shell commands minutes, not 30 seconds', () => {
    expect(shellTimeoutMs({})).toBe(300_000);
    expect(shellTimeoutMs({ LA_SHELL_TIMEOUT_MS: '900000' })).toBe(900_000);
    expect(shellTimeoutMs({ LA_SHELL_TIMEOUT_MS: '10' })).toBe(300_000);
  });
});
