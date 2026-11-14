import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, post } from '../lib/api';

interface Run { id: string; status: string; modelId: string | null; routingNote: string | null; inputTokens: number; outputTokens: number; costUsd: number; error: string | null; startedAt: string }
interface Step { id: string; index: number; kind: string; name: string; status: string; input: unknown; output: unknown; latencyMs: number; tokensIn: number; tokensOut: number; error: string | null }
interface Checkpoint { id: string; note: string; phase: string; createdAt: string }

export function Runs() {
  const params = useParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(params.id || null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api<{ runs: Run[] }>('/api/runs').then((data) => setRuns(data.runs)); }, []);
  useEffect(() => {
    if (!selected) return;
    api<{ steps: Step[]; checkpoints: Checkpoint[] }>(`/api/runs/${selected}`).then((data) => { setSteps(data.steps); setCheckpoints(data.checkpoints); });
  }, [selected]);

  const run = runs.find((item) => item.id === selected);

  return (
    <div className="page">
      <h1>Runs</h1>
      <p className="lede">A run is a persisted state machine. If the process dies, it resumes from the last checkpoint instead of hanging. Retry from an earlier checkpoint does not pretend to undo files that already changed — use the edit checkpoint for that.</p>
      <div className="runs-grid">
        <div className="run-list">
          {runs.length === 0 && <p className="faint">No runs yet. Every chat reply becomes one.</p>}
          {runs.map((item) => (
            <button key={item.id} className={item.id === selected ? 'run-item active' : 'run-item'} onClick={() => { setSelected(item.id); if (window.innerWidth <= 980) setTimeout(() => document.getElementById('run-detail')?.scrollIntoView({ behavior: 'smooth' }), 50); }}>
              <span className="mono ellipsis">{item.id}</span>
              <span className={`badge ${item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'bad' : item.status === 'running' ? 'warn' : ''}`}>{item.status}</span>
              <span className="faint tok">{item.inputTokens + item.outputTokens} tok</span>
            </button>
          ))}
        </div>
        <div id="run-detail" className="run-detail">
          {!run && <p className="faint">Pick a run to see its steps and checkpoints.</p>}
          {run && (
            <div className="card">
              <div className="row"><span className="badge">{run.status}</span><span className="muted">{run.routingNote}</span></div>
              {run.error && <p className="badge bad">{run.error}</p>}
              <p className="faint">Cost estimate ${run.costUsd.toFixed(4)}. Local models are $0.</p>
              <div className="row">
                <button className="btn" onClick={() => post(`/api/runs/${run.id}/control`, { action: 'resume' })}>Resume</button>
                <button className="btn danger" onClick={() => post(`/api/runs/${run.id}/control`, { action: 'stop' })}>Stop</button>
              </div>
            </div>
          )}
          {checkpoints.map((checkpoint) => (
            <div key={checkpoint.id} className="row" style={{ marginTop: 8 }}>
              <span className="mono faint">{checkpoint.phase}</span>
              <span>{checkpoint.note}</span>
              {selected && <button className="btn" onClick={() => post(`/api/runs/${selected}/control`, { action: 'retry_from', checkpointId: checkpoint.id })}>Retry from here</button>}
            </div>
          ))}
          {steps.map((step) => (
            <button key={step.id} className="card step-card" aria-expanded={open === step.id} onClick={() => setOpen(open === step.id ? null : step.id)}>
              <strong>{step.index}. {step.kind}</strong> · {step.name} · {step.status} · {step.latencyMs} ms
              {open === step.id && <pre className="command">{JSON.stringify({ input: step.input, output: step.output, error: step.error }, null, 2)}</pre>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
