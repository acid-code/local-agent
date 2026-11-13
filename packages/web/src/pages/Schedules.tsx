import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Schedule { id: string; name: string; cron: string; prompt: string; enabled: boolean; nextRunAt: string | null; lastStatus: string | null }
interface Agent { id: string; name: string }

export function Schedules() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('Morning note');
  const [cron, setCron] = useState('0 8 * * *');
  const [prompt, setPrompt] = useState('Summarize anything I should remember today.');
  const [agentId, setAgentId] = useState('');

  async function load() {
    setRows((await api<{ schedules: Schedule[] }>('/api/schedules')).schedules);
    const list = (await api<{ agents: Agent[] }>('/api/agents')).agents;
    setAgents(list);
    if (!agentId && list[0]) setAgentId(list[0].id);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Schedules</h1>
      <p className="lede">Five-field cron, one prompt, one persona. A missed run while the box was off fires once on the next tick, then waits for the following time. It does not replay a backlog.</p>
      <form className="card" onSubmit={async (event) => { event.preventDefault(); await post('/api/schedules', { agentId, name, cron, prompt }); await load(); }}>
        <label className="field"><span>Persona</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Cron</span><input value={cron} onChange={(event) => setCron(event.target.value)} /></label>
        <label className="field"><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <button className="btn primary">Save routine</button>
      </form>
      {rows.map((row) => (
        <article key={row.id} className="card">
          <h3>{row.name}</h3>
          <p className="mono">{row.cron}</p>
          <p className="muted">{row.prompt}</p>
          <p className="faint">Next {row.nextRunAt || '—'} · {row.lastStatus || 'never run'}</p>
          <button className="btn" onClick={() => post(`/api/schedules/${row.id}/run`)}>Run now</button>
        </article>
      ))}
    </div>
  );
}
