import { useState } from 'react';
import { AlertCircle, Brain, CheckCircle2, CircleDashed, CircleStop, Copy, RotateCcw, Wrench } from 'lucide-react';
import { humanDuration, isRetriedStep, pairSteps, stepPerf, traceLabel, traceSummary, type TraceStep } from '../lib/trace';
import { t } from '../i18n';

type Step = TraceStep;

/** A run's steps as a timeline: summary header, think → do pairs, errors under failed rows, tap to expand. */
export function TraceList({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
    {steps.length > 0 && (() => { const sum = traceSummary(steps); return (
      <div className="trace-summary" role="group" aria-label={t('Run summary')}>
        <span><strong>{humanDuration(sum.totalMs) || '0 ms'}</strong> {t('total')}</span>
        <span><strong>{sum.steps}</strong> {t('steps')}</span>
        <span className={sum.failures ? 'bad' : ''}><strong>{sum.failures}</strong> {t('failed')}</span>
        {(sum.tokensIn + sum.tokensOut) > 0 && <span className="faint">{sum.tokensIn} → {sum.tokensOut} {t('tokens')}</span>}
      </div>
    ); })()}
    <ol className="trace-list">
      {pairSteps(steps).map((pair, pairIndex) => (
        <li key={pair.model?.id ?? `p${pairIndex}`} className="trace-pair">
          {[pair.model, ...pair.tools].filter((step): step is Step => Boolean(step)).map((step) => {
            const { label, detail } = traceLabel(step);
            const failed = step.status === 'failed' || Boolean(step.error);
            const retried = isRetriedStep(steps, step);
            const perf = stepPerf(step);
            const Icon = retried ? RotateCcw : failed ? AlertCircle : step.status === 'stopped' ? CircleStop : step.kind === 'model' ? Brain : step.status === 'completed' ? (step.kind === 'tool' ? Wrench : CheckCircle2) : CircleDashed;
            const body = JSON.stringify({ input: step.input, output: step.output }, null, 2);
            return (
              <div key={step.id} className={`trace-step${retried ? ' retried' : failed ? ' failed' : ''}${step.kind === 'model' ? ' model' : ' tool'}`}>
                <button type="button" className="trace-row" aria-expanded={open === step.id} onClick={() => setOpen(open === step.id ? null : step.id)}>
                  <Icon size={16} className="trace-ico" aria-hidden />
                  <span className="trace-label" dir="auto">{label}{detail && <span className="trace-detail mono"> {detail}</span>}</span>
                  {retried && <span className="trace-chip retried">{t('retried')}</span>}
                  {perf.cacheHitPct != null && <span className="trace-chip perf">{perf.cacheHitPct}% {t('cache')}</span>}
                  {perf.tokPerSec != null && <span className="trace-chip perf">{perf.tokPerSec} {t('tok/s')}</span>}
                  {(step.tokensIn || step.tokensOut) ? <span className="trace-chip">{step.tokensIn}→{step.tokensOut}</span> : null}
                  <span className="trace-time">{humanDuration(step.latencyMs)}</span>
                </button>
                {step.error && <p className="trace-error" dir="auto">{step.error}</p>}
                {open === step.id && (
                  <div className="trace-body">
                    <button type="button" className="icon-btn trace-copy" aria-label={t('Copy')} title={t('Copy')} onClick={() => void navigator.clipboard?.writeText(body)}><Copy size={14} /></button>
                    <pre className="mono" dir="ltr">{body.slice(0, 20_000)}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </li>
      ))}
    </ol>
    </>
  );
}
