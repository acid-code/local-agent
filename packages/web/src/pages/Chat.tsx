import { CuteArt } from '../components/CuteArt';
import { isOwner } from '../lib/role';
import { useEffect, useRef, useState } from 'react';
import { Menu as DropMenu } from '../components/ui';
import { ModelPicker, useUsableModels } from '../lib/models';
import { browserDictationSupported, startDictation } from '../lib/dictation';
import { ScanText, AtSign, Info, Layers, Brain, Check, ChevronDown, Code2, Copy, Download, Eye, FileText, Folder, FolderGit2, GitBranch, ListTree, Menu, MessageSquare, MessageSquarePlus, Pin, PinOff, Plus, Search, Mic, PanelRight, Paperclip, Pencil, Quote, RotateCcw, Send, Share, Square, Trash2, Volume2, Wrench, X } from 'lucide-react';
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
import { speak } from '../lib/speak';
import { api, post } from '../lib/api';
import { isAbort, latestOnly } from '../lib/latest';
import { Markdown } from '../components/Markdown';
import { Face, type FaceAgent } from '../components/Face';
import { t, fmt } from '../i18n';

interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null; modelPin?: string | null; updatedAt?: string }
type Agent = PanelAgent & FaceAgent;
interface Message { id: string; role: string; content: string; createdAt?: string; agentId?: string | null; toolName?: string | null; routingNote?: string | null; toolCalls?: { name: string }[] | null }
interface Step { id: string; kind: string; name: string; status: string; latencyMs?: number; output?: unknown; error?: string | null }
interface Plan { id: string; items: { id: string; text: string; status: string }[] }
interface Edit { id: string; label: string; diff: string; revertedAt: string | null }
interface Offer { id: string; kind: string; masked: string }
interface CheckItem { id: string; title: string; ok: boolean; detail: string; optional: boolean }

const draftKey = (id: string) => `la-draft:${id}`;

/** Messages per page when opening a chat; older ones load on scroll. */
const PAGE = 150;

