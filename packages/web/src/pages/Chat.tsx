import { CuteArt } from '../components/CuteArt';
import { useEffect, useRef, useState } from 'react';
import { AtSign, Brain, Check, ChevronDown, Copy, Download, Eye, FileText, Folder, ListTree, Menu, Mic, Paperclip, Pencil, Quote, RotateCcw, Send, Square, Trash2, Wrench, X } from 'lucide-react';
import { CiteContext, type CiteHandlers } from '../components/Markdown';
import { FileViewer, type QuotePick, type ViewerSource } from '../components/FileViewer';
import { MentionPicker, type MentionPick } from '../components/MentionPicker';
import { CONTEXT_MARK, citationsIn, fileMeta, humanSize, kindOf, quoteBlock, rawUrl, saveFile, uploadFile, type Cite, type FileMeta } from '../lib/files';
import { Link, useLocation } from 'react-router-dom';
import { parseSources, toolSummary } from '@local-agent/shared';
import { toast, errorText } from '../lib/toast';
import { api, post } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { Face, type FaceAgent } from '../components/Face';

interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null; modelPin?: string | null }
interface ModelChoice { id: string; name: string; embedding?: boolean; enabled?: boolean }
interface ProjectDraft { label: string; path: string }
interface Agent extends FaceAgent { id: string; name: string }
interface Message { id: string; role: string; content: string; agentId?: string | null; toolName?: string | null; routingNote?: string | null; toolCalls?: { name: string }[] | null }
interface Step { id: string; kind: string; name: string; status: string; latencyMs?: number; output?: unknown; error?: string | null }
interface Plan { id: string; items: { id: string; text: string; status: string }[] }
interface Edit { id: string; label: string; diff: string; revertedAt: string | null }
interface Offer { id: string; kind: string; masked: string }
interface CheckItem { id: string; title: string; ok: boolean; detail: string; optional: boolean }

const draftKey = (id: string) => `la-draft:${id}`;

