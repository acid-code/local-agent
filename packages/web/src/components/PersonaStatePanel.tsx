import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CalendarClock, CheckCircle2, ChevronRight, CircleDashed, FileText, X, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { humanSize } from '../lib/files';
import { Face, type FaceAgent } from './Face';

interface StateAgent extends FaceAgent { id: string; title?: string }
interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null }
interface Run { id: string; sessionId: string; agentId: string; status: string; startedAt: string; endedAt: string | null; modelId: string | null }
interface Schedule { id: string; agentId: string; name: string; cron: string; enabled: boolean; nextRunAt: string | null }
interface Trigger { id: string; agentId: string; name: string; kind: string; enabled: boolean }
interface FileRow { id: string; sessionId: string | null; name: string; size: number; source: 'upload' | 'agent'; createdAt: string }
interface Resources { current: { memory: { totalGiB: number; availableGiB: number }; gpu: { name?: string } | null; disk: { totalBytes: number; freeBytes: number } } }
interface Voice { whisper: boolean; kokoro: boolean }

const ACTIVE = new Set(['queued', 'running', 'awaiting_approval', 'paused']);
const ago = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h ago` : new Date(iso).toLocaleDateString();
};
const LANGS: [string, string][] = [['auto', 'Auto-detect'], ['en-US', 'English'], ['he-IL', 'Hebrew'], ['ar', 'Arabic'], ['ru-RU', 'Russian'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German']];
const nextAt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'not scheduled');

/** The active persona at a glance: what it is coding, what is coming up, the computer it runs on, and voice. */
export function PersonaStatePanel({ agent, sessions, tick, onClose, onOpenSession, onOpenFile, onOpenPersona }: {
  agent: StateAgent; sessions: Session[]; tick: number; onClose: () => void;
  onOpenSession: (id: string) => void; onOpenFile: (id: string) => void; onOpenPersona: () => void;
}) {
  const [tab, setTab] = useState<'activity' | 'library'>('activity');
  const [runs, setRuns] = useState<Run[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [resources, setResources] = useState<Resources | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const mine = new Map(sessions.filter((session) => session.agentId === agent.id).map((session) => [session.id, session]));

  useEffect(() => {
    let live = true;
    const load = () => {
      void api<{ runs: Run[] }>('/api/runs').then((data) => live && setRuns(data.runs.filter((run) => run.agentId === agent.id))).catch(() => undefined);
      void api<{ schedules: Schedule[] }>('/api/schedules').then((data) => live && setSchedules(data.schedules.filter((row) => row.agentId === agent.id))).catch(() => undefined);
      void api<{ triggers: Trigger[] }>('/api/triggers').then((data) => live && setTriggers(data.triggers.filter((row) => row.agentId === agent.id))).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [agent.id, tick]);
  useEffect(() => {
    void api<Resources>('/api/resources').then(setResources).catch(() => setResources(null));
    void api<Voice>('/api/voice').then(setVoice).catch(() => setVoice(null));
  }, []);
  useEffect(() => {
    if (tab !== 'library') return;
    void api<{ files: FileRow[] }>('/api/files?limit=200').then((data) => setFiles(data.files.filter((file) => file.sessionId && mine.has(file.sessionId)))).catch(() => undefined);
  }, [tab, agent.id, tick, sessions.length]);

  const coding = runs.filter((run) => { const session = mine.get(run.sessionId); return session && (session.mode === 'code' || session.workshopId); }).slice(0, 5);
  const working = runs.filter((run) => ACTIVE.has(run.status) && !coding.includes(run)).slice(0, 3);
  const upcoming = [...schedules.filter((row) => row.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt))), ...triggers.filter((row) => row.enabled)].slice(0, 6);
  const memory = resources?.current.memory;

  // "#2" = the second run in that chat, like the reference's "Run failed · #1".
  const runNumber = (run: Run) => runs.filter((row) => row.sessionId === run.sessionId && row.startedAt <= run.startedAt).length;
  const runRow = (run: Run) => {
    const session = mine.get(run.sessionId);
    const failed = run.status === 'failed';
    const done = run.status === 'completed';
    const label = failed ? 'Run failed' : done ? 'Run finished' : ACTIVE.has(run.status) ? 'Running' : run.status.replace('_', ' ');
    return (
      <li key={run.id}>
        <button className={`state-card state-row${failed ? ' failed' : ''}`} onClick={() => onOpenSession(run.sessionId)} title={`${label} · ${ago(run.startedAt)}`}>
          {failed ? <AlertCircle size={18} className="state-ico bad" aria-hidden /> : done ? <CheckCircle2 size={18} className="state-ico ok" aria-hidden /> : <CircleDashed size={18} className="state-ico live" aria-hidden />}
          <span className="grow"><span className="ellipsis" dir="auto">{session?.title || 'Chat'}</span><small className="faint">{label} · <span className="run-no">#{runNumber(run)}</span></small></span>
          <ChevronRight size={16} className="faint" aria-hidden />
        </button>
      </li>
    );
  };
  const [voiceName, setVoiceName] = useState(() => localStorage.getItem('la-voice') || 'default');
  const [voiceLang, setVoiceLang] = useState(() => localStorage.getItem('la-voice-lang') || 'auto');
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    const read = () => setVoices([...new Set(synth.getVoices().map((row) => row.name))].slice(0, 30));
    read();
    synth.addEventListener?.('voiceschanged', read);
    return () => synth.removeEventListener?.('voiceschanged', read);
  }, []);
  useEffect(() => { localStorage.setItem('la-voice', voiceName); }, [voiceName]);
  useEffect(() => { localStorage.setItem('la-voice-lang', voiceLang); }, [voiceLang]);
  const busy = runs.some((run) => ACTIVE.has(run.status));

  return (
    <aside className="side-panel state-panel" aria-label={`${agent.name} status`} style={agent.accent ? { ['--persona' as string]: agent.accent } : undefined}>
      <div className="state-hero">
        <button className="icon-btn round state-close" aria-label="Close status panel" onClick={onClose}><X size={18} /></button>
        <button className="state-face" onClick={onOpenPersona} title="Persona info"><Face agent={agent} size={76} /></button>
        <strong className="state-name ellipsis" dir="auto" title={agent.title ? `${agent.name} · ${agent.title}` : agent.name}>{agent.name}{agent.title ? <span className="state-title"> · {agent.title}</span> : null}</strong>
        <div className="seg state-tabs" role="group" aria-label="Status views">
          <button aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Activity</button>
          <button aria-pressed={tab === 'library'} onClick={() => setTab('library')}>Library</button>
        </div>
      </div>
      {tab === 'activity' ? (
        <div className="panel-body state-body">
          <section className="state-sec">
            <h4>Coding</h4>
            {coding.length ? <ul className="state-list">{coding.map(runRow)}</ul> : <p className="faint state-empty center">Ask {agent.name} to change code in a repo, and its runs show up here</p>}
            {working.length > 0 && <><h5 className="faint">Working now</h5><ul className="state-list">{working.map(runRow)}</ul></>}
          </section>
          <section className="state-sec">
            <h4>Upcoming</h4>
            {upcoming.length ? (
              <ul className="state-list">
                {upcoming.map((row) => 'cron' in row
                  ? <li key={row.id}><Link className="state-card state-row" to="/schedules"><CalendarClock size={18} className="state-ico" aria-hidden /><span className="grow"><span className="ellipsis">{row.name}</span><small className="faint">{nextAt(row.nextRunAt)} · {row.cron}</small></span><ChevronRight size={16} className="faint" aria-hidden /></Link></li>
                  : <li key={row.id}><Link className="state-card state-row" to="/triggers"><Zap size={18} className="state-ico" aria-hidden /><span className="grow"><span className="ellipsis">{row.name}</span><small className="faint">when {row.kind} fires</small></span><ChevronRight size={16} className="faint" aria-hidden /></Link></li>)}
              </ul>
            ) : <p className="faint state-empty center">Ask {agent.name} to do something on a schedule, and it shows up here</p>}
          </section>
          <section className="state-sec">
            <h4>Computer</h4>
            <div className="state-card computer-card">
              <span className="grow">
                <span className="ellipsis" dir="auto">{agent.name}'s computer</span>
                <small className="faint">{busy ? 'Working' : 'Asleep'}{memory ? ` · ${memory.availableGiB.toFixed(1)} of ${memory.totalGiB.toFixed(0)} GB free` : ''}</small>
                {memory && <span className="state-meter" role="meter" aria-label="Memory in use" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 - (memory.availableGiB / memory.totalGiB) * 100)}><span style={{ width: `${Math.round(100 - (memory.availableGiB / memory.totalGiB) * 100)}%` }} /></span>}
              </span>
              <span className={`computer-thumb${busy ? ' awake' : ''}`} aria-hidden><Face agent={agent} size={26} /></span>
            </div>
            {resources && <p className="faint state-detail">Disk {(resources.current.disk.freeBytes / 1024 ** 3).toFixed(0)} GB free{resources.current.gpu?.name ? ` · ${resources.current.gpu.name}` : ' · no GPU'}</p>}
          </section>
          <section className="state-sec">
            <h4>Voice chat</h4>
            <div className="state-card voice-card">
              <label className="voice-row"><span>Voice</span>
                <select value={voiceName} onChange={(event) => setVoiceName(event.target.value)} aria-label="Voice">
                  <option value="default">{voice?.kokoro ? 'Kokoro (local)' : 'Browser default'}</option>
                  {voices.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="voice-row"><span>Language</span>
                <select value={voiceLang} onChange={(event) => setVoiceLang(event.target.value)} aria-label="Language">
                  {LANGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            <p className="faint state-detail">{voice ? <>Hold the mic to talk · {voice.whisper ? 'local Whisper' : 'browser dictation'}</> : 'Hold the mic button to talk.'}</p>
          </section>
        </div>
      ) : (
        <div className="panel-body state-body">
          {files.length ? (
            <ul className="state-list">
              {files.slice(0, 40).map((file) => (
                <li key={file.id}><button className="state-row" onClick={() => onOpenFile(file.id)}><FileText size={14} aria-hidden /><span className="grow"><span className="ellipsis" dir="auto">{file.name}</span><small className="faint">{file.source === 'agent' ? 'from the agent' : 'from you'} · {humanSize(file.size)} · {ago(file.createdAt)}</small></span></button></li>
              ))}
            </ul>
          ) : <p className="faint state-empty">Files you share with {agent.name}, and files it makes, show up here.</p>}
          <Link className="link-btn state-more" to="/library">Open the Library</Link>
        </div>
      )}
    </aside>
  );
}
