import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, ChevronRight, Copy, Cpu, FileCode2, FolderGit2, GitBranch, RotateCcw, Sparkles, Square, Terminal, Wrench, X } from 'lucide-react';
import type { ContextBreakdown } from '@local-agent/shared';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { t } from '../i18n';

export interface HelperStepNote {
  tool: string;
  summary: string;
  status: 'running' | 'completed' | 'failed';
  at: string;
}

export interface MiniAgentRow {
  id: string;
  childRunId?: string | null;
  agentName: string;
  role?: string;
  modelName?: string | null;
  task: string;
  status: string;
  result?: string | null;
  error?: string | null;
  createdAt?: string;
  endedAt?: string | null;
  worktreePath?: string | null;
  currentStep?: string | null;
  stepCount?: number;
  recentSteps?: HelperStepNote[];
}

export interface TraceStep {
  id: string;
  kind: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface DiffEdit {
  id: string;
  runId: string | null;
  label: string;
  diff: string;
  revertedAt: string | null;
  keptAt: string | null;
  keptFiles: string[];
  revertedFiles: string[];
}

export interface MentionItem {
  kind: 'file' | 'git' | 'repo';
  label: string;
  insert: string;
  detail: string;
}

function fmtElapsed(createdAt?: string, endedAt?: string | null, nowMs = Date.now()): string {
  if (!createdAt) return '';
  const start = new Date(createdAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : nowMs;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Visible Mini-Agent Activity Strip right above the composer. */
export function MiniAgentStrip({
  helpers,
  onStop,
}: {
  helpers: MiniAgentRow[];
  onStop: (id: string) => Promise<void> | void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);
  const running = helpers.filter((h) => h.status === 'running' || h.status === 'queued' || h.status === 'waiting');
  const recent = helpers.filter((h) => h.status === 'done' || h.status === 'failed').slice(0, 2);
  const shown = [...running, ...recent];

  useEffect(() => {
    if (!running.length) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running.length]);

  if (!shown.length) return null;

  return (
    <div className="mini-strip" aria-label={t('Mini-agents')}>
      <div className="mini-strip-head">
        <span className="row" style={{ gap: 6 }}>
          <Bot size={14} aria-hidden />
          <strong>{running.length ? t('{0} mini-agent(s) running', [running.length]) : t('Recent mini-agents')}</strong>
        </span>
      </div>
      <div className="mini-strip-list">
        {shown.map((h) => {
          const isLive = h.status === 'running' || h.status === 'queued' || h.status === 'waiting';
          const open = expanded === h.id;
          return (
            <div key={h.id} className={`mini-card ${h.status}`}>
              <div className="mini-card-row">
                <button type="button" className="mini-card-toggle" onClick={() => setExpanded(open ? null : h.id)}>
                  <span className={`mini-dot ${isLive ? 'live' : h.status}`} aria-hidden />
                  <span className="mini-name">{h.agentName}</span>
                  {h.role && h.role !== 'general' && (
                    <span className={`mini-role role-${h.role}`}>
                      {h.role === 'research' ? t('research') : h.role === 'verify' ? t('verify') : t('coder')}
                    </span>
                  )}
                  {h.modelName && <span className="mini-model">{h.modelName}</span>}
                  <span className="mini-task ellipsis" dir="auto">
                    {isLive && h.currentStep ? `${h.stepCount ? `#${h.stepCount} ` : ''}${h.currentStep}` : h.task}
                  </span>
                  <span className="mini-time mono faint">{fmtElapsed(h.createdAt, h.endedAt, nowMs)}</span>
                  {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                </button>
                {isLive && (
                  <button type="button" className="icon-btn mini-stop" title={t('Stop mini-agent')} aria-label={t('Stop mini-agent')} onClick={() => void onStop(h.id)}>
                    <Square size={12} />
                  </button>
                )}
              </div>
              {open && (
                <div className="mini-card-body">
                  {h.currentStep && isLive && (
                    <div className="mini-live-step faint" dir="auto">
                      <span>{t('Now: {0}', [h.currentStep])}</span>
                    </div>
                  )}
                  {h.worktreePath && (
                    <div className="mini-worktree mono faint">
                      <GitBranch size={11} aria-hidden />
                      <span>{t('Worktree')}: {h.worktreePath}</span>
                    </div>
                  )}
                  {Array.isArray(h.recentSteps) && h.recentSteps.length > 0 && (
                    <div className="mini-steps">
                      {h.recentSteps.map((step, idx) => (
                        <div key={`${h.id}-s-${idx}`} className={`mini-step-row ${step.status}`}>
                          <span className={`mini-dot ${step.status === 'running' ? 'live' : step.status === 'completed' ? 'done' : 'failed'}`} aria-hidden />
                          <span className="mini-step-tool mono">{step.tool}</span>
                          <span className="mini-step-sum ellipsis" dir="auto">{step.summary}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {h.result && <pre className="mini-out" dir="auto">{h.result.slice(0, 2000)}</pre>}
                  {h.error && <pre className="mini-out err">{h.error}</pre>}
                  {!h.result && !h.error && !(Array.isArray(h.recentSteps) && h.recentSteps.length) && <span className="faint">{t('Working on workspace…')}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Smart Context Auto-Nudge when Context Ring crosses 80%. */
export function ContextNudgeBanner({
  breakdown,
  dismissed,
  busy,
  onDismiss,
  onCompact,
  onHandoff,
}: {
  breakdown: ContextBreakdown | null;
  dismissed: boolean;
  busy: boolean;
  onDismiss: () => void;
  onCompact: () => Promise<void> | void;
  onHandoff: () => Promise<void> | void;
}) {
  const [working, setWorking] = useState<'compact' | 'handoff' | null>(null);
  if (!breakdown || dismissed) return null;
  const pct = Math.round((breakdown.used / Math.max(1, breakdown.budget)) * 100);
  if (pct < 80) return null;

  return (
    <div className="ctx-nudge" role="status">
      <Sparkles size={15} aria-hidden />
      <span className="grow">{t('Context is at {0}%. Compact or continue in a fresh chat to keep replies fast.', [pct])}</span>
      <button type="button" className="btn ghost small" disabled={busy || Boolean(working)} onClick={async () => { setWorking('compact'); try { await onCompact(); } finally { setWorking(null); } }}>
        {working === 'compact' ? t('Compacting…') : t('Compact chat')}
      </button>
      <button type="button" className="btn primary small" disabled={busy || Boolean(working)} onClick={async () => { setWorking('handoff'); try { await onHandoff(); } finally { setWorking(null); } }}>
        {working === 'handoff' ? t('Handing off…') : t('Continue in new chat')}
      </button>
      <button type="button" className="icon-btn" aria-label={t('Dismiss')} onClick={onDismiss}><X size={14} /></button>
    </div>
  );
}

/** Compact timeline-style file-change card. Changes remain visible; no keep/revert state is needed. */
export function InlineDiffCard({
  edit,
}: {
  edit: DiffEdit;
}) {
  const [open, setOpen] = useState(false);
  const lines = (edit.diff || '').split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div className={`diff-card${edit.revertedAt ? ' reverted' : ''}`}>
      <div className="diff-card-head">
        <button type="button" className="diff-card-title" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <FileCode2 size={14} aria-hidden />
          <strong className="mono ellipsis">{edit.label}</strong>
          <span className="diff-stat add">+{added}</span>
          <span className="diff-stat del">-{removed}</span>
        </button>
        {edit.revertedAt && <span className="badge">{t('Reverted')}</span>}
      </div>
      {open && (
        <pre className="diff-body mono">
          {lines.slice(0, 140).map((line, i) => {
            const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
            return <div key={i} className={`diff-line ${cls}`}>{line || ' '}</div>;
          })}
          {lines.length > 140 && <div className="diff-line hunk">{t('… {0} more lines', [lines.length - 140])}</div>}
        </pre>
      )}
    </div>
  );
}

/** One run-level summary with an expandable list of changed files. */
export function BulkDiffCard({ edits, onChanged }: { edits: DiffEdit[]; onChanged: () => void | Promise<void> }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const groups = new Map<string, DiffEdit[]>();
  for (const edit of edits) {
    const key = edit.runId || `single:${edit.id}`;
    const group = groups.get(key) || [];
    group.push(edit);
    groups.set(key, group);
  }

  return (
    <div className="bulk-diff-list">
      {[...groups.entries()].map(([key, group]) => {
        const files = [...new Set(group.flatMap((edit) => edit.label.split(',').map((label) => label.trim()).filter(Boolean)))];
        const lines = group.flatMap((edit) => (edit.diff || '').split('\n'));
        const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
        const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
        const bulkOpen = openGroup === key;
        const bulkKept = group.every((edit) => Boolean(edit.keptAt));
        const bulkReverted = group.every((edit) => Boolean(edit.revertedAt));
        return (
          <div className="bulk-diff" key={key}>
            <div className="bulk-diff-head">
              <button type="button" className="bulk-diff-toggle" onClick={() => { setOpenGroup((value) => value === key ? null : key); setOpenFile(null); }}>
                {bulkOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                <span className="bulk-diff-title"><strong>{files.length} {files.length === 1 ? t('file') : t('files')} changed</strong></span>
              </button>
              <span className="diff-stat add">+{added}</span>
              <span className="diff-stat del">-{removed}</span>
              <div className="bulk-diff-actions">
                {bulkKept ? (
                  <span className="badge ok"><Check size={12} aria-hidden /> {t('Kept')}</span>
                ) : (
                  <button type="button" className="btn ghost small" onClick={async () => { await Promise.all(group.map((edit) => post(`/api/edits/${edit.id}/keep`, {}))); await onChanged(); }}>
                    <Check size={13} aria-hidden /> {t('Keep')}
                  </button>
                )}
                {key.startsWith('single:') ? (
                  <button type="button" className="btn ghost small" disabled={bulkReverted} onClick={async () => { await Promise.all(group.map((edit) => post(`/api/edits/${edit.id}/revert`, {}))); await onChanged(); }}>
                    <RotateCcw size={13} aria-hidden /> {t('Undo')}
                  </button>
                ) : (
                  <button type="button" className="btn ghost small" disabled={bulkReverted} onClick={async () => { await post(`/api/runs/${key}/rollback`, {}); await onChanged(); }}>
                    <RotateCcw size={13} aria-hidden /> {t('Undo')}
                  </button>
                )}
                <button type="button" className="icon-btn" title={t('Copy file names')} aria-label={t('Copy file names')} onClick={() => { void navigator.clipboard?.writeText(files.join('\n')); }}>
                  <Copy size={14} aria-hidden />
                </button>
              </div>
            </div>
            {bulkOpen && (
              <div className="bulk-diff-files">
                {group.map((edit) => {
                  const labels = edit.label.split(',').map((label) => label.trim()).filter(Boolean);
                  const editLines = (edit.diff || '').split('\n');
                  const editAdded = editLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
                  const editRemoved = editLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
                  return labels.map((label) => {
                    const keptFile = Boolean(edit.keptAt) || edit.keptFiles.some((item) => item.endsWith(label) || label.endsWith(item));
                    const revertedFile = Boolean(edit.revertedAt) || edit.revertedFiles.some((item) => item.endsWith(label) || label.endsWith(item));
                    return (
                      <div className="bulk-file" key={`${edit.id}:${label}`}>
                        <div className="bulk-file-row">
                          <button type="button" className="bulk-file-head" onClick={() => setOpenFile(openFile === `${edit.id}:${label}` ? null : `${edit.id}:${label}`)}>
                            {openFile === `${edit.id}:${label}` ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                            <FileCode2 size={13} aria-hidden />
                            <span className="mono ellipsis">{label}</span>
                            <span className="diff-stat add">+{editAdded}</span>
                            <span className="diff-stat del">-{editRemoved}</span>
                          </button>
                          <div className="bulk-file-actions">
                            {keptFile ? <span className="badge ok"><Check size={12} aria-hidden /> {t('Kept')}</span> : (
                              <button type="button" className="btn ghost small" onClick={async () => { await post(`/api/edits/${edit.id}/keep`, { path: label }); await onChanged(); }}>
                                <Check size={12} aria-hidden /> {t('Keep')}
                              </button>
                            )}
                            <button type="button" className="btn ghost small" disabled={revertedFile} onClick={async () => { await post(`/api/edits/${edit.id}/revert-file`, { path: label }); await onChanged(); }}>
                              <RotateCcw size={12} aria-hidden /> {t('Undo')}
                            </button>
                          </div>
                        </div>
                        {openFile === `${edit.id}:${label}` && (
                          <pre className="diff-body mono">
                            {editLines.slice(0, 140).map((line, index) => {
                              const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
                              return <div key={index} className={`diff-line ${cls}`}>{line || ' '}</div>;
                            })}
                            {editLines.length > 140 && <div className="diff-line hunk">{t('… {0} more lines', [editLines.length - 140])}</div>}
                          </pre>
                        )}
                      </div>
                    );
                  });
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface LivePrefillState {
  total: number;
  cached: number;
  processed: number;
  toEval: number;
  evaluated: number;
  prefillPct: number;
  promptPct: number;
  cacheHitPct: number;
  timeMs: number;
  prefillTokPerSec: number | null;
  done: boolean;
}

/** Cursor-style expandable decision & tool-call timeline (live while running, inspectable after). */
interface LiveLlmTelemetry {
  slot: {
    server: string;
    isProcessing: boolean;
    isPrefilling: boolean;
    isGenerating?: boolean;
    nDecoded?: number;
    nCtx: number;
    promptTotal: number;
    promptProcessed: number;
    promptCached: number;
    promptNewTotal?: number;
    promptNewProcessed?: number;
    prefillPct: number | null;
    promptPct?: number | null;
    cacheHitPct: number | null;
    prefillTokPerSec?: number | null;
    exactProgress?: boolean;
    speculative: boolean;
    speculativeType: string | null;
  } | null;
  gpu: { busyPct: number | null; gttUsedGiB: number | null; gttTotalGiB: number | null };
  cpu: { busyPct: number; cores: number; ramUsedGiB: number; ramTotalGiB: number };
}

function modelArchOf(name: string) {
  const n = name.toLowerCase();
  if (n.includes('qwen3.6') && (n.includes('35b') || n.includes('a3b'))) {
    return {
      title: 'Qwen3.6-35B-A3B · Hybrid MoE',
      layers: 40,
      specialLabel: '10 KV + 30 DeltaNet',
      isSpecialLayer: (i: number) => (i + 1) % 4 === 0,
      expertsLabel: '8 / 256 active experts (3B active)',
      activeClusters: 8,
      totalClusters: 32,
    };
  }
  if (n.includes('inkling')) {
    return {
      title: 'Inkling 2 Mini · Looped MoE',
      layers: 24,
      specialLabel: '12 looped middle layers (×3 = 48 passes)',
      isSpecialLayer: (i: number) => i >= 6 && i < 18,
      expertsLabel: '3.4B active / 26.4B MoE',
      activeClusters: 6,
      totalClusters: 32,
    };
  }
  return null;
}

function ModelLiveViz({
  modelName,
  telemetry,
  livePrefill,
  live,
  tps,
}: {
  modelName: string;
  telemetry: LiveLlmTelemetry | null;
  livePrefill?: LivePrefillState | null;
  live: boolean;
  tps?: number | null;
}) {
  const arch = modelArchOf(modelName);
  const slot = telemetry?.slot;
  const gpu = telemetry?.gpu;
  const cpu = telemetry?.cpu;
  const phase = useState(() => 0)[0];
  const [tick, setTick] = useState(phase);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setTick((v) => (v + 1) % 32), 650);
    return () => window.clearInterval(id);
  }, [live]);

  const activePrefill = live ? livePrefill : null;
  const isPrefilling = Boolean(activePrefill) || Boolean(slot?.isPrefilling && !slot?.isGenerating);
  const isGenerating = !activePrefill && Boolean(slot?.isGenerating);
  const total = activePrefill ? activePrefill.total : (slot?.promptTotal ?? 0);
  const cached = activePrefill ? activePrefill.cached : (slot?.promptCached ?? 0);
  const processed = activePrefill ? activePrefill.processed : (slot?.promptProcessed ?? 0);
  const cachedPct = activePrefill
    ? activePrefill.cacheHitPct
    : total > 0
      ? Math.min(100, Math.round((cached / total) * 100))
      : 0;
  const workPct = activePrefill ? activePrefill.prefillPct : slot?.prefillPct ?? null;
  const overallPct = activePrefill
    ? activePrefill.promptPct
    : slot?.promptPct ?? (total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0);
  const toEval = activePrefill ? activePrefill.toEval : (slot?.promptNewTotal ?? Math.max(0, total - cached));
  const evaluated = activePrefill ? activePrefill.evaluated : (slot?.promptNewProcessed ?? Math.max(0, processed - cached));
  const prefillTps = activePrefill ? activePrefill.prefillTokPerSec : (slot?.prefillTokPerSec ?? null);
  const cacheLabel = activePrefill ? activePrefill.cacheHitPct : (slot?.cacheHitPct ?? null);
  const gttPct = gpu?.gttUsedGiB != null && gpu?.gttTotalGiB ? Math.min(100, Math.round((gpu.gttUsedGiB / gpu.gttTotalGiB) * 100)) : 0;
  const ramPct = cpu?.ramTotalGiB ? Math.min(100, Math.round((cpu.ramUsedGiB / cpu.ramTotalGiB) * 100)) : 0;

  return (
    <div className="llm-viz" dir="ltr">
      {(activePrefill || slot) && total > 0 && (
        <div className="llm-viz-sec">
          <div className="llm-viz-head">
            <span>
              {isPrefilling
                ? workPct != null
                  ? `Prefill ${workPct}%${prefillTps ? ` · ${prefillTps} t/s` : ''}`
                  : 'Prefilling…'
                : isGenerating
                  ? `Generating${slot?.nDecoded ? ` · ${slot.nDecoded} tok` : ''}`
                  : 'Prompt ready'}
            </span>
            <span className="mono faint">
              {isPrefilling
                ? cached > 0
                  ? `${evaluated.toLocaleString()} / ${toEval.toLocaleString()} new · ${cachedPct}% cached (${total.toLocaleString()} total)`
                  : `${processed.toLocaleString()} / ${total.toLocaleString()} tok`
                : `${total.toLocaleString()} tok${cacheLabel != null ? ` · ${cacheLabel}% cached` : isGenerating ? '' : ' in KV cache'}`}
            </span>
          </div>
          <div className="llm-bar">
            <span className="llm-bar-cached" style={{ width: `${isPrefilling ? cachedPct : (cacheLabel ?? 0)}%` }} />
            <span className="llm-bar-new" style={{ width: `${isPrefilling ? Math.max(0, overallPct - cachedPct) : Math.max(0, 100 - (cacheLabel ?? 0))}%` }} />
          </div>
        </div>
      )}
      {!activePrefill && slot && isPrefilling && total === 0 && (
        <div className="llm-viz-sec">
          <div className="llm-viz-head">
            <span>Prefilling…</span>
            <span className="mono faint">{(slot.promptProcessed ?? 0).toLocaleString()} tok evaluated</span>
          </div>
        </div>
      )}

      {telemetry && (
        <div className="llm-split">
          <div className="llm-split-card">
            <div className="llm-viz-head">
              <strong>iGPU</strong>
              <span className="mono">{gpu?.busyPct != null ? `${gpu.busyPct}%` : '—'}</span>
            </div>
            <div className="llm-bar"><span className="llm-bar-gpu" style={{ width: `${gpu?.busyPct ?? 0}%` }} /></div>
            <small className="faint mono">
              GTT {gpu?.gttUsedGiB ?? '—'} / {gpu?.gttTotalGiB ?? '—'} GB ({gttPct}%)
            </small>
          </div>
          <div className="llm-split-card">
            <div className="llm-viz-head">
              <strong>CPU</strong>
              <span className="mono">{cpu ? `${cpu.busyPct}%` : '—'}</span>
            </div>
            <div className="llm-bar"><span className="llm-bar-cpu" style={{ width: `${cpu?.busyPct ?? 0}%` }} /></div>
            <small className="faint mono">
              RAM {cpu?.ramUsedGiB ?? '—'} / {cpu?.ramTotalGiB ?? '—'} GB ({ramPct}%) · {cpu?.cores ?? 0}T
            </small>
          </div>
        </div>
      )}

      {arch && (
        <div className="llm-viz-sec">
          <div className="llm-viz-head">
            <strong>{arch.title}</strong>
            <span className="faint mono">
              {slot?.speculative ? `${slot.speculativeType || 'draft'} · ` : ''}
              {tps ? `${tps.toFixed(1)} t/s` : arch.specialLabel}
            </span>
          </div>
          <div className="llm-layers" title={arch.specialLabel}>
            {Array.from({ length: arch.layers }, (_, i) => (
              <span
                key={i}
                className={`llm-layer${arch.isSpecialLayer(i) ? ' special' : ''}${live && !slot?.isPrefilling && (i % 8 === tick % 8) ? ' pulse' : ''}`}
              />
            ))}
          </div>
          <div className="llm-viz-head" style={{ marginTop: 4 }}>
            <small className="faint">{arch.expertsLabel}</small>
            <small className="faint">{arch.specialLabel}</small>
          </div>
          <div className="llm-experts" aria-hidden>
            {Array.from({ length: arch.totalClusters }, (_, i) => {
              const hot = live && ((i + tick * 3) % Math.floor(arch.totalClusters / arch.activeClusters) === 0);
              return <span key={i} className={`llm-exp${hot ? ' hot' : ''}`} />;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function DecisionTimeline({
  steps,
  live,
  liveTokPerSec,
  livePrefill,
  docked,
  onStop,
}: {
  steps: TraceStep[];
  live: boolean;
  liveTokPerSec?: number | null;
  livePrefill?: LivePrefillState | null;
  docked?: boolean;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(docked ? false : live);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<LiveLlmTelemetry | null>(null);
  const visible = steps.filter((s) => s.kind === 'routing' || s.kind === 'tool' || s.kind === 'model' || s.kind === 'contract');

  const hasExpandedModel = Boolean(expandedStep && visible.some((s) => s.id === expandedStep && s.kind === 'model'));
  useEffect(() => {
    if (!live && !hasExpandedModel) return;
    let alive = true;
    const poll = () => {
      void api<LiveLlmTelemetry>('/api/llm/live').then((d) => alive && setTelemetry(d)).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, live ? 1000 : 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [live, hasExpandedModel]);

  if (!visible.length) return null;

  const toolCount = visible.filter((s) => s.kind === 'tool').length;
  const activeStep = [...visible].reverse().find((s) => s.status === 'running');
  const activeModelStepId = [...visible].reverse().find((s) => s.kind === 'model' && s.status === 'running')?.id ?? null;
  const completedModelSteps = visible.filter((s) => s.kind === 'model' && s.tokensOut && s.latencyMs && s.latencyMs > 0);
  const totalOut = completedModelSteps.reduce((acc, s) => acc + (s.tokensOut || 0), 0);
  const totalSec = completedModelSteps.reduce((acc, s) => acc + ((s.latencyMs || 0) / 1000), 0);
  const avgTps = totalOut > 0 && totalSec > 0 ? Math.round((totalOut / totalSec) * 10) / 10 : null;
  const shownTps = live ? (liveTokPerSec ?? avgTps) : avgTps;
  const isActivelyStreaming = Boolean(liveTokPerSec && liveTokPerSec > 0) || (!livePrefill && Boolean(telemetry?.slot?.isGenerating));
  const prefillingNow = Boolean(live && activeModelStepId && !isActivelyStreaming && (livePrefill || telemetry?.slot?.isPrefilling));
  const prefillPct = prefillingNow ? (livePrefill ? livePrefill.prefillPct : (telemetry?.slot?.prefillPct ?? null)) : null;

  return (
    <div className={`decision-trace${docked ? ' docked' : ''}${live ? ' live' : ''}`}>
      <div className="decision-head">
        <button type="button" className="decision-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <Cpu size={14} aria-hidden />
          <span>
            {activeStep
              ? prefillPct != null
                ? `${activeStep.name} · Prefill ${prefillPct}%`
                : prefillingNow && activeStep.id === activeModelStepId
                  ? `${activeStep.name} · Prefilling…`
                  : t('Running {0}…', [activeStep.name])
              : t('Decision path · {0} steps ({1} tools)', [visible.length, toolCount])}
          </span>
        </button>
        {prefillPct != null ? (
          <span className="decision-tps mono">{prefillPct}%</span>
        ) : shownTps != null && shownTps > 0 ? (
          <span className="decision-tps mono" title={live ? 'Live decode speed' : 'Average decode speed'}>
            {shownTps.toFixed(1)} t/s
          </span>
        ) : null}
        {live && onStop && (
          <button type="button" className="btn ghost small danger" onClick={onStop}>
            <Square size={12} aria-hidden /> {t('Cancel')}
          </button>
        )}
      </div>
      {open && (
        <ol className="decision-list">
          {visible.map((step) => {
            const isStepOpen = expandedStep === step.id;
            const icon = step.kind === 'tool' ? (step.name === 'shell' ? <Terminal size={13} /> : <Wrench size={13} />) : <Sparkles size={13} />;
            const isLiveModel = live && step.id === activeModelStepId;
            const summary = step.kind === 'routing'
              ? String((step.output as { reason?: string } | null)?.reason || step.name)
              : step.kind === 'model'
                ? `${step.name}${isLiveModel && prefillPct != null ? ` · Prefill ${prefillPct}%` : isLiveModel && prefillingNow ? ' · Prefilling…' : step.tokensOut ? ` · ${step.tokensOut} tok` : ''}`
                : step.name;
            return (
              <li key={step.id} className={`decision-item ${step.status}`}>
                <button type="button" className="decision-row" onClick={() => setExpandedStep(isStepOpen ? null : step.id)}>
                  <span className={`mini-dot ${step.status === 'running' ? 'live' : step.status}`} aria-hidden />
                  {icon}
                  <span className="decision-label ellipsis">{summary}</span>
                  {step.latencyMs ? <span className="mono faint decision-ms">{step.latencyMs >= 1000 ? `${(step.latencyMs / 1000).toFixed(1)}s` : `${step.latencyMs}ms`}</span> : null}
                  {isStepOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {isLiveModel && prefillPct != null && (
                  <div className="llm-row-progress" aria-hidden>
                    <span style={{ width: `${prefillPct}%` }} />
                  </div>
                )}
                {isStepOpen && (
                  <div className="decision-detail">
                    {step.kind === 'model' && (
                      <ModelLiveViz modelName={step.name} telemetry={telemetry} livePrefill={isLiveModel ? livePrefill : null} live={isLiveModel} tps={shownTps} />
                    )}
                    {step.input != null && <pre className="mini-out">{typeof step.input === 'string' ? step.input : JSON.stringify(step.input, null, 2).slice(0, 1200)}</pre>}
                    {step.output != null && <pre className="mini-out">{typeof step.output === 'string' ? step.output.slice(0, 1800) : JSON.stringify(step.output, null, 2).slice(0, 1800)}</pre>}
                    {step.error && <pre className="mini-out err">{step.error}</pre>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** @ mention fuzzy popover above the composer (@file, @git). */
export function MentionPopover({
  items,
  selected,
  onPick,
}: {
  items: MentionItem[];
  selected: number;
  onPick: (item: MentionItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mention-pop" role="listbox" aria-label={t('Attach context')}>
      {items.map((item, idx) => (
        <button
          key={`${item.kind}:${item.label}`}
          type="button"
          role="option"
          aria-selected={idx === selected}
          className={idx === selected ? 'mention-item on' : 'mention-item'}
          onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
        >
          {item.kind === 'git' ? <GitBranch size={14} aria-hidden /> : <FileCode2 size={14} aria-hidden />}
          <span className="mono ellipsis grow">{item.label}</span>
          <span className="faint">{item.detail}</span>
        </button>
      ))}
    </div>
  );
}

/** One-click Local (/projects) + GitHub repo picker to clone and attach repos straight into this chat. */
export function LocalRepoPicker({
  sessionId,
  onAttached,
}: {
  sessionId: string | null;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'local' | 'github' | 'new'>('local');
  const [repos, setRepos] = useState<{ name: string; path: string; isGit: boolean }[] | null>(null);
  const [ghRepos, setGhRepos] = useState<{ name: string; fullName: string; cloneUrl: string; isPrivate: boolean; cloned: boolean }[] | null>(null);
  const [ghUser, setGhUser] = useState('');
  const [ghError, setGhError] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newGithub, setNewGithub] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) { if (!open) setPos(null); return; }
    const place = () => {
      if (!trigger.current || !pop.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const w = pop.current.offsetWidth;
      const h = pop.current.offsetHeight;
      let left = rect.right - w;
      left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
      const canAbove = rect.top - h - 10 >= 10;
      const top = canAbove ? rect.top - h - 10 : Math.min(window.innerHeight - h - 10, rect.bottom + 10);
      setPos({ top, left, side: canAbove ? 'top' : 'bottom' });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, tab, repos, ghRepos, ghError]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (pop.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'local' || repos !== null) return;
    api<{ repos: { name: string; path: string; isGit: boolean }[] }>('/api/projects/discover')
      .then((res) => setRepos(res.repos || []))
      .catch(() => setRepos([]));
  }, [open, tab, repos]);

  const loadGithub = (user = ghUser) => {
    setGhError('');
    setGhRepos(null);
    api<{ repos: { name: string; fullName: string; cloneUrl: string; isPrivate: boolean; cloned: boolean }[] }>(`/api/github/repos${user.trim() ? `?user=${encodeURIComponent(user.trim())}` : ''}`)
      .then((res) => setGhRepos(res.repos || []))
      .catch((err) => { setGhRepos([]); setGhError(errorText(err)); });
  };

  useEffect(() => {
    if (open && tab === 'github' && ghRepos === null && !ghError) loadGithub();
  }, [open, tab]);

  return (
    <div className="repo-picker-wrap">
      <button
        ref={trigger}
        type="button"
        className={`icon-btn round${open ? ' on' : ''}`}
        title={t('Attach local or GitHub repo')}
        aria-label={t('Attach local or GitHub repo')}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <FolderGit2 size={17} />
      </button>
      {open && createPortal(
        <div
          ref={pop}
          className="repo-picker-pop"
          role="dialog"
          aria-label={t('Attach local or GitHub repo')}
          data-side={pos?.side ?? 'top'}
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
        >
          <div className="ctx-pop-head">
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className={tab === 'local' ? 'btn primary small' : 'btn ghost small'} onClick={() => setTab('local')}>{t('Local')}</button>
              <button type="button" className={tab === 'github' ? 'btn primary small' : 'btn ghost small'} onClick={() => setTab('github')}>{t('GitHub')}</button>
              <button type="button" className={tab === 'new' ? 'btn primary small' : 'btn ghost small'} onClick={() => setTab('new')}>{t('New')}</button>
            </div>
            <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setOpen(false)}><X size={14} /></button>
          </div>
          {tab === 'local' ? (
            repos === null ? (
              <p className="faint">{t('Scanning…')}</p>
            ) : repos.length === 0 ? (
              <p className="faint">{t('No local repos found in /projects.')}</p>
            ) : (
              <div className="repo-picker-list">
                {repos.map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    className="repo-picker-row"
                    disabled={busy === r.path}
                    onClick={async () => {
                      setBusy(r.path);
                      try {
                        await post('/api/projects/attach', { path: r.path, name: r.name, sessionId: sessionId || undefined });
                        toast(t('Attached {0}.', [r.name]), 'ok');
                        setOpen(false);
                        onAttached();
                      } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
                    }}
                  >
                    <FolderGit2 size={14} aria-hidden />
                    <span className="mono ellipsis grow">{r.name}</span>
                    {r.isGit && <span className="badge">git</span>}
                  </button>
                ))}
              </div>
            )
          ) : tab === 'new' ? (
            <form
              className="repo-picker-list"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newName.trim()) return;
                setBusy('create');
                try {
                  const res = await post<{ repo: { label: string }; remoteUrl?: string | null }>('/api/projects/create', {
                    name: newName.trim(),
                    description: newDesc.trim() || undefined,
                    createGithub: newGithub,
                    isPrivate: true,
                    sessionId: sessionId || undefined,
                  });
                  toast(res.remoteUrl ? t('Created {0} (+ GitHub repo).', [res.repo.label]) : t('Created & attached {0}.', [res.repo.label]), 'ok');
                  setNewName(''); setNewDesc(''); setRepos(null); setOpen(false);
                  onAttached();
                } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
              }}
            >
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('Project name (e.g. gym-tracker)')} required />
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={t('Short description (optional)')} />
              <label className="row" style={{ gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={newGithub} onChange={(e) => setNewGithub(e.target.checked)} />
                <span>{t('Also create private GitHub repo')}</span>
              </label>
              <button type="submit" className="btn primary small" disabled={busy === 'create' || !newName.trim()}>
                {busy === 'create' ? t('Creating…') : t('Create & attach')}
              </button>
            </form>
          ) : (
            <div className="repo-picker-list">
              <form className="row" style={{ gap: 4, marginBottom: 4 }} onSubmit={(e) => { e.preventDefault(); loadGithub(ghUser); }}>
                <input value={ghUser} onChange={(e) => setGhUser(e.target.value)} placeholder={t('GitHub user (optional)')} style={{ flex: 1, minWidth: 0 }} />
                <button type="submit" className="btn ghost small">{t('Load')}</button>
              </form>
              {ghError && <p className="faint">{ghError}</p>}
              {ghRepos === null ? (
                <p className="faint">{t('Loading GitHub repos…')}</p>
              ) : ghRepos.length === 0 ? (
                <p className="faint">{t('No repos found. Add GITHUB_TOKEN in Settings → Vault for private repos.')}</p>
              ) : (
                ghRepos.map((r) => (
                  <button
                    key={r.fullName}
                    type="button"
                    className="repo-picker-row"
                    disabled={busy === r.fullName}
                    onClick={async () => {
                      setBusy(r.fullName);
                      try {
                        await post('/api/github/clone', { cloneUrl: r.cloneUrl, name: r.name, sessionId: sessionId || undefined });
                        toast(t('Cloned & attached {0}.', [r.name]), 'ok');
                        setRepos(null);
                        setOpen(false);
                        onAttached();
                      } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
                    }}
                  >
                    <GitBranch size={14} aria-hidden />
                    <span className="mono ellipsis grow">{r.name}</span>
                    <span className="badge">{busy === r.fullName ? '…' : r.cloned ? t('Attach') : t('Clone')}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
