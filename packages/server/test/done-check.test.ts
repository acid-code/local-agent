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

describe('acceptance checks from the plan', () => {
  it('needs a passing run of each named command after the last edit', async () => {
    const { unmetChecks, checkCommands } = await import('../src/recovery.js');
    expect(checkCommands('`npm test` and `npm run typecheck` pass')).toEqual(['npm test', 'npm run typecheck']);
    const checks = ['`npm test` passes', 'README mentions the flag'];
    const base = [step(1, 'plan', { items: ['x'], checks }), step(2, 'write_file', { path: 'src/a.ts' })];
    expect(unmetChecks(base, checks, true)).toEqual(['`npm test` passes']);
    expect(unmetChecks([...base, step(3, 'shell', { command: 'npm test' }, 'tool', 'completed', 'exit 1\nfail')], checks, true)).toEqual(['`npm test` passes']);
    expect(unmetChecks([...base, step(3, 'shell', { command: 'cd api && npm test' }, 'tool', 'completed', 'exit 0\nok')], checks, true)).toEqual([]);
    // A later edit needs a fresh run.
    expect(unmetChecks([...base, step(3, 'shell', { command: 'npm test' }), step(4, 'apply_patch', { patch: 'src/b.ts' })], checks, true)).toEqual(['`npm test` passes']);
    // Without shell nothing can be run, so command checks do not block.
    expect(unmetChecks(base, ['`npm test` passes'], false)).toEqual([]);
    expect(unmetChecks([step(1, 'plan', { items: ['x'], checks })], ['README mentions the flag'], true)).toEqual(['README mentions the flag']);
  });

  it('the done check sends back unverified acceptance checks once', () => {
    const steps = [step(1, 'plan', { items: ['x'], checks: ['`npm test` passes'] }), step(2, 'shell', { command: 'ls' })];
    const first = doneCheck(steps, 'All done.', 0, 5, ['shell'], ['`npm test` passes']);
    expect(first).toMatchObject({ action: 'retry' });
    expect((first as { note: string }).note).toMatch(/ACCEPTANCE CHECKS/);
    const asked = [...steps, step(3, 'verify', {}, 'contract', 'completed', 'Sent back: Acceptance checks not verified (1)')];
    expect(doneCheck(asked, 'All done.', 1, 5, ['shell'], ['`npm test` passes']).action).toBe('ok');
  });
});
