import { memo, useEffect, useState, type CSSProperties } from 'react';
import { AlertCircle, Bot, Brain, CheckCircle2, ChevronRight, Container, FileCode2, FilePen, FileText, Globe, Pause, RotateCcw, Search, Sparkles, SquareTerminal, Users, Wrench, X } from 'lucide-react';
import { MiniAgentCard, type MiniAgentRow } from './ChatUpgrades';
import { Markdown } from './Markdown';
import { clockDelay } from '../lib/anim-clock';
import { diffStats, formatDuration, sameGroup, sameRow, type StepIcon, type WorkGroup, type WorkRow, type WorkStep } from '../lib/work-steps';
import { t } from '../i18n';

const ICONS: Record<StepIcon, typeof Brain> = {
  edit: FilePen, read: FileText, think: Brain, command: SquareTerminal, search: Search, web: Globe,
  memory: Sparkles, agent: Users, container: Container, tool: Wrench,
};

/**
 * Copilot-style work block: "Completed N steps in Xm Ys" with a chevron, then a thin guide line with one airy,
 * clickable row per step (icon, verb, muted target, duration, file chips) and the agent's narration in between.
 */
/**
 * An animation-delay pinned to the wall clock, taken once per mount: if the dots are ever remounted (chat switch,
 * reconnect) they carry on the shared beat instead of restarting at 0%.
 */
export function useClockPhase(periodMs: number, offsetMs = 0): CSSProperties {
  const [style] = useState<CSSProperties>(() => {
    const raw = Number.parseInt(clockDelay(periodMs, Date.now(), offsetMs), 10);
    // Always use a negative delay so the dot starts immediately in-phase without freezing first.
    const negative = raw > 0 ? raw - periodMs : raw;
    return { animationDelay: `${negative}ms` };
  });
  return style;
}

/** The "Working…" dots: sequential 1-2-3 wave via pure CSS delays; memoized so streaming tokens never re-render them. */
export const TypingDots = memo(function TypingDots({ label, note }: { label: string; note: string }) {
  return <div className="typing" role="status" aria-label={label}><span aria-hidden /><em>{note}</em></div>;
});

/** The reasoning streaming in right now: one quiet row that becomes a "Thought" row when the step lands. */
function LiveThoughtRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tail = text.trim().replace(/\s+/g, ' ');
  return (
    <li className={`work-step pending live-thought${open ? ' open' : ''}`}>
      <button type="button" className="work-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Brain size={15} className="work-icon" aria-hidden />
        <span className="work-verb">{t('Thinking…')}</span>
        <span className="work-target ellipsis" dir="auto">{tail.length > 120 ? `…${tail.slice(-119)}` : tail}</span>
      </button>
      {open && <div className="work-detail think" dir="auto">{text}</div>}
    </li>
  );
}

const PHASE_LABELS: Record<string, string> = {
  planning: 'Planning',
  investigating: 'Investigating',
  editing: 'Editing',
  verifying: 'Verifying',
  fixing: 'Fixing',
  summarizing: 'Summarizing',
};