type OcrMode = 'auto' | 'printed' | 'handwriting' | 'off';
const IMAGE_NAME = /\.(jpe?g|png|webp|heic|heif|tiff?|bmp|gif)$/i;

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
  const runSession = useRef<string | null>(null);
  const [status, setStatus] = useState('');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [secret, setSecret] = useState<{ id: string; name: string; reason: string } | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const dictationStop = useRef<(() => void) | null>(null);
  const [ocrMode, setOcrModeState] = useState<OcrMode>(() => { try { const v = localStorage.getItem('la-ocr'); return v === 'off' || v === 'printed' || v === 'handwriting' ? v : 'auto'; } catch { return 'auto'; } });
  const setOcrMode = (value: OcrMode) => { setOcrModeState(value); try { localStorage.setItem('la-ocr', value); } catch { /* private mode */ } };
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
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Distance from the bottom to keep while older messages are added above.
  const prependAnchor = useRef<number | null>(null);
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
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 981px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 981px)');
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
    // Text typed while the first chat was still opening is kept, not wiped.
    const fromNothing = !currentRef.current;
    if (!new URLSearchParams(window.location.search).get('share')) setDraft((value) => localStorage.getItem(draftKey(id)) || (fromNothing ? value : ''));
    const switching = currentRef.current !== id;
    setCurrent(id);
    currentRef.current = id;
    try {
      const [data, wsData] = await Promise.all([
        // Newest page only; a jump to an older message loads everything so it can be found.
        api<{ session: Session; activeRun?: { id: string; status: string } | null; messages: Message[]; hasMore?: boolean; plan: Plan | null; edits: Edit[] }>(pendingJump.current ? `/api/sessions/${id}` : `/api/sessions/${id}?limit=${PAGE}`, { signal: gate.signal }),
        api<typeof chatWs>(`/api/sessions/${id}/workspaces`, { signal: gate.signal }).catch((error) => { if (isAbort(error)) throw error; return { items: [], roots: [], sets: [] }; }),
      ]);
      if (!gate.current()) return;
      setOpenedMeta(data.session);
      setChatWs(wsData);
      setMessages(data.messages);
      setHasMore(Boolean(data.hasMore));
      setPlan(data.plan);
      setEdits(data.edits);
      setMode(data.session.mode);
      setModelPin(data.session.modelPin || null);
      setStreaming('');
      setThinking('');
      // Reloading the same chat after a failed reply keeps the reason on screen.
      if (switching) setRunError(null);
      // Attach to a reply already running in this chat; drop the stream of a chat we left.
      if (data.activeRun) { runSession.current = id; setRunId(data.activeRun.id); setStatus(data.activeRun.status); }
      else if (runSession.current !== id) { runSession.current = null; setRunId(null); setStatus(''); }
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
          const created = await post<{ session: Session }>('/api/sessions', { agentId: persona, title: t('New chat') }, { signal: gate.signal });
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
    if (prependAnchor.current !== null && box.current) {
      box.current.scrollTop = box.current.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
      return;
    }
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages, streaming, thinking, runError]);
  async function loadOlder() {
    const first = messages.find((message) => !message.id.startsWith('local') && !message.id.startsWith('div-'));
    if (!current || !first || loadingOlder) return;
    setLoadingOlder(true);
    const sessionId = current;
    try {
      const page = await api<{ messages: Message[]; hasMore: boolean }>(`/api/sessions/${sessionId}/messages?before=${encodeURIComponent(first.id)}&limit=${PAGE}`);
      if (currentRef.current !== sessionId) return;
      if (box.current) prependAnchor.current = box.current.scrollHeight - box.current.scrollTop;
      setMessages((rows) => [...page.messages.filter((row) => !rows.some((have) => have.id === row.id)), ...rows]);
      setHasMore(page.hasMore);
    } catch (error) { toast(errorText(error), 'error'); } finally { setLoadingOlder(false); }
  }
  // Keep an unsent draft per chat, so a reload or a failed send never loses it.
  useEffect(() => {
    if (!current) return;
    if (draft) localStorage.setItem(draftKey(current), draft); else localStorage.removeItem(draftKey(current));
  }, [draft, current]);
  useEffect(() => {
    if (isOwner()) api<{ scan: unknown; checklist: CheckItem[] }>('/api/discovery').then((data) => setChecklist(data.scan ? data.checklist || [] : [])).catch(() => undefined);
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

  // A reply that starts in this chat from elsewhere (a timer, another tab, a trigger) shows up live here too.
  useEffect(() => {
    const onLive = (event: Event) => {
      const data = (event as CustomEvent).detail as { type?: string; status?: string; runId?: string; sessionId?: string; parentRunId?: string | null };
      if (data.type !== 'status' || data.status !== 'running' || !data.runId || data.parentRunId || data.sessionId !== currentRef.current) return;
      runSession.current = data.sessionId;
      setRunId((value) => value === data.runId ? value : data.runId!);
      setStatus('running');
    };
    window.addEventListener('la:live', onLive);
    return () => window.removeEventListener('la:live', onLive);
  }, []);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        setSteps(data.steps || []);
        setStatus(data.run?.status || '');
        // The run may have ended before this stream connected (e.g. it failed at once): show why.
        if (data.run?.status === 'failed' && data.run?.error) setRunError(String(data.run.error));
        // Ended before this stream connected: the 'done' event is gone, so load the reply now.
        if (['completed', 'failed', 'stopped', 'interrupted'].includes(String(data.run?.status))) {
          setLoadingNote('');
          if (current && currentRef.current === current) void openSession(current);
          void refreshLists().catch(() => undefined);
          source.close();
          return;
        }
      }
      if (data.type === 'token') setStreaming((value) => value + data.text);
      if (data.type === 'thinking') setThinking((value) => value + data.text);
      if (data.type === 'error') setRunError(String(data.message || 'The reply failed.'));
      if (data.type === 'step' && data.step) {
        setSteps((value) => [...value.filter((step) => step.id !== data.step.id), data.step]);
        if (data.step.kind === 'model' && data.step.name) setLastModel(String(data.step.name));
      }
      if (data.type === 'message') {
        if (data.message?.sessionId && data.message.sessionId !== currentRef.current) return;
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
    const created = await post<{ session: Session }>('/api/sessions', { agentId: persona, mode: nextMode, title: nextMode === 'code' ? t('Coding session') : t('New chat') });
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
    if (!target) { toast(t('Create a persona under Agents first.'), 'info'); return; }
    if (active) { toast(t('A reply is still running. Press Stop (Esc) first.'), 'info'); return; }
    const sentQuotes = override === undefined ? quotes : [];
    const sentMentions = override === undefined ? mentions : [];
    const tokens = sentMentions.map((m) => m.kind === 'file' ? `[file:${m.id}]` : `[@${m.root}:${m.path || '.'}${m.start ? `#L${m.start}${m.end && m.end !== m.start ? `-${m.end}` : ''}` : ''}]`);
    const content = [...sentQuotes.map((q) => quoteBlock(q.ref, q.text)), typed.trim() || (tokens.length ? 'Please look at these.' : ''), tokens.length ? tokens.join(' ') : ''].filter(Boolean).join('\n\n');
    const payloadMentions = sentMentions.map((m) => m.kind === 'file' ? { kind: 'file' as const, id: m.id, ocr: ocrMode !== 'off' && IMAGE_NAME.test(m.label) ? ocrMode : undefined } : { kind: 'path' as const, root: m.root, path: m.path, start: m.start, end: m.end });
    if (payloadMentions.some((m) => m.kind === 'file' && m.ocr)) setLoadingNote(t('Reading the text in the photo…'));
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
      toast(t('Not sent: {0} Your text is still in the box.', [errorText(error, 'Could not send.')]), 'error');
      return;
    }
    setVoiceNote('');
    setOffers(result.offers || []);
    runSession.current = target;
    setRunId(result.run.id);
    setStatus('running');
  }

  const appendSpoken = (text: string) => setDraft((value) => `${value} ${text}`.trim());
  const noVoiceHelp = t('No speech model on this machine. Start Whisper from Setup → Voice, or use Chrome/Edge for built-in dictation.');
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
        setVoiceNote(t('Listening (browser dictation)…'));
        dictationStop.current = startDictation(appendSpoken, (message) => { setVoiceNote(message); toast(message, 'error'); });
        setRecording(true);
        return;
      }
      const message = !navigator.mediaDevices?.getUserMedia ? t('The microphone needs HTTPS or http://localhost in this browser.') : noVoiceHelp;
      setVoiceNote(message);
      toast(message, 'error');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'NotAllowedError' ? t('Microphone permission was denied. Allow it in the browser’s site settings.') : error instanceof Error ? error.message : 'Microphone unavailable.';
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
      if (!blob.size) { setVoiceNote(t('Nothing recorded. Hold the button while you speak.')); return; }
      setVoiceNote(t('Transcribing…'));
      try {
        const voiceLang = (() => { try { return localStorage.getItem('la-voice-lang') || ''; } catch { return ''; } })();
        const response = await fetch(`/api/voice/transcribe${/^(he|en)/.test(voiceLang) ? `?lang=${voiceLang.slice(0, 2)}` : ''}`, { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
        const data = await response.json().catch(() => ({})) as { text?: string; error?: string; code?: string; hint?: string };
        if (response.ok) { appendSpoken(data.text || ''); setVoiceNote(''); return; }
        if (data.code === 'no_stt') whisperUp.current = false;
        const message = [data.error || 'Voice is not available.', data.hint].filter(Boolean).join(' ');
        setVoiceNote(message);
        toast(data.code === 'no_stt' && browserDictationSupported() ? t('{0} Hold the mic again to use browser dictation.', [data.error]) : message, 'error');
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
      if (action === 'stop') toast(t('Stopped.'), 'info');
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
    } catch { toast(t('Copy is blocked here. Select the text instead.'), 'info'); }
  }

  async function removeChat(id: string) {
    const row = sessions.find((session) => session.id === id);
    if (!window.confirm(t('Delete “{0}”? It disappears from the list.', [row?.title || 'this chat']))) return;
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      const rows = await refreshLists();
      toast(t('Chat deleted.'), 'ok');
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
    } catch (error) { toast(errorText(error, t('That message is gone.')), 'error'); }
  }
  const citeHandlers: CiteHandlers = {
    open: (cite) => void openCite(cite),
    quoteCode: (code, sourceId) => addQuote({ ref: `msg:${sourceId}`, text: code.slice(0, 2000), label: t('code block') }),
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
    const created = await post<{ session: Session }>('/api/sessions', { agentId, title: t('New chat') });
    await refreshLists();
    await openSession(created.session.id);
  }
  async function newPersona() {
    try {
      const created = await post<{ agent: Agent }>('/api/agents', { name: 'New persona', systemPrompt: 'You are a helpful assistant. Be brief and concrete.', toolAllowlist: ['remember', 'recall', 'web_search'] });
      if (current) await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ agentId: created.agent.id }) });
      else await post('/api/sessions', { agentId: created.agent.id, title: t('New chat') }).then((res) => setCurrent((res as { session: Session }).session.id));
      await refreshLists();
      setPanel('settings');
      toast(t('Persona created. Name it and pick its tools here.'), 'ok');
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
          <input autoFocus dir="auto" aria-label={t('Chat title')} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => void saveTitle(session.id)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); } }} />
        </form>
      ) : (
        <button className="session-open" onClick={() => { void openSession(session.id); setRail(false); }} title={session.title}>
          <strong dir="auto">{session.title}</strong>
          <span className="faint">{session.workshopId ? t('Workspace · ') : session.mode === 'code' ? t('Coding · ') : ''}{relativeTime(session.updatedAt)}</span>
        </button>
      )}
      <span className="session-ops">
        <DropMenu label={t('Options for {0}', [session.title])} items={[
          { label: t('Rename'), icon: Pencil, onSelect: () => { setRenaming(session.id); setTitleDraft(session.title); } },
          { label: pins.includes(session.id) ? t('Unpin') : t('Pin'), icon: pins.includes(session.id) ? PinOff : Pin, onSelect: () => togglePin(session.id) },
          { label: t('Delete chat'), icon: Trash2, danger: true, separator: true, onSelect: () => void removeChat(session.id) },
        ]} />
      </span>
    </div>
  );

  function exportChat() {
    const lines = [`# ${currentSession?.title || 'Chat'}`, ''];
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const [visible] = message.content.split(CONTEXT_MARK);
      if (!visible?.trim()) continue;
      const who = message.role === 'user' ? 'You' : agents.find((agent) => agent.id === message.agentId)?.name || persona?.name || 'Agent';
      lines.push(`**${who}**${message.createdAt ? ` · ${fmt.dateTime(message.createdAt)}` : ''}`, '', visible.trim(), '');
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(currentSession?.title || 'chat').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'chat'}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return (
    <CiteContext.Provider value={citeHandlers}>
    <div className={`chat v2${trace ? ' with-trace' : ''}${panel || showState ? ' with-panel' : ''}`} style={persona?.accent ? { ['--persona' as string]: persona.accent } : undefined}>
      {viewer && <FileViewer source={viewer.source} anchor={viewer.anchor} onClose={() => setViewer(null)} onQuote={addQuote} />}
      {selQuote && <button className="sel-quote" style={{ left: selQuote.x, top: selQuote.y }} onMouseDown={(event) => event.preventDefault()} onClick={() => { addQuote({ ref: `msg:${selQuote.id}`, text: selQuote.text, label: 'selection' }); setSelQuote(null); window.getSelection()?.removeAllRanges(); }}><Quote size={14} />{' '}{t('Quote')}</button>}
      {(rail || trace || panel) && <div className="scrim" onClick={() => { setRail(false); setTrace(false); setPanel(null); }} />}
      <aside className={rail ? 'rail open' : 'rail'} aria-label={t('Chats')}>
        <div className="sheet-head">
          <strong>{t('Chats')}</strong>
          <button className="icon-btn" aria-label={t('Close chats')} onClick={() => setRail(false)}><X size={18} /></button>
        </div>
        <div className="row rail-actions">
          <span className="split">
            <button className="btn primary" title={t('Start a new chat with the first agent')} onClick={() => { void createChat('chat'); setRail(false); }}><MessageSquarePlus size={16} aria-hidden />{' '}{t('New chat')}</button>
            <DropMenu label={t('More ways to start')} icon={ChevronDown} align="start" items={[
              { label: t('New chat'), icon: MessageSquarePlus, hint: t('Talk'), onSelect: () => { void createChat('chat'); setRail(false); } },
              { label: t('New coding session'), icon: Code2, hint: t('Edits files'), onSelect: () => { void createChat('code'); setRail(false); } },
              { label: t('Chat in a workspace…'), icon: FolderGit2, hint: t('Folders and repos'), onSelect: () => { setRail(false); setPanel('workspace'); } },
            ]} />
          </span>
        </div>
        <label className="rail-search"><Search size={15} aria-hidden /><input type="search" placeholder={t('Search chats')} aria-label={t('Search chats')} value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} /></label>
        <div className="session-list">
          {pinnedRows.length > 0 && <><p className="list-heading">{t('Pinned')}</p>{pinnedRows.map(renderSession)}</>}
          {[...groups.entries()].map(([agentId, rows]) => {
            const owner = agents.find((agent) => agent.id === agentId);
            return <div key={agentId || 'none'} className="session-group">{(groups.size > 1 || pinnedRows.length > 0) && <p className="list-heading">{owner ? <><Face agent={owner} size={16} /> {owner.name}</> : t('Other')}</p>}{rows.map(renderSession)}</div>;
          })}
          {sessions.length === 0 && <p className="faint">{t('No chats yet. Press New chat to start one.')}</p>}
          {sessions.length > 0 && filtered.length === 0 && <p className="faint">{t('No chat titles match “')}{chatQuery}”.</p>}
          {nextCursor && <button className="btn ghost small" type="button" onClick={() => void loadMoreSessions()}>{t('Older chats')}</button>}
        </div>
      </aside>
      <section className="thread">
        <div className="thread-head">
          <button className="icon-btn round chats-btn" aria-label={t('Show chats')} title={t('Chats')} onClick={() => { if (window.matchMedia('(max-width: 980px)').matches) window.dispatchEvent(new Event('la:open-sidebar')); else setRail(true); }}><Menu size={17} /></button>
          <span className="head-spacer" />
          {persona && <button className="persona-name head-pill" title={t('{0} · persona info (Ctrl+Shift+I)', [currentSession?.title || 'New chat'])} aria-expanded={panel === 'persona' || panel === 'settings'} onClick={() => setPanel(panel === 'persona' || panel === 'settings' ? null : 'persona')}>
            <Face agent={persona} size={22} /><span className="persona-label ellipsis" dir="auto">{persona.name}{(persona as { title?: string }).title ? ` · ${(persona as { title?: string }).title}` : ''}</span>
            {active && <span className="head-live" aria-label="working" />}
          </button>}
          <strong className="thread-title sr-only" dir="auto">{currentSession?.title || t('No chat open')}</strong>
          <span className="head-spacer" />
          <div className="head-actions">
            {status && status !== 'completed' && !active && <span className={`badge ${status === 'failed' ? 'bad' : ''}`}>{status}</span>}
            {mode === 'code' && <span className="badge warn">{currentSession?.workshopId ? 'workshop' : 'coding'}</span>}
            {currentSession && <button className="icon-btn round" aria-label={t('Export chat')} title={t('Export this chat as Markdown')} onClick={exportChat}><Share size={17} /></button>}
            {persona && <button className={showState ? 'icon-btn round on' : 'icon-btn round'} aria-pressed={showState} aria-label={t('Status')} title={t('{0}: coding, upcoming, computer, voice', [persona.name])} onClick={toggleState}><PanelRight size={17} /></button>}
            {currentSession && <DropMenu label={t('Chat options')} items={[
              { label: t('Chats with this persona'), icon: MessageSquare, onSelect: () => setRail(true) },
              { label: t('Export chat'), icon: Share, onSelect: exportChat },
              { label: t('Helpers, timers and files'), icon: Layers, onSelect: () => setPanel(panel === 'context' ? null : 'context') },
              { label: trace ? t('Hide trace') : t('Show trace'), icon: ListTree, onSelect: () => setTrace((value) => !value) },
              { label: t('Rename chat'), icon: Pencil, onSelect: () => { setRail(true); setRenaming(currentSession.id); setTitleDraft(currentSession.title); } },
              { label: t('Persona info'), icon: Info, hint: t('Ctrl+Shift+I'), onSelect: () => setPanel('persona') },
              { label: t('Persona settings'), icon: Pencil, onSelect: () => setPanel('settings') },
              { label: t('Add or create workspaces'), icon: FolderGit2, onSelect: () => setPanel('workspace') },
              { label: t('New chat'), icon: MessageSquarePlus, onSelect: () => void createChat('chat') },
              { label: t('Delete chat'), icon: Trash2, danger: true, separator: true, onSelect: () => void removeChat(currentSession.id) },
            ]} />}
          </div>
        </div>
        {(current || chatWs.roots.length > 0) && (
          <div className="ws-strip" aria-label={t('Workspaces in this chat')}>
            {chatWs.roots.map((root) => (
              <span key={root.id} className={wsRoot === root.id && panel === 'files' ? 'ws-pill on' : 'ws-pill'}>
                <button type="button" className="ws-pill-open" title={`${root.path}${root.via ? ` · from ${root.via}` : ''}${root.dirty ? ` · ${root.dirty} uncommitted` : ''}`} onClick={() => { if (panel === 'files' && wsRoot === root.id) setPanel(null); else { setWsRoot(root.id); setPanel('files'); } }}>
                  {root.isRepo ? <GitBranch size={13} aria-hidden /> : <Folder size={13} aria-hidden />}
                  <span className="ws-pill-label">{root.label}</span>
                  {root.branch && <span className="faint mono">{root.branch}</span>}
                  {root.dirty > 0 && <span className="dirty-dot" aria-label={`${root.dirty} uncommitted`} />}
                </button>
                <button type="button" className="chip-x" aria-label={t('Remove {0} from this chat', [root.label])} title={t('Remove from this chat')} onClick={() => removeWorkspace(root)}><X size={12} /></button>
              </span>
            ))}
            <DropMenu className="ws-add" align="start" label={t('Add a workspace to this chat')} icon={Plus} text={chatWs.roots.length ? undefined : t('Add workspace')} items={[
              ...ws.workspaces.filter((row) => !chatWs.roots.some((root) => root.id === row.id)).map((row, index) => ({ label: row.label, heading: index === 0 ? 'Folders and repos' : undefined, hint: row.kind === 'repo' ? row.branch || 'repo' : 'folder', onSelect: () => addWorkspace({ kind: 'root', id: row.id }, row.label) })),
              ...ws.sets.filter((set) => !chatWs.items.some((item) => item.kind === 'set' && item.id === set.id)).map((set, index) => ({ label: set.name, heading: index === 0 ? 'Sets' : undefined, hint: set.projects.join(' + '), onSelect: () => addWorkspace({ kind: 'set', id: set.id }, set.name) })),
              ...(canManage ? [{ label: t('Add folder, repo or clone…'), icon: FolderGit2, separator: true, onSelect: () => setPanel('workspace') }] : []),
            ]} />
            {chatWs.roots.length === 0 && <span className="faint ws-hint">{t('Attach folders or repos; the agent works in exactly these.')}</span>}
          </div>
        )}
        <div className={dragging ? 'messages dragging' : 'messages'} ref={box} onMouseUp={onSelectText} onTouchEnd={() => setTimeout(onSelectText, 50)} onScroll={(event) => { if (selQuote) setSelQuote(null); if (hasMore && !loadingOlder && event.currentTarget.scrollTop < 200) void loadOlder(); }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void dropFiles(event.dataTransfer.files); }}>
          <div className="messages-inner">
          {hasMore && <div className="load-older"><button className="btn ghost small" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? t('Loading…') : t('Load earlier messages')}</button></div>}
          {setupLeft.length > 0 && (
            <div className="card first-run">
              <h3>{t('Finish setup')}</h3>
              <p className="muted">{setupLeft.length} step{setupLeft.length === 1 ? '' : 's'}{' '}{t('left before real models answer here.')}</p>
              <ul className="checklist">
                {checklist.filter((item) => !item.optional).map((item) => (
                  <li key={item.id} className={item.ok ? 'done' : ''}><span className={`dot ${item.ok ? 'ok' : 'warn'}`} /> <span><strong>{item.title}</strong> <span className="faint">{item.ok ? '' : item.detail}</span></span></li>
                ))}
              </ul>
              <div className="row"><Link className="btn primary" to="/setup">{t('Open Setup')}</Link><Link className="btn" to="/settings#health">{t('Check health')}</Link></div>
            </div>
          )}
          {messages.length === 0 && (
            <div className="empty-chat">
              {persona ? <Face agent={persona} size={64} /> : <CuteArt />}
              <h2>{persona ? greetingFor(persona) : t('Create a persona to start.')}</h2>
              {modelsLoaded && usable.empty
                ? <div className="no-model"><p className="muted">{t('No model yet. Pull a local one here, or')}{' '}<Link to="/setup">{t('set one up')}</Link>{' '}{t('(Ollama or a Gemini key).')}</p>{canManage && <PullModel onDone={() => void modelState.refresh()} />}</div>
                : <div className="starters">
                    {startersFor(persona, mode === 'code').map((prompt) => (
                      <button key={prompt} className="starter" onClick={() => { setDraft(prompt); input.current?.focus(); }}>{prompt}</button>
                    ))}
                  </div>}
              {!persona && <Link className="btn primary" to="/agents?new=1">{t('New persona')}</Link>}
            </div>
          )}
          {offers.length > 0 && (
            <div className="banner">
              {t('A key-shaped string was moved out of the message. Save it in the vault?')}
              {offers.map((offer) => (
                <button key={offer.id} className="btn" onClick={async () => { await post(`/api/vault/captures/${offer.id}/accept`, { name: 'PASTED_KEY' }); setOffers((value) => value.filter((item) => item.id !== offer.id)); }}>{offer.kind} {offer.masked}</button>
              ))}
            </div>
          )}
          {secret && (
            <form className="banner" onSubmit={async (event) => { event.preventDefault(); await post(`/api/secret-requests/${secret.id}`, { value: secretValue }); setSecret(null); setSecretValue(''); }}>
              <strong>{t('Secret needed:')}{' '}{secret.name}</strong>
              <p className="muted">{secret.reason}{' '}{t('The model will only see a handle.')}</p>
              <input className="input" type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder={t('Paste the key')} />
              <div className="row">
                <button className="btn primary" type="submit">{t('Save and resume')}</button>
                <button className="btn danger" type="button" onClick={async () => { await post(`/api/secret-requests/${secret.id}`, { deny: true }); setSecret(null); }}>{t('Deny')}</button>
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
              return <div key={message.id} className="tool-call-chip"><Wrench size={14} />{' '}{t('Calling')}{' '}{calls.join(', ')}…{message.routingNote && <span className="switch">{message.routingNote}</span>}</div>;
            }
            const [visible, attached] = message.content.split(CONTEXT_MARK);
            const cites = citationsIn(visible || '').filter((cite) => cite.kind === 'file');
            const helperNote = Boolean(message.routingNote?.startsWith('helper:'));
            return (
            <article key={message.id} id={`m-${message.id}`} data-mid={message.id} title={message.createdAt ? fmt.dateTime(message.createdAt) : undefined} className={`${message.role === 'user' ? 'msg user' : fromAgent ? `msg from-agent${streak ? ' cont' : ''}` : 'msg'}${helperNote ? ' helper-result' : ''}`} style={fromAgent ? { ['--accent' as string]: speaker.accent || '#e4b56a' } : undefined}>
              {fromAgent ? !streak && <div className="who"><Face agent={speaker} size={28} /><span className="meta">{speaker.emoji ? `${speaker.emoji} ` : ''}{speaker.name}</span></div> : message.role !== 'user' && message.role !== 'assistant' && <div className="meta"><span>{message.role}</span></div>}
              {message.routingNote && !helperNote && <div className="switch">{message.routingNote}</div>}
              <div dir="auto"><Markdown text={visible || ''} sourceId={message.id} /></div>
              {attached && <details className={attached.includes('### Text read from ') ? 'attached-note ocr-note' : 'attached-note'} open={attached.includes('### Text read from ') && attached.length < 3000}><summary className="faint">{attached.includes('### Text read from ') ? t('Text read from the photo') : <>{t('Context sent with this message (')}{Math.round(attached.length / 1000)}{t('k characters)')}</>}</summary><pre className={attached.includes('### Text read from ') ? 'tool-output ocr-text' : 'mono tool-output'} dir={attached.includes('### Text read from ') ? 'auto' : undefined}>{attached.slice(0, 4000)}{attached.length > 4000 ? '\n…' : ''}</pre></details>}
              {cites.length > 0 && <div className="file-cards">{[...new Map(cites.map((c) => [c.kind === 'file' ? c.id : '', c])).values()].map((cite) => cite.kind === 'file' && <FileCard key={cite.id} id={cite.id} onOpen={() => setViewer({ source: { kind: 'file', id: cite.id }, anchor: cite.anchor })} />)}</div>}
              {message.id !== 'local' && (
                <div className="msg-actions">
                  <button className="icon-btn" aria-label={t('Quote message')} title={t('Quote in your reply')} onClick={() => addQuote({ ref: `msg:${message.id}`, text: (visible || '').slice(0, 1200), label: message.role === 'user' ? t('your message') : 'reply' })}><Quote size={15} /></button>
                  <button className="icon-btn" aria-label={t('Copy message')} title={t('Copy')} onClick={() => void copy(message.id, visible || '')}>{copied === message.id ? <Check size={15} /> : <Copy size={15} />}</button>
                  {message.role !== 'user' && <button className="icon-btn" aria-label={t('Read aloud')} title={t('Read aloud (press again to stop)')} onClick={() => { if (!speak(visible || '')) toast(t('This browser cannot read aloud.'), 'error'); }}><Volume2 size={15} /></button>}
                  {message.role === 'user' && <button className="icon-btn" aria-label={t('Edit as new message')} title={t('Edit into the box')} onClick={() => { setDraft(visible || ''); input.current?.focus(); }}><Pencil size={15} /></button>}
                  {message.id === lastAssistant && !active && <button className="icon-btn" aria-label={t('Regenerate reply')} title={t('Ask again')} onClick={retry}><RotateCcw size={15} /></button>}
                </div>
              )}
            </article>
            );
          })}
          {thinking && (
            <details className="thinking" open={!streaming}>
              <summary><Brain size={14} /> {streaming ? t('Thought for a moment') : t('Thinking…')}</summary>
              <div className="think" dir="auto">{thinking}</div>
            </details>
          )}
          {streaming && <article className="msg" dir="auto"><Markdown text={streaming} streaming /></article>}
          {asks.map((ask) => (
            <div key={ask.id} className="approval-card" role="alertdialog" aria-label={t('Approval needed')}>
              <div className="grow">
                <small className="faint">{t('Needs your OK ·')}{' '}{ask.toolName}</small>
                <p dir="auto">{ask.reason}</p>
              </div>
              <div className="row">
                <button className="btn ghost" onClick={() => void decide(ask.id, 'deny')}>{t('Deny')}</button>
                <button className="btn primary" onClick={() => void decide(ask.id, 'approve')}><Check size={15} aria-hidden />{' '}{t('Approve')}</button>
              </div>
            </div>
          ))}
          {active && !streaming && !thinking && <div className="typing" aria-label={t('Working')}><span /><span /><span /> <em>{loadingNote || t('Working…')}</em></div>}
          {runError && !active && (
            <div className="banner error-card" role="alert">
              <strong>{t('The reply failed.')}</strong>
              <p className="muted" dir="auto">{runError}</p>
              <div className="row"><button className="btn primary" onClick={retry}><RotateCcw size={15} />{' '}{t('Try again')}</button><button className="btn ghost" onClick={() => setTrace(true)}>{t('Open trace')}</button></div>
            </div>
          )}
          {mode === 'code' && plan && (
            <div className="card">
              <h3>{t('Plan')}</h3>
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
              <div className="row"><strong>{edit.label}</strong>{edit.revertedAt ? <span className="badge">reverted</span> : <button className="btn" onClick={async () => { await post(`/api/edits/${edit.id}/revert`); if (current) void openSession(current); }}>{t('Revert checkpoint')}</button>}</div>
              <pre className="command">{edit.diff}</pre>
            </div>
          ))}
          </div>
        </div>
        <div className="composer">
          {picker && <MentionPicker query={picker.query} setQuery={(query) => setPicker({ query })} defaultRoot={agentRoot} sessionId={current} onPick={addMention} onClose={() => { setPicker(null); input.current?.focus(); }} />}
          <form onSubmit={send}>
            {(quotes.length > 0 || mentions.length > 0) && (
              <div className="chips" aria-label={t('Attached references')}>
                {quotes.map((q) => (
                  <span key={q.key} className="chip quote-chip" title={q.text}>
                    <Quote size={13} /><span className="chip-label"><strong>{q.label}</strong> <span className="faint" dir="auto">“{q.text.replace(/\s+/g, ' ').slice(0, 60)}{q.text.length > 60 ? '…' : ''}”</span></span>
                    <button type="button" aria-label={t('Remove quote')} onClick={() => setQuotes((rows) => rows.filter((row) => row.key !== q.key))}><X size={13} /></button>
                  </span>
                ))}
                {mentions.map((m) => (
                  <span key={m.key} className="chip mention-chip">
                    <button type="button" className="chip-open" title={t('Preview')} onClick={() => { if (m.kind === 'file') setViewer({ source: { kind: 'file', id: m.id } }); else if (!m.dir) setViewer({ source: { kind: 'path', root: m.root, path: m.path }, anchor: m.start ? `L${m.start}-${m.end || m.start}` : undefined }); }}>
                      {m.kind === 'file' ? <Paperclip size={13} /> : m.dir ? <Folder size={13} /> : <AtSign size={13} />}
                      <span className="chip-label ellipsis" dir="auto">{m.label}{m.kind === 'path' && m.start ? `#L${m.start}-${m.end || m.start}` : ''}{m.kind === 'path' && m.dir ? '/' : ''}</span>
                    </button>
                    <button type="button" aria-label={t('Remove reference')} onClick={() => setMentions((rows) => rows.filter((row) => row.key !== m.key))}><X size={13} /></button>
                  </span>
                ))}
                {mentions.some((m) => m.kind === 'file' && IMAGE_NAME.test(m.label)) && (
                  <label className="chip ocr-chip" title={t('Read the text in attached photos and send it along (English and Hebrew)')}>
                    <ScanText size={13} aria-hidden />
                    <select aria-label={t('Read text in photos')} value={ocrMode} onChange={(event) => setOcrMode(event.target.value as OcrMode)}>
                      <option value="auto">{t('Read text: auto')}</option>
                      <option value="printed">{t('Read text: printed')}</option>
                      <option value="handwriting">{t('Read text: handwriting')}</option>
                      <option value="off">{t('Read text: off')}</option>
                    </select>
                  </label>
                )}
              </div>
            )}
            <textarea ref={input} dir="auto" rows={1} value={draft} aria-label={t('Message')} placeholder={mode === 'code' ? t('Ask for a plan, then an edit…') : t('Message')} onChange={(event) => {
              const value = event.target.value;
              setDraft(value);
              const upto = value.slice(0, event.target.selectionStart ?? value.length);
              const at = /(^|\s)@([^\s@]*)$/.exec(upto);
              if (at) setPicker({ query: at[2] || '' }); else if (picker && !upto.includes('@')) setPicker(null);
            }} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void dropFiles(event.clipboardData.files); } }} onKeyDown={(event) => { if (picker && event.key === 'Escape') { event.preventDefault(); setPicker(null); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} />
            <div className="composer-bar">
              <button className="icon-btn round composer-plus" type="button" aria-label={t('Add files, folders or uploads (@)')} title={t('Add files (@) or upload')} onClick={() => setPicker(picker ? null : { query: '' })}><Plus size={18} /></button>
              <PersonaChip agents={agents} active={persona} onSwitch={(id) => void switchPersona(id)} onEdit={() => setPanel('settings')} onNew={() => void newPersona()} />
              <span title={modelPin ? t('Pinned to {0}', [pinnedName]) : lastModel ? t('Auto picks per message. Last reply: {0}', [lastModel]) : t('Auto picks a model per message')}>
                <ModelPicker state={modelState} value={modelPin} autoLabel={lastModel && !modelPin ? `Auto · ${lastModel}` : 'Auto'} onChange={async (value) => {
                  const previous = modelPin;
                  setModelPin(value);
                  try {
                    if (current) await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ modelPin: value }) });
                  } catch (error) { toast(errorText(error), 'error'); setModelPin(previous); }
                }} />
              </span>
              {meter && <span className="context-meter" aria-label={t('Context used')} title={t('Context used / budget')}>{Math.round((meter.used / Math.max(1, meter.budget)) * 100)}{t('% ctx')}</span>}
              <span className="spacer" />
              <button className={recording ? 'icon-btn round on' : 'icon-btn round'} type="button" aria-label={t('Hold to talk')} title={t('Hold to talk')} onPointerDown={() => void holdTalk(true)} onPointerUp={() => void holdTalk(false)} onPointerLeave={() => { if (recording) void holdTalk(false); }}><Mic size={18} /></button>
              {active && status !== 'paused' && <button className="btn ghost pause-btn" type="button" onClick={() => control('pause')}>{t('Pause')}</button>}
              {status === 'paused' && <button className="btn ghost" type="button" onClick={() => control('resume')}>{t('Resume')}</button>}
              {active ? <button className="icon-btn round danger-fill" type="button" aria-label={t('Stop (Esc)')} title={t('Stop (Esc)')} onClick={() => control('stop')}><Square size={16} /></button>
                : <button className="icon-btn round primary-fill" type="submit" aria-label={t('Send')} title={t('Send (Enter)')} disabled={(!draft.trim() && !quotes.length && !mentions.length) || !current}><Send size={17} /></button>}
            </div>
          </form>
          {(voiceNote || loadingNote) ? <p className="composer-hint faint">{voiceNote || loadingNote}</p> : <p className="composer-hint faint"><span className="kbd-hint">{t('Enter to send · Shift+Enter for a new line · Esc to stop')}</span></p>}
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
      <aside className={trace ? 'trace open' : 'trace'} aria-label={t('Trace')}>
        <div className="sheet-head">
          <strong>{t('Trace')}</strong>
          <button className="icon-btn" aria-label={t('Close trace')} onClick={() => setTrace(false)}><X size={18} /></button>
        </div>
        <p className="faint">{t('Every model call and tool call lands here, with the arguments the model actually sent.')}</p>
        {steps.map((step) => (
          <div key={step.id} className="step">
            <div className="row"><span className={`dot ${step.status === 'completed' ? 'ok' : step.status === 'failed' ? 'bad' : 'live'}`} /><strong>{step.kind}</strong> <span className="muted ellipsis">{step.name}</span></div>
            <div className="faint">{step.status}{step.latencyMs ? t(' · {0} ms', [step.latencyMs]) : ''}</div>
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
  if (meta === null) return <div className="file-card missing"><FileText size={18} /><span className="faint">{t('File')}{' '}{id}{' '}{t('is gone.')}</span></div>;
  const kind = meta ? kindOf(meta.name, meta.mime) : 'binary';
  if (meta && kind === 'image') {
    return (
      <div className="file-card image-card">
        <button className="file-card-main" onClick={onOpen} title={t('Preview')}><img src={rawUrl(id)} alt={meta.name} className="file-preview" loading="lazy" /></button>
        <div className="image-card-bar">
          <span className="file-card-text"><strong className="ellipsis" dir="auto">{meta.name}</strong><span className="faint">{humanSize(meta.size)}</span></span>
          <button className="icon-btn" aria-label={t('Preview')} title={t('Preview')} onClick={onOpen}><Eye size={16} /></button>
          <button className="icon-btn" aria-label={t('Download')} title={t('Download')} onClick={() => saveFile(rawUrl(id), meta.name, meta.mime)}><Download size={16} /></button>
        </div>
      </div>
    );
  }
  return (
    <div className="file-card">
      <button className="file-card-main" onClick={onOpen} title={t('Preview')}>
        {meta && kind === 'image' ? <img src={rawUrl(id)} alt="" className="file-thumb" /> : <span className={`file-icon k-${kind}`}><FileText size={20} /></span>}
        <span className="file-card-text"><strong className="ellipsis" dir="auto">{meta?.name || t('Loading…')}</strong><span className="faint">{meta ? `${kind.toUpperCase()} · ${humanSize(meta.size)}` : ''}</span></span>
      </button>
      <button className="icon-btn" aria-label={t('Preview')} title={t('Preview')} onClick={onOpen}><Eye size={16} /></button>
      <button className="icon-btn" aria-label={t('Download')} title={t('Download')} onClick={() => meta && saveFile(rawUrl(id), meta.name, meta.mime)}><Download size={16} /></button>
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
  return fmt.date(iso, { month: 'short', day: 'numeric' });
}
