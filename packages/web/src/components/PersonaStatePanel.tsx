import { useEffect, useState } from 'react';
import { isOwner } from '../lib/role';
import { Link } from 'react-router-dom';
import { AlertCircle, CalendarClock, CheckCircle2, ChevronRight, CircleDashed, CircleStop, FileText, KeyRound, X, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { humanSize } from '../lib/files';
import { Face, type FaceAgent } from './Face';
import { t, fmt } from '../i18n';

interface StateAgent extends FaceAgent { id: string; title?: string }
interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null }
interface Run { id: string; sessionId: string; agentId: string; status: string; startedAt: string; endedAt: string | null; modelId: string | null }
interface Schedule { id: string; agentId: string; name: string; cron: string; enabled: boolean; nextRunAt: string | null }
interface Trigger { id: string; agentId: string; name: string; kind: string; enabled: boolean }
interface FileRow { id: string; sessionId: string | null; name: string; size: number; source: 'upload' | 'agent'; createdAt: string }
interface WorkbenchInfo {
  enabled: boolean;
  state: 'running' | 'idle' | 'stopped' | 'missing' | 'unavailable';
  image: string;
  memoryBytes: number | null;
  memoryLimitBytes: number;
  cpuPercent: number | null;
  lastUsedAt: string | null;
  tools?: { node: string | null; python: string | null; uv: string | null };
}
interface Resources {
  current: {
    memory: { totalGiB: number; availableGiB: number };
    gpu: { name?: string } | null;
    disk: { totalBytes: number; freeBytes: number };
    gtt?: { usedBytes: number; totalBytes: number } | null;
    residentModels?: string[];
    workbench?: WorkbenchInfo | null;
  };
}
interface Voice { whisper: boolean; kokoro: boolean }

