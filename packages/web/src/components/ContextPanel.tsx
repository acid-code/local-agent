import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bot, CalendarClock, FileText, Pause, Play, RotateCcw, Square, Trash2, X, Zap } from 'lucide-react';
import { api, post } from '../lib/api';
import { humanSize, rawUrl, type FileMeta } from '../lib/files';
import { errorText, toast } from '../lib/toast';
import { Markdown } from './Markdown';

interface Helper { id: string; agentName: string; task: string; status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'; result: string | null; error: string | null; childSessionId: string; childRunId: string | null; cli: string | null; maxSteps: number; timeoutMs: number; createdAt: string; endedAt: string | null }
interface Approval { id: string; runId: string; reason: string }
interface Timer { id: string; name: string; cron: string; enabled: boolean; nextRunAt?: string | null; createdBy: string }
interface Trigger { id: string; name: string; kind: string; enabled: boolean; createdBy: string }
interface Checkpoint { runId: string; edits: number; labels: string; createdAt: string }
type ProducedFile = FileMeta & { helperId?: string };
export interface ChatContext { helpers: Helper[]; approvals: Approval[]; timers: Timer[]; triggers: Trigger[]; files: { uploads: FileMeta[]; produced: ProducedFile[] }; checkpoints: Checkpoint[] }
interface TranscriptMessage { id: string; role: string; content: string; toolName?: string | null }

const STATUS_LABEL: Record<Helper['status'], string> = { running: 'Running', waiting: 'Needs you', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const ago = (iso?: string | null) => {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(iso).toLocaleDateString();
};

/** Everything this chat set in motion: helpers, timers and triggers it created, files both ways, and replies that can be rolled back. */
export function ContextPanel({ sessionId, tick, onClose, onOpenFile, onRolledBack }: { sessionId: string; tick: number; onClose: () => void; onOpenFile: (id: string) => void; onRolledBack: () => void }) {
  const [data, setData] = useState<ChatContext | null>(null);
  const [transcript, setTranscript] = useState<{ helper: Helper; messages: TranscriptMessage[] } | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<ChatContext>(`/api/sessions/${sessionId}/context`)); } catch (error) { toast(errorText(error), 'error'); }
  }, [sessionId]);
  useEffect(() => { void load(); }, [load, tick]);
  // Poll while a helper is busy, so status and results show up without a reload.
  const busy = Boolean(data?.helpers.some((row) => row.status === 'running' || row.status === 'waiting'));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [busy, load]);

  async function act(action: () => Promise<unknown>, done?: string) {
    try { await action(); if (done) toast(done, 'ok'); await load(); } catch (error) { toast(errorText(error), 'error'); }
  }
  async function openTranscript(helper: Helper) {
    try {
      const res = await api<{ messages: TranscriptMessage[] }>(`/api/sessions/${helper.childSessionId}`);
      setTranscript({ helper, messages: res.messages.filter((row) => row.role === 'user' || row.role === 'assistant' || row.role === 'tool') });
    } catch (error) { toast(errorText(error), 'error'); }
  }

  if (transcript) {
    return (
      <aside className="side-panel open context-pane" aria-label="Helper transcript">
        <div className="panel-head pane-head">
          <button className="icon-btn" aria-label="Back to chat context" onClick={() => setTranscript(null)}><ArrowLeft size={16} /></button>
          <strong className="grow ellipsis">{transcript.helper.agentName} · helper</strong>
          <span className={`ctx-status ${transcript.helper.status}`}>{STATUS_LABEL[transcript.helper.status]}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="panel-body ctx-transcript">
          <p className="faint">Read-only. This helper ran on its own with up to {transcript.helper.maxSteps} steps and {Math.round(transcript.helper.timeoutMs / 60000)} min.</p>
          {transcript.messages.map((row) => row.role === 'tool'
            ? <details key={row.id} className="ctx-tool"><summary className="faint">{row.toolName || 'tool'} output</summary><pre className="mono tool-output">{row.content.slice(0, 3000)}</pre></details>
            : <div key={row.id} className={`ctx-msg ${row.role}`}><small className="faint">{row.role === 'user' ? 'Task' : transcript.helper.agentName}</small><Markdown text={row.content} sourceId={row.id} /></div>)}
        </div>
      </aside>
    );
  }

  const files = data?.files;
  return (
    <aside className="side-panel open context-pane" aria-label="Chat context">
      <div className="panel-head pane-head"><strong className="grow">This chat</strong><button className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
      {!data ? <div className="panel-body"><div className="skeleton-lines"><span /><span /></div></div> : (
        <div className="panel-body pane-overview">
          <section className="pane-section">
            <h4>Helpers</h4>
            {data.helpers.length === 0 ? <p className="faint">None yet. A persona can start helpers in the background for side tasks.</p> : (
              <ul className="ctx-list">
                {data.helpers.map((helper) => (
                  <li key={helper.id} className="ctx-item">
                    <div className="row">
                      <span className={`dot ${helper.status === 'done' ? 'ok' : helper.status === 'failed' ? 'bad' : helper.status === 'stopped' ? '' : 'live'}`} aria-hidden />
                      <Bot size={14} aria-hidden />
                      <strong className="ellipsis">{helper.agentName}</strong>
                      {helper.cli && <span className="faint mono">{helper.cli}</span>}
                      <span className={`ctx-status ${helper.status}`}>{STATUS_LABEL[helper.status]}</span>
                    </div>
                    <p className="ctx-task" dir="auto">{helper.task}</p>
                    {helper.error && helper.status !== 'done' && <p className="faint ctx-err">{helper.error}</p>}
                    <div className="row ctx-actions">
                      <span className="faint grow">{ago(helper.endedAt || helper.createdAt)}</span>
                      {(helper.status === 'running' || helper.status === 'waiting') && <button className="btn ghost small" onClick={() => void act(() => post(`/api/helpers/${helper.id}/stop`, {}), 'Helper stopped.')}><Square size={13} aria-hidden /> Stop</button>}
                      <button className="btn ghost small" onClick={() => void openTranscript(helper)}>Transcript</button>
                    </div>
                    {data.approvals.filter((row) => row.runId === helper.childRunId).map((approval) => (
                      <div key={approval.id} className="ctx-approval">
                        <p dir="auto">{approval.reason}</p>
                        <div className="row"><button className="btn primary small" onClick={() => void act(() => post(`/api/approvals/${approval.id}`, { decision: 'approve' }))}>Approve</button><button className="btn ghost small" onClick={() => void act(() => post(`/api/approvals/${approval.id}`, { decision: 'deny' }))}>Deny</button></div>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="pane-section">
            <h4>Timers and triggers</h4>
            {data.timers.length + data.triggers.length === 0 ? <p className="faint">Nothing scheduled from this chat.</p> : (
              <ul className="pane-list ctx-sched">
                {data.timers.map((timer) => (
                  <li key={timer.id}>
                    <CalendarClock size={14} aria-hidden />
                    <span className="grow ellipsis" title={timer.nextRunAt ? `Next: ${new Date(timer.nextRunAt).toLocaleString()}` : undefined}>{timer.name}{!timer.enabled && <span className="faint"> · paused</span>}</span>
                    <span className="faint mono">{timer.cron}</span>
                    <button className="icon-btn sm" aria-label={timer.enabled ? `Pause ${timer.name}` : `Resume ${timer.name}`} onClick={() => void act(() => api(`/api/schedules/${timer.id}`, { method: 'PATCH', body: JSON.stringify(timer.enabled ? { enabled: false } : { enabled: true, cron: timer.cron }) }))}>{timer.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
                    <button className="icon-btn sm" aria-label={`Delete ${timer.name}`} onClick={() => { if (window.confirm(`Delete timer “${timer.name}”?`)) void act(() => api(`/api/schedules/${timer.id}`, { method: 'DELETE' }), 'Timer deleted.'); }}><Trash2 size={13} /></button>
                  </li>
                ))}
                {data.triggers.map((trigger) => (
                  <li key={trigger.id}>
                    <Zap size={14} aria-hidden />
                    <span className="grow ellipsis">{trigger.name}{!trigger.enabled && <span className="faint"> · paused</span>}</span>
                    <span className="faint">{trigger.kind}</span>
                    <button className="icon-btn sm" aria-label={trigger.enabled ? `Pause ${trigger.name}` : `Resume ${trigger.name}`} onClick={() => void act(() => api(`/api/triggers/${trigger.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !trigger.enabled }) }))}>{trigger.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
                    <button className="icon-btn sm" aria-label={`Delete ${trigger.name}`} onClick={() => { if (window.confirm(`Delete trigger “${trigger.name}”?`)) void act(() => api(`/api/triggers/${trigger.id}`, { method: 'DELETE' }), 'Trigger deleted.'); }}><Trash2 size={13} /></button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="pane-section">
            <h4>Files</h4>
            <FileGroup title="From you" files={files!.uploads} empty="No uploads in this chat." onOpen={onOpenFile} />
            <FileGroup title="From agents" files={files!.produced} empty="Nothing produced yet." onOpen={onOpenFile} />
          </section>

          {data.checkpoints.length > 0 && (
            <section className="pane-section">
              <h4>File edits</h4>
              <ul className="pane-list">
                {data.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.runId}>
                    <FileText size={14} aria-hidden />
                    <span className="grow ellipsis" title={checkpoint.labels}>{checkpoint.edits} edit{checkpoint.edits === 1 ? '' : 's'} · {checkpoint.labels}</span>
                    <span className="faint">{ago(checkpoint.createdAt)}</span>
                    <button className="btn ghost small" title="Undo every file change this reply made" onClick={() => { if (window.confirm(`Undo ${checkpoint.edits} file edit${checkpoint.edits === 1 ? '' : 's'} from this reply?`)) void act(async () => { await post(`/api/runs/${checkpoint.runId}/rollback`, {}); onRolledBack(); }, 'Rolled back.'); }}><RotateCcw size={13} aria-hidden /> Roll back</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

function FileGroup({ title, files, empty, onOpen }: { title: string; files: ProducedFile[]; empty: string; onOpen: (id: string) => void }) {
  return (
    <div className="ctx-files">
      <small className="faint">{title} · {files.length}</small>
      {files.length === 0 ? <p className="faint">{empty}</p> : (
        <ul className="pane-list">
          {files.slice(0, 30).map((file) => (
            <li key={file.id}>
              <FileText size={14} aria-hidden />
              <button className="link-btn grow ellipsis" onClick={() => onOpen(file.id)}>{file.name}</button>
              {file.helperId && <span className="faint">helper</span>}
              <a className="faint" href={rawUrl(file.id, true)} aria-label={`Download ${file.name}`}>{humanSize(file.size)}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