export function Chat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [secret, setSecret] = useState<{ id: string; name: string; reason: string } | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const [projects, setProjects] = useState<ProjectDraft[]>([{ label: 'server', path: '' }, { label: 'apk', path: '' }]);
  const [shopName, setShopName] = useState('Server and app');
  const [shopNote, setShopNote] = useState('');
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelPin, setModelPin] = useState<string | null>(null);
  const [loadingNote, setLoadingNote] = useState('');
  const [meter, setMeter] = useState<{ used: number; budget: number } | null>(null);
  const [rail, setRail] = useState(false);
  const [trace, setTrace] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [thinking, setThinking] = useState('');
  const [runError, setRunError] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<CheckItem[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const [quotes, setQuotes] = useState<(QuotePick & { key: string })[]>([]);
  const [mentions, setMentions] = useState<(MentionPick & { key: string })[]>([]);
  const [viewer, setViewer] = useState<{ source: ViewerSource; anchor?: string } | null>(null);
  const [picker, setPicker] = useState<{ query: string } | null>(null);
  const [selQuote, setSelQuote] = useState<{ x: number; y: number; text: string; id: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pendingJump = useRef<string | null>(null);
  const active = ['running', 'loading', 'waiting', 'paused', 'awaiting_approval'].includes(status);

  async function refreshLists() {
    const [sessionRes, agentRes] = await Promise.all([
      api<{ sessions: Session[]; nextCursor: string | null }>('/api/sessions?limit=50'),
      api<{ agents: Agent[] }>('/api/agents'),
    ]);
    setSessions(sessionRes.sessions);
    setNextCursor(sessionRes.nextCursor);
    setAgents(agentRes.agents);
    return sessionRes.sessions;
  }

  async function loadMoreSessions() {
    if (!nextCursor) return;
    const page = await api<{ sessions: Session[]; nextCursor: string | null }>(`/api/sessions?limit=50&cursor=${encodeURIComponent(nextCursor)}`);
    setSessions((rows) => [...rows, ...page.sessions.filter((row) => !rows.some((have) => have.id === row.id))]);
    setNextCursor(page.nextCursor);
  }

  async function openSession(id: string) {
    // Restore this chat's unsent draft in the same render as the switch, so the save effect never wipes it.
    if (!new URLSearchParams(window.location.search).get('share')) setDraft(localStorage.getItem(draftKey(id)) || '');
    setCurrent(id);
    const data = await api<{ session: Session; messages: Message[]; plan: Plan | null; edits: Edit[] }>(`/api/sessions/${id}`);
    setMessages(data.messages);
    setPlan(data.plan);
    setEdits(data.edits);
    setMode(data.session.mode);
    setModelPin(data.session.modelPin || null);
    setStreaming('');
    setThinking('');
    setRunError(null);
    if (data.session.agentId) await post(`/api/agents/${data.session.agentId}/read`, {}).catch(() => undefined);
  }

  const location = useLocation();
  useEffect(() => {
    api<{ models: ModelChoice[] }>('/api/models').then((data) => setModels(data.models)).catch(() => undefined);
    const share = new URLSearchParams(location.search).get('share');
    if (share) setDraft(share);
    const persona = new URLSearchParams(location.search).get('persona');
    refreshLists().then(async (rows) => {
      if (persona) {
        const existing = rows.find((session) => session.agentId === persona);
        if (existing) await openSession(existing.id);
        else {
          const created = await post<{ session: Session }>('/api/sessions', { agentId: persona, title: 'New chat' });
          await openSession(created.session.id);
        }
        await post(`/api/agents/${persona}/read`, {});
        return;
      }
      if (rows[0]) void openSession(rows[0].id);
    }).catch(() => undefined);
  }, [location.search]);
  useEffect(() => {
    if (pendingJump.current && messages.some((m) => m.id === pendingJump.current)) {
      const id = pendingJump.current; pendingJump.current = null;
      setTimeout(() => flash(id), 50);
      return;
    }
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages, streaming, thinking, runError]);
  // Keep an unsent draft per chat, so a reload or a failed send never loses it.
  useEffect(() => {
    if (!current) return;
    if (draft) localStorage.setItem(draftKey(current), draft); else localStorage.removeItem(draftKey(current));
  }, [draft, current]);
  useEffect(() => {
    api<{ scan: unknown; checklist: CheckItem[] }>('/api/discovery').then((data) => setChecklist(data.scan ? data.checklist || [] : [])).catch(() => undefined);
  }, []);
  // Esc stops a running reply (when no dialog or menu has focus).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (rail) { setRail(false); return; }
      if (active && runId) { event.preventDefault(); void control('stop'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, runId, rail]);
  // Grow the composer with its text, up to the CSS max height.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        setSteps(data.steps || []);
        setStatus(data.run?.status || '');
      }
      if (data.type === 'token') setStreaming((value) => value + data.text);
      if (data.type === 'thinking') setThinking((value) => value + data.text);
      if (data.type === 'error') setRunError(String(data.message || 'The reply failed.'));
      if (data.type === 'step' && data.step) {
        setSteps((value) => [...value.filter((step) => step.id !== data.step.id), data.step]);
        if (data.step.kind === 'model' && data.step.name) setLastModel(String(data.step.name));
      }
      if (data.type === 'message') {
        setMessages((value) => [...value, data.message]);
        setStreaming('');
        setThinking('');
      }
      if (data.type === 'context') setMeter({ used: Number(data.used || 0), budget: Number(data.budget || 0) });
      if (data.type === 'status') {
        setStatus(data.status);
        setLoadingNote(data.status === 'loading' ? String(data.detail || 'Loading model') : '');
      }
      if (data.type === 'secret' && data.request) setSecret(data.request);
      if (data.type === 'done') {
        setLoadingNote('');
        setStatus(data.run?.status || 'completed');
        if (data.run?.modelId) setLastModel(models.find((model) => model.id === data.run.modelId)?.name || String(data.run.modelId));
        if (data.run?.status === 'failed' && data.run?.error) setRunError(String(data.run.error));
        if (current) void openSession(current);
        void refreshLists().catch(() => undefined);
        source.close();
      }
    };
    return () => source.close();
  }, [runId]);

  async function createWorkshop(event: { preventDefault(): void }) {
    event.preventDefault();
    const filled = projects.filter((project) => project.path.trim());
    try {
      const created = await post<{ session: Session }>('/api/workshops', { name: shopName, projects: filled });
      setShopNote('');
      await refreshLists();
      await openSession(created.session.id);
    } catch (error) {
      setShopNote(error instanceof Error ? error.message : 'Could not open the workshop.');
    }
  }

  async function createChat(nextMode: 'chat' | 'code'): Promise<string | undefined> {
    if (!agents[0]) return undefined;
    const created = await post<{ session: Session }>('/api/sessions', { agentId: agents[0].id, mode: nextMode, title: nextMode === 'code' ? 'Coding session' : 'New chat' });
    await refreshLists();
    await openSession(created.session.id);
    return created.session.id;
  }

  async function send(event?: { preventDefault(): void }, override?: string) {
    event?.preventDefault();
    const typed = override ?? draft;
    const attaching = override === undefined && (quotes.length > 0 || mentions.length > 0);
    if (!typed.trim() && !attaching) return;
    // Typing with no chat open starts one, instead of silently doing nothing.
    const target = current || await createChat('chat').catch(() => undefined);
    if (!target) { toast('Create a persona under Agents first.', 'info'); return; }
    if (active) { toast('A reply is still running. Press Stop (Esc) first.', 'info'); return; }
    const sentQuotes = override === undefined ? quotes : [];
    const sentMentions = override === undefined ? mentions : [];
    const tokens = sentMentions.map((m) => m.kind === 'file' ? `[file:${m.id}]` : `[@${m.root}:${m.path || '.'}${m.start ? `#L${m.start}${m.end && m.end !== m.start ? `-${m.end}` : ''}` : ''}]`);
    const content = [...sentQuotes.map((q) => quoteBlock(q.ref, q.text)), typed.trim() || (tokens.length ? 'Please look at these.' : ''), tokens.length ? tokens.join(' ') : ''].filter(Boolean).join('\n\n');
    const payloadMentions = sentMentions.map((m) => m.kind === 'file' ? { kind: 'file' as const, id: m.id } : { kind: 'path' as const, root: m.root, path: m.path, start: m.start, end: m.end });
    if (override === undefined) { setDraft(''); setQuotes([]); setMentions([]); }
    setRunError(null);
    setThinking('');
    setMessages((value) => [...value, { id: 'local', role: 'user', content }]);
    const agentId = sessions.find((session) => session.id === target)?.agentId || agents[0]?.id;
    let result: { run: { id: string }; offers: Offer[] };
    try {
      result = await post<{ run: { id: string }; offers: Offer[] }>(`/api/sessions/${target}/messages`, { content, agentId, mentions: payloadMentions.length ? payloadMentions : undefined });
    } catch (error) {
      // A reply is still running (409) or the model choice was refused (400). Keep the draft.
      setMessages((value) => value.filter((message) => message.id !== 'local'));
      if (override === undefined) { setDraft(typed); setQuotes(sentQuotes); setMentions(sentMentions); }
      toast(`Not sent: ${errorText(error, 'Could not send.')} Your text is still in the box.`, 'error');
      return;
    }
    setVoiceNote('');
    setOffers(result.offers || []);
    setRunId(result.run.id);
    setStatus('running');
  }

  async function holdTalk(start: boolean) {
    if (start) {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        setVoiceNote(error instanceof Error ? error.message : 'Microphone unavailable.');
        return;
      }
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const response = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const data = await response.json();
        if (!response.ok) setVoiceNote(data.error || 'Voice is not available.');
        else setDraft((value) => `${value} ${data.text || ''}`.trim());
        if (!response.ok) toast(data.error || 'Voice is not available.', 'error');
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } else {
      recorder.current?.stop();
      setRecording(false);
    }
  }

  async function control(action: string) {
    if (!runId) return;
    try {
      await post(`/api/runs/${runId}/control`, { action });
      if (action === 'stop') toast('Stopped.', 'info');
    } catch (error) { toast(errorText(error), 'error'); }
  }

  function retry() {
    const last = [...messages].reverse().find((message) => message.role === 'user');
    if (last) void send(undefined, last.content);
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((value) => (value === id ? null : value)), 1500);
    } catch { toast('Copy is blocked here. Select the text instead.', 'info'); }
  }

  async function removeChat(id: string) {
    const row = sessions.find((session) => session.id === id);
    if (!window.confirm(`Delete “${row?.title || 'this chat'}”? It disappears from the list.`)) return;
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      const rows = await refreshLists();
      toast('Chat deleted.', 'ok');
      if (id === current) {
        if (rows[0]) await openSession(rows[0].id);
        else { setCurrent(null); setMessages([]); }
      }
    } catch (error) { toast(errorText(error), 'error'); }
  }

  async function saveTitle(id: string) {
    const title = titleDraft.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      setSessions((rows) => rows.map((row) => (row.id === id ? { ...row, title } : row)));
    } catch (error) { toast(errorText(error), 'error'); }
  }

  const currentSession = sessions.find((session) => session.id === current);
  const pinnedName = modelPin ? models.find((model) => model.id === modelPin)?.name || modelPin : '';
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  const setupLeft = checklist.filter((item) => !item.optional && !item.ok);
  const agentRoot = (currentSession?.agentId || agents[0]?.id) ? `ws:${currentSession?.agentId || agents[0]?.id}` : null;

  function addQuote(pick: QuotePick) {
    setQuotes((rows) => [...rows.filter((row) => !(row.ref === pick.ref && row.text === pick.text)), { ...pick, key: `${pick.ref}-${Date.now()}` }].slice(-6));
    input.current?.focus();
  }
  function addMention(pick: MentionPick) {
    setMentions((rows) => [...rows, { ...pick, key: `${pick.kind}-${Date.now()}-${Math.random()}` }].slice(-12));
    setPicker(null);
    // Drop the "@query" the user typed.
    setDraft((value) => value.replace(/(^|\s)@[^\s@]*$/, '$1'));
    setTimeout(() => input.current?.focus(), 0);
  }
  function flash(id: string) {
    const el = document.getElementById(`m-${id}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    return true;
  }
  async function openCite(cite: Cite) {
    if (cite.kind === 'file') { setViewer({ source: { kind: 'file', id: cite.id }, anchor: cite.anchor }); return; }
    if (cite.kind === 'path') { setViewer({ source: { kind: 'path', root: cite.root, path: cite.path }, anchor: cite.start ? `L${cite.start}-${cite.end || cite.start}` : undefined }); return; }
    if (flash(cite.id)) return;
    try {
      const data = await api<{ message: { sessionId: string } }>(`/api/messages/${cite.id}`);
      pendingJump.current = cite.id;
      await openSession(data.message.sessionId);
    } catch (error) { toast(errorText(error, 'That message is gone.'), 'error'); }
  }
  const citeHandlers: CiteHandlers = {
    open: (cite) => void openCite(cite),
    quoteCode: (code, sourceId) => addQuote({ ref: `msg:${sourceId}`, text: code.slice(0, 2000), label: 'code block' }),
  };
  function onSelectText() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || '';
    if (!sel || !text || !sel.rangeCount) { setSelQuote(null); return; }
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    const article = node?.closest('article[data-mid]') as HTMLElement | null;
    const id = article?.dataset.mid;
    if (!id || id === 'local') { setSelQuote(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelQuote({ x: Math.min(window.innerWidth - 120, Math.max(8, rect.left + rect.width / 2 - 50)), y: Math.max(8, rect.top - 46), text: text.slice(0, 2000), id });
  }
  async function dropFiles(list: FileList | null) {
    if (!list?.length) return;
    for (const file of Array.from(list)) {
      try { const saved = await uploadFile(file, current); addMention({ kind: 'file', id: saved.id, label: saved.name }); }
      catch (error) { toast(errorText(error), 'error'); }
    }
  }

  return (
    <CiteContext.Provider value={citeHandlers}>
    <div className={trace ? 'chat with-trace' : 'chat'}>
      {viewer && <FileViewer source={viewer.source} anchor={viewer.anchor} onClose={() => setViewer(null)} onQuote={addQuote} />}
      {selQuote && <button className="sel-quote" style={{ left: selQuote.x, top: selQuote.y }} onMouseDown={(event) => event.preventDefault()} onClick={() => { addQuote({ ref: `msg:${selQuote.id}`, text: selQuote.text, label: 'selection' }); setSelQuote(null); window.getSelection()?.removeAllRanges(); }}><Quote size={14} /> Quote</button>}
      {(rail || trace) && <div className="scrim" onClick={() => { setRail(false); setTrace(false); }} />}
      <aside className={rail ? 'rail open' : 'rail'} aria-label="Chats">
        <div className="sheet-head">
          <strong>Chats</strong>
          <button className="icon-btn" aria-label="Close chats" onClick={() => setRail(false)}><X size={18} /></button>
        </div>
        <div className="row rail-actions">
          <button className="btn primary" onClick={() => { void createChat('chat'); setRail(false); }}>New chat</button>
          <button className="btn" onClick={() => { void createChat('code'); setRail(false); }}>Code</button>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <div key={session.id} className={session.id === current ? 'session-item active' : 'session-item'}>
              {renaming === session.id ? (
                <form className="rename" onSubmit={(event) => { event.preventDefault(); void saveTitle(session.id); }}>
                  <input autoFocus dir="auto" aria-label="Chat title" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => void saveTitle(session.id)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); } }} />
                </form>
              ) : (
                <button className="session-open" onClick={() => { void openSession(session.id); setRail(false); }} title={session.title}>
                  <strong dir="auto">{session.title}</strong>
                  <span className="faint">{session.workshopId ? 'Workshop' : session.mode === 'code' ? 'Coding' : 'Chat'}</span>
                </button>
              )}
              <span className="session-ops">
                <button className="icon-btn" aria-label={`Rename ${session.title}`} title="Rename" onClick={() => { setRenaming(session.id); setTitleDraft(session.title); }}><Pencil size={15} /></button>
                <button className="icon-btn danger" aria-label={`Delete ${session.title}`} title="Delete" onClick={() => void removeChat(session.id)}><Trash2 size={15} /></button>
              </span>
            </div>
          ))}
          {sessions.length === 0 && <p className="faint">No chats yet. Start one with New chat.</p>}
          {nextCursor && <button className="btn" type="button" onClick={() => void loadMoreSessions()}>Older chats</button>}
        </div>
        {agents.length < 2 && <p className="muted">Create two personas under Agents. The house operator and the researcher are one click each.</p>}
        <details className="card workshop">
          <summary><strong>Workshop</strong> <span className="faint">several projects, one coding chat</span><ChevronDown size={16} /></summary>
          <form onSubmit={createWorkshop}>
            <p className="faint">The turn goes to a model that can code.</p>
            <input className="input" value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Name" aria-label="Workshop name" />
            {projects.map((project, index) => (
              <div key={index} className="project-row">
                <input className="input" value={project.label} onChange={(event) => setProjects((rows) => rows.map((row, i) => i === index ? { ...row, label: event.target.value } : row))} placeholder="label" aria-label="Project label" />
                <input className="input" value={project.path} onChange={(event) => setProjects((rows) => rows.map((row, i) => i === index ? { ...row, path: event.target.value } : row))} placeholder="/home/asaf/src/server" aria-label="Project path" />
              </div>
            ))}
            <div className="row">
              <button className="btn" type="button" onClick={() => setProjects((rows) => [...rows, { label: '', path: '' }])}>Add project</button>
              <button className="btn primary" type="submit">Open workshop</button>
            </div>
            {shopNote && <p className="muted">{shopNote}</p>}
          </form>
        </details>
      </aside>
      <section className="thread">
        <div className="thread-head">
          <button className="btn ghost chats-btn" aria-label="Show chats" onClick={() => setRail(true)}><Menu size={16} /> <span>Chats</span></button>
          <strong className="thread-title" dir="auto" title={currentSession?.title}>{currentSession?.title || 'No chat open'}</strong>
          {status && status !== 'completed' && <span className={`badge ${status === 'failed' ? 'bad' : active ? 'warn' : ''}`}>{status}</span>}
          {mode === 'code' && <span className="badge warn">{currentSession?.workshopId ? 'workshop' : 'coding'}</span>}
          <button className={trace ? 'btn ghost on' : 'btn ghost'} aria-pressed={trace} aria-label="Trace" onClick={() => setTrace((value) => !value)}><ListTree size={16} /> <span>Trace</span></button>
        </div>
        <div className={dragging ? 'messages dragging' : 'messages'} ref={box} onMouseUp={onSelectText} onTouchEnd={() => setTimeout(onSelectText, 50)} onScroll={() => selQuote && setSelQuote(null)}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void dropFiles(event.dataTransfer.files); }}>
          <div className="messages-inner">
          {setupLeft.length > 0 && (
            <div className="card first-run">
              <h3>Finish setup</h3>
              <p className="muted">{setupLeft.length} step{setupLeft.length === 1 ? '' : 's'} left before real models answer here.</p>
              <ul className="checklist">
                {checklist.filter((item) => !item.optional).map((item) => (
                  <li key={item.id} className={item.ok ? 'done' : ''}><span className={`dot ${item.ok ? 'ok' : 'warn'}`} /> <span><strong>{item.title}</strong> <span className="faint">{item.ok ? '' : item.detail}</span></span></li>
                ))}
              </ul>
              <div className="row"><Link className="btn primary" to="/setup">Open Setup</Link><Link className="btn" to="/settings#health">Check health</Link></div>
            </div>
          )}
          {messages.length === 0 && (
            <div className="card empty-card">
              <CuteArt />
              <h3>{current ? 'Say something to start.' : 'No chat open.'}</h3>
              <p className="muted">Ask a question, or try one of these. With no model connected, Rehearsal still streams and calls tools.</p>
              <div className="row">
                {['list files', 'remember that this box has 48 GB', '/image a cosy reading nook, watercolor'].map((prompt) => (
                  <button key={prompt} className="btn" onClick={() => { setDraft(prompt); input.current?.focus(); }}>{prompt}</button>
                ))}
              </div>
            </div>
          )}
          {offers.length > 0 && (
            <div className="banner">
              A key-shaped string was moved out of the message. Save it in the vault?
              {offers.map((offer) => (
                <button key={offer.id} className="btn" onClick={async () => { await post(`/api/vault/captures/${offer.id}/accept`, { name: 'PASTED_KEY' }); setOffers((value) => value.filter((item) => item.id !== offer.id)); }}>{offer.kind} {offer.masked}</button>
              ))}
            </div>
          )}
          {secret && (
            <form className="banner" onSubmit={async (event) => { event.preventDefault(); await post(`/api/secret-requests/${secret.id}`, { value: secretValue }); setSecret(null); setSecretValue(''); }}>
              <strong>Secret needed: {secret.name}</strong>
              <p className="muted">{secret.reason} The model will only see a handle.</p>
              <input className="input" type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="Paste the key" />
              <div className="row">
                <button className="btn primary" type="submit">Save and resume</button>
                <button className="btn danger" type="button" onClick={async () => { await post(`/api/secret-requests/${secret.id}`, { deny: true }); setSecret(null); }}>Deny</button>
              </div>
            </form>
          )}
          {messages.map((message) => {
            const speaker = message.agentId ? agents.find((agent) => agent.id === message.agentId) : undefined;
            const fromAgent = message.role !== 'user' && message.role !== 'tool' && speaker;
            if (message.role === 'tool') return <ToolCard key={message.id} name={message.toolName} content={message.content} />;
            const calls = (message.toolCalls || []).map((call) => call.name).filter(Boolean);
            if (message.role === 'assistant' && !message.content.trim() && calls.length) {
              return <div key={message.id} className="tool-call-chip"><Wrench size={14} /> Calling {calls.join(', ')}…{message.routingNote && <span className="switch">{message.routingNote}</span>}</div>;
            }
            const [visible, attached] = message.content.split(CONTEXT_MARK);
            const cites = citationsIn(visible || '').filter((cite) => cite.kind === 'file');
            return (
            <article key={message.id} id={`m-${message.id}`} data-mid={message.id} className={message.role === 'user' ? 'msg user' : fromAgent ? 'msg from-agent' : 'msg'} style={fromAgent ? { ['--accent' as string]: speaker.accent || '#e4b56a' } : undefined}>
              {fromAgent ? <div className="who"><Face agent={speaker} size={28} /><span className="meta">{speaker.emoji ? `${speaker.emoji} ` : ''}{speaker.name}</span></div> : message.role !== 'user' && <div className="meta"><span>{message.role}</span></div>}
              {message.routingNote && <div className="switch">{message.routingNote}</div>}
              <div dir="auto"><Markdown text={visible || ''} sourceId={message.id} /></div>
              {attached && <details className="attached-note"><summary className="faint">Context sent with this message ({Math.round(attached.length / 1000)}k characters)</summary><pre className="mono tool-output">{attached.slice(0, 4000)}{attached.length > 4000 ? '\n…' : ''}</pre></details>}
              {cites.length > 0 && <div className="file-cards">{[...new Map(cites.map((c) => [c.kind === 'file' ? c.id : '', c])).values()].map((cite) => cite.kind === 'file' && <FileCard key={cite.id} id={cite.id} onOpen={() => setViewer({ source: { kind: 'file', id: cite.id }, anchor: cite.anchor })} />)}</div>}
              {message.id !== 'local' && (
                <div className="msg-actions">
                  <button className="icon-btn" aria-label="Quote message" title="Quote in your reply" onClick={() => addQuote({ ref: `msg:${message.id}`, text: (visible || '').slice(0, 1200), label: message.role === 'user' ? 'your message' : 'reply' })}><Quote size={15} /></button>
                  <button className="icon-btn" aria-label="Copy message" title="Copy" onClick={() => void copy(message.id, visible || '')}>{copied === message.id ? <Check size={15} /> : <Copy size={15} />}</button>
                  {message.role === 'user' && <button className="icon-btn" aria-label="Edit as new message" title="Edit into the box" onClick={() => { setDraft(visible || ''); input.current?.focus(); }}><Pencil size={15} /></button>}
                  {message.id === lastAssistant && !active && <button className="icon-btn" aria-label="Regenerate reply" title="Ask again" onClick={retry}><RotateCcw size={15} /></button>}
                </div>
              )}
            </article>
            );
          })}
          {thinking && (
            <details className="thinking" open={!streaming}>
              <summary><Brain size={14} /> {streaming ? 'Thought for a moment' : 'Thinking…'}</summary>
              <div className="think" dir="auto">{thinking}</div>
            </details>
          )}
          {streaming && <article className="msg" dir="auto"><Markdown text={streaming} streaming /></article>}
          {active && !streaming && !thinking && <div className="typing" aria-label="Working"><span /><span /><span /> <em>{loadingNote || 'Working…'}</em></div>}
          {runError && !active && (
            <div className="banner error-card" role="alert">
              <strong>The reply failed.</strong>
              <p className="muted" dir="auto">{runError}</p>
              <div className="row"><button className="btn primary" onClick={retry}><RotateCcw size={15} /> Try again</button><button className="btn ghost" onClick={() => setTrace(true)}>Open trace</button></div>
            </div>
          )}
          {mode === 'code' && plan && (
            <div className="card">
              <h3>Plan</h3>
              {plan.items.map((item) => (
                <label key={item.id} className="row">
                  <input type="checkbox" checked={item.status === 'done'} onChange={async (event) => { await api(`/api/plan-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.checked ? 'done' : 'pending' }) }); if (current) void openSession(current); }} />
                  <span>{item.text}</span>
                </label>
              ))}
            </div>
          )}
          {mode === 'code' && edits.map((edit) => (
            <div key={edit.id} className="card">
              <div className="row"><strong>{edit.label}</strong>{edit.revertedAt ? <span className="badge">reverted</span> : <button className="btn" onClick={async () => { await post(`/api/edits/${edit.id}/revert`); if (current) void openSession(current); }}>Revert checkpoint</button>}</div>
              <pre className="command">{edit.diff}</pre>
            </div>
          ))}
          </div>
        </div>
        <div className="composer">
          {picker && <MentionPicker query={picker.query} setQuery={(query) => setPicker({ query })} defaultRoot={agentRoot} sessionId={current} onPick={addMention} onClose={() => { setPicker(null); input.current?.focus(); }} />}
          <form onSubmit={send}>
            {(quotes.length > 0 || mentions.length > 0) && (
              <div className="chips" aria-label="Attached references">
                {quotes.map((q) => (
                  <span key={q.key} className="chip quote-chip" title={q.text}>
                    <Quote size={13} /><span className="chip-label"><strong>{q.label}</strong> <span className="faint" dir="auto">“{q.text.replace(/\s+/g, ' ').slice(0, 60)}{q.text.length > 60 ? '…' : ''}”</span></span>
                    <button type="button" aria-label="Remove quote" onClick={() => setQuotes((rows) => rows.filter((row) => row.key !== q.key))}><X size={13} /></button>
                  </span>
                ))}
                {mentions.map((m) => (
                  <span key={m.key} className="chip mention-chip">
                    <button type="button" className="chip-open" title="Preview" onClick={() => { if (m.kind === 'file') setViewer({ source: { kind: 'file', id: m.id } }); else if (!m.dir) setViewer({ source: { kind: 'path', root: m.root, path: m.path }, anchor: m.start ? `L${m.start}-${m.end || m.start}` : undefined }); }}>
                      {m.kind === 'file' ? <Paperclip size={13} /> : m.dir ? <Folder size={13} /> : <AtSign size={13} />}
                      <span className="chip-label ellipsis" dir="auto">{m.label}{m.kind === 'path' && m.start ? `#L${m.start}-${m.end || m.start}` : ''}{m.kind === 'path' && m.dir ? '/' : ''}</span>
                    </button>
                    <button type="button" aria-label="Remove reference" onClick={() => setMentions((rows) => rows.filter((row) => row.key !== m.key))}><X size={13} /></button>
                  </span>
                ))}
              </div>
            )}
            <textarea ref={input} dir="auto" rows={1} value={draft} aria-label="Message" placeholder={mode === 'code' ? 'Ask for a plan, then an edit…' : 'Message'} onChange={(event) => {
              const value = event.target.value;
              setDraft(value);
              const upto = value.slice(0, event.target.selectionStart ?? value.length);
              const at = /(^|\s)@([^\s@]*)$/.exec(upto);
              if (at) setPicker({ query: at[2] || '' }); else if (picker && !upto.includes('@')) setPicker(null);
            }} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void dropFiles(event.clipboardData.files); } }} onKeyDown={(event) => { if (picker && event.key === 'Escape') { event.preventDefault(); setPicker(null); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} />
            <div className="composer-bar">
              <label className="model-pill" title={modelPin ? `Pinned to ${pinnedName}` : lastModel ? `Auto picks per message. Last reply: ${lastModel}` : 'Auto picks a model per message'}>
                <select aria-label="Model" value={modelPin || ''} onChange={async (event) => {
                  const value = event.target.value || null;
                  setModelPin(value);
                  try {
                    if (current) await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ modelPin: value }) });
                  } catch (error) { toast(errorText(error), 'error'); setModelPin(modelPin); }
                }}>
                  <option value="">{lastModel && !modelPin ? `Auto · ${lastModel}` : 'Auto'}</option>
                  {models.filter((model) => !model.embedding && model.enabled !== false).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden />
              </label>
              {meter && <span className="context-meter" aria-label="Context used" title="Context used / budget">{Math.round((meter.used / Math.max(1, meter.budget)) * 100)}% ctx</span>}
              <span className="spacer" />
              <button className="icon-btn round" type="button" aria-label="Reference a file, folder, or upload (@)" title="Reference files (@) or upload" onClick={() => setPicker(picker ? null : { query: '' })}><Paperclip size={18} /></button>
              <button className={recording ? 'icon-btn round on' : 'icon-btn round'} type="button" aria-label="Hold to talk" title="Hold to talk" onPointerDown={() => void holdTalk(true)} onPointerUp={() => void holdTalk(false)} onPointerLeave={() => { if (recording) void holdTalk(false); }}><Mic size={18} /></button>
              {active && status !== 'paused' && <button className="btn ghost pause-btn" type="button" onClick={() => control('pause')}>Pause</button>}
              {status === 'paused' && <button className="btn ghost" type="button" onClick={() => control('resume')}>Resume</button>}
              {active ? <button className="icon-btn round danger-fill" type="button" aria-label="Stop (Esc)" title="Stop (Esc)" onClick={() => control('stop')}><Square size={16} /></button>
                : <button className="icon-btn round primary-fill" type="submit" aria-label="Send" title="Send (Enter)" disabled={(!draft.trim() && !quotes.length && !mentions.length) || !current}><Send size={17} /></button>}
            </div>
          </form>
          {(voiceNote || loadingNote) ? <p className="composer-hint faint">{voiceNote || loadingNote}</p> : <p className="composer-hint faint"><span className="kbd-hint">Enter to send · Shift+Enter for a new line · Esc to stop</span></p>}
        </div>
      </section>
      <aside className={trace ? 'trace open' : 'trace'} aria-label="Trace">
        <div className="sheet-head">
          <strong>Trace</strong>
          <button className="icon-btn" aria-label="Close trace" onClick={() => setTrace(false)}><X size={18} /></button>
        </div>
        <p className="faint">Every model call and tool call lands here, with the arguments the model actually sent.</p>
        {steps.map((step) => (
          <div key={step.id} className="step">
            <div className="row"><span className={`dot ${step.status === 'completed' ? 'ok' : step.status === 'failed' ? 'bad' : 'live'}`} /><strong>{step.kind}</strong> <span className="muted ellipsis">{step.name}</span></div>
            <div className="faint">{step.status}{step.latencyMs ? ` · ${step.latencyMs} ms` : ''}</div>
            {step.error && <div className="badge bad wrap">{step.error}</div>}
          </div>
        ))}
      </aside>
    </div>
    </CiteContext.Provider>
  );
}

