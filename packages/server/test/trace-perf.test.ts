import { describe, expect, it } from 'vitest';
import { isRetriedStep, stepPerf, type TraceStep } from '../../web/src/lib/trace.js';

describe('trace perf & retry helpers', () => {
  it('extracts cacheHitPct and tokPerSec from telemetry or perf', () => {
    const s1: TraceStep = { id: '1', kind: 'model', name: 'Qwen', status: 'completed', output: { telemetry: { tokPerSec: 36.84, cacheHitPct: 91.6 } } };
    expect(stepPerf(s1)).toEqual({ tokPerSec: 36.8, cacheHitPct: 92 });
    const s2: TraceStep = { id: '2', kind: 'model', name: 'Qwen', status: 'completed', perf: { tokPerSec: 25, cacheHitPct: 50 } };
    expect(stepPerf(s2)).toEqual({ tokPerSec: 25, cacheHitPct: 50 });
    const s3: TraceStep = { id: '3', kind: 'tool', name: 'shell', status: 'completed' };
    expect(stepPerf(s3)).toEqual({});
  });

  it('marks a failed step as retried when a later step of the same kind/tool follows', () => {
    const steps: TraceStep[] = [
      { id: 'm1', kind: 'model', name: 'Qwen', status: 'failed', error: 'timeout' },
      { id: 'm2', kind: 'model', name: 'Qwen', status: 'completed' },
      { id: 't1', kind: 'tool', name: 'shell', status: 'failed', error: 'exit 1' },
      { id: 't2', kind: 'tool', name: 'shell', status: 'completed' },
      { id: 't3', kind: 'tool', name: 'read_file', status: 'failed', error: 'ENOENT' },
    ];
    expect(isRetriedStep(steps, steps[0]!)).toBe(true);
    expect(isRetriedStep(steps, steps[1]!)).toBe(false);
    expect(isRetriedStep(steps, steps[2]!)).toBe(true);
    expect(isRetriedStep(steps, steps[4]!)).toBe(false);
  });
});