function fmtCompactElapsed(startIso?: string, endIso?: string, nowMs = Date.now()): string {
  if (!startIso) return '';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface PlanView {
  id: string;
  items: { id: string; text: string; status: string; note?: string | null }[];
  canUndo?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Antigravity-style collapsible step summary pill ("Worked for 2m > ◔ 1/3 steps") with expandable checklist & evidence. */
export function PlanProgressPill({
  plan,
  active,
  liveFocus,
  livePhase,
  runStartedAt,
  onToggleItem,
  onUndo,
  onDismiss,
}: {
  plan: PlanView;
  active: boolean;
  liveFocus?: string;
  livePhase?: string;
  runStartedAt?: string | null;
  onToggleItem: (itemId: string, nextStatus: 'done' | 'pending') => void | Promise<void>;
  onUndo?: () => void | Promise<void>;
  onDismiss?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const doneCount = plan.items.filter((item) => item.status === 'done').length;
  const total = plan.items.length;
  const startIso = (active ? runStartedAt : undefined) || plan.createdAt;
  const endIso = active ? undefined : plan.updatedAt;
  const elapsed = fmtCompactElapsed(startIso, endIso, nowMs);
  const workedLabel = active
    ? (elapsed ? t('Working · {0}', [elapsed]) : t('Working…'))
    : (elapsed ? t('Worked for {0}', [elapsed]) : t('Completed steps'));
  const pct = total > 0 ? Math.max(0, Math.min(1, doneCount / total)) : 0;
  const radius = 5.5;
  const circ = 2 * Math.PI * radius;
  const phaseTitle = livePhase ? t(PHASE_LABELS[livePhase] ?? livePhase) : '';

  return (
    <div className={`plan-pill-wrap${open ? ' open' : ''}${active ? ' live' : ''}`}>
      <div className="plan-pill-bar">
        <button type="button" className="plan-pill-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="plan-worked">{workedLabel}</span>
          <ChevronRight size={14} className="plan-chev" aria-hidden />
          <svg className="plan-ring" viewBox="0 0 16 16" aria-hidden>
            <circle cx="8" cy="8" r={radius} className="plan-ring-track" />
            {pct > 0 && (
              <circle
                cx="8" cy="8" r={radius}
                className="plan-ring-fill"
                strokeDasharray={`${pct * circ} ${circ}`}
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
          <span className="plan-count">{t('{0}/{1} steps', [doneCount, total])}</span>
        </button>
        {active && (liveFocus || phaseTitle) && (
          <span className="plan-focus-inline ellipsis" dir="auto">
            {phaseTitle && <span className="work-phase-pill">{phaseTitle}</span>}
            {liveFocus}
          </span>
        )}
      </div>
      {open && (
        <div className="plan-card" role="region" aria-label={t('Plan progress')}>
          <div className="plan-card-list">
            {plan.items.map((item) => {
              const st = item.status === 'doing' || item.status === 'done' || item.status === 'blocked' ? item.status : 'pending';
              return (
                <div key={item.id} className={`plan-item-row ${st}`}>
                  <button
                    type="button"
                    className="plan-item-icon-btn"
                    title={st === 'done' ? t('Mark pending') : t('Mark done')}
                    onClick={() => void onToggleItem(item.id, st === 'done' ? 'pending' : 'done')}
                  >
                    {st === 'done' ? (
                      <CheckCircle2 size={16} aria-hidden />
                    ) : st === 'doing' ? (
                      <Pause size={15} aria-hidden />
                    ) : st === 'blocked' ? (
                      <AlertCircle size={16} aria-hidden />
                    ) : (
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                  </button>
                  <div className="plan-item-body">
                    <div className="plan-item-text" dir="auto">{item.text}</div>
                    {item.note && <div className="plan-item-note" dir="auto">{item.note}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          {(plan.canUndo || (!active && onDismiss)) && (
            <div className="plan-card-actions">
              {plan.canUndo && onUndo && (
                <button type="button" className="btn ghost small" onClick={() => void onUndo()}>
                  <RotateCcw size={12} aria-hidden /> {t('Undo plan')}
                </button>
              )}
              {!active && onDismiss && (
                <button type="button" className="btn ghost small" onClick={() => void onDismiss()}>
                  <X size={12} aria-hidden /> {t('Dismiss')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type GroupProps = { group: WorkGroup; live: boolean; diffs: string[]; helpers?: MiniAgentRow[]; onStopHelper?: (id: string) => Promise<void> | void; defaultOpen?: boolean; liveThought?: string; liveFocus?: string; livePhase?: string };
const sameDiffs = (a: string[], b: string[]) => a.length === b.length && a.every((d, i) => d === b[i]);
const sameHelpers = (a: MiniAgentRow[] = [], b: MiniAgentRow[] = []) => a.length === b.length
  && a.every((h, i) => {
    const o = b[i]!;
    return h.id === o.id && h.status === o.status && h.stepCount === o.stepCount
      && h.currentStep === o.currentStep && h.endedAt === o.endedAt
      && h.result === o.result && h.error === o.error;
  });

/** Memoised: the chat re-renders on every streamed token, but a group only re-renders when its rows change. */
export const WorkGroupView = memo(WorkGroupViewInner, (a: GroupProps, b: GroupProps) =>
  a.live === b.live && a.defaultOpen === b.defaultOpen && a.liveThought === b.liveThought
  && (a.liveFocus ?? '') === (b.liveFocus ?? '') && (a.livePhase ?? '') === (b.livePhase ?? '')
  && sameGroup(a.group, b.group) && sameDiffs(a.diffs, b.diffs) && sameHelpers(a.helpers, b.helpers));

function WorkGroupViewInner({ group, live, diffs, helpers, onStopHelper, defaultOpen, liveThought, liveFocus, livePhase }: GroupProps) {
  const [open, setOpen] = useState(Boolean(defaultOpen || live));
  const stats = diffs.length ? diffStats(diffs) : null;
  const duration = formatDuration(group.durationMs);
  const n = group.stepCount;
  const phaseTitle = livePhase ? t(PHASE_LABELS[livePhase] ?? livePhase) : '';
  const title = live
    ? (liveFocus ? liveFocus : t('Working · {0} steps so far', [n]))
    : duration ? t('Completed {0} steps in {1}', [n, duration]) : t('Completed {0} steps', [n]);
  return (
    <section className={`work-group${open ? ' open' : ''}${live ? ' live' : ''}`} aria-label={title}>
      <button type="button" className="work-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={15} className="work-chev" aria-hidden />
        {live && <span className="work-live-dot" aria-hidden />}
        {live && phaseTitle && <span className="work-phase-pill">{phaseTitle}</span>}
        <span className="work-title">{n === 1 && !live ? (duration ? t('Completed 1 step in {0}', [duration]) : t('Completed 1 step')) : title}</span>
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="work-diffstat mono"><span className="add">+{stats.added}</span> <span className="del">-{stats.removed}</span></span>
        )}
      </button>
      {open && (
        <ol className="work-rows">
          {group.rows.map((row) => <WorkRowView key={row.id} row={row} live={live} />)}
          {liveThought && <LiveThoughtRow text={liveThought} />}
        </ol>
      )}
      {open && helpers && helpers.length > 0 && (
        <div className="work-helpers" aria-label={t('Mini-agents')}>
          <span className="work-helpers-label">
            <Bot size={12} aria-hidden />
            <span>{t('Mini-agents')}</span>
          </span>
          {[...helpers].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')).map((h) => (
            <MiniAgentCard key={h.id} helper={h} onStop={onStopHelper} />
          ))}
        </div>
      )}
    </section>
  );
}

const WorkRowView = memo(function WorkRowView({ row, live }: { row: WorkRow; live: boolean }) {
  if (row.type === 'narration') return <li className="work-narration" dir="auto"><Markdown text={row.text} /></li>;
  if (row.type === 'thought') return <ThoughtRow text={row.text} />;
  // A step without a result in a run that is no longer live did not finish: it was stopped, not still running.
  return <StepRow step={row} stopped={row.pending && !live} />;
}, (a, b) => a.live === b.live && sameRow(a.row, b.row));

function ThoughtRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const words = text.split(/\s+/).length;
  return (
    <li className={`work-step${open ? ' open' : ''}`}>
      <button type="button" className="work-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Brain size={15} className="work-icon" aria-hidden />
        <span className="work-verb">{t('Thought')}</span>
        <span className="work-target">{t('{0} words', [words])}</span>
      </button>
      {open && <div className="work-detail think" dir="auto">{text}</div>}
    </li>
  );
}

function StepRow({ step, stopped }: { step: WorkStep; stopped: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[step.icon] ?? Wrench;
  const argsText = step.args ? JSON.stringify(step.args, null, 2) : '';
  return (
    <li className={`work-step${open ? ' open' : ''}${step.failed ? ' failed' : ''}${step.pending && !stopped ? ' pending' : ''}${stopped ? ' stopped' : ''}`}>
      <button type="button" className="work-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon size={15} className="work-icon" aria-hidden />
        <span className="work-verb">{step.verb}</span>
        {(step.why || (step.target && step.files.length === 0)) && (
          <span className="work-target ellipsis" title={step.target || step.why}>{step.why || step.target}</span>
        )}
        {step.files.slice(0, 3).map((file) => (
          <span key={file} className="work-file mono" title={file}><FileCode2 size={12} aria-hidden />{file.split('/').pop()}</span>
        ))}
        <span className="work-spacer" />
        {stopped ? <span className="work-time faint">{t('stopped')}</span> : step.pending ? <span className="work-time faint">{t('running…')}</span> : step.durationMs != null && <span className="work-time faint">{formatDuration(step.durationMs)}</span>}
      </button>
      {open && (
        <div className="work-detail">
          {argsText && <><div className="work-detail-label">{t('Input')}</div><pre className="mono">{argsText.slice(0, 4000)}</pre></>}
          {step.output && <><div className="work-detail-label">{step.icon === 'edit' && /^[-+@]/m.test(step.output) ? t('Diff') : t('Output')}</div><pre className="mono">{step.output.slice(0, 6000)}{step.output.length > 6000 ? '\n…' : ''}</pre></>}
          {!argsText && !step.output && <p className="faint">{t('No details were recorded for this step.')}</p>}
        </div>
      )}
    </li>
  );
}
