/** Copilot-style work groups in the chat: grouping, verbs, durations and diff counts. */
import { describe, expect, it } from 'vitest';
import { describeStep, diffStats, formatDuration, groupWork, type WorkMessage } from '../../web/src/lib/work-steps';

const at = (s: number) => new Date(Date.UTC(2026, 10, 22, 12, 0, s)).toISOString();

describe('work steps', () => {
  const messages: WorkMessage[] = [
    { id: 'u1', role: 'user', content: 'fix the bug', createdAt: at(0) },
    { id: 'a1', role: 'assistant', content: 'Let me look at the file first.', thinking: 'The bug is probably in Chat.tsx', createdAt: at(1), runId: 'r1', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"packages/web/src/pages/Chat.tsx"}' }] },
    { id: 't1', role: 'tool', content: 'export function Chat() {}', toolCallId: 'c1', toolName: 'read_file', createdAt: at(3), runId: 'r1' },
    { id: 'a2', role: 'assistant', content: '', createdAt: at(4), runId: 'r1', toolCalls: [{ id: 'c2', name: 'write_file', arguments: '{"path":"src/a.ts","content":"x"}' }, { id: 'c3', name: 'shell', arguments: '{"command":"npm test\\necho done"}' }] },
    { id: 't2', role: 'tool', content: 'ok', toolCallId: 'c2', toolName: 'write_file', createdAt: at(5), runId: 'r1' },
    { id: 't3', role: 'tool', content: 'Error: 1 failed', toolCallId: 'c3', toolName: 'shell', createdAt: at(65), runId: 'r1' },
    { id: 'a3', role: 'assistant', content: 'Fixed it.', createdAt: at(70), runId: 'r1' },
  ];

  it('groups tool work between the user message and the final answer', () => {
    const items = groupWork(messages);
    expect(items.map((item) => item.kind)).toEqual(['message', 'work', 'message']);
    const group = items[1] as Extract<(typeof items)[number], { kind: 'work' }>;
    expect(group.stepCount).toBe(3);
    expect(group.rows.map((row) => row.type)).toEqual(['thought', 'narration', 'step', 'step', 'step']);
    expect(group.durationMs).toBe(64_000);
    expect(group.runIds).toEqual(['r1']);
    const steps = group.rows.filter((row) => row.type === 'step');
    expect(steps.map((s) => s.type === 'step' && `${s.verb}|${s.target}|${s.files.join(',')}|${s.durationMs}|${s.failed}`)).toEqual([
      'Read|Chat.tsx|packages/web/src/pages/Chat.tsx|2000|false',
      'Edited|a.ts|src/a.ts|1000|false',
      'Ran|npm test||61000|true',
    ]);
  });

  it('marks a call without a result as pending', () => {
    const group = groupWork([{ id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'web_search', arguments: '{"query":"local llm news"}' }] }])[0];
    expect(group.kind === 'work' && group.rows[0]).toMatchObject({ type: 'step', verb: 'Searched the web for', target: 'local llm news', pending: true });
  });

  it('describes unknown tools and formats durations and diffs', () => {
    expect(describeStep('github_create_issue', { action: 'create' })).toMatchObject({ icon: 'tool', verb: 'Used github create issue', target: 'create' });
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(null)).toBe('');
    expect(diffStats(['--- a/x\n+++ b/x\n@@\n-old\n+new\n+more\n context'])).toEqual({ added: 2, removed: 1 });
  });
});
