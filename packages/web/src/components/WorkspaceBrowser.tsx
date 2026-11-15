import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AtSign, ChevronDown, ChevronRight, ExternalLink, FileText, Folder, GitBranch, GitCommitHorizontal, Download, RefreshCw, Save, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { Menu } from './ui';

export interface ChatRoot { id: string; label: string; path: string; kind: string; via: string | null; branch: string | null; dirty: number; isRepo: boolean }
interface Entry { name: string; path: string; dir: boolean; size: number }
interface Status { isRepo: boolean; branch: string | null; ahead: number; behind: number; files: { path: string; index: string; work: string }[]; log: { sha: string; subject: string }[] }
interface FileData { text: string; truncated: boolean; binary: boolean; size: number }

/**
 * Right panel for one attached workspace: file tree, viewer/editor (save inline), git status and diff (refreshes live
 * while open, so the agent's edits show up), and quick actions: pull, commit, new branch, open in a new window.
 */
interface RuleRow { key: string; root: string; file: string; kind: 'always' | 'glob' | 'manual' | 'nested'; globs: string[]; description: string; chars: number; enabled: boolean; preview: string }
const KIND_NOTE: Record<RuleRow['kind'], string> = { always: 'always on', glob: 'for matching files', manual: 'read when relevant', nested: 'for its folder' };

