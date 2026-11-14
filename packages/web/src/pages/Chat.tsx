import { CuteArt } from '../components/CuteArt';
import { useEffect, useRef, useState } from 'react';
import { Menu as DropMenu } from '../components/ui';
import { ModelPicker, useUsableModels } from '../lib/models';
import { browserDictationSupported, startDictation } from '../lib/dictation';
import { AtSign, Info, Layers, Brain, Check, ChevronDown, Code2, Copy, Download, Eye, FileText, Folder, FolderGit2, GitBranch, ListTree, Menu, MessageSquarePlus, Pin, PinOff, Plus, Search, Mic, PanelRight, Paperclip, Pencil, Quote, RotateCcw, Send, Square, Trash2, Wrench, X } from 'lucide-react';
import { CiteContext, type CiteHandlers } from '../components/Markdown';
import { FileViewer, type QuotePick, type ViewerSource } from '../components/FileViewer';
import { MentionPicker, type MentionPick } from '../components/MentionPicker';
import { CONTEXT_MARK, citationsIn, fileMeta, humanSize, kindOf, quoteBlock, rawUrl, saveFile, uploadFile, type Cite, type FileMeta } from '../lib/files';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PullModel } from '../components/PullModel';
import { WorkspaceBrowser, type ChatRoot } from '../components/WorkspaceBrowser';
import { PersonaStatePanel } from '../components/PersonaStatePanel';
import { PersonaPanel, useWorkspaces, type PanelAgent } from '../components/PersonaPanel';
import { PersonaChip, greetingFor, startersFor } from '../components/ChatChips';
import { ContextPanel } from '../components/ContextPanel';
import { parseSources, toolSummary } from '@local-agent/shared';
import { toast, errorText } from '../lib/toast';
import { api, post } from '../lib/api';
import { isAbort, latestOnly } from '../lib/latest';
import { Markdown } from '../components/Markdown';
import { Face, type FaceAgent } from '../components/Face';

interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null; modelPin?: string | null; updatedAt?: string }
type Agent = PanelAgent & FaceAgent;
interface Message { id: string; role: string; content: string; createdAt?: string; agentId?: string | null; toolName?: string | null; routingNote?: string | null; toolCalls?: { name: string }[] | null }
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
  const dictationStop = useRef<(() => void) | null>(null);
  const whisperUp = useRef<boolean | null>(null);
  const held = useRef(false);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const modelState = useUsableModels();
  const { models: usable, all: models, loaded: modelsLoaded } = modelState;
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
  const [panel, setPanel] = useState<null | 'persona' | 'settings' | 'workspace' | 'files' | 'context' | 'state'>(null);
  // The persona status panel sits on the right on wide screens unless closed; on narrow ones it opens on demand.
  const [stateOpen, setStateOpen] = useState(() => localStorage.getItem('la-state-pane') !== 'closed');
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1100px)');
    const onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => { localStorage.setItem('la-state-pane', stateOpen ? 'open' : 'closed'); }, [stateOpen]);
  const showState = panel === 'state' || (!panel && wide && stateOpen);
  const toggleState = () => { if (showState) { setStateOpen(false); if (panel === 'state') setPanel(null); } else { setStateOpen(true); setPanel(wide ? null : 'state'); } };
  // Bumps when a background helper finishes, so the chat and its context panel refresh.
  const [helperTick, setHelperTick] = useState(0);
  // Tool calls waiting for a yes/no (e.g. creating a timer). Shown as a card above the composer.
  const [asks, setAsks] = useState<{ id: string; runId: string; toolName: string; reason: string }[]>([]);
  const [chatWs, setChatWs] = useState<{ items: { kind: 'root' | 'set'; id: string }[]; roots: ChatRoot[]; sets: { id: string; name: string; roots: string[] }[] }>({ items: [], roots: [], sets: [] });
  const [wsRoot, setWsRoot] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [pins, setPins] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('la-pinned-chats') || '[]'); } catch { return []; } });
  const ws = useWorkspaces();
  const navigate = useNavigate();
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

  async function loadChatWs(id: string | null) {
    if (!id) { setChatWs({ items: [], roots: [], sets: [] }); return; }
    try { setChatWs(await api(`/api/sessions/${id}/workspaces`)); } catch { setChatWs({ items: [], roots: [], sets: [] }); }
  }
  // Latest click wins: every open aborts the one before it, and stale replies are dropped.
  const openGate = useRef(latestOnly());
  // The open chat's own record, so the header is right even when it is not on the loaded page of the list.
  const [openedMeta, setOpenedMeta] = useState<Session | null>(null);
  const currentRef = useRef<string | null>(null);
  async function openSession(id: string, gate = openGate.current.begin()) {
    // Restore this chat's unsent draft in the same render as the switch, so the save effect never wipes it.
    if (!new URLSearchParams(window.location.search).get('share')) setDraft(localStorage.getItem(draftKey(id)) || '');
    setCurrent(id);
    currentRef.current = id;
    try {
      const [data, wsData] = await Promise.all([
        api<{ session: Session; messages: Message[]; plan: Plan | null; edits: Edit[] }>(`/api/sessions/${id}`, { signal: gate.signal }),
        api<typeof chatWs>(`/api/sessions/${id}/workspaces`, { signal: gate.signal }).catch((error) => { if (isAbort(error)) throw error; return { items: [], roots: [], sets: [] }; }),
      ]);
      if (!gate.current()) return;
      setOpenedMeta(data.session);
      setChatWs(wsData);
      setMessages(data.messages);
      setPlan(data.plan);
      setEdits(data.edits);
      setMode(data.session.mode);
      setModelPin(data.session.modelPin || null);
      setStreaming('');
      setThinking('');
      setRunError(null);
      if (data.session.agentId) void post(`/api/agents/${data.session.agentId}/read`, {}).catch(() => undefined);
    } catch (error) {
      if (!isAbort(error) && gate.current()) toast((error as Error).message, 'error');
    }
  }

  async function loadAsks(run: string | null) {
    if (!run) { setAsks([]); return; }
    try { const data = await api<{ approvals: { id: string; runId: string; toolName: string; reason: string }[] }>('/api/approvals'); setAsks(data.approvals.filter((row) => row.runId === run)); }
    catch { /* the card shows on the next status */ }
  }
  useEffect(() => { if (status === 'awaiting_approval') void loadAsks(runId); else setAsks([]); }, [status, runId]);
  async function decide(id: string, decision: 'approve' | 'deny') {
    setAsks((rows) => rows.filter((row) => row.id !== id));
    try { await post(`/api/approvals/${id}`, { decision }); } catch (error) { toast(errorText(error), 'error'); void loadAsks(runId); }
  }

  // While helpers run in the background, check now and then; when the last one ends, its result is in the chat.
  useEffect(() => {
    if (!current) return;
    const id = current;
    let stopped = false;
    let wasBusy = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const ctx = await api<{ helpers: { status: string }[] }>(`/api/sessions/${id}/context`);
        if (stopped || currentRef.current !== id) return;
        const busy = ctx.helpers.some((row) => row.status === 'running' || row.status === 'waiting');
        if (wasBusy && !busy) {
          const data = await api<{ messages: Message[] }>(`/api/sessions/${id}`);
          if (!stopped && currentRef.current === id) { setMessages(data.messages); setHelperTick((value) => value + 1); }
        }
        wasBusy = busy;
        if (busy) timer = window.setTimeout(() => void check(), 4000);
      } catch { /* the next run or open checks again */ }
    };
    void check();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [current, status]);

  const location = useLocation();
  // Runs on every navigation (location.key), so clicking the same persona again still opens it.
  // This effect only reads the URL; nothing here navigates, so URL and state cannot ping-pong.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const share = params.get('share');
    if (share) setDraft(share);
    const persona = params.get('persona');
    const gate = openGate.current.begin();
    void (async () => {
      try {
        const pane = params.get('pane');
        if (pane === 'info') setPanel('persona');
        else if (pane === 'settings') setPanel('settings');
        // One-shot params: drop them so a reload does not make another chat. Native replaceState, so the router does not re-run this effect.
        if (params.get('new') || pane) { const keep = new URLSearchParams(params); keep.delete('new'); keep.delete('pane'); window.history.replaceState(window.history.state, '', `${location.pathname}${keep.size ? `?${keep}` : ''}`); }
        if (persona && params.get('new')) {
          const created = await post<{ session: Session }>('/api/sessions', { agentId: persona, title: 'New chat' }, { signal: gate.signal });
          if (!gate.current()) return;
          await openSession(created.session.id, gate);
          if (gate.current()) void refreshLists().catch(() => undefined);
          return;
        }
        if (persona) {
          // One server call finds or creates the persona's chat atomically: no duplicates, however fast the clicks.
          const opened = await post<{ session: Session; created: boolean }>(`/api/agents/${persona}/open-chat`, {}, { signal: gate.signal });
          if (!gate.current()) return;
          await openSession(opened.session.id, gate);
          if (gate.current()) void refreshLists().catch(() => undefined);
          return;
        }
        const rows = await refreshLists();
        if (gate.current() && rows[0] && !currentRef.current) await openSession(rows[0].id, gate);
      } catch (error) {
        if (!isAbort(error) && gate.current()) toast((error as Error).message, 'error');
      }
    })();
  }, [location.key]);
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
      if (event.key === '/' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); (document.querySelector('.persona-chip') as HTMLButtonElement | null)?.click(); return; }
      // Ctrl/Cmd+Shift+I: this persona's info pane.
      if ((event.key === 'I' || event.key === 'i') && event.shiftKey && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setPanel((value) => value === 'persona' || value === 'settings' ? null : 'persona'); return; }
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
        setLoadingNote(data.status === 'loading' || data.status === 'waiting' ? String(data.detail || (data.status === 'waiting' ? 'Waiting' : 'Loading model')) : '');
      }
      if (data.type === 'secret' && data.request) setSecret(data.request);
      if (data.type === 'approval' || (data.type === 'status' && data.status === 'awaiting_approval')) void loadAsks(runId);
      if (data.type === 'done') {
        setLoadingNote('');
        setStatus(data.run?.status || 'completed');
        if (data.run?.modelId) setLastModel(models.find((model) => model.id === data.run.modelId)?.name || String(data.run.modelId));
        if (data.run?.status === 'failed' && data.run?.error) setRunError(String(data.run.error));
        if (current && currentRef.current === current) void openSession(current);
        void refreshLists().catch(() => undefined);
        source.close();
      }
    };
    return () => source.close();
  }, [runId]);

  async function createChat(nextMode: 'chat' | 'code'): Promise<string | undefined> {
    const persona = (sessions.find((session) => session.id === current) || (openedMeta?.id === current ? openedMeta : undefined))?.agentId || agents[0]?.id;
    if (!persona) return undefined;
    const created = await post<{ session: Session }>('/api/sessions', { agentId: persona, mode: nextMode, title: nextMode === 'code' ? 'Coding session' : 'New chat' });
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

  const appendSpoken = (text: string) => setDraft((value) => `${value} ${text}`.trim());
  const noVoiceHelp = 'No speech model on this machine. Start Whisper from Setup → Voice, or use Chrome/Edge for built-in dictation.';
  async function holdTalk(start: boolean) {
    held.current = start;
    if (!start) {
      if (dictationStop.current) { dictationStop.current(); dictationStop.current = null; }
      recorder.current?.stop();
      recorder.current = null;
      setRecording(false);
      return;
    }
    // Decide once whether the server can transcribe; otherwise use the browser's own dictation.
    if (whisperUp.current === null) whisperUp.current = await api<{ whisper: boolean }>('/api/voice').then((data) => data.whisper).catch(() => false);
    if (!held.current) return;
    if (!whisperUp.current || !navigator.mediaDevices?.getUserMedia) {
      if (browserDictationSupported()) {
        setVoiceNote('Listening (browser dictation)…');
        dictationStop.current = startDictation(appendSpoken, (message) => { setVoiceNote(message); toast(message, 'error'); });
        setRecording(true);
        return;
      }
      const message = !navigator.mediaDevices?.getUserMedia ? 'The microphone needs HTTPS or http://localhost in this browser.' : noVoiceHelp;
      setVoiceNote(message);
      toast(message, 'error');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser’s site settings.' : error instanceof Error ? error.message : 'Microphone unavailable.';
      setVoiceNote(message);
      toast(message, 'error');
      return;
    }
    if (!held.current) { stream.getTracks().forEach((track) => track.stop()); return; }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
      if (!blob.size) { setVoiceNote('Nothing recorded. Hold the button while you speak.'); return; }
      setVoiceNote('Transcribing…');
      try {
        const response = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
        const data = await response.json().catch(() => ({})) as { text?: string; error?: string; code?: string; hint?: string };
        if (response.ok) { appendSpoken(data.text || ''); setVoiceNote(''); return; }
        if (data.code === 'no_stt') whisperUp.current = false;
        const message = [data.error || 'Voice is not available.', data.hint].filter(Boolean).join(' ');
        setVoiceNote(message);
        toast(data.code === 'no_stt' && browserDictationSupported() ? `${data.error} Hold the mic again to use browser dictation.` : message, 'error');
      } catch {
        setVoiceNote('Could not reach the server to transcribe.');
      }
    };
    rec.start();
    recorder.current = rec;
    setVoiceNote('Recording… release to transcribe.');
    setRecording(true);
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

  const currentSession = sessions.find((session) => session.id === current) || (openedMeta?.id === current ? openedMeta : undefined);
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

  const persona = agents.find((agent) => agent.id === currentSession?.agentId) || agents[0];
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('la:active-persona', { detail: persona?.id ?? null }));
  }, [persona?.id]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent('la:active-persona', { detail: null })); }, []);
  const canManage = usable.canManage !== false;
  function note(text: string) {
    setMessages((rows) => [...rows, { id: `div-${Date.now()}`, role: 'divider', content: text }]);
  }
  async function switchPersona(id: string) {
    const next = agents.find((agent) => agent.id === id);
    if (!next) return;
    if (!current) { await createChatWith(id); return; }
    try {
      await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ agentId: id }) });
      setSessions((rows) => rows.map((row) => (row.id === current ? { ...row, agentId: id } : row)));
      note(`${next.name} answers from here on`);
    } catch (error) { toast(errorText(error), 'error'); }
  }
  async function createChatWith(agentId: string) {
    const created = await post<{ session: Session }>('/api/sessions', { agentId, title: 'New chat' });
    await refreshLists();
    await openSession(created.session.id);
  }
  async function newPersona() {
    try {
      const created = await post<{ agent: Agent }>('/api/agents', { name: 'New persona', systemPrompt: 'You are a helpful assistant. Be brief and concrete.', toolAllowlist: ['remember', 'recall', 'web_search'] });
      if (current) await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ agentId: created.agent.id }) });
      else await post('/api/sessions', { agentId: created.agent.id, title: 'New chat' }).then((res) => setCurrent((res as { session: Session }).session.id));
      await refreshLists();
      setPanel('settings');
      toast('Persona created. Name it and pick its tools here.', 'ok');
    } catch (error) { toast(errorText(error), 'error'); }
  }
  async function saveChatWs(items: { kind: 'root' | 'set'; id: string }[], note_?: string) {
    const target = current || await createChat('code').catch(() => undefined);
    if (!target) return;
    try {
      const data = await api<typeof chatWs & { session: Session }>(`/api/sessions/${target}/workspaces`, { method: 'PUT', body: JSON.stringify({ items }) });
      setChatWs({ items: data.items, roots: data.roots, sets: data.sets });
      setSessions((rows) => rows.map((row) => (row.id === target ? { ...row, ...data.session } : row)));
      setMode(data.session.mode);
      if (note_) note(note_);
    } catch (error) { toast(errorText(error), 'error'); }
  }
  function addWorkspace(item: { kind: 'root' | 'set'; id: string }, label: string) {
    if (chatWs.items.some((row) => row.kind === item.kind && row.id === item.id)) return;
    void saveChatWs([...chatWs.items, item], `${label} attached to this chat`);
  }
  function removeWorkspace(root: ChatRoot) {
    let items = chatWs.items.filter((row) => !(row.kind === 'root' && row.id === root.id));
    // A root that came from a set: drop the set but keep its other folders attached.
    for (const set of chatWs.sets.filter((row) => row.roots.includes(root.id))) {
      items = items.filter((row) => !(row.kind === 'set' && row.id === set.id));
      for (const other of set.roots) if (other !== root.id && !items.some((row) => row.kind === 'root' && row.id === other)) items.push({ kind: 'root', id: other });
    }
    if (wsRoot === root.id) { setPanel(null); setWsRoot(null); }
    void saveChatWs(items, `${root.label} removed from this chat`);
  }
  function togglePin(id: string) {
    setPins((rows) => { const next = rows.includes(id) ? rows.filter((row) => row !== id) : [id, ...rows]; localStorage.setItem('la-pinned-chats', JSON.stringify(next)); return next; });
  }
  const filtered = sessions.filter((session) => !chatQuery.trim() || session.title.toLowerCase().includes(chatQuery.trim().toLowerCase()));
  const pinnedRows = filtered.filter((session) => pins.includes(session.id));
  const groups = new Map<string, Session[]>();
  for (const session of filtered) {
    if (pins.includes(session.id)) continue;
    const key = session.agentId || '';
    groups.set(key, [...(groups.get(key) || []), session]);
  }
  const renderSession = (session: Session) => (
    <div key={session.id} className={session.id === current ? 'session-item active' : 'session-item'}>
      {renaming === session.id ? (
        <form className="rename" onSubmit={(event) => { event.preventDefault(); void saveTitle(session.id); }}>
          <input autoFocus dir="auto" aria-label="Chat title" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => void saveTitle(session.id)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); } }} />
        </form>
      ) : (
        <button className="session-open" onClick={() => { void openSession(session.id); setRail(false); }} title={session.title}>
          <strong dir="auto">{session.title}</strong>
          <span className="faint">{session.workshopId ? 'Workspace · ' : session.mode === 'code' ? 'Coding · ' : ''}{relativeTime(session.updatedAt)}</span>
        </button>
      )}
      <span className="session-ops">
        <DropMenu label={`Options for ${session.title}`} items={[
          { label: 'Rename', icon: Pencil, onSelect: () => { setRenaming(session.id); setTitleDraft(session.title); } },
          { label: pins.includes(session.id) ? 'Unpin' : 'Pin', icon: pins.includes(session.id) ? PinOff : Pin, onSelect: () => togglePin(session.id) },
          { label: 'Delete chat', icon: Trash2, danger: true, separator: true, onSelect: () => void removeChat(session.id) },
        ]} />
      </span>
    </div>
  );

  return (
    <CiteContext.Provider value={citeHandlers}>
    <div className={`chat v2${trace ? ' with-trace' : ''}${panel || showState ? ' with-panel' : ''}`} style={persona?.accent ? { ['--persona' as string]: persona.accent } : undefined}>
      {viewer && <FileViewer source={viewer.source} anchor={viewer.anchor} onClose={() => setViewer(null)} onQuote={addQuote} />}
      {selQuote && <button className="sel-quote" style={{ left: selQuote.x, top: selQuote.y }} onMouseDown={(event) => event.preventDefault()} onClick={() => { addQuote({ ref: `msg:${selQuote.id}`, text: selQuote.text, label: 'selection' }); setSelQuote(null); window.getSelection()?.removeAllRanges(); }}><Quote size={14} /> Quote</button>}
      {(rail || trace || panel) && <div className="scrim" onClick={() => { setRail(false); setTrace(false); setPanel(null); }} />}
      <aside className={rail ? 'rail open' : 'rail'} aria-label="Chats">
        <div className="sheet-head">
          <strong>Chats</strong>
          <button className="icon-btn" aria-label="Close chats" onClick={() => setRail(false)}><X size={18} /></button>
        </div>
        <div className="row rail-actions">
          <span className="split">
            <button className="btn primary" title="Start a new chat with the first agent" onClick={() => { void createChat('chat'); setRail(false); }}><MessageSquarePlus size={16} aria-hidden /> New chat</button>
            <DropMenu label="More ways to start" icon={ChevronDown} align="start" items={[
              { label: 'New chat', icon: MessageSquarePlus, hint: 'Talk', onSelect: () => { void createChat('chat'); setRail(false); } },
              { label: 'New coding session', icon: Code2, hint: 'Edits files', onSelect: () => { void createChat('code'); setRail(false); } },
              { label: 'Chat in a workspace…', icon: FolderGit2, hint: 'Folders and repos', onSelect: () => { setRail(false); setPanel('workspace'); } },
            ]} />
          </span>
        </div>
        <label className="rail-search"><Search size={15} aria-hidden /><input type="search" placeholder="Search chats" aria-label="Search chats" value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} /></label>
        <div className="session-list">
          {pinnedRows.length > 0 && <><p className="list-heading">Pinned</p>{pinnedRows.map(renderSession)}</>}
          {[...groups.entries()].map(([agentId, rows]) => {
            const owner = agents.find((agent) => agent.id === agentId);
            return <div key={agentId || 'none'} className="session-group">{(groups.size > 1 || pinnedRows.length > 0) && <p className="list-heading">{owner ? <><Face agent={owner} size={16} /> {owner.name}</> : 'Other'}</p>}{rows.map(renderSession)}</div>;
          })}
          {sessions.length === 0 && <p className="faint">No chats yet. Press New chat to start one.</p>}
          {sessions.length > 0 && filtered.length === 0 && <p className="faint">No chat titles match “{chatQuery}”.</p>}
          {nextCursor && <button className="btn ghost small" type="button" onClick={() => void loadMoreSessions()}>Older chats</button>}
        </div>
      </aside>
      <section className="thread">
        <div className="thread-head">
          <button className="btn ghost chats-btn" aria-label="Show chats" onClick={() => setRail(true)}><Menu size={16} /> <span>Chats</span></button>
          {persona && <button className="persona-name" title={`${persona.name} · info (Ctrl+Shift+I)`} aria-label={`${persona.name}, open persona info`} aria-expanded={panel === 'persona' || panel === 'settings'} onClick={() => setPanel(panel === 'persona' || panel === 'settings' ? null : 'persona')}><Face agent={persona} size={22} /><span className="persona-label">{persona.name}</span></button>}
          <strong className="thread-title" dir="auto" title={currentSession?.title}>{currentSession?.title || 'No chat open'}</strong>
          {status && status !== 'completed' && <span className={`badge ${status === 'failed' ? 'bad' : active ? 'warn' : ''}`}>{status}</span>}
          {mode === 'code' && <span className="badge warn">{currentSession?.workshopId ? 'workshop' : 'coding'}</span>}
          <button className={trace ? 'btn ghost on' : 'btn ghost'} aria-pressed={trace} title="Show what the agent did: model, tools, timings" onClick={() => setTrace((value) => !value)}><ListTree size={16} aria-hidden /> <span>Trace</span></button>
          {currentSession && <button className={panel === 'context' ? 'btn ghost on' : 'btn ghost'} aria-pressed={panel === 'context'} title="Helpers, timers, files and edits from this chat" onClick={() => setPanel(panel === 'context' ? null : 'context')}><Layers size={16} aria-hidden /> <span>This chat</span></button>}
          {persona && <button className={showState ? 'btn ghost on' : 'btn ghost'} aria-pressed={showState} title={`${persona.name}: coding, upcoming, computer, voice`} onClick={toggleState}><PanelRight size={16} aria-hidden /> <span>Status</span></button>}
          {currentSession && <DropMenu label="Chat options" items={[
            { label: 'Rename chat', icon: Pencil, onSelect: () => { setRail(true); setRenaming(currentSession.id); setTitleDraft(currentSession.title); } },
            { label: trace ? 'Hide trace' : 'Show trace', icon: ListTree, onSelect: () => setTrace((value) => !value) },
            { label: 'Helpers, timers and files', icon: Layers, onSelect: () => setPanel('context') },
            { label: 'Persona info', icon: Info, hint: 'Ctrl+Shift+I', onSelect: () => setPanel('persona') },
            { label: 'Persona settings', icon: Pencil, onSelect: () => setPanel('settings') },
            { label: 'Add or create workspaces', icon: FolderGit2, onSelect: () => setPanel('workspace') },
            { label: 'New chat', icon: MessageSquarePlus, onSelect: () => void createChat('chat') },
            { label: 'Delete chat', icon: Trash2, danger: true, separator: true, onSelect: () => void removeChat(currentSession.id) },
          ]} />}
        </div>
        {(current || chatWs.roots.length > 0) && (
          <div className="ws-strip" aria-label="Workspaces in this chat">
            {chatWs.roots.map((root) => (
              <span key={root.id} className={wsRoot === root.id && panel === 'files' ? 'ws-pill on' : 'ws-pill'}>
                <button type="button" className="ws-pill-open" title={`${root.path}${root.via ? ` · from ${root.via}` : ''}${root.dirty ? ` · ${root.dirty} uncommitted` : ''}`} onClick={() => { if (panel === 'files' && wsRoot === root.id) setPanel(null); else { setWsRoot(root.id); setPanel('files'); } }}>
                  {root.isRepo ? <GitBranch size={13} aria-hidden /> : <Folder size={13} aria-hidden />}
                  <span className="ws-pill-label">{root.label}</span>
                  {root.branch && <span className="faint mono">{root.branch}</span>}
                  {root.dirty > 0 && <span className="dirty-dot" aria-label={`${root.dirty} uncommitted`} />}
                </button>
                <button type="button" className="chip-x" aria-label={`Remove ${root.label} from this chat`} title="Remove from this chat" onClick={() => removeWorkspace(root)}><X size={12} /></button>
              </span>
            ))}
            <DropMenu className="ws-add" align="start" label="Add a workspace to this chat" icon={Plus} text={chatWs.roots.length ? undefined : 'Add workspace'} items={[
              ...ws.workspaces.filter((row) => !chatWs.roots.some((root) => root.id === row.id)).map((row, index) => ({ label: row.label, heading: index === 0 ? 'Folders and repos' : undefined, hint: row.kind === 'repo' ? row.branch || 'repo' : 'folder', onSelect: () => addWorkspace({ kind: 'root', id: row.id }, row.label) })),
              ...ws.sets.filter((set) => !chatWs.items.some((item) => item.kind === 'set' && item.id === set.id)).map((set, index) => ({ label: set.name, heading: index === 0 ? 'Sets' : undefined, hint: set.projects.join(' + '), onSelect: () => addWorkspace({ kind: 'set', id: set.id }, set.name) })),
              ...(canManage ? [{ label: 'Add folder, repo or clone…', icon: FolderGit2, separator: true, onSelect: () => setPanel('workspace') }] : []),
            ]} />
            {chatWs.roots.length === 0 && <span className="faint ws-hint">Attach folders or repos; the agent works in exactly these.</span>}
          </div>
        )}
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
            <div className="empty-chat">
              {persona ? <Face agent={persona} size={64} /> : <CuteArt />}
              <h2>{persona ? greetingFor(persona) : 'Create a persona to start.'}</h2>
              {modelsLoaded && usable.empty
                ? <div className="no-model"><p className="muted">No model yet. Pull a local one here, or <Link to="/setup">set one up</Link> (Ollama or a Gemini key).</p>{canManage && <PullModel onDone={() => void modelState.refresh()} />}</div>
                : <div className="starters">
                    {startersFor(persona, mode === 'code').map((prompt) => (
                      <button key={prompt} className="starter" onClick={() => { setDraft(prompt); input.current?.focus(); }}>{prompt}</button>
                    ))}
                  </div>}
              {!persona && <Link className="btn primary" to="/agents?new=1">New persona</Link>}
            </div>
          )}
          {asks.map((ask) => (
            <div key={ask.id} className="approval-card" role="alertdialog" aria-label="Approval needed">
              <div className="grow">
                <small className="faint">Needs your OK · {ask.toolName}</small>
                <p dir="auto">{ask.reason}</p>
              </div>
              <div className="row">
                <button className="btn ghost" onClick={() => void decide(ask.id, 'deny')}>Deny</button>
                <button className="btn primary" onClick={() => void decide(ask.id, 'approve')}><Check size={15} aria-hidden /> Approve</button>
              </div>
            </div>
          ))}
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
          {messages.map((message, index) => {
            const speaker = message.agentId ? agents.find((agent) => agent.id === message.agentId) : undefined;
            const fromAgent = message.role !== 'user' && message.role !== 'tool' && speaker;
            // The persona mark and name show only on the first reply of a streak.
            let previous: Message | undefined;
            for (let i = index - 1; i >= 0; i -= 1) { if (messages[i]!.role !== 'tool') { previous = messages[i]; break; } }
            const streak = Boolean(fromAgent && previous && previous.role === 'assistant' && previous.agentId === message.agentId);
            if (message.role === 'divider') return <div key={message.id} className="settings-divider" role="note"><span>{message.content}</span></div>;
            if (message.role === 'tool') return <ToolCard key={message.id} name={message.toolName} content={message.content} />;
            const calls = (message.toolCalls || []).map((call) => call.name).filter(Boolean);
            if (message.role === 'assistant' && !message.content.trim() && calls.length) {
              return <div key={message.id} className="tool-call-chip"><Wrench size={14} /> Calling {calls.join(', ')}…{message.routingNote && <span className="switch">{message.routingNote}</span>}</div>;
            }
            const [visible, attached] = message.content.split(CONTEXT_MARK);
            const cites = citationsIn(visible || '').filter((cite) => cite.kind === 'file');
            const helperNote = Boolean(message.routingNote?.startsWith('helper:'));
            return (
            <article key={message.id} id={`m-${message.id}`} data-mid={message.id} title={message.createdAt ? new Date(message.createdAt).toLocaleString() : undefined} className={`${message.role === 'user' ? 'msg user' : fromAgent ? `msg from-agent${streak ? ' cont' : ''}` : 'msg'}${helperNote ? ' helper-result' : ''}`} style={fromAgent ? { ['--accent' as string]: speaker.accent || '#e4b56a' } : undefined}>
              {fromAgent ? !streak && <div className="who"><Face agent={speaker} size={28} /><span className="meta">{speaker.emoji ? `${speaker.emoji} ` : ''}{speaker.name}</span></div> : message.role !== 'user' && message.role !== 'assistant' && <div className="meta"><span>{message.role}</span></div>}
              {message.routingNote && !helperNote && <div className="switch">{message.routingNote}</div>}
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
              <button className="icon-btn round composer-plus" type="button" aria-label="Add files, folders or uploads (@)" title="Add files (@) or upload" onClick={() => setPicker(picker ? null : { query: '' })}><Plus size={18} /></button>
              <PersonaChip agents={agents} active={persona} onSwitch={(id) => void switchPersona(id)} onEdit={() => setPanel('settings')} onNew={() => void newPersona()} />
              <span title={modelPin ? `Pinned to ${pinnedName}` : lastModel ? `Auto picks per message. Last reply: ${lastModel}` : 'Auto picks a model per message'}>
                <ModelPicker state={modelState} value={modelPin} autoLabel={lastModel && !modelPin ? `Auto · ${lastModel}` : 'Auto'} onChange={async (value) => {
                  const previous = modelPin;
                  setModelPin(value);
                  try {
                    if (current) await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ modelPin: value }) });
                  } catch (error) { toast(errorText(error), 'error'); setModelPin(previous); }
                }} />
              </span>
              {meter && <span className="context-meter" aria-label="Context used" title="Context used / budget">{Math.round((meter.used / Math.max(1, meter.budget)) * 100)}% ctx</span>}
              <span className="spacer" />
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
      {panel === 'files' && wsRoot && chatWs.roots.find((root) => root.id === wsRoot) && (
        <WorkspaceBrowser sessionId={current} root={chatWs.roots.find((root) => root.id === wsRoot)!} live={active} onClose={() => setPanel(null)} onChanged={() => void loadChatWs(current)}
          onMention={(path) => addMention({ kind: 'path', root: wsRoot, path, dir: false, label: path })} />
      )}
      {panel === 'context' && current && <ContextPanel sessionId={current} tick={messages.length + helperTick} onClose={() => setPanel(null)}
        onOpenFile={(id) => setViewer({ source: { kind: 'file', id } })} onRolledBack={() => void openSession(current)} />}
      {(panel === 'persona' || panel === 'settings' || panel === 'workspace') && <PersonaPanel agent={persona || null} tab={panel} onTab={setPanel} onClose={() => setPanel(null)} ws={ws} canManage={canManage}
        onAttach={(rootId, label) => addWorkspace({ kind: 'root', id: rootId }, label)}
        onSaved={(agent, what) => {
          setAgents((rows) => rows.map((row) => (row.id === agent.id ? { ...row, ...agent } : row)));
          setMessages((rows) => { const last = rows[rows.length - 1]; const text = 'Settings changed · applies to the next message'; return last?.role === 'divider' && last.content === text ? rows : rows.length ? [...rows, { id: `div-${Date.now()}`, role: 'divider', content: text }] : rows; });
          void what;
        }} />}
      {showState && persona && !['persona', 'settings', 'workspace', 'files', 'context'].includes(panel || '') && (
        <PersonaStatePanel agent={persona} sessions={sessions} tick={messages.length + helperTick} onClose={toggleState}
          onOpenSession={(id) => { void openSession(id); if (!wide) setPanel(null); }} onOpenFile={(id) => setViewer({ source: { kind: 'file', id } })} onOpenPersona={() => setPanel('persona')} />
      )}
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

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