const ACTIVE = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_secret', 'paused']);
const ago = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms < 86_400_000 ? fmt.ago(iso) : fmt.date(iso);
};
const LANGS: [string, string][] = [['auto', 'Auto-detect'], ['en-US', 'English'], ['he-IL', 'Hebrew'], ['ar', 'Arabic'], ['ru-RU', 'Russian'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German']];
const nextAt = (iso: string | null) => (iso ? fmt.date(iso, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : t('not scheduled'));

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
      if (isOwner()) void api<{ triggers: Trigger[] }>('/api/triggers').then((data) => live && setTriggers(data.triggers.filter((row) => row.agentId === agent.id))).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [agent.id, tick]);
  useEffect(() => {
    let live = true;
    const loadResources = () => {
      if (isOwner()) void api<Resources>('/api/resources').then((data) => live && setResources(data)).catch(() => live && setResources(null));
    };
    loadResources();
    const timer = window.setInterval(loadResources, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [tick]);
  useEffect(() => {
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
    const stopped = run.status === 'stopped';
    const waitingSecret = run.status === 'awaiting_secret';
    const waitingApproval = run.status === 'awaiting_approval';
    const label = failed ? 'Run failed' : done ? 'Run finished' : stopped ? 'Run stopped' : waitingSecret ? 'Waiting for secret' : waitingApproval ? 'Waiting for approval' : ACTIVE.has(run.status) ? 'Running' : run.status.replace('_', ' ');
    const Icon = failed ? AlertCircle : done ? CheckCircle2 : stopped ? CircleStop : waitingSecret ? KeyRound : waitingApproval ? AlertCircle : CircleDashed;
    return (
      <li key={run.id}>
        <button className={`state-card state-row${failed ? ' failed' : ''}`} onClick={() => onOpenSession(run.sessionId)} title={`${label} · ${ago(run.startedAt)}`}>
          <Icon size={18} className={`state-ico${failed ? ' bad' : done ? ' ok' : ACTIVE.has(run.status) ? ' live' : ''}`} aria-hidden />
          <span className="grow"><span className="ellipsis" dir="auto">{session?.title || t('Chat')}</span><small className="faint">{label} · <span className="run-no">#{runNumber(run)}</span></small></span>
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
        <button className="icon-btn round state-close" aria-label={t('Close status panel')} onClick={onClose}><X size={18} /></button>
        <button className="state-face" onClick={onOpenPersona} title={t('Persona info')}><Face agent={agent} size={76} /></button>
        <strong className="state-name ellipsis" dir="auto" title={agent.title ? `${agent.name} · ${agent.title}` : agent.name}>{agent.name}{agent.title ? <span className="state-title"> · {agent.title}</span> : null}</strong>
        <div className="seg state-tabs" role="group" aria-label={t('Status views')}>
          <button aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>{t('Activity')}</button>
          <button aria-pressed={tab === 'library'} onClick={() => setTab('library')}>{t('Library')}</button>
        </div>
      </div>
      {tab === 'activity' ? (
        <div className="panel-body state-body">
          <section className="state-sec">
            <h4>{t('Coding')}</h4>
            {coding.length ? <ul className="state-list">{coding.map(runRow)}</ul> : <p className="faint state-empty center">{t('Ask')}{' '}{agent.name}{' '}{t('to change code in a repo, and its runs show up here')}</p>}
            {working.length > 0 && <><h5 className="faint">{t('Working now')}</h5><ul className="state-list">{working.map(runRow)}</ul></>}
          </section>
          <section className="state-sec">
            <h4>{t('Upcoming')}</h4>
            {upcoming.length ? (
              <ul className="state-list">
                {upcoming.map((row) => 'cron' in row
                  ? <li key={row.id}><Link className="state-card state-row" to="/schedules"><CalendarClock size={18} className="state-ico" aria-hidden /><span className="grow"><span className="ellipsis">{row.name}</span><small className="faint">{nextAt(row.nextRunAt)} · {row.cron}</small></span><ChevronRight size={16} className="faint" aria-hidden /></Link></li>
                  : <li key={row.id}><Link className="state-card state-row" to="/triggers"><Zap size={18} className="state-ico" aria-hidden /><span className="grow"><span className="ellipsis">{row.name}</span><small className="faint">when {row.kind} fires</small></span><ChevronRight size={16} className="faint" aria-hidden /></Link></li>)}
              </ul>
            ) : <p className="faint state-empty center">{t('Ask')}{' '}{agent.name}{' '}{t('to do something on a schedule, and it shows up here')}</p>}
          </section>
          <section className="state-sec">
            <h4>{t('Computer')}</h4>
            {(() => {
              const wb = resources?.current.workbench;
              const gtt = resources?.current.gtt;
              const resident = resources?.current.residentModels ?? [];
              const wbStateLabel = !wb ? (busy ? t('Running') : t('Stopped'))
                : !wb.enabled ? t('Ephemeral mode')
                : wb.state === 'running' ? t('Running')
                : wb.state === 'idle' ? t('Idle')
                : wb.state === 'unavailable' ? t('Docker unavailable')
                : t('Stopped');
              const wbActive = wb ? (wb.state === 'running' || wb.state === 'idle') : busy;
              const wbStats: string[] = [];
              if (wb?.cpuPercent != null) wbStats.push(`${wb.cpuPercent.toFixed(0)}% CPU`);
              if (wb?.memoryBytes != null) wbStats.push(`${(wb.memoryBytes / 1024 ** 3).toFixed(1)} / ${(wb.memoryLimitBytes / 1024 ** 3).toFixed(0)} GB`);
              const toolParts = wb?.tools ? [
                wb.tools.node ? `node ${wb.tools.node}` : null,
                wb.tools.python ? `python ${wb.tools.python}` : null,
                wb.tools.uv ? `uv ${wb.tools.uv}` : null,
              ].filter(Boolean) : [];
              return (
                <>
                  <div className="state-card computer-card">
                    <span className="grow">
                      <span className="ellipsis">{t('Shared workbench')}</span>
                      <small className="faint">
                        {wbStateLabel}{wbStats.length ? ` · ${wbStats.join(' · ')}` : ''}
                      </small>
                      {memory && (
                        <>
                          <small className="faint">{t('RAM free: {0} / {1} GB', [memory.availableGiB.toFixed(1), memory.totalGiB.toFixed(0)])}</small>
                          <span className="state-meter" role="meter" aria-label={t('Memory in use')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 - (memory.availableGiB / memory.totalGiB) * 100)}><span style={{ width: `${Math.round(100 - (memory.availableGiB / memory.totalGiB) * 100)}%` }} /></span>
                        </>
                      )}
                      {gtt && (
                        <small className="faint">{t('GTT: {0} / {1} GB', [(gtt.usedBytes / 1024 ** 3).toFixed(1), (gtt.totalBytes / 1024 ** 3).toFixed(0)])}</small>
                      )}
                      {resources && (
                        <small className="faint ellipsis" title={resident.join(', ')}>
                          {resident.length ? `${t('Resident models')}: ${resident.join(', ')}` : t('No resident models')}
                        </small>
                      )}
                      {toolParts.length > 0 && (
                        <small className="faint ellipsis" dir="ltr">{toolParts.join(' · ')}</small>
                      )}
                    </span>
                    <span className={`computer-thumb${wbActive ? ' awake' : ''}`} aria-hidden><Face agent={agent} size={26} /></span>
                  </div>
                  {resources && <p className="faint state-detail">{t('Disk')}{' '}{(resources.current.disk.freeBytes / 1024 ** 3).toFixed(0)}{' '}{t('GB free')}{resources.current.gpu?.name ? ` · ${resources.current.gpu.name}` : t(' · no GPU')}</p>}
                </>
              );
            })()}
          </section>
          <section className="state-sec">
            <h4>{t('Voice chat')}</h4>
            <div className="state-card voice-card">
              <label className="voice-row"><span>{t('Voice')}</span>
                <select value={voiceName} onChange={(event) => setVoiceName(event.target.value)} aria-label={t('Voice')}>
                  <option value="default">{voice?.kokoro ? t('Kokoro (local)') : t('Browser default')}</option>
                  {voices.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="voice-row"><span>{t('Language')}</span>
                <select value={voiceLang} onChange={(event) => setVoiceLang(event.target.value)} aria-label={t('Language')}>
                  {LANGS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
                </select>
              </label>
            </div>
            <p className="faint state-detail">{voice ? <>{t('Hold the mic to talk ·')}{' '}{voice.whisper ? t('local Whisper') : t('browser dictation')}</> : t('Hold the mic button to talk.')}</p>
          </section>
        </div>
      ) : (
        <div className="panel-body state-body">
          {files.length ? (
            <ul className="state-list">
              {files.slice(0, 40).map((file) => (
                <li key={file.id}><button className="state-row" onClick={() => onOpenFile(file.id)}><FileText size={14} aria-hidden /><span className="grow"><span className="ellipsis" dir="auto">{file.name}</span><small className="faint">{file.source === 'agent' ? t('from the agent') : t('from you')} · {humanSize(file.size)} · {ago(file.createdAt)}</small></span></button></li>
              ))}
            </ul>
          ) : <p className="faint state-empty">{t('Files you share with')}{' '}{agent.name}{t(', and files it makes, show up here.')}</p>}
          <Link className="link-btn state-more" to="/library">{t('Open the Library')}</Link>
        </div>
      )}
    </aside>
  );
}
