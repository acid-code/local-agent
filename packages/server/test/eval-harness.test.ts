import path from 'node:path';
import { describe, expect, it } from 'vitest';

const harness = path.resolve(__dirname, '../../../scripts/eval/run.mjs');

describe('eval harness', () => {
  it('loads every fixture and scores a run', async () => {
    const { loadTasks, score } = await import(harness);
    const tasks = loadTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    const task = tasks.find((item: { id: string }) => item.id === 'read-range');
    const run = { status: 'completed', startedAt: '2026-11-22T10:00:00Z', endedAt: '2026-11-22T10:00:30Z', inputTokens: 100, outputTokens: 20 };
    const steps = [
      { kind: 'model', output: { telemetry: { promptTokens: 1000, cachedTokens: 0 } } },
      { kind: 'tool', name: 'read_file', input: { path: 'package.json', startLine: 1, endLine: 5 } },
      { kind: 'model', output: { telemetry: { promptTokens: 1200, cachedTokens: 1000 } } },
    ];
    const good = score(task, run, steps, 'Lines 1-5: {"name": "x"}');
    expect(good.passed).toBe(true);
    expect(good.cacheHitPct).toBe(45);
    const bad = score(task, run, [steps[0], { kind: 'tool', name: 'read_file', input: { path: 'package.json' } }], 'no idea');
    expect(bad.passed).toBe(false);
    expect(bad.checks.filter((item: { ok: boolean }) => !item.ok).map((item: { name: string }) => item.name)).toEqual(['read_file args startLine', 'reply ~ /\\{/']);
  });
});
