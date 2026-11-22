import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, post } from '../lib/api';
import { EmptyState, PageHeader } from '../components/ui';
import { Activity } from 'lucide-react';
import { TraceList } from '../components/TraceList';
import { t } from '../i18n';

interface Run { id: string; status: string; modelId: string | null; routingNote: string | null; inputTokens: number; outputTokens: number; costUsd: number; error: string | null; startedAt: string }
interface Step { id: string; index: number; kind: string; name: string; status: string; input: unknown; output: unknown; latencyMs: number; tokensIn: number; tokensOut: number; error: string | null }
interface Checkpoint { id: string; note: string; phase: string; createdAt: string }

export function Runs() {
  const params = useParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(params.id || null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);

  useEffect(() => { api<{ runs: Run[] }>('/api/runs').then((data) => setRuns(data.runs)); }, []);
  useEffect(() => {
    if (!selected) return;
    api<{ steps: Step[]; checkpoints: Checkpoint[] }>(`/api/runs/${selected}`).then((data) => { setSteps(data.steps); setCheckpoints(data.checkpoints); });
  }, [selected]);

  const run = runs.find((item) => item.id === selected);

  return (
    <div className="page">
      <PageHeader title={t('Runs')} description={t('Every reply is a run with checkpoints. If the process stops, it resumes from the last checkpoint. Retrying from an earlier one does not undo file changes; use the edit checkpoint for that.')} />
      <div className="runs-grid">
        <div className="run-list">
          {runs.length === 0 && <EmptyState icon={Activity} title={t('No runs yet')} action={<a className="btn" href="/">{t('Start a chat')}</a>}>{t('Every chat reply, schedule and trigger becomes a run you can inspect here.')}</EmptyState>}
          {runs.map((item) => (
            <button key={item.id} className={item.id === selected ? 'run-item active' : 'run-item'} onClick={() => { setSelected(item.id); if (window.innerWidth <= 980) setTimeout(() => document.getElementById('run-detail')?.scrollIntoView({ behavior: 'smooth' }), 50); }}>
              <span className="mono ellipsis">{item.id}</span>
              <span className={`badge ${item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'bad' : item.status === 'running' ? 'warn' : ''}`}>{item.status}</span>
              <span className="faint tok">{item.inputTokens + item.outputTokens} tok</span>
            </button>
          ))}
        </div>
        <div id="run-detail" className="run-detail">
          {!run && <p className="faint">{t('Pick a run to see its steps and checkpoints.')}</p>}
          {run && (
            <div className="card">
              <div className="row"><span className="badge">{run.status}</span><span className="muted">{run.routingNote}</span></div>
              {run.error && <p className="badge bad">{run.error}</p>}
              <p className="faint">{t('Cost estimate $')}{run.costUsd.toFixed(4)}. Local models are $0.</p>
              <div className="row">
                <button className="btn" onClick={() => post(`/api/runs/${run.id}/control`, { action: 'resume' })}>{t('Resume')}</button>
                <button className="btn danger" onClick={() => post(`/api/runs/${run.id}/control`, { action: 'stop' })}>{t('Stop')}</button>
              </div>
            </div>
          )}
          {checkpoints.map((checkpoint) => (
            <div key={checkpoint.id} className="row" style={{ marginTop: 8 }}>
              <span className="mono faint">{checkpoint.phase}</span>
              <span>{checkpoint.note}</span>
              {selected && <button className="btn" onClick={() => post(`/api/runs/${selected}/control`, { action: 'retry_from', checkpointId: checkpoint.id })}>{t('Retry from here')}</button>}
            </div>
          ))}
          <TraceList steps={steps} />
        </div>
      </div>
    </div>
  );
}
