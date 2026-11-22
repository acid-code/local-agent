import { memo, useState, type CSSProperties } from 'react';
import { Brain, ChevronRight, Container, FileCode2, FilePen, FileText, Globe, Search, Sparkles, SquareTerminal, Users, Wrench } from 'lucide-react';
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

/** The "Working…" dots: mounted once for the whole run; only the note changes, fading in under its own key. */
export function TypingDots({ label, note }: { label: string; note: string }) {
  const a = useClockPhase(1800, 0);
  const b = useClockPhase(1800, 220);
  const c = useClockPhase(1800, 440);
  return <div className="typing" role="status" aria-label={label}><span style={a} aria-hidden /><span style={b} aria-hidden /><span style={c} aria-hidden /> <em key={note}>{note}</em></div>;
}

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

type GroupProps = { group: WorkGroup; live: boolean; diffs: string[]; defaultOpen?: boolean; liveThought?: string };
const sameDiffs = (a: string[], b: string[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** Memoised: the chat re-renders on every streamed token, but a group only re-renders when its rows change. */
export const WorkGroupView = memo(WorkGroupViewInner, (a: GroupProps, b: GroupProps) =>
  a.live === b.live && a.defaultOpen === b.defaultOpen && a.liveThought === b.liveThought && sameGroup(a.group, b.group) && sameDiffs(a.diffs, b.diffs));

function WorkGroupViewInner({ group, live, diffs, defaultOpen, liveThought }: GroupProps) {
  const [open, setOpen] = useState(Boolean(defaultOpen || live));
  const stats = diffs.length ? diffStats(diffs) : null;
  const duration = formatDuration(group.durationMs);
  const n = group.stepCount;
  const title = live
    ? t('Working · {0} steps so far', [n])
    : duration ? t('Completed {0} steps in {1}', [n, duration]) : t('Completed {0} steps', [n]);
  return (
    <section className={`work-group${open ? ' open' : ''}${live ? ' live' : ''}`} aria-label={title}>
      <button type="button" className="work-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={15} className="work-chev" aria-hidden />
        {live && <span className="work-live-dot" aria-hidden />}
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
        {step.target && step.files.length === 0 && <span className="work-target ellipsis" title={step.target}>{step.target}</span>}
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
