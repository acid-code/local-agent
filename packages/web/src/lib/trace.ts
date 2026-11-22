/** Plain-language trace rows for a run's steps (web Runs page; Android mirrors it). Pure, unit-tested. */
export interface TraceStep { id: string; index?: number; kind: string; name: string; status: string; input?: unknown; output?: unknown; latencyMs?: number | null; tokensIn?: number; tokensOut?: number; error?: string | null }

/** 402 ms, 8.5 s, 6m 24s, 1h 3m. */
export function humanDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
function args(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') { const a = (input as { arguments?: unknown }).arguments ?? input; if (typeof a === 'string') { try { return JSON.parse(a) as Record<string, unknown>; } catch { return {}; } } return a as Record<string, unknown>; }
  return {};
}

/** "Thinking · Inkling 2 Mini", "Ran shell command" + "npm test", "Read file" + "Chat.tsx". */
export function traceLabel(step: TraceStep): { label: string; detail: string } {
  if (step.kind === 'model') return { label: `Thinking · ${step.name}`, detail: '' };
  if (step.kind === 'route' || step.name === 'route') return { label: 'Picked a model', detail: step.name === 'route' ? '' : step.name };
  const a = args(step.input);
  const clip = (text: string, n = 70) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  const file = str(a.path) || str(a.file);
  switch (step.name) {
    case 'shell': case 'run_command': return { label: 'Ran shell command', detail: clip(str(a.command).split('\n')[0] ?? '') };
    case 'read_file': return { label: 'Read file', detail: file.split('/').pop() ?? '' };
    case 'write_file': case 'edit_file': case 'apply_patch': return { label: 'Edited file', detail: file.split('/').pop() ?? '' };
    case 'web_search': return { label: 'Searched the web', detail: clip(str(a.query)) };
    case 'web_fetch': return { label: 'Opened a page', detail: clip(str(a.url).replace(/^https?:\/\//, '')) };
    default: return { label: step.kind === 'tool' ? `Used ${step.name.replace(/_/g, ' ')}` : `${step.kind} ${step.name}`.trim(), detail: clip(file || str(a.query) || '') };
  }
}

/** Summary header: total time, steps, failures, tokens. */
export function traceSummary(steps: TraceStep[]) {
  return {
    totalMs: steps.reduce((sum, s) => sum + (s.latencyMs ?? 0), 0),
    steps: steps.length,
    failures: steps.filter((s) => s.status === 'failed' || Boolean(s.error)).length,
    tokensIn: steps.reduce((sum, s) => sum + (s.tokensIn ?? 0), 0),
    tokensOut: steps.reduce((sum, s) => sum + (s.tokensOut ?? 0), 0),
  };
}

/** Each model step with the tool calls that follow it, so a trace reads as think → do, think → do. */
export function pairSteps<T extends TraceStep>(steps: T[]): { model: T | null; tools: T[] }[] {
  const out: { model: T | null; tools: T[] }[] = [];
  for (const step of steps) {
    if (step.kind === 'model' || !out.length) out.push({ model: step.kind === 'model' ? step : null, tools: step.kind === 'model' ? [] : [step] });
    else out[out.length - 1]!.tools.push(step);
  }
  return out;
}
