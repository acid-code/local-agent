import { describe, expect, it } from 'vitest';
import { clockDelay, keepIdentity } from '../../web/src/lib/anim-clock';
import { groupWork, sameGroup } from '../../web/src/lib/work-steps';

describe('clockDelay', () => {
  it('puts every mount on the same wall-clock beat', () => {
    expect(clockDelay(1400, 0)).toBe('0ms');
    expect(clockDelay(1400, 1400 * 5 + 300)).toBe('-300ms');
    expect(clockDelay(1200, 1200 * 9 + 100, 150)).toBe('50ms');
    // Two mounts 2.1 periods apart land on the same phase.
    const a = Number.parseInt(clockDelay(1400, 10_000), 10);
    const b = Number.parseInt(clockDelay(1400, 10_000 + 1400 * 3), 10);
    expect(a).toBe(b);
  });
});

describe('keepIdentity', () => {
  const m = (id: string, content: string) => ({ id, role: 'assistant', content, toolCalls: [{ id: 'c', name: 'read_file' }] });
  it('returns the same array when a snapshot changes nothing', () => {
    const prev = [m('1', 'a'), m('2', 'b')];
    expect(keepIdentity(prev, [m('1', 'a'), m('2', 'b')])).toBe(prev);
  });
  it('keeps unchanged objects and takes changed or new ones', () => {
    const prev = [m('1', 'a'), m('2', 'b')];
    const next = keepIdentity(prev, [m('1', 'a'), m('2', 'B'), m('3', 'c')]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next.map((x) => x.content)).toEqual(['a', 'B', 'c']);
  });
});

describe('sameGroup', () => {
  const call = { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"x.ts"}' }] };
  it('treats a regrouped but unchanged transcript as the same, and a finished step as changed', () => {
    const [g1] = groupWork([call]);
    const [g2] = groupWork([{ ...call }]);
    expect(g1 !== g2 && sameGroup(g1 as never, g2 as never)).toBe(true);
    const [g3] = groupWork([call, { id: 't1', role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'read_file' }]);
    expect(sameGroup(g1 as never, g3 as never)).toBe(false);
  });
});
