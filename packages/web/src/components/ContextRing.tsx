import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextBreakdown } from '@local-agent/shared';
import { t } from '../i18n';

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.max(0, Math.round(n)));
}

const SEGMENTS: { key: keyof Pick<ContextBreakdown, 'systemPrompt' | 'personaAndTools' | 'memory' | 'history' | 'files'>; label: string; color: string }[] = [
  { key: 'systemPrompt', label: 'System prompt', color: '#7c98f5' },
  { key: 'personaAndTools', label: 'Persona & tools', color: '#b794f4' },
  { key: 'memory', label: 'Memory', color: '#68c3a3' },
  { key: 'history', label: 'History', color: '#e4b56a' },
  { key: 'files', label: 'Files', color: '#f08c6b' },
];

/** Cursor-style circular filling context ring; clicking opens an itemized breakdown popover. */
export function ContextRing({
  breakdown,
  onOpenContext,
  onCompact,
  onHandoff,
  busy,
}: {
  breakdown: ContextBreakdown | null;
  onOpenContext?: () => void;
  onCompact?: () => Promise<void> | void;
  onHandoff?: () => Promise<void> | void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<'compact' | 'handoff' | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const budget = Math.max(1, breakdown?.budget ?? 1);
  const used = Math.max(0, breakdown?.used ?? 0);
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const r = 8;
  const circ = 2 * Math.PI * r;
  const offset = circ - (circ * pct) / 100;
  const tone = pct >= 85 ? 'bad' : pct >= 65 ? 'warn' : 'ok';

  useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const w = pop.current.offsetWidth;
    const h = pop.current.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
    const canAbove = rect.top - h - 8 >= 10;
    const top = canAbove ? rect.top - h - 8 : Math.min(window.innerHeight - h - 10, rect.bottom + 8);
    setPos({ top, left, side: canAbove ? 'top' : 'bottom' });
  }, [open, breakdown]);

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

  if (!breakdown) return null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ctx-ring-btn ${tone}${open ? ' open' : ''}`}
        aria-label={t('Context used: {0}%', [pct])}
        aria-expanded={open}
        title={t('Context: {0} / {1} tokens ({2}%) — click for breakdown', [fmtTok(used), fmtTok(budget), pct])}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg className="ctx-ring-svg" width="22" height="22" viewBox="0 0 22 22" aria-hidden>
          <circle className="ctx-ring-track" cx="11" cy="11" r={r} strokeWidth="2.4" fill="none" />
          <circle
            className="ctx-ring-fill"
            cx="11"
            cy="11"
            r={r}
            strokeWidth="2.4"
            fill="none"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 11 11)"
          />
        </svg>
        <span className="ctx-ring-pct">{pct}%</span>
      </button>
      {open && createPortal(
        <div
          ref={pop}
          role="dialog"
          aria-label={t('Context breakdown')}
          className="ctx-popover"
          data-side={pos?.side ?? 'top'}
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
        >
          <div className="ctx-pop-head">
            <strong>{t('Context window')}</strong>
            <span className="mono faint">{fmtTok(used)} / {fmtTok(budget)} ({pct}%)</span>
          </div>
          <div className="ctx-bar" aria-hidden>
            {SEGMENTS.map((seg) => {
              const val = breakdown[seg.key] || 0;
              const width = Math.min(100, (val / budget) * 100);
              if (width <= 0.2) return null;
              return <span key={seg.key} style={{ width: `${width}%`, background: seg.color }} title={`${seg.label}: ${fmtTok(val)}`} />;
            })}
          </div>
          <ul className="ctx-breakdown-list">
            {SEGMENTS.map((seg) => {
              const val = breakdown[seg.key] || 0;
              const share = Math.round((val / budget) * 100);
              return (
                <li key={seg.key}>
                  <span className="ctx-dot" style={{ background: seg.color }} aria-hidden />
                  <span className="grow">{t(seg.label)}</span>
                  <span className="mono">{fmtTok(val)}</span>
                  <span className="faint mono ctx-share">{share}%</span>
                </li>
              );
            })}
            <li className="ctx-room-row">
              <span className="ctx-dot room" aria-hidden />
              <span className="grow">{t('Room left')}</span>
              <span className="mono">{fmtTok(breakdown.remaining)}</span>
              <span className="faint mono ctx-share">{Math.max(0, 100 - pct)}%</span>
            </li>
          </ul>
          {(onCompact || onHandoff) && (
            <div className="ctx-pop-actions">
              {onCompact && (
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={Boolean(busy || working)}
                  onClick={async () => {
                    setWorking('compact');
                    try { await onCompact(); } finally { setWorking(null); }
                  }}
                >
                  {working === 'compact' ? t('Compacting…') : t('Compact chat')}
                </button>
              )}
              {onHandoff && (
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={Boolean(busy || working)}
                  onClick={async () => {
                    setWorking('handoff');
                    try { await onHandoff(); setOpen(false); } finally { setWorking(null); }
                  }}
                >
                  {working === 'handoff' ? t('Handing off…') : t('Continue in new chat')}
                </button>
              )}
            </div>
          )}
          <div className="ctx-pop-foot">
            <span className="faint">{t('Output reserve: {0}', [fmtTok(breakdown.outputReserve)])}</span>
            {onOpenContext && (
              <button type="button" className="link-btn" onClick={() => { setOpen(false); onOpenContext(); }}>{t('Details')}</button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
