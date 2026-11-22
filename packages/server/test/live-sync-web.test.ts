/** The web chat's live-sync rules (packages/web/src/lib/live-sync.ts). */
import { describe, expect, it } from 'vitest';
import { backoffMs, chatLiveAction, mergeSnapshot, snapshotDiffers } from '../../web/src/lib/live-sync';

const ctx = { sessionId: 'ses_a', runId: 'run_1' };
const m = (id: string, role = 'assistant', content = id) => ({ id, role, content });

describe('web chat live sync', () => {
  it('adopts a run started elsewhere in the open chat, ignores other chats and its own run', () => {
    expect(chatLiveAction({ type: 'status', runId: 'run_2', status: 'running', sessionId: 'ses_a' }, ctx)).toEqual({ kind: 'adopt-run', runId: 'run_2', status: 'running' });
    expect(chatLiveAction({ type: 'status', runId: 'run_2', status: 'waiting', sessionId: 'ses_a' }, { sessionId: 'ses_a', runId: null })).toMatchObject({ kind: 'adopt-run' });
    expect(chatLiveAction({ type: 'status', runId: 'run_1', status: 'running', sessionId: 'ses_a' }, ctx).kind).toBe('none');
    expect(chatLiveAction({ type: 'status', runId: 'run_9', status: 'running', sessionId: 'ses_b' }, ctx).kind).toBe('none');
    expect(chatLiveAction({ type: 'status', runId: 'run_2', status: 'completed', sessionId: 'ses_a' }, ctx).kind).toBe('none');
  });

  it('shows messages of other runs at once and reloads when another run ends', () => {
    expect(chatLiveAction({ type: 'message', runId: 'run_2', message: m('x'), sessionId: 'ses_a' }, ctx)).toEqual({ kind: 'upsert-message', message: m('x') });
    expect(chatLiveAction({ type: 'message', runId: 'run_1', message: m('x'), sessionId: 'ses_a' }, ctx).kind).toBe('none');
    expect(chatLiveAction({ type: 'done', runId: 'run_2', sessionId: 'ses_a' }, ctx).kind).toBe('reload');
    expect(chatLiveAction({ type: 'token', runId: 'run_2', sessionId: 'ses_a' }, ctx).kind).toBe('none');
  });

  it('merges a reconnect snapshot: keeps older pages and unechoed local sends, takes the server copy of the rest', () => {
    const local = [m('m1', 'user'), m('m2'), m('m3', 'user', 'c'), m('local-1', 'user', 'still sending'), m('local-2', 'user', 'd')];
    const server = [m('m2'), m('m3', 'user', 'c'), m('m4'), m('m5', 'user', 'd')];
    expect(mergeSnapshot(local, server).map((row) => row.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'local-1']);
    // A gap (more missed than one page): the server page replaces the screen.
    expect(mergeSnapshot([m('old')], [m('n1'), m('n2')]).map((row) => row.id)).toEqual(['n1', 'n2']);
    expect(snapshotDiffers(local, server)).toBe(true);
    expect(snapshotDiffers(server, server)).toBe(false);
  });

  it('backs off 1s, 2s, 4s, 8s, then 15s', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});
