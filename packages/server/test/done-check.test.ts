import { describe, expect, it } from 'vitest';
import { doneCheck, promiseOnly, unverifiedEdits } from '../src/recovery.js';
import type { StepRow } from '../src/db.js';

const step = (index: number, name: string, input: unknown, kind = 'tool', status = 'completed', output: unknown = 'ok') => ({ index, name, input, kind, status, output, error: null }) as unknown as StepRow;

describe('done check', () => {
  it('spots replies that only announce the next step', () => {
    expect(promiseOnly("I found the bug in auth.ts. I'll now run the tests.")).toBe(true);
    expect(promiseOnly('Let me check the logs first.')).toBe(true);
    expect(promiseOnly('Okay, next I will update the config:')).toBe(true);
    expect(promiseOnly('Next, I will update the config:')).toBe(true);
    expect(promiseOnly('עכשיו אריץ את הבדיקות.')).toBe(true);
    expect(promiseOnly('Done. All 40 tests pass. Let me know if you need anything else.')).toBe(false);
    expect(promiseOnly('Should I run the tests now?')).toBe(false);
    expect(promiseOnly('The capital of France is Paris.')).toBe(false);
  });

  it('lists code files edited after the last shell command', () => {
    const steps = [step(1, 'write_file', { path: 'src/a.ts' }), step(2, 'shell', { command: 'npm test' }), step(3, 'apply_patch', { patch: '--- a/src/b.ts\n+++ b/src/b.ts' }), step(4, 'write_file', { path: 'README.md' })];
    expect(unverifiedEdits(steps)).toEqual(['src/b.ts']);
    expect(unverifiedEdits([...steps, step(5, 'shell', { command: 'npx tsc' })])).toEqual([]);
    expect(unverifiedEdits([step(1, 'write_file', { path: 'src/a.ts' }, 'tool', 'failed')])).toEqual([]);
  });

  it('sends back promise-only endings and unverified edits once each', () => {
    const edits = [step(1, 'write_file', { path: 'src/a.ts' })];
    expect(doneCheck(edits, 'Fixed the bug.', 0, 5, ['shell']).action).toBe('retry');
    expect(doneCheck(edits, 'Fixed the bug.', 0, 5, []).action).toBe('ok');
    const asked = [...edits, step(2, 'verify', {}, 'contract', 'completed', 'Sent back: Unverified code edits (src/a.ts)')];
    expect(doneCheck(asked, 'Fixed the bug.', 1, 5, ['shell']).action).toBe('ok');
    expect(doneCheck([], "I'll run the build now.", 0, 5).action).toBe('retry');
    expect(doneCheck([], "I'll run the build now.", 0, 1).action).toBe('ok');
    expect(doneCheck([], "I'll run the build now.", 2, 5).action).toBe('ok');
  });
});