function FileCard({ id, onOpen }: { id: string; onOpen: () => void }) {
  const [meta, setMeta] = useState<FileMeta | null | undefined>(undefined);
  useEffect(() => { void fileMeta(id).then(setMeta); }, [id]);
  if (meta === null) return <div className="file-card missing"><FileText size={18} /><span className="faint">File {id} is gone.</span></div>;
  const kind = meta ? kindOf(meta.name, meta.mime) : 'binary';
  if (meta && kind === 'image') {
    return (
      <div className="file-card image-card">
        <button className="file-card-main" onClick={onOpen} title="Preview"><img src={rawUrl(id)} alt={meta.name} className="file-preview" loading="lazy" /></button>
        <div className="image-card-bar">
          <span className="file-card-text"><strong className="ellipsis" dir="auto">{meta.name}</strong><span className="faint">{humanSize(meta.size)}</span></span>
          <button className="icon-btn" aria-label="Preview" title="Preview" onClick={onOpen}><Eye size={16} /></button>
          <button className="icon-btn" aria-label="Download" title="Download" onClick={() => saveFile(rawUrl(id), meta.name, meta.mime)}><Download size={16} /></button>
        </div>
      </div>
    );
  }
  return (
    <div className="file-card">
      <button className="file-card-main" onClick={onOpen} title="Preview">
        {meta && kind === 'image' ? <img src={rawUrl(id)} alt="" className="file-thumb" /> : <span className={`file-icon k-${kind}`}><FileText size={20} /></span>}
        <span className="file-card-text"><strong className="ellipsis" dir="auto">{meta?.name || 'Loading…'}</strong><span className="faint">{meta ? `${kind.toUpperCase()} · ${humanSize(meta.size)}` : ''}</span></span>
      </button>
      <button className="icon-btn" aria-label="Preview" title="Preview" onClick={onOpen}><Eye size={16} /></button>
      <button className="icon-btn" aria-label="Download" title="Download" onClick={() => meta && saveFile(rawUrl(id), meta.name, meta.mime)}><Download size={16} /></button>
    </div>
  );
}

function ToolCard({ name, content }: { name?: string | null; content: string }) {
  const sources = parseSources(name, content);
  return (
    <details className="tool-card">
      <summary>
        <Wrench size={14} />
        <strong>{name || 'tool'}</strong>
        <span className="faint ellipsis">{sources.length ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : toolSummary(content)}</span>
        <ChevronDown size={14} className="chev" />
      </summary>
      {sources.length > 0 ? (
        <ol className="sources">
          {sources.map((source) => (
            <li key={source.n}>
              <span className="cite">{source.n}</span>
              <span className="source-body">
                {source.url ? <a href={source.url} target="_blank" rel="noreferrer" dir="auto">{source.title}</a> : <strong dir="auto">{source.title}</strong>}
                {source.url && <span className="faint url">{source.url.replace(/^https?:\/\//, '')}</span>}
                {source.snippet && <span className="muted snippet" dir="auto">{source.snippet}</span>}
              </span>
            </li>
          ))}
        </ol>
      ) : <pre className="mono tool-output" dir="auto">{content}</pre>}
    </details>
  );
}
