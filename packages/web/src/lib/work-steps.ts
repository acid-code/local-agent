/**
 * Turns the raw chat transcript (assistant tool calls, tool results, reasoning) into Copilot-style work groups:
 * one collapsible "Completed N steps in Xm Ys" block per stretch of agent work, with narration between steps.
 * Pure: no React, no DOM, so it is unit-tested from the server test suite.
 */
export interface WorkMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  toolCallId?: string | null;
  toolName?: string | null;
  thinking?: string | null;
  runId?: string | null;
  toolCalls?: { id?: string; name: string; arguments?: string }[] | null;
}

export type StepIcon = 'edit' | 'read' | 'think' | 'command' | 'search' | 'web' | 'memory' | 'agent' | 'container' | 'tool';

export interface WorkStep {
  type: 'step';
  id: string;
  icon: StepIcon;
  verb: string;
  target: string;
  files: string[];
  durationMs: number | null;
  args: Record<string, unknown> | null;
  output: string;
  failed: boolean;
  pending: boolean;
}
export interface WorkThought { type: 'thought'; id: string; text: string }
export interface WorkNarration { type: 'narration'; id: string; text: string }
export type WorkRow = WorkStep | WorkThought | WorkNarration;

export interface WorkGroup {
  kind: 'work';
  id: string;
  rows: WorkRow[];
  stepCount: number;
  durationMs: number | null;
  runIds: string[];
}
export type RenderItem<M> = { kind: 'message'; message: M } | WorkGroup;

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value as Record<string, unknown> : null; } catch { return null; }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const clip = (text: string, n = 90) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Verb, target and icon for one tool call, e.g. "Edited" + "Chat.tsx", "Ran" + "npm test". */
export function describeStep(name: string, args: Record<string, unknown> | null): { icon: StepIcon; verb: string; target: string; files: string[] } {
  const a = args ?? {};
  const path = str(a.path) || str(a.file) || str(a.filePath);
  switch (name) {
    case 'write_file': case 'create_file': case 'edit_file': case 'apply_patch': case 'str_replace':
      return { icon: 'edit', verb: name === 'create_file' ? 'Created' : 'Edited', target: path ? base(path) : '', files: path ? [path] : [] };
    case 'read_file':
      return { icon: 'read', verb: 'Read', target: path ? base(path) : '', files: path ? [path] : [] };
    case 'list_dir':
      return { icon: 'read', verb: 'Listed', target: path || '.', files: [] };
    case 'shell': case 'run_command': case 'terminal':
      return { icon: 'command', verb: 'Ran', target: clip(str(a.command).split('\n')[0] || ''), files: [] };
    case 'web_search':
      return { icon: 'search', verb: 'Searched the web for', target: clip(str(a.query)), files: [] };
    case 'kb_search': case 'search_chats': case 'recall':
      return { icon: 'search', verb: 'Searched', target: clip(str(a.query) || str(a.q)), files: [] };
    case 'web_fetch':
      return { icon: 'web', verb: 'Fetched', target: clip(str(a.url).replace(/^https?:\/\//, '')), files: [] };
    case 'remember': case 'memory_file':
      return { icon: 'memory', verb: 'Saved to memory', target: clip(str(a.content) || str(a.text), 60), files: [] };
    case 'consult_agent':
      return { icon: 'agent', verb: 'Asked', target: str(a.agent) || str(a.name) || 'a helper', files: [] };
    case 'docker_ps': case 'docker_inspect': case 'docker_run': case 'docker_rm':
      return { icon: 'container', verb: name === 'docker_run' ? 'Started container' : name === 'docker_rm' ? 'Removed container' : 'Checked containers', target: str(a.image) || str(a.name) || str(a.id), files: [] };
    default:
      return { icon: 'tool', verb: `Used ${name.replace(/_/g, ' ')}`, target: path ? base(path) : clip(str(a.action) || str(a.query) || ''), files: path ? [path] : [] };
  }
}

const isWorkMessage = (m: WorkMessage) => m.role === 'tool' || (m.role === 'assistant' && Boolean(m.toolCalls?.length));
const time = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

/** Group consecutive tool calls, tool results and their narration into work blocks; everything else stays a message. */
export function groupWork<M extends WorkMessage>(messages: M[]): RenderItem<M>[] {
  const out: RenderItem<M>[] = [];
  let current: { msgs: M[] } | null = null;
  const flush = () => {
    if (!current) return;
    out.push(buildGroup(current.msgs));
    current = null;
  };
  for (const message of messages) {
    if (isWorkMessage(message)) {
      if (!current) current = { msgs: [] };
      current.msgs.push(message);
    } else {
      flush();
      out.push({ kind: 'message', message });
    }
  }
  flush();
  return out;
}

function buildGroup(msgs: WorkMessage[]): WorkGroup {
  const rows: WorkRow[] = [];
  const results = new Map<string, WorkMessage>();
  for (const m of msgs) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m);
  const used = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.thinking?.trim()) rows.push({ type: 'thought', id: `${m.id}:think`, text: m.thinking.trim() });
      if (m.content.trim()) rows.push({ type: 'narration', id: `${m.id}:say`, text: m.content.trim() });
      for (const [i, call] of (m.toolCalls ?? []).entries()) {
        const args = parseArgs(call.arguments);
        const result = call.id ? results.get(call.id) : undefined;
        if (result) used.add(result.id);
        const d = describeStep(call.name, args);
        const start = time(m.createdAt);
        const end = time(result?.createdAt);
        const output = result?.content ?? '';
        rows.push({
          type: 'step', id: `${m.id}:${call.id ?? i}`, ...d, args,
          durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
          output, pending: !result, failed: /^(error|denied|blocked|failed)\b/i.test(output.trim()),
        });
      }
    } else if (m.role === 'tool' && !used.has(m.id)) {
      // A result whose call was on an earlier page: still show it as a step.
      const d = describeStep(m.toolName || 'tool', null);
      rows.push({ type: 'step', id: m.id, ...d, args: null, durationMs: null, output: m.content, pending: false, failed: /^(error|denied|blocked|failed)\b/i.test(m.content.trim()) });
    }
  }
  const first = time(msgs[0]?.createdAt);
  const last = time(msgs[msgs.length - 1]?.createdAt);
  return {
    kind: 'work',
    id: `work-${msgs[0]?.id ?? 'x'}`,
    rows,
    stepCount: rows.filter((r) => r.type === 'step').length,
    durationMs: Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null,
    runIds: [...new Set(msgs.map((m) => m.runId).filter((id): id is string => Boolean(id)))],
  };
}

/** "45s", "2m 05s", "1h 3m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 1) return `${Math.max(1, Math.round(ms))}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Lines added and removed in unified diffs (headers excluded). */
export function diffStats(diffs: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/** True when a row would render the same (lets React skip unchanged rows while the stream ticks). */
export function sameRow(a: WorkRow, b: WorkRow): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.id !== b.id) return false;
  if (a.type !== 'step' || b.type !== 'step') return (a as WorkThought).text === (b as WorkThought).text;
  return a.pending === b.pending && a.failed === b.failed && a.output === b.output && a.durationMs === b.durationMs
    && a.verb === b.verb && a.target === b.target && a.icon === b.icon && a.files.join('\n') === b.files.join('\n')
    && JSON.stringify(a.args) === JSON.stringify(b.args);
}

/** True when a work group would render the same: same rows, counts and timing. */
export function sameGroup(a: WorkGroup, b: WorkGroup): boolean {
  if (a === b) return true;
  return a.id === b.id && a.stepCount === b.stepCount && a.durationMs === b.durationMs && a.rows.length === b.rows.length
    && a.rows.every((row, i) => sameRow(row, b.rows[i]!));
}
