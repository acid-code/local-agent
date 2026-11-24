import { CuteArt } from '../components/CuteArt';
import { isOwner } from '../lib/role';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu as DropMenu } from '../components/ui';
import { ModelPicker, useUsableModels } from '../lib/models';
import { browserDictationSupported, startDictation } from '../lib/dictation';
import { Archive, ArrowLeft, ScanText, AtSign, Info, Layers, Brain, Check, ChevronDown, Code2, Copy, Download, Eye, FileText, Folder, FolderGit2, GitBranch, Headphones, ListTree, Menu, MessageSquare, MessageSquarePlus, Pin, PinOff, Plus, Search, Mic, PanelRight, Paperclip, Pencil, Quote, RotateCcw, Send, Share, Square, Trash2, Volume2, Wrench, X } from 'lucide-react';
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
import { ContextRing } from '../components/ContextRing';
import { TypingDots, WorkGroupView } from '../components/WorkSteps';
import { TraceList } from '../components/TraceList';
import { groupWork, savedSkills } from '../lib/work-steps';
import { ContextNudgeBanner, DecisionTimeline, BulkDiffCard, LocalRepoPicker, MiniAgentStrip, type MiniAgentRow } from '../components/ChatUpgrades';
import { parseSources, toolSummary, waitStateOf, waitedFor, type ContextBreakdown, type ReasoningEffort } from '@local-agent/shared';
import { toast, errorText } from '../lib/toast';
import { copyText } from '../lib/files';
import { speak, subscribeSpeaking } from '../lib/speak';
import { WAKE_AFTER_MS, backoffMs, chatLiveAction, mergeSnapshot, snapshotDiffers } from '../lib/live-sync';
import { keepIdentity } from '../lib/anim-clock';
import { api, post } from '../lib/api';
import { isAbort, latestOnly } from '../lib/latest';
import { Markdown } from '../components/Markdown';
import { Face, type FaceAgent } from '../components/Face';
import { t, fmt } from '../i18n';

interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null; modelPin?: string | null; effort?: Exclude<ReasoningEffort, 'auto'> | null; updatedAt?: string }
type Agent = PanelAgent & FaceAgent;
interface Message { id: string; role: string; content: string; createdAt?: string; agentId?: string | null; toolName?: string | null; toolCallId?: string | null; runId?: string | null; routingNote?: string | null; thinking?: string | null; toolCalls?: { id?: string; name: string; arguments?: string }[] | null }
interface Step { id: string; kind: string; name: string; status: string; latencyMs?: number; output?: unknown; error?: string | null }
interface Plan { id: string; items: { id: string; text: string; status: string; note?: string | null }[]; canUndo?: boolean }
interface Edit { id: string; runId: string | null; label: string; diff: string; revertedAt: string | null; keptAt: string | null; keptFiles: string[]; revertedFiles: string[] }
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
  const [liveTps, setLiveTps] = useState<number | null>(null);
  const streamMetricsRef = useRef<{ startedAt: number; chunks: number; chars: number }>({ startedAt: 0, chunks: 0, chars: 0 });
  const streamFlushRef = useRef<{ text: string; thinking: string; textTimer: number | null; thinkingTimer: number | null }>({ text: '', thinking: '', textTimer: null, thinkingTimer: null });
  const [runId, setRunId] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;
  // Bumped when the page comes back after a while (sleep, minimised window) or the network returns: live streams reconnect and resync.
  const [wake, setWake] = useState(0);
  const [runReconnect, setRunReconnect] = useState(0);
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
  const [effort, setEffort] = useState<ReasoningEffort>('auto');
  const [loadingNote, setLoadingNote] = useState('');
  // What a waiting run waits for: the large-model queue or RAM (see waitStateOf).
  const [waitInfo, setWaitInfo] = useState<unknown>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [, setWaitTick] = useState(0);
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const [miniAgents, setMiniAgents] = useState<MiniAgentRow[]>([]);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [voiceLoop, setVoiceLoop] = useState(false);
  const voiceLoopRef = useRef(false);
  voiceLoopRef.current = voiceLoop;
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const nearBottomRef = useRef(true);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  useEffect(() => subscribeSpeaking(setSpeakingId), []);
  const [rail, setRail] = useState(false);
  const [trace, setTrace] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
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
  // Work groups are rebuilt only when the transcript changes, not on every streamed token.
  const items = useMemo(() => groupWork(messages), [messages]);
  // Live reasoning between steps shows as the last row of the live work group, so it no longer pops a separate
  // block in and out below the steps on every tool call.
  const thoughtInGroup = Boolean(active && thinking && !streaming && items[items.length - 1]?.kind === 'work');
  // The "Working…" dots stay mounted for the whole run. They used to unmount whenever a thought or text streamed
  // and come back between steps, which read as flicker; now only their note changes.
  const showTyping = active && status !== 'paused' && status !== 'awaiting_approval';
  const typingNote = loadingNote || (thinking && !streaming ? t('Thinking…') : t('Working…'));

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
  const [browserNotice, setBrowserNotice] = useState<{ persona: string; url: string; needsLogin?: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
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
        api<{ session: Session; activeRun?: { id: string; status: string } | null; live?: { text: string; thinking: string; status: string; detail?: string } | null; breakdown?: ContextBreakdown | null; messages: Message[]; hasMore?: boolean; plan: Plan | null; edits: Edit[] }>(pendingJump.current ? `/api/sessions/${id}` : `/api/sessions/${id}?limit=${PAGE}`, { signal: gate.signal }),
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
      setEffort(data.session.effort || 'auto');
      setBreakdown(data.breakdown ?? null);
      if (switching) {
        setRunError(null);
        setLastModel('');
      }
      // Attach to a reply already running in this chat and hydrate any in-progress streamed output; drop the stream of a chat we left.
      if (data.activeRun) {
        runSession.current = id;
        setRunId(data.activeRun.id);
        setStatus(data.live?.status || data.activeRun.status);
        setStreaming(data.live?.text || '');
        setThinking(data.live?.thinking || '');
        setLoadingNote(data.live?.detail || '');
        setWaitInfo((data.live as { waitInfo?: unknown } | null)?.waitInfo ?? null);
      } else if (runSession.current !== id) {
        runSession.current = null;
        setRunId(null);
        setStatus('');
        setStreaming('');
        setThinking('');
        setLoadingNote('');
      } else {
        setStreaming('');
        setThinking('');
      }
      if (data.session.agentId) void post(`/api/agents/${data.session.agentId}/read`, {}).catch(() => undefined);
    } catch (error) {
      if (!isAbort(error) && gate.current()) toast((error as Error).message, 'error');
    }
  }

  const helperRunIds = miniAgents.map((h) => h.childRunId).filter((id): id is string => Boolean(id));
  const helperWaiting = miniAgents.some((h) => h.status === 'waiting');
  const helperRunKey = helperRunIds.join(',');
  async function loadAsks(run: string | null, extraRuns: string[] = []) {
    const wanted = new Set([run, ...extraRuns].filter((id): id is string => Boolean(id)));
    if (!wanted.size) { setAsks([]); return; }
    try { const data = await api<{ approvals: { id: string; runId: string; toolName: string; reason: string }[] }>('/api/approvals'); setAsks(data.approvals.filter((row) => wanted.has(row.runId))); }
    catch { /* the card shows on the next status */ }
  }
  useEffect(() => {
    if (status === 'awaiting_approval' || helperWaiting) void loadAsks(runId, helperRunIds);
    else setAsks([]);
  }, [status, runId, helperWaiting, helperRunKey]);
  async function decide(id: string, decision: 'approve' | 'deny') {
    setAsks((rows) => rows.filter((row) => row.id !== id));
    try { await post(`/api/approvals/${id}`, { decision }); } catch (error) { toast(errorText(error), 'error'); void loadAsks(runId, helperRunIds); }
  }

  // While helpers run in the background, check now and then; when the last one ends, its result is in the chat.
  useEffect(() => {
    setNudgeDismissed(false);
    if (!current) { setMiniAgents([]); return; }
    const id = current;
    let stopped = false;
    let wasBusy = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const ctx = await api<{ helpers: MiniAgentRow[] }>(`/api/sessions/${id}/context`);
        if (stopped || currentRef.current !== id) return;
        setMiniAgents(ctx.helpers || []);
        const busy = (ctx.helpers || []).some((row) => row.status === 'running' || row.status === 'queued' || row.status === 'waiting');
        if (wasBusy && !busy) {
          const data = await api<{ messages: Message[] }>(`/api/sessions/${id}`);
          if (!stopped && currentRef.current === id) { setMessages((prev) => keepIdentity(prev, data.messages)); setHelperTick((value) => value + 1); }
        }
        wasBusy = busy;
        if (busy) timer = window.setTimeout(() => void check(), 2500);
      } catch { /* the next run or open checks again */ }
    };
    void check();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [current, status, helperTick]);

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
    if (nearBottomRef.current) {
      box.current?.scrollTo({ top: box.current.scrollHeight });
    }
  }, [messages, streaming, thinking, runError]);

  // Periodic memory re-check while waiting in the admission queue so runs never stay stuck once memory frees.
  useEffect(() => {
    if (status !== 'waiting') return;
    const timer = window.setInterval(() => {
      void post('/api/memory/recheck', {}).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status]);
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
  // Tick the "waiting 1m 20s" counter while a run waits.
  useEffect(() => {
    if (status !== 'waiting') { setConfirmForce(false); return; }
    const timer = window.setInterval(() => setWaitTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status]);
  // Esc stops a running reply (when no dialog or menu has focus).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); (document.querySelector('.persona-chip') as HTMLButtonElement | null)?.click(); return; }
      // Ctrl/Cmd+Shift+I: this persona's info pane.
      if ((event.key === 'I' || event.key === 'i') && event.shiftKey && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setPanel((value) => value === 'persona' || value === 'settings' ? null : 'persona'); return; }
      if (event.key !== 'Escape') return;
      // An open menu or dialog handles its own Esc first.
      if (document.querySelector('.menu-panel, [role="dialog"]')) return;
      if (rail) { setRail(false); return; }
      if (trace) { event.preventDefault(); setTrace(false); return; }
      if (active && runId) { event.preventDefault(); void control('stop'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, runId, rail, trace]);
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

  // Coming back after sleep, a minimised window or a network change: the old connections may be dead without
  // having errored yet, so reconnect both live streams (each starts with a fresh snapshot).
  useEffect(() => {
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt >= WAKE_AFTER_MS) setWake((n) => n + 1);
      hiddenAt = 0;
    };
    const onOnline = () => setWake((n) => n + 1);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    // The app-wide live socket reconnected (server restart, network back): resync this chat too.
    window.addEventListener('la:resync', onOnline);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline); window.removeEventListener('la:resync', onOnline); };
  }, []);

  // The open chat's live feed. Runs started anywhere (phone, another window, a timer), messages from other runs
  // and runs ending while this page streams nothing all arrive here within a second. Every (re)connect starts with
  // a snapshot, so a dropped connection resyncs instead of leaving the chat stale until you navigate away and back.
  useEffect(() => {
    if (!current) return;
    const sessionId = current;
    let source: EventSource | null = null;
    let first = true;
    let attempt = 0;
    let retry: number | undefined;
    let closed = false;
    const adopt = (id: string, nextStatus: string) => {
      runSession.current = sessionId;
      setRunId((value) => value === id ? value : id);
      setStatus(nextStatus);
    };
    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/sessions/${sessionId}/events`);
      source.onopen = () => { attempt = 0; };
      source.onmessage = (event) => {
        if (currentRef.current !== sessionId) return;
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') {
          const wasFirst = first;
          first = false;
          if (data.activeRun && data.activeRun.id !== runIdRef.current) adopt(data.activeRun.id, data.live?.status || data.activeRun.status);
          // Same run still going after a reconnect: its own stream may have died with the connection, so reopen it.
          else if (!wasFirst && data.activeRun) setRunReconnect((n) => n + 1);
          if (!wasFirst && Array.isArray(data.messages)) {
            setMessages((prev) => snapshotDiffers(prev, data.messages) ? keepIdentity(prev, mergeSnapshot(prev, data.messages)) : prev);
            // The run this page streamed ended while the connection was down: load its final state.
            if (!data.activeRun && runIdRef.current) void openSession(sessionId);
          }
          return;
        }
        const action = chatLiveAction(data, { sessionId, runId: runIdRef.current });
        if (action.kind === 'adopt-run') adopt(action.runId, action.status);
        else if (action.kind === 'upsert-message') setMessages((value) => [...value.filter((m) => m.id !== action.message.id), action.message as Message]);
        else if (action.kind === 'reload') { void openSession(sessionId); void refreshLists().catch(() => undefined); }
      };
      source.onerror = () => {
        // EventSource retries by itself after network errors (server sends retry: 1000). It gives up only on an
        // HTTP error (e.g. the server restarting); then reconnect with backoff.
        if (source?.readyState !== EventSource.CLOSED || closed) return;
        source = null;
        retry = window.setTimeout(connect, backoffMs(attempt++));
      };
    };
    connect();
    return () => { closed = true; window.clearTimeout(retry); source?.close(); };
    // openSession/refreshLists are stable enough: they read refs and set state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, wake]);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        const buffer = streamFlushRef.current;
        if (buffer.textTimer != null) window.clearTimeout(buffer.textTimer);
        if (buffer.thinkingTimer != null) window.clearTimeout(buffer.thinkingTimer);
        buffer.text = '';
        buffer.thinking = '';
        buffer.textTimer = null;
        buffer.thinkingTimer = null;
        setSteps(data.steps || []);
        setStatus(data.statusDetail && data.run?.status === 'running' && /Waiting for memory|\(queued/i.test(String(data.statusDetail)) ? 'waiting' : (data.run?.status || ''));
        if (typeof data.streaming === 'string' && data.streaming) setStreaming(data.streaming);
        if (typeof data.thinking === 'string' && data.thinking) setThinking(data.thinking);
        if (typeof data.statusDetail === 'string' && data.statusDetail) setLoadingNote(data.statusDetail);
        setWaitInfo(data.waitInfo ?? null);
        if (Array.isArray(data.messages) && data.run?.sessionId === currentRef.current) {
          setMessages((prev) => (data.messages.length >= prev.length ? keepIdentity(prev, data.messages as Message[]) : prev));
        }
        // The run may have ended before this stream connected (e.g. it failed at once): show why.
        if (data.run?.status === 'failed' && data.run?.error) setRunError(String(data.run.error));
        // Ended before this stream connected: the 'done' event is gone, so load the reply now.
        if (['completed', 'failed', 'stopped', 'interrupted'].includes(String(data.run?.status))) {
          setLoadingNote('');
          const cur = currentRef.current;
          if (cur) void openSession(cur);
          void refreshLists().catch(() => undefined);
          source.close();
          return;
        }
      }
      if (data.type === 'token' || data.type === 'thinking') {
        const piece = String(data.text || '');
        const buffer = streamFlushRef.current;
        if (data.type === 'token') {
          buffer.text += piece;
          if (buffer.textTimer == null) {
            buffer.textTimer = window.setTimeout(() => {
              const pending = buffer.text;
              buffer.text = '';
              buffer.textTimer = null;
              if (pending) setStreaming((value) => value + pending);
            }, 45);
          }
        } else {
          buffer.thinking += piece;
          if (buffer.thinkingTimer == null) {
            buffer.thinkingTimer = window.setTimeout(() => {
              const pending = buffer.thinking;
              buffer.thinking = '';
              buffer.thinkingTimer = null;
              if (pending) setThinking((value) => value + pending);
            }, 45);
          }
        }
        const nowMs = performance.now();
        const m = streamMetricsRef.current;
        if (!m.startedAt) m.startedAt = nowMs;
        m.chunks += 1;
        m.chars += piece.length;
        const elapsed = (nowMs - m.startedAt) / 1000;
        if (elapsed >= 0.35) {
          // Each SSE delta from llama-server/Ollama is ~1 token (or ~3.5 chars when coalesced).
          const estTokens = Math.max(m.chunks, Math.round(m.chars / 3.6));
          setLiveTps(Math.round((estTokens / elapsed) * 10) / 10);
        }
      }
      if (data.type === 'computer_browser_started') {
        setBrowserNotice({ persona: String(data.personaName || 'Agent'), url: String(data.url || '') });
      }
      if (data.type === 'computer_login_pause') {
        setBrowserNotice({ persona: String(data.personaName || 'Agent'), url: String(data.url || ''), needsLogin: true });
      }
      if (data.type === 'error') setRunError(String(data.message || 'The reply failed.'));
      if (data.type === 'step' && data.step) {
        setSteps((value) => [...value.filter((step) => step.id !== data.step.id), data.step]);
        if (data.step.kind === 'model' && data.step.name) setLastModel(String(data.step.name));
        const cur = currentRef.current;
        if ((data.step.name === 'tasks' || data.step.name === 'plan') && data.step.status === 'completed' && cur) void api<{ plan: Plan | null }>(`/api/sessions/${cur}?limit=1`).then((fresh) => setPlan(fresh.plan)).catch(() => undefined);
      }
      if (data.type === 'message') {
        if (data.message?.sessionId && data.message.sessionId !== currentRef.current) return;
        const buffer = streamFlushRef.current;
        if (buffer.textTimer != null) window.clearTimeout(buffer.textTimer);
        if (buffer.thinkingTimer != null) window.clearTimeout(buffer.thinkingTimer);
        buffer.text = '';
        buffer.thinking = '';
        buffer.textTimer = null;
        buffer.thinkingTimer = null;
        setMessages((value) => [...value.filter((m) => m.id !== data.message.id), data.message]);
        setStreaming('');
        setThinking('');
        streamMetricsRef.current = { startedAt: 0, chunks: 0, chars: 0 };
        // Auto-speak reply if the responding persona has Answer by voice enabled or Voice-First Mode is on.
        if (data.message?.role === 'assistant' && data.message?.content?.trim() && !(data.message.toolCalls?.length)) {
          const speaker = agentsRef.current.find((a) => a.id === data.message.agentId);
          if (speaker?.voiceReply || voiceLoopRef.current) {
            const [spoken] = String(data.message.content).split(CONTEXT_MARK);
            if (spoken?.trim()) speak(spoken, { key: data.message.id, agentId: speaker?.id });
          }
        }
      }
      if (data.type === 'context') {
        if (data.breakdown) setBreakdown(data.breakdown as ContextBreakdown);
        else setBreakdown((prev) => ({
          budget: Number(data.budget || prev?.budget || 1),
          used: Number(data.used || 0),
          remaining: Math.max(0, Number(data.budget || 0) - Number(data.used || 0)),
          outputReserve: prev?.outputReserve ?? 2048,
          systemPrompt: prev?.systemPrompt ?? 0,
          personaAndTools: prev?.personaAndTools ?? 0,
          memory: prev?.memory ?? 0,
          history: Number(data.used || 0),
          files: prev?.files ?? 0,
        }));
      }
      if (data.type === 'status') {
        setStatus(data.status);
        setLoadingNote(data.status === 'loading' || data.status === 'waiting' ? String(data.detail || (data.status === 'waiting' ? 'Waiting' : 'Loading model')) : '');
        setWaitInfo(data.status === 'waiting' ? (data.waitInfo ?? null) : null);
      }
      if (data.type === 'secret' && data.request) setSecret(data.request);
      if (data.type === 'approval' || (data.type === 'status' && data.status === 'awaiting_approval')) void loadAsks(runId);
      if (data.type === 'done') {
        setLoadingNote('');
        setStatus(data.run?.status || 'completed');
        if (data.run?.modelId) setLastModel(modelsRef.current.find((model) => model.id === data.run.modelId)?.name || String(data.run.modelId));
        if (data.run?.status === 'failed' && data.run?.error) setRunError(String(data.run.error));
        const cur = currentRef.current;
        if (cur && runSession.current === cur) void openSession(cur);
        void refreshLists().catch(() => undefined);
        source.close();
      }
    };
    return () => source.close();
  }, [runId, wake, runReconnect]);

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
    const sentQuotes = override === undefined ? quotes : [];
    const sentMentions = override === undefined ? mentions : [];
    const tokens = sentMentions.map((m) => m.kind === 'file' ? `[file:${m.id}]` : `[@${m.root}:${m.path || '.'}${m.start ? `#L${m.start}${m.end && m.end !== m.start ? `-${m.end}` : ''}` : ''}]`);
    const content = [...sentQuotes.map((q) => quoteBlock(q.ref, q.text)), typed.trim() || (tokens.length ? 'Please look at these.' : ''), tokens.length ? tokens.join(' ') : ''].filter(Boolean).join('\n\n');
    if (active && runId) {
      try {
        await post(`/api/runs/${runId}/steer`, { content });
        if (override === undefined) { setDraft(''); setQuotes([]); setMentions([]); }
        setMessages((value) => [...value, { id: `steer-local-${Date.now()}`, role: 'user', content, routingNote: 'Steering' }]);
        toast(t('Steering added to the active run.'), 'info');
      } catch (error) {
        if (override === undefined) { setDraft(typed); setQuotes(sentQuotes); setMentions(sentMentions); }
        toast(errorText(error, 'Could not steer the active run.'), 'error');
      }
      return;
    }
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
      if (action === 'force') toast(t('Forcing run past memory wait…'), 'info');
    } catch (error) { toast(errorText(error), 'error'); }
  }

  function retry() {
    const last = [...messages].reverse().find((message) => message.role === 'user');
    if (last) void send(undefined, last.content);
  }

  async function copy(id: string, text: string) {
    const ok = await copyText(text);
    if (ok) {
      setCopied(id);
      setTimeout(() => setCopied((value) => (value === id ? null : value)), 1500);
    } else {
      toast(t('Copy is blocked here. Select the text instead.'), 'info');
    }
  }

  function removeChat(id: string) {
    const row = sessions.find((session) => session.id === id) || (openedMeta?.id === id ? openedMeta : undefined);
    setDeleteTarget({ id, title: row?.title || t('this chat') });
  }

  async function confirmRemoveChat(permanent: boolean) {
    if (!deleteTarget || deleting) return;
    const { id } = deleteTarget;
    setDeleting(true);
    try {
      await api(`/api/sessions/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' });
      setDeleteTarget(null);
      const rows = await refreshLists();
      toast(permanent ? t('Chat deleted permanently.') : t('Chat archived.'), 'ok');
      if (id === current) {
        if (rows[0]) await openSession(rows[0].id);
        else { setCurrent(null); setMessages([]); }
      }
    } catch (error) { toast(errorText(error), 'error'); } finally { setDeleting(false); }
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
        {steps.length > 0 && (
          <DecisionTimeline steps={steps} live={Boolean(active)} liveTokPerSec={liveTps} docked onStop={() => control('stop')} />
        )}
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
        <div className={dragging ? 'messages dragging' : 'messages'} ref={box} onMouseUp={onSelectText} onTouchEnd={() => setTimeout(onSelectText, 50)} onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          if (nearBottomRef.current !== atBottom) { nearBottomRef.current = atBottom; setNearBottom(atBottom); }
          if (selQuote) setSelQuote(null);
          if (hasMore && !loadingOlder && el.scrollTop < 200) void loadOlder();
        }}
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
              <div className="row"><Link className="btn primary" to="/settings#system">{t('Open System Settings')}</Link><Link className="btn" to="/settings#health">{t('Check health')}</Link></div>
            </div>
          )}
          {messages.length === 0 && (
            <div className="empty-chat">
              {persona ? <Face agent={persona} size={64} /> : <CuteArt />}
              <h2>{persona ? greetingFor(persona) : t('Create a persona to start.')}</h2>
              {modelsLoaded && usable.empty
                ? <div className="no-model"><p className="muted">{t('No model yet. Pull a local one here, or configure one in')}{' '}<Link to="/settings#system">{t('Settings → System')}</Link>{' '}{t('(Ollama, llama-server, or Gemini).')}</p>{canManage && <PullModel suggestion="gpt-oss:20b" onDone={() => void modelState.refresh()} />}</div>
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
          {(() => { const indexOf = new Map(messages.map((m, i) => [m.id, i])); return items.map((item, itemIndex) => {
            if (item.kind === 'work') {
              const live = Boolean(active) && itemIndex === items.length - 1;
              const runs = new Set(item.runIds);
              const skills = live ? [] : savedSkills(item);
              const view = <WorkGroupView key={item.id} group={item} live={live} liveThought={live && thoughtInGroup ? thinking : undefined} diffs={edits.filter((edit) => edit.runId && runs.has(edit.runId)).map((edit) => edit.diff)} />;
              if (!skills.length) return view;
              return <div key={item.id}>{view}{skills.map((skill) => <SkillSavedNotice key={skill.slug} slug={skill.slug} version={skill.version} />)}</div>;
            }
            const message = item.message;
            const index = indexOf.get(message.id) ?? 0;
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
            const [rawVisible, attached] = message.content.split(CONTEXT_MARK);
            const pmsgMatch = (rawVisible || '').match(/^\[persona-message\|([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^\]]*)\]\n?/);
            const pmsg = pmsgMatch ? { id: pmsgMatch[1]!, kind: pmsgMatch[2]!, fromAgentId: pmsgMatch[3]!, fromName: pmsgMatch[4]!, fromSessionId: pmsgMatch[5] || '' } : null;
            const visible = pmsg ? (rawVisible || '').slice(pmsgMatch![0].length) : (rawVisible || '');
            const cites = citationsIn(visible || '').filter((cite) => cite.kind === 'file');
            const helperNote = Boolean(message.routingNote?.startsWith('helper:'));
            return (
            <article key={message.id} id={`m-${message.id}`} data-mid={message.id} title={message.createdAt ? fmt.dateTime(message.createdAt) : undefined} className={`${message.role === 'user' ? 'msg user' : fromAgent ? `msg from-agent${streak ? ' cont' : ''}` : 'msg'}${helperNote ? ' helper-result' : ''}${pmsg ? ' persona-msg' : ''}`} style={fromAgent ? { ['--accent' as string]: speaker.accent || '#e4b56a' } : undefined}>
              {pmsg && (
                <div className="persona-msg-head">
                  <span>{t('From {0}', [pmsg.fromName])}</span>
                  {pmsg.kind === 'handoff' && <span className="pill small">{t('Handoff')}</span>}
                  {pmsg.fromAgentId && <Link className="link-button" to={`/?persona=${pmsg.fromAgentId}`}>{t('Open chat')}</Link>}
                </div>
              )}
              {!pmsg && (fromAgent ? !streak && <div className="who"><Face agent={speaker} size={28} /><span className="meta">{speaker.emoji ? `${speaker.emoji} ` : ''}{speaker.name}</span></div> : message.role !== 'user' && message.role !== 'assistant' && <div className="meta"><span>{message.role}</span></div>)}
              {message.routingNote && !helperNote && <div className="switch">{message.routingNote}</div>}
              {message.thinking && (
                <details className="thinking saved-thinking">
                  <summary><Brain size={14} aria-hidden /> {t('Reasoning')}</summary>
                  <div className="think" dir="auto">{message.thinking}</div>
                </details>
              )}
              <div dir="auto"><Markdown text={visible || ''} sourceId={message.id} /></div>
              {attached && <details className={attached.includes('### Text read from ') ? 'attached-note ocr-note' : 'attached-note'} open={attached.includes('### Text read from ') && attached.length < 3000}><summary className="faint">{attached.includes('### Text read from ') ? t('Text read from the photo') : <>{t('Context sent with this message (')}{Math.round(attached.length / 1000)}{t('k characters)')}</>}</summary><pre className={attached.includes('### Text read from ') ? 'tool-output ocr-text' : 'mono tool-output'} dir={attached.includes('### Text read from ') ? 'auto' : undefined}>{attached.slice(0, 4000)}{attached.length > 4000 ? '\n…' : ''}</pre></details>}
              {cites.length > 0 && <div className="file-cards">{[...new Map(cites.map((c) => [c.kind === 'file' ? c.id : '', c])).values()].map((cite) => cite.kind === 'file' && <FileCard key={cite.id} id={cite.id} onOpen={() => setViewer({ source: { kind: 'file', id: cite.id }, anchor: cite.anchor })} />)}</div>}
              {message.id !== 'local' && (
                <div className="msg-actions">
                  <button className="icon-btn" aria-label={t('Quote message')} title={t('Quote in your reply')} onClick={() => addQuote({ ref: `msg:${message.id}`, text: (visible || '').slice(0, 1200), label: message.role === 'user' ? t('your message') : 'reply' })}><Quote size={15} /></button>
                  <button className="icon-btn" aria-label={t('Copy message')} title={t('Copy')} onClick={() => void copy(message.id, visible || '')}>{copied === message.id ? <Check size={15} /> : <Copy size={15} />}</button>
                  {message.role !== 'user' && <button className={speakingId === message.id ? 'icon-btn on' : 'icon-btn'} aria-label={t('Read aloud')} title={speakingId === message.id ? t('Stop reading') : t('Read aloud')} onClick={() => { if (!speak(visible || '', { key: message.id, agentId: message.agentId ?? undefined })) toast(t('This browser cannot read aloud.'), 'error'); }}><Volume2 size={15} /></button>}
                  {message.role === 'user' && <button className="icon-btn" aria-label={t('Edit as new message')} title={t('Edit into the box')} onClick={() => { setDraft(visible || ''); input.current?.focus(); }}><Pencil size={15} /></button>}
                  {message.id === lastAssistant && !active && <button className="icon-btn" aria-label={t('Regenerate reply')} title={t('Ask again')} onClick={retry}><RotateCcw size={15} /></button>}
                </div>
              )}
            </article>
            );
          }); })()}
          {(streaming || (thinking && !thoughtInGroup)) && (
            <article className={persona ? 'msg from-agent streaming-msg' : 'msg streaming-msg'} style={persona ? { ['--accent' as string]: persona.accent || '#e4b56a' } : undefined}>
              {persona && <div className="who"><Face agent={persona} size={28} /><span className="meta">{persona.emoji ? `${persona.emoji} ` : ''}{persona.name}</span></div>}
              {thinking && (
                <details className="thinking" open>
                  <summary><Brain size={14} aria-hidden /> {streaming ? t('Reasoning') : t('Thinking…')}</summary>
                  <div className="think" dir="auto">{thinking}</div>
                </details>
              )}
              {streaming && <div dir="auto"><Markdown text={streaming} streaming /></div>}
            </article>
          )}
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
          {status === 'waiting' && (() => {
            const wait = waitStateOf(loadingNote, waitInfo);
            const waited = waitedFor(wait.since);
            return (
              <div className={`wait-banner ${wait.kind}`} role="status" data-wait={wait.kind}>
                <div className="grow">
                  <strong>{wait.kind === 'queue' ? (wait.behind ? t('Queued behind {0}', [wait.behind]) : t('Queued')) : t('Waiting for memory')}</strong>
                  <p className="faint">
                    {wait.kind === 'queue'
                      ? (wait.ahead > 1 ? t('{0} chats are ahead of this one. It starts on its own when they finish.', [wait.ahead]) : t('Another chat is using the large model. This one starts on its own when that finishes.'))
                      : (loadingNote || t('Checking available RAM (MemAvailable)…'))}
                    {waited ? <> · {t('waiting {0}', [waited])}</> : null}
                  </p>
                </div>
                <div className="row">
                  {wait.kind === 'memory' && <button type="button" className="btn ghost small" onClick={() => void post('/api/memory/recheck', {}).then(() => toast(t('Re-checked memory.'), 'info')).catch((e) => toast(errorText(e), 'error'))}>{t('Re-check')}</button>}
                  {wait.canForce && <button type="button" className="btn primary small" onClick={() => setConfirmForce(true)}>{t('Force run')}</button>}
                  <button type="button" className="btn danger small" onClick={() => void control('stop')}>{t('Cancel')}</button>
                </div>
                {confirmForce && wait.canForce && (
                  <div className="wait-confirm" role="alertdialog" aria-label={t('Force run')}>
                    <p>{t('Force run loads the model even though there is not enough free RAM. If another large model is loaded, the mini PC can freeze until it is restarted.')}</p>
                    <div className="row">
                      <button type="button" className="btn ghost small" onClick={() => setConfirmForce(false)}>{t('Cancel')}</button>
                      <button type="button" className="btn danger small" onClick={() => { setConfirmForce(false); void control('force'); }}>{t('Force run anyway')}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {showTyping && <TypingDots label={t('Working')} note={typingNote} />}
          {runError && !active && (
            <div className="banner error-card" role="alert">
              <strong>{t('The reply failed.')}</strong>
              <p className="muted" dir="auto">{runError}</p>
              <div className="row"><button className="btn primary" onClick={retry}><RotateCcw size={15} />{' '}{t('Try again')}</button><button className="btn ghost" onClick={() => setTrace(true)}>{t('Open trace')}</button></div>
            </div>
          )}
          {plan && plan.items.length > 0 && (() => {
            const doneCount = plan.items.filter((item) => item.status === 'done').length;
            const allDone = doneCount === plan.items.length;
            const showBody = !allDone || active || planExpanded;
            return (
              <div className={`card task-list${allDone && !active ? ' completed' : ''}`}>
                <div className="task-list-head">
                  <button
                    type="button"
                    className="task-list-title"
                    onClick={() => { if (allDone && !active) setPlanExpanded((v) => !v); }}
                  >
                    <strong>{mode === 'code' ? t('Plan') : t('Tasks')}</strong>
                    <span className="faint small">{doneCount}/{plan.items.length}</span>
                  </button>
                  <div className="task-list-actions">
                    {plan.canUndo && current && (
                      <button type="button" className="btn ghost small" onClick={async () => {
                        try {
                          const res = await post<{ plan: Plan | null }>(`/api/sessions/${current}/plan/undo`, {});
                          setPlan(res.plan);
                          toast(t('Plan change undone.'), 'ok');
                        } catch (error) { toast(errorText(error), 'error'); }
                      }}><RotateCcw size={12} aria-hidden /> {t('Undo plan')}</button>
                    )}
                    {!active && current && (
                      <button
                        type="button"
                        className="btn ghost small"
                        title={t('Dismiss')}
                        aria-label={t('Dismiss')}
                        onClick={async () => {
                          try {
                            await api(`/api/sessions/${current}/plan`, { method: 'PUT', body: JSON.stringify({ items: [] }) });
                            setPlan(null);
                            setPlanExpanded(false);
                          } catch (error) { toast(errorText(error), 'error'); }
                        }}
                      ><X size={13} aria-hidden /></button>
                    )}
                  </div>
                </div>
                {showBody && plan.items.map((item) => (
                  <label key={item.id} className="row" title={item.note ?? undefined}>
                    <input type="checkbox" checked={item.status === 'done'} onChange={async (event) => { await api(`/api/plan-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.checked ? 'done' : 'pending' }) }); if (current) void openSession(current); }} />
                    <span dir="auto" className={item.status === 'blocked' ? 'bad' : item.status === 'doing' ? 'strong' : item.status === 'done' ? 'done-text' : undefined}>{item.text}</span>
                    {item.status === 'doing' && <span className="badge">{t('working')}</span>}
                    {item.status === 'blocked' && <span className="badge bad">{t('blocked')}</span>}
                  </label>
                ))}
              </div>
            );
          })()}
          {edits.length > 0 && <BulkDiffCard edits={edits} onChanged={() => { if (current) void openSession(current); }} />}
          </div>
          {!nearBottom && (
            <button type="button" className="scroll-bottom-pill" onClick={() => { nearBottomRef.current = true; setNearBottom(true); box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }); }}>
              <ChevronDown size={14} aria-hidden /> {active ? t('Jump to live reply') : t('Jump to bottom')}
            </button>
          )}
        </div>
        <div className="composer">
          {browserNotice && isOwner() && (
            <div className="login-pause-banner" role="status" style={{ marginBottom: 8 }}>
              <div className="grow">
                <strong>{browserNotice.needsLogin ? t('Take over to sign in') : `${browserNotice.persona} ${t('started browsing')}`}</strong>
                {browserNotice.url && <p className="faint ellipsis">{browserNotice.url}</p>}
              </div>
              <Link className="btn primary small" to="/computer">{t('Open live view')}</Link>
              <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setBrowserNotice(null)}><X size={14} /></button>
            </div>
          )}
          <MiniAgentStrip
            helpers={miniAgents}
            onStop={async (id) => {
              try {
                await post(`/api/helpers/${id}/stop`, {});
                setHelperTick((v) => v + 1);
                toast(t('Stopped mini-agent.'));
              } catch (error) { toast(errorText(error), 'error'); }
            }}
          />
          <ContextNudgeBanner
            breakdown={breakdown}
            dismissed={nudgeDismissed}
            busy={Boolean(active)}
            onDismiss={() => setNudgeDismissed(true)}
            onCompact={async () => {
              if (!currentSession) return;
              try {
                const res = await post<{ compactedMessages: number; breakdown?: ContextBreakdown | null }>(`/api/sessions/${currentSession.id}/compact`, {});
                if (res.breakdown) setBreakdown(res.breakdown);
                toast(res.compactedMessages ? t('Compacted {0} earlier messages.', [res.compactedMessages]) : t('Chat is already compact.'));
              } catch (error) { toast(errorText(error), 'error'); }
            }}
            onHandoff={async () => {
              if (!currentSession) return;
              try {
                const res = await post<{ session: Session }>(`/api/sessions/${currentSession.id}/handoff`, {});
                setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)]);
                await openSession(res.session.id);
                toast(t('Continued in a fresh chat with a handoff brief.'));
              } catch (error) { toast(errorText(error), 'error'); }
            }}
          />
          {picker && <MentionPicker query={picker.query} setQuery={(query) => setPicker({ query })} defaultRoot={agentRoot} sessionId={current} anchorRef={composerFormRef} onPick={addMention} onClose={() => { setPicker(null); input.current?.focus(); }} />}
          <form ref={composerFormRef} onSubmit={send}>
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
            <textarea ref={input} dir="auto" rows={1} spellCheck={true} autoCorrect="on" autoCapitalize="sentences" value={draft} aria-label={t('Message')} placeholder={active ? t('Steer the active agent without stopping it…') : mode === 'code' ? t('Ask for a plan, then an edit…') : t('Message')} onChange={(event) => {
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
              {(() => {
                const effortOptions: { value: ReasoningEffort; label: string; hint: string }[] = [
                  { value: 'auto', label: t('Auto'), hint: t('per turn') },
                  { value: 'off', label: t('Off'), hint: t('no thinking, fastest') },
                  { value: 'low', label: t('Low'), hint: t('short thinking') },
                  { value: 'medium', label: t('Medium'), hint: t('balanced') },
                  { value: 'high', label: t('High'), hint: t('deep thinking') },
                ];
                const pickEffort = async (value: ReasoningEffort) => {
                  const previous = effort;
                  setEffort(value);
                  try {
                    if (current) await api(`/api/sessions/${current}`, { method: 'PATCH', body: JSON.stringify({ effort: value === 'auto' ? null : value }) });
                  } catch (error) { toast(errorText(error), 'error'); setEffort(previous); }
                };
                const activeOption = effortOptions.find((opt) => opt.value === effort) ?? effortOptions[0]!;
                return (
                  <DropMenu
                    label={t('Thinking effort')}
                    text={effort === 'auto' ? t('Effort') : `${t('Effort')}: ${activeOption.label}`}
                    icon={Brain}
                    className="model-trigger"
                    align="start"
                    trailing={<ChevronDown size={14} aria-hidden />}
                    items={effortOptions.map((opt) => ({
                      label: opt.label,
                      hint: opt.hint,
                      checked: effort === opt.value,
                      onSelect: () => void pickEffort(opt.value),
                    }))}
                  />
                );
              })()}
              <ContextRing
                breakdown={breakdown}
                busy={Boolean(active)}
                onOpenContext={() => setPanel('context')}
                onCompact={currentSession ? async () => {
                  try {
                    const res = await post<{ compactedMessages: number; breakdown?: ContextBreakdown | null }>(`/api/sessions/${currentSession.id}/compact`, {});
                    if (res.breakdown) setBreakdown(res.breakdown);
                    toast(res.compactedMessages ? t('Compacted {0} earlier messages.', [res.compactedMessages]) : t('Chat is already compact.'));
                  } catch (error) { toast(errorText(error), 'error'); }
                } : undefined}
                onHandoff={currentSession ? async () => {
                  try {
                    const res = await post<{ session: Session }>(`/api/sessions/${currentSession.id}/handoff`, {});
                    setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)]);
                    await openSession(res.session.id);
                    toast(t('Continued in a fresh chat with a handoff brief.'));
                  } catch (error) { toast(errorText(error), 'error'); }
                } : undefined}
              />
              <span className="spacer" />
              {canManage && <LocalRepoPicker sessionId={current} onAttached={() => void loadChatWs(current)} />}
              <button
                className={voiceLoop ? 'icon-btn round on' : 'icon-btn round'}
                type="button"
                aria-pressed={voiceLoop}
                aria-label={voiceLoop ? t('Voice mode on') : t('Voice mode')}
                title={voiceLoop ? t('Voice-first mode ON — auto-speaks replies (click to stop)') : t('Voice-first mode — auto-speak replies and converse hands-free')}
                onClick={() => {
                  const next = !voiceLoop;
                  setVoiceLoop(next);
                  toast(next ? t('Voice-first mode on. Replies will be spoken automatically.') : t('Voice-first mode off.'));
                }}
              >
                <Headphones size={17} />
              </button>
              <button className={recording ? 'icon-btn round on' : 'icon-btn round'} type="button" aria-label={t('Hold to talk')} title={t('Hold to talk')} onPointerDown={() => void holdTalk(true)} onPointerUp={() => void holdTalk(false)} onPointerLeave={() => { if (recording) void holdTalk(false); }}><Mic size={18} /></button>
              {active && status !== 'paused' && <button className="btn ghost pause-btn" type="button" onClick={() => control('pause')}>{t('Pause')}</button>}
              {status === 'paused' && <button className="btn ghost" type="button" onClick={() => control('resume')}>{t('Resume')}</button>}
              {active && draft.trim() && (
                <button className="icon-btn round primary-fill" type="submit" aria-label={t('Steer')} title={t('Steer (Enter)')}><Send size={17} /></button>
              )}
              {active ? <button className="icon-btn round danger-fill" type="button" aria-label={t('Stop (Esc)')} title={t('Stop (Esc)')} onClick={() => control('stop')}><Square size={16} /></button>
                : <button className="icon-btn round primary-fill" type="submit" aria-label={t('Send')} title={t('Send (Enter)')} disabled={!draft.trim() && !quotes.length && !mentions.length}><Send size={17} /></button>}
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
        <div className="sheet-head trace-head">
          <button className="icon-btn" aria-label={t('Back')} title={t('Back')} onClick={() => setTrace(false)}><ArrowLeft size={18} className="flip-rtl" /></button>
          <strong>{t('Trace')}</strong>
          <span className="head-spacer" />
          <button className="icon-btn" aria-label={t('Close trace')} title={t('Close trace')} onClick={() => setTrace(false)}><X size={18} /></button>
        </div>
        <p className="faint">{t('Every model call and tool call lands here, with the arguments the model actually sent.')}</p>
        <div className="trace-pane"><TraceList steps={steps} /></div>
      </aside>
      {deleteTarget && createPortal(
        <div
          className="modal-backdrop delete-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t('Delete chat')}
          onClick={() => { if (!deleting) setDeleteTarget(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !deleting) setDeleteTarget(null); }}
        >
          <div className="modal-card delete-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="delete-modal-head">
              <div className="delete-modal-title">
                <strong>{t('Delete chat')}</strong>
                <span className="faint ellipsis" dir="auto">“{deleteTarget.title}”</span>
              </div>
              <button type="button" className="icon-btn" aria-label={t('Close')} disabled={deleting} onClick={() => setDeleteTarget(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="delete-choice-list">
              <button type="button" className="delete-choice" disabled={deleting} onClick={() => void confirmRemoveChat(false)}>
                <span className="delete-choice-icon"><Archive size={18} aria-hidden /></span>
                <span className="delete-choice-text">
                  <strong>{t('Archive')}</strong>
                  <small className="faint">{t('Hide from the sidebar. History stays in the database.')}</small>
                </span>
              </button>
              <button type="button" className="delete-choice danger" disabled={deleting} onClick={() => void confirmRemoveChat(true)}>
                <span className="delete-choice-icon"><Trash2 size={18} aria-hidden /></span>
                <span className="delete-choice-text">
                  <strong>{t('Delete permanently')}</strong>
                  <small className="faint">{t('Remove this chat, its messages, and run history forever.')}</small>
                </span>
              </button>
            </div>
            <div className="delete-modal-foot">
              <button type="button" className="btn ghost small" disabled={deleting} onClick={() => setDeleteTarget(null)}>{t('Cancel')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
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

/** "Saved skill X" under the steps that saved it, with Edit (opens Skills) and Delete. */
function SkillSavedNotice({ slug, version }: { slug: string; version: number }) {
  const [gone, setGone] = useState(false);
  if (gone) return <div className="tool-call-chip" role="status"><Trash2 size={14} />{' '}{t('Deleted skill {0}.', [slug])}</div>;
  return (
    <div className="tool-call-chip" role="status">
      <Brain size={14} />{' '}{t('Saved skill {0} (v{1}).', [slug, version])}{' '}
      <Link to={`/skills?open=${encodeURIComponent(slug)}`}>{t('Edit')}</Link>{' · '}
      <button type="button" className="link-button" onClick={async () => {
        if (!window.confirm(t('Delete the skill “{0}” and its history? Personas stop loading it.', [slug]))) return;
        try { await api(`/api/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' }); setGone(true); } catch (error) { toast(errorText(error), 'error'); }
      }}>{t('Delete')}</button>
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
