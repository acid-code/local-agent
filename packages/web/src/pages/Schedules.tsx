import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { EmptyState, PageHeader } from '../components/ui';
import { CalendarClock, Plus } from 'lucide-react';
import { t } from '../i18n';

interface Schedule { id: string; name: string; cron: string; prompt: string; enabled: boolean; nextRunAt: string | null; lastStatus: string | null }
interface Agent { id: string; name: string }

export function Schedules() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('Morning note');
  const [cron, setCron] = useState('0 8 * * *');
  const [prompt, setPrompt] = useState('Summarize anything I should remember today.');
  const [agentId, setAgentId] = useState('');
  const [adding, setAdding] = useState(false);

  async function load() {
    setRows((await api<{ schedules: Schedule[] }>('/api/schedules')).schedules);
    const list = (await api<{ agents: Agent[] }>('/api/agents')).agents;
    setAgents(list);
    if (!agentId && list[0]) setAgentId(list[0].id);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <PageHeader title={t('Schedules')} description={t('Run a prompt on a timetable with one persona. A run missed while the box was off fires once when it is back; it never replays a backlog.')} actions={<button className="btn primary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><Plus size={16} aria-hidden />{' '}{t('New schedule')}</button>} />
      {adding && (
      <form className="card section" onSubmit={async (event) => { event.preventDefault(); await post('/api/schedules', { agentId, name, cron, prompt }); await load(); setAdding(false); }}>
        <label className="field"><span>{t('Persona')}</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field"><span>{t('Name')}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>{t('Cron')}</span><input value={cron} onChange={(event) => setCron(event.target.value)} /></label>
        <label className="field"><span>{t('Prompt')}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <button className="btn primary">{t('Save routine')}</button>
      </form>
      )}
      {!adding && rows.length === 0 && <EmptyState icon={CalendarClock} title={t('No schedules yet')} action={<button className="btn primary" onClick={() => setAdding(true)}>{t('New schedule')}</button>}>{t('A schedule sends a prompt to a persona on a timetable, like a morning summary at 8:00.')}</EmptyState>}
      {rows.map((row) => (
        <article key={row.id} className="card">
          <h3>{row.name}</h3>
          <p className="mono">{row.cron}</p>
          <p className="muted">{row.prompt}</p>
          <p className="faint">{t('Next')}{' '}{row.nextRunAt || '—'} · {row.lastStatus || t('never run')}</p>
          <button className="btn" onClick={() => post(`/api/schedules/${row.id}/run`)}>{t('Run now')}</button>
        </article>
      ))}
    </div>
  );
}
