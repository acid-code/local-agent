import { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Cpu, FileCode2, FolderGit2, GitBranch, RotateCcw, Sparkles, Square, Terminal, Wrench, X } from 'lucide-react';
import type { ContextBreakdown } from '@local-agent/shared';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { t } from '../i18n';

export interface MiniAgentRow {
  id: string;
  agentName: string;
  modelName?: string | null;
  task: string;
  status: string;
  result?: string | null;
  error?: string | null;
  createdAt?: string;
  endedAt?: string | null;
}

export interface TraceStep {
  id: string;
  kind: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface DiffEdit {
  id: string;
  label: string;
  diff: string;
  revertedAt: string | null;
}

export interface MentionItem {
  kind: 'file' | 'git' | 'repo';
  label: string;
  insert: string;
  detail: string;
}

function fmtElapsed(createdAt?: string, endedAt?: string | null, nowMs = Date.now()): string {
  if (!createdAt) return '';
  const start = new Date(createdAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : nowMs;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Visible Mini-Agent Activity Strip right above the composer. */
export function MiniAgentStrip({
  helpers,
  onStop,
}: {
  helpers: MiniAgentRow[];
  onStop: (id: string) => Promise<void> | void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);
  const running = helpers.filter((h) => h.status === 'running' || h.status === 'queued' || h.status === 'waiting');
  const recent = helpers.filter((h) => h.status === 'done' || h.status === 'failed').slice(0, 2);
  const shown = [...running, ...recent];

  useEffect(() => {
    if (!running.length) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running.length]);

  if (!shown.length) return null;

  return (
    <div className="mini-strip" aria-label={t('Mini-agents')}>
      <div className="mini-strip-head">
        <span className="row" style={{ gap: 6 }}>
          <Bot size={14} aria-hidden />
          <strong>{running.length ? t('{0} mini-agent(s) running', [running.length]) : t('Recent mini-agents')}</strong>
        </span>
      </div>
      <div className="mini-strip-list">
        {shown.map((h) => {
          const isLive = h.status === 'running' || h.status === 'queued' || h.status === 'waiting';
          const open = expanded === h.id;
          return (
            <div key={h.id} className={`mini-card ${h.status}`}>
              <div className="mini-card-row">
                <button type="button" className="mini-card-toggle" onClick={() => setExpanded(open ? null : h.id)}>
                  <span className={`mini-dot ${isLive ? 'live' : h.status}`} aria-hidden />
                  <span className="mini-name">{h.agentName}</span>
                  {h.modelName && <span className="mini-model">{h.modelName}</span>}
                  <span className="mini-task ellipsis" dir="auto">{h.task}</span>
                  <span className="mini-time mono faint">{fmtElapsed(h.createdAt, h.endedAt, nowMs)}</span>
                  {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                </button>
                {isLive && (
                  <button type="button" className="icon-btn mini-stop" title={t('Stop mini-agent')} aria-label={t('Stop mini-agent')} onClick={() => void onStop(h.id)}>
                    <Square size={12} />
                  </button>
                )}
              </div>
              {open && (
                <div className="mini-card-body">
                  {h.result && <pre className="mini-out" dir="auto">{h.result.slice(0, 2000)}</pre>}
                  {h.error && <pre className="mini-out err">{h.error}</pre>}
                  {!h.result && !h.error && <span className="faint">{t('Working on workspace…')}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Smart Context Auto-Nudge when Context Ring crosses 80%. */
export function ContextNudgeBanner({
  breakdown,
  dismissed,
  busy,
  onDismiss,
  onCompact,
  onHandoff,
}: {
  breakdown: ContextBreakdown | null;
  dismissed: boolean;
  busy: boolean;
  onDismiss: () => void;
  onCompact: () => Promise<void> | void;
  onHandoff: () => Promise<void> | void;
}) {
  const [working, setWorking] = useState<'compact' | 'handoff' | null>(null);
  if (!breakdown || dismissed) return null;
  const pct = Math.round((breakdown.used / Math.max(1, breakdown.budget)) * 100);
  if (pct < 80) return null;

  return (
    <div className="ctx-nudge" role="status">
      <Sparkles size={15} aria-hidden />
      <span className="grow">{t('Context is at {0}%. Compact or continue in a fresh chat to keep replies fast.', [pct])}</span>
      <button type="button" className="btn ghost small" disabled={busy || Boolean(working)} onClick={async () => { setWorking('compact'); try { await onCompact(); } finally { setWorking(null); } }}>
        {working === 'compact' ? t('Compacting…') : t('Compact chat')}
      </button>
      <button type="button" className="btn primary small" disabled={busy || Boolean(working)} onClick={async () => { setWorking('handoff'); try { await onHandoff(); } finally { setWorking(null); } }}>
        {working === 'handoff' ? t('Handing off…') : t('Continue in new chat')}
      </button>
      <button type="button" className="icon-btn" aria-label={t('Dismiss')} onClick={onDismiss}><X size={14} /></button>
    </div>
  );
}

/** Cursor-style syntax-colored inline diff card with Keep / Revert actions. */
export function InlineDiffCard({
  edit,
  kept,
  onKeep,
  onRevert,
}: {
  edit: DiffEdit;
  kept: boolean;
  onKeep: () => void;
  onRevert: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(!edit.revertedAt && !kept);
  const [reverting, setReverting] = useState(false);
  const lines = (edit.diff || '').split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div className={`diff-card${edit.revertedAt ? ' reverted' : ''}${kept ? ' kept' : ''}`}>
      <div className="diff-card-head">
        <button type="button" className="diff-card-title" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <FileCode2 size={14} aria-hidden />
          <strong className="mono ellipsis">{edit.label}</strong>
          <span className="diff-stat add">+{added}</span>
          <span className="diff-stat del">-{removed}</span>
        </button>
        <div className="row" style={{ gap: 6 }}>
          {edit.revertedAt ? (
            <span className="badge">{t('Reverted')}</span>
          ) : kept ? (
            <span className="badge ok"><Check size={12} aria-hidden /> {t('Kept')}</span>
          ) : (
            <>
              <button type="button" className="btn ghost small" onClick={onKeep}>
                <Check size={13} aria-hidden /> {t('Keep')}
              </button>
              <button type="button" className="btn ghost small danger" disabled={reverting} onClick={async () => { setReverting(true); try { await onRevert(); } finally { setReverting(false); } }}>
                <RotateCcw size={13} aria-hidden /> {t('Revert')}
              </button>
            </>
          )}
        </div>
      </div>
      {open && (
        <pre className="diff-body mono">
          {lines.slice(0, 140).map((line, i) => {
            const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
            return <div key={i} className={`diff-line ${cls}`}>{line || ' '}</div>;
          })}
          {lines.length > 140 && <div className="diff-line hunk">{t('… {0} more lines', [lines.length - 140])}</div>}
        </pre>
      )}
    </div>
  );
}

/** Cursor-style expandable decision & tool-call timeline (live while running, inspectable after). */
export function DecisionTimeline({
  steps,
  live,
  onStop,
}: {
  steps: TraceStep[];
  live: boolean;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(live);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const visible = steps.filter((s) => s.kind === 'routing' || s.kind === 'tool' || s.kind === 'model' || s.kind === 'contract');
  if (!visible.length) return null;

  const toolCount = visible.filter((s) => s.kind === 'tool').length;
  const activeStep = visible.find((s) => s.status === 'running');

  return (
    <div className={`decision-trace${live ? ' live' : ''}`}>
      <div className="decision-head">
        <button type="button" className="decision-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <Cpu size={14} aria-hidden />
          <span>
            {activeStep
              ? t('Running {0}…', [activeStep.name])
              : t('Decision path · {0} steps ({1} tools)', [visible.length, toolCount])}
          </span>
        </button>
        {live && onStop && (
          <button type="button" className="btn ghost small danger" onClick={onStop}>
            <Square size={12} aria-hidden /> {t('Cancel')}
          </button>
        )}
      </div>
      {open && (
        <ol className="decision-list">
          {visible.map((step) => {
            const isStepOpen = expandedStep === step.id;
            const icon = step.kind === 'tool' ? (step.name === 'shell' ? <Terminal size={13} /> : <Wrench size={13} />) : <Sparkles size={13} />;
            const summary = step.kind === 'routing'
              ? String((step.output as { reason?: string } | null)?.reason || step.name)
              : step.kind === 'model'
                ? `${step.name}${step.tokensOut ? ` · ${step.tokensOut} tok` : ''}`
                : step.name;
            return (
              <li key={step.id} className={`decision-item ${step.status}`}>
                <button type="button" className="decision-row" onClick={() => setExpandedStep(isStepOpen ? null : step.id)}>
                  <span className={`mini-dot ${step.status === 'running' ? 'live' : step.status}`} aria-hidden />
                  {icon}
                  <span className="decision-label ellipsis">{summary}</span>
                  {step.latencyMs ? <span className="mono faint decision-ms">{step.latencyMs >= 1000 ? `${(step.latencyMs / 1000).toFixed(1)}s` : `${step.latencyMs}ms`}</span> : null}
                  {isStepOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {isStepOpen && (
                  <div className="decision-detail">
                    {step.input != null && <pre className="mini-out">{typeof step.input === 'string' ? step.input : JSON.stringify(step.input, null, 2).slice(0, 1200)}</pre>}
                    {step.output != null && <pre className="mini-out">{typeof step.output === 'string' ? step.output.slice(0, 1800) : JSON.stringify(step.output, null, 2).slice(0, 1800)}</pre>}
                    {step.error && <pre className="mini-out err">{step.error}</pre>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** @ mention fuzzy popover above the composer (@file, @git). */
export function MentionPopover({
  items,
  selected,
  onPick,
}: {
  items: MentionItem[];
  selected: number;
  onPick: (item: MentionItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mention-pop" role="listbox" aria-label={t('Attach context')}>
      {items.map((item, idx) => (
        <button
          key={`${item.kind}:${item.label}`}
          type="button"
          role="option"
          aria-selected={idx === selected}
          className={idx === selected ? 'mention-item on' : 'mention-item'}
          onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
        >
          {item.kind === 'git' ? <GitBranch size={14} aria-hidden /> : <FileCode2 size={14} aria-hidden />}
          <span className="mono ellipsis grow">{item.label}</span>
          <span className="faint">{item.detail}</span>
        </button>
      ))}
    </div>
  );
}

/** One-click Local (/projects) + GitHub repo picker to clone and attach repos straight into this chat. */
export function LocalRepoPicker({
  sessionId,
  onAttached,
}: {
  sessionId: string | null;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'local' | 'github' | 'new'>('local');
  const [repos, setRepos] = useState<{ name: string; path: string; isGit: boolean }[] | null>(null);
  const [ghRepos, setGhRepos] = useState<{ name: string; fullName: string; cloneUrl: string; isPrivate: boolean; cloned: boolean }[] | null>(null);
  const [ghUser, setGhUser] = useState('');
  const [ghError, setGhError] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newGithub, setNewGithub] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open || tab !== 'local' || repos !== null) return;
    api<{ repos: { name: string; path: string; isGit: boolean }[] }>('/api/projects/discover')
      .then((res) => setRepos(res.repos || []))
      .catch(() => setRepos([]));
  }, [open, tab, repos]);

  const loadGithub = (user = ghUser) => {
    setGhError('');
    setGhRepos(null);
    api<{ repos: { name: string; fullName: string; cloneUrl: string; isPrivate: boolean; cloned: boolean }[] }>(`/api/github/repos${user.trim() ? `?user=${encodeURIComponent(user.trim())}` : ''}`)
      .then((res) => setGhRepos(res.repos || []))
      .catch((err) => { setGhRepos([]); setGhError(errorText(err)); });
  };

  useEffect(() => {
    if (open && tab === 'github' && ghRepos === null && !ghError) loadGithub();
  }, [open, tab]);

  return (
    <div className="repo-picker-wrap">
      <button type="button" className="icon-btn round" title={t('Attach local or GitHub repo')} aria-label={t('Attach local or GitHub repo')} onClick={() => setOpen((v) => !v)}>
        <FolderGit2 size={17} />
      </button>
      {open && (
        <div className="repo-picker-pop" role="dialog" aria-label={t('Attach local or GitHub repo')}>
          <div className="ctx-pop-head">
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className={tab === 'local' ? 'btn primary small' : 'btn ghost small'} onClick={() => setTab('local')}>{t('Local')}</button>
              <button type="button" className={tab === 'github' ? 'btn primary small' : 'btn ghost small'} onClick={() => setTab('github')}>{t('GitHub')}</button>
              <button type="button" className={tab === 'new' ? 'btn primary small' : 'btn ghost small'} onClick={() => setTab('new')}>{t('New')}</button>
            </div>
            <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setOpen(false)}><X size={14} /></button>
          </div>
          {tab === 'local' ? (
            repos === null ? (
              <p className="faint">{t('Scanning…')}</p>
            ) : repos.length === 0 ? (
              <p className="faint">{t('No local repos found in /projects.')}</p>
            ) : (
              <div className="repo-picker-list">
                {repos.map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    className="repo-picker-row"
                    disabled={busy === r.path}
                    onClick={async () => {
                      setBusy(r.path);
                      try {
                        await post('/api/projects/attach', { path: r.path, name: r.name, sessionId: sessionId || undefined });
                        toast(t('Attached {0}.', [r.name]), 'ok');
                        setOpen(false);
                        onAttached();
                      } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
                    }}
                  >
                    <FolderGit2 size={14} aria-hidden />
                    <span className="mono ellipsis grow">{r.name}</span>
                    {r.isGit && <span className="badge">git</span>}
                  </button>
                ))}
              </div>
            )
          ) : tab === 'new' ? (
            <form
              className="repo-picker-list"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newName.trim()) return;
                setBusy('create');
                try {
                  const res = await post<{ repo: { label: string }; remoteUrl?: string | null }>('/api/projects/create', {
                    name: newName.trim(),
                    description: newDesc.trim() || undefined,
                    createGithub: newGithub,
                    isPrivate: true,
                    sessionId: sessionId || undefined,
                  });
                  toast(res.remoteUrl ? t('Created {0} (+ GitHub repo).', [res.repo.label]) : t('Created & attached {0}.', [res.repo.label]), 'ok');
                  setNewName(''); setNewDesc(''); setRepos(null); setOpen(false);
                  onAttached();
                } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
              }}
            >
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('Project name (e.g. gym-tracker)')} required />
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={t('Short description (optional)')} />
              <label className="row" style={{ gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={newGithub} onChange={(e) => setNewGithub(e.target.checked)} />
                <span>{t('Also create private GitHub repo')}</span>
              </label>
              <button type="submit" className="btn primary small" disabled={busy === 'create' || !newName.trim()}>
                {busy === 'create' ? t('Creating…') : t('Create & attach')}
              </button>
            </form>
          ) : (
            <div className="repo-picker-list">
              <form className="row" style={{ gap: 4, marginBottom: 4 }} onSubmit={(e) => { e.preventDefault(); loadGithub(ghUser); }}>
                <input value={ghUser} onChange={(e) => setGhUser(e.target.value)} placeholder={t('GitHub user (optional)')} style={{ flex: 1, minWidth: 0 }} />
                <button type="submit" className="btn ghost small">{t('Load')}</button>
              </form>
              {ghError && <p className="faint">{ghError}</p>}
              {ghRepos === null ? (
                <p className="faint">{t('Loading GitHub repos…')}</p>
              ) : ghRepos.length === 0 ? (
                <p className="faint">{t('No repos found. Add GITHUB_TOKEN in Settings → Vault for private repos.')}</p>
              ) : (
                ghRepos.map((r) => (
                  <button
                    key={r.fullName}
                    type="button"
                    className="repo-picker-row"
                    disabled={busy === r.fullName}
                    onClick={async () => {
                      setBusy(r.fullName);
                      try {
                        await post('/api/github/clone', { cloneUrl: r.cloneUrl, name: r.name, sessionId: sessionId || undefined });
                        toast(t('Cloned & attached {0}.', [r.name]), 'ok');
                        setRepos(null);
                        setOpen(false);
                        onAttached();
                      } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
                    }}
                  >
                    <GitBranch size={14} aria-hidden />
                    <span className="mono ellipsis grow">{r.name}</span>
                    <span className="badge">{busy === r.fullName ? '…' : r.cloned ? t('Attach') : t('Clone')}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
