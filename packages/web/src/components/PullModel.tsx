import { useState } from 'react';
import { Download } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';

/** In-context "pull a model" action: runs the Ollama pull job, shows progress, then rescans. */
export function PullModel({ onDone, compact = false, suggestion = 'gemma4:e4b' }: { onDone?: () => void; compact?: boolean; suggestion?: string }) {
  const [name, setName] = useState(suggestion);
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [line, setLine] = useState('');
  async function run(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!name.trim()) return;
    setState('running'); setLine('Starting…');
    try {
      const { job } = await post<{ job: { id: string } }>('/api/setup/actions/pull-model/run', { confirm: true, model: name.trim() });
      const timer = setInterval(async () => {
        try {
          const data = await api<{ job: { status: string; output: string } }>(`/api/jobs/${job.id}`);
          setLine(data.job.output.trim().split('\n').pop() || '');
          if (data.job.status === 'running') return;
          clearInterval(timer);
          if (data.job.status === 'failed') { setState('failed'); toast(`Pull failed: ${data.job.output.trim().split('\n').pop() || 'see Setup'}`, 'error'); return; }
          await post('/api/models/scan').catch(() => undefined);
          setState('done'); toast(`${name.trim()} is ready.`, 'ok'); onDone?.();
        } catch (error) { clearInterval(timer); setState('failed'); toast(errorText(error), 'error'); }
      }, 1200);
    } catch (error) { setState('failed'); toast(errorText(error), 'error'); }
  }
  return (
    <form className={compact ? 'pull-model compact' : 'pull-model'} onSubmit={run}>
      <input aria-label="Ollama model name" value={name} onChange={(event) => setName(event.target.value)} placeholder="gemma4:e4b" disabled={state === 'running'} />
      <button className="btn primary small" disabled={state === 'running'}><Download size={14} aria-hidden /> {state === 'running' ? 'Pulling…' : 'Pull model'}</button>
      {state === 'running' && <span className="faint mono ellipsis pull-line">{line}</span>}
    </form>
  );
}
