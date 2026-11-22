/** The wait card: the large-model queue and the RAM wait are different things with different buttons. */
import { describe, expect, it } from 'vitest';
import { waitStateOf, waitedFor } from '@local-agent/shared';

describe('wait state', () => {
  it('reads the queue from waitInfo and never offers Force run', () => {
    const s = waitStateOf('Waiting for qwen to finish (queued).', { kind: 'queue', behind: 'qwen', ahead: 1, since: '2026-11-22T13:00:00.000Z' });
    expect(s).toMatchObject({ kind: 'queue', title: 'Queued behind qwen', canForce: false, ahead: 1 });
    expect(waitedFor(s.since, Date.parse('2026-11-22T13:01:05.000Z'))).toBe('1m 05s');
  });
  it('falls back to the detail text (older servers, llama-server lease text)', () => {
    const s = waitStateOf('Waiting for the uncensored llama-server model to finish in another chat (queued).', null);
    expect(s).toMatchObject({ kind: 'queue', behind: 'uncensored llama-server model', canForce: false });
    expect(waitStateOf('Waiting for qwen3 to finish (queued, 3 ahead).').ahead).toBe(3);
  });
  it('keeps "Waiting for memory" (with Force run) only for the RAM wait', () => {
    const s = waitStateOf('Waiting for memory, 1 ahead', { ahead: 1, neededBytes: 9, availableBytes: 1, usedBytes: 1, budgetBytes: 9, reason: 'x' });
    expect(s).toMatchObject({ kind: 'memory', title: 'Waiting for memory', canForce: true });
    expect(waitStateOf('').kind).toBe('memory');
  });
});