/** Rule files this workspace brings into the chat (AGENTS.md, .cursor/rules, CLAUDE.md…). Click a chip to switch it for this chat. */
function RuleChips({ sessionId, rootPath }: { sessionId: string; rootPath: string }) {
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const load = useCallback(() => api<{ rules: RuleRow[] }>(`/api/sessions/${sessionId}/rules`).then((data) => setRules(data.rules.filter((rule) => rule.root === rootPath))).catch(() => setRules([])), [sessionId, rootPath]);
  useEffect(() => { void load(); }, [load]);
  if (!rules || rules.length === 0) return null;
  const on = rules.filter((rule) => rule.enabled).length;
  return (
    <div className="rule-chips" aria-label="Project rules">
      <small className="faint">Rules · {on} of {rules.length} on</small>
      <div className="chip-row">
        {rules.map((rule) => (
          <button key={rule.key} type="button" className={rule.enabled ? 'chip on' : 'chip'} aria-pressed={rule.enabled}
            title={`${rule.file} — ${KIND_NOTE[rule.kind]}${rule.globs.length ? ` (${rule.globs.join(', ')})` : ''} · ${rule.chars} chars\n\n${rule.description || rule.preview}`}
            onClick={async () => {
              setRules((rows) => rows?.map((row) => row.key === rule.key ? { ...row, enabled: !row.enabled } : row) ?? rows);
              try { await api(`/api/sessions/${sessionId}/rules`, { method: 'PUT', body: JSON.stringify({ key: rule.key, enabled: !rule.enabled }) }); }
              catch (error) { toast(errorText(error), 'error'); void load(); }
            }}>{rule.file.replace(/^\.cursor\/rules\//, '')}{rule.kind !== 'always' && <span className="faint"> · {rule.kind === 'glob' ? 'glob' : rule.kind === 'nested' ? 'folder' : 'on demand'}</span>}</button>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceBrowser({ root, live, onClose, onChanged, onMention, sessionId }: {
  root: ChatRoot; live: boolean; onClose: () => void; onChanged: () => void; onMention: (path: string) => void; sessionId?: string | null;
}) {
  const [view, setView] = useState<'files' | 'changes'>(root.dirty ? 'changes' : 'files');
  const [tree, setTree] = useState<Record<string, Entry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set(['.']));
  const [file, setFile] = useState<{ path: string; data: FileData; draft: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [diff, setDiff] = useState('');
  const [diffPath, setDiffPath] = useState('');
  const [form, setForm] = useState<null | 'commit' | 'branch'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/git/${encodeURIComponent(root.id)}`;

  const loadDir = useCallback(async (dir: string) => {
    try { const data = await api<{ entries: Entry[] }>(`${base}/tree?path=${encodeURIComponent(dir)}`); setTree((rows) => ({ ...rows, [dir]: data.entries })); } catch (error) { toast(errorText(error), 'error'); }
  }, [base]);
  const loadStatus = useCallback(async () => {
    try {
      const data = await api<{ status: Status }>(`${base}/status`);
      setStatus(data.status);
      const d = await api<{ diff: string }>(`${base}/diff${diffPath ? `?path=${encodeURIComponent(diffPath)}` : ''}`);
      setDiff(d.diff);
    } catch { /* folder without git */ }
  }, [base, diffPath]);

  useEffect(() => { setTree({}); setOpen(new Set(['.'])); setFile(null); setDiffPath(''); void loadDir('.'); }, [root.id]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  // Live: while the panel is open, refresh git status and the diff (faster while a reply runs).
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void loadStatus(); }, live ? 2000 : 6000);
    return () => clearInterval(timer);
  }, [loadStatus, live]);

  async function openFile(path: string) {
    try { const data = await api<{ file: FileData }>(`${base}/file?path=${encodeURIComponent(path)}`); setFile({ path, data: data.file, draft: data.file.text }); }
    catch (error) { toast(errorText(error), 'error'); }
  }
  async function save() {
    if (!file || file.data.truncated || file.data.binary) return;
    setBusy(true);
    try {
      await api(`${base}/file`, { method: 'PUT', body: JSON.stringify({ path: file.path, content: file.draft }) });
      setFile({ ...file, data: { ...file.data, text: file.draft } });
      toast(`Saved ${file.path}.`, 'ok'); void loadStatus(); onChanged();
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(false); }
  }
  async function action(name: 'pull' | 'commit' | 'branch', extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await post(`${base}/action`, { action: name, ...extra });
      toast(name === 'pull' ? 'Pulled.' : name === 'commit' ? 'Committed.' : `On branch ${String(extra.name)}.`, 'ok');
      setForm(null); setText(''); void loadStatus(); onChanged();
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(false); }
  }

  const changed = status?.files.length ?? 0;
  const edited = Boolean(file && file.draft !== file.data.text);
  const renderDir = (dir: string, depth: number): ReactNode => (tree[dir] || []).map((entry) => (
    <div key={entry.path}>
      <button type="button" className={file?.path === entry.path ? 'tree-row on' : 'tree-row'} style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => { if (entry.dir) { const next = new Set(open); if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); if (!tree[entry.path]) void loadDir(entry.path); } setOpen(next); } else void openFile(entry.path); }}>
        {entry.dir ? (open.has(entry.path) ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />) : <span style={{ width: 13 }} />}
        {entry.dir ? <Folder size={14} aria-hidden /> : <FileText size={14} aria-hidden />}
        <span className="ellipsis">{entry.name}</span>
        {status?.files.some((f) => f.path === entry.path) && <span className="dirty-dot" aria-label="changed" />}
      </button>
      {entry.dir && open.has(entry.path) && renderDir(entry.path, depth + 1)}
    </div>
  ));

  return (
    <aside className="side-panel open ws-browser" aria-label={`Workspace ${root.label}`}>
      <div className="panel-head">
        <div className="grow ws-title">
          <strong>{root.label}</strong>
          <small className="faint mono ellipsis" title={root.path}>{status?.isRepo ? <><GitBranch size={12} aria-hidden /> {status.branch || 'detached'}{status.ahead ? ` ↑${status.ahead}` : ''}{status.behind ? ` ↓${status.behind}` : ''} · </> : 'folder · '}{root.path}</small>
        </div>
        <Menu label="Workspace actions" items={[
          ...(status?.isRepo ? [
            { label: 'Pull', icon: Download, hint: 'fast-forward only', onSelect: () => void action('pull') },
            { label: 'Commit…', icon: GitCommitHorizontal, disabled: !changed, hint: changed ? `${changed} changed` : 'nothing to commit', onSelect: () => { setForm('commit'); setText(''); } },
            { label: 'New branch…', icon: GitBranch, onSelect: () => { setForm('branch'); setText(''); } },
          ] : []),
          { label: 'Refresh', icon: RefreshCw, onSelect: () => { void loadDir('.'); void loadStatus(); } },
          { label: 'Open in a new window', icon: ExternalLink, separator: true, onSelect: () => window.open(`/workspace?root=${encodeURIComponent(root.id)}`, '_blank', 'noopener') },
        ]} />
        <button className="icon-btn" aria-label="Close panel" onClick={onClose}><X size={18} /></button>
      </div>
      {sessionId && <RuleChips sessionId={sessionId} rootPath={root.path} />}
      {form && (
        <form className="ws-quick" onSubmit={(event) => { event.preventDefault(); if (form === 'commit') void action('commit', { message: text }); else void action('branch', { name: text.trim() }); }}>
          <input autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder={form === 'commit' ? 'Commit message' : 'feature/my-change'} aria-label={form === 'commit' ? 'Commit message' : 'Branch name'} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setForm(null); } }} />
          <button className="btn primary small" disabled={busy || !text.trim()}>{form === 'commit' ? `Commit ${changed}` : 'Create'}</button>
          <button type="button" className="btn ghost small" onClick={() => setForm(null)}>Cancel</button>
        </form>
      )}
      <div className="panel-tabs ws-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'files'} onClick={() => setView('files')}>Files</button>
        <button role="tab" aria-selected={view === 'changes'} onClick={() => setView('changes')}>Changes{changed ? ` ${changed}` : ''}{live && <span className="live-dot" title="Updating live" />}</button>
      </div>
      {view === 'files' && (
        <div className={file ? 'ws-split' : 'ws-split solo'}>
          <div className="ws-tree" role="tree">{tree['.'] ? (tree['.'].length ? renderDir('.', 0) : <p className="faint panel-note">Empty folder.</p>) : <div className="skeleton-lines"><span /><span /><span /></div>}</div>
          {file && (
            <div className="ws-editor">
              <div className="ws-editor-head">
                <span className="mono ellipsis grow" title={file.path}>{file.path}{edited ? ' •' : ''}</span>
                <button className="icon-btn" title="Mention in the message (@)" aria-label="Mention this file" onClick={() => onMention(file.path)}><AtSign size={15} /></button>
                <button className="btn small primary" disabled={!edited || busy || file.data.truncated} onClick={() => void save()} title="Save (Ctrl+S)"><Save size={13} aria-hidden /> Save</button>
                <button className="icon-btn" aria-label="Close file" onClick={() => { if (!edited || window.confirm('Discard unsaved changes?')) setFile(null); }}><X size={15} /></button>
              </div>
              {file.data.binary ? <p className="faint panel-note">Binary file ({file.data.size.toLocaleString()} bytes). Open it from the workspace page.</p> : (
                <>
                  {file.data.truncated && <p className="faint panel-note">Large file: showing the start only, editing is off.</p>}
                  <textarea className="code-edit" spellCheck={false} readOnly={file.data.truncated} value={file.draft} aria-label={`Edit ${file.path}`}
                    onChange={(event) => setFile({ ...file, draft: event.target.value })}
                    onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save(); } }} />
                </>
              )}
            </div>
          )}
        </div>
      )}
      {view === 'changes' && (
        <div className="panel-body">
          {!status?.isRepo ? <p className="faint">Not a git repo, so there is no diff. Edits still save.</p> : changed === 0 ? <p className="faint">No uncommitted changes. Edits from you or the agent show up here as they happen.</p> : (
            <>
              <div className="ws-changes">
                <button type="button" className={diffPath === '' ? 'tree-row on' : 'tree-row'} onClick={() => setDiffPath('')}>All changes</button>
                {status.files.map((f) => (
                  <button key={f.path} type="button" className={diffPath === f.path ? 'tree-row on' : 'tree-row'} onClick={() => setDiffPath(f.path)}>
                    <span className="mono change-code">{(f.index + f.work).replace(/\s/g, '') || '?'}</span><span className="ellipsis">{f.path}</span>
                  </button>
                ))}
              </div>
              <DiffView text={diff} />
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => { setForm('commit'); setText(''); }}><GitCommitHorizontal size={14} aria-hidden /> Commit…</button>
            </>
          )}
          {status?.log?.length ? <><p className="panel-sub">Recent commits</p>{status.log.slice(0, 5).map((c) => <p key={c.sha} className="mono faint commit-line">{c.sha.slice(0, 7)} {c.subject}</p>)}</> : null}
        </div>
      )}
    </aside>
  );
}

function DiffView({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  if (!text.trim()) return <p className="faint">No diff for this selection.</p>;
  return (
    <pre ref={ref} className="diff-view">
      {text.split('\n').slice(0, 3000).map((line, index) => (
        <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : undefined}>{line}{'\n'}</span>
      ))}
    </pre>
  );
}
