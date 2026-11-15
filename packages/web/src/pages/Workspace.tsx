import { useEffect, useState } from 'react';
import { isOwner } from '../lib/role';
import { ArrowDown, ArrowUp, ChevronLeft, Download, File, Folder, GitBranch, GitPullRequest, RefreshCw, Upload } from 'lucide-react';
import { api, post } from '../lib/api';
import { humanSize } from '../lib/files';
import { errorText, toast } from '../lib/toast';
import { FileViewer, type ViewerSource } from '../components/FileViewer';

interface Root { id: string; label: string; path: string; kind: 'workspace' | 'project'; remote: string | null; workshops: string[] }
interface Status { isRepo: boolean; branch: string | null; upstream: string | null; ahead: number; behind: number; remote: string | null; files: { path: string; index: string; work: string }[]; log: { sha: string; subject: string }[]; branches: string[] }
interface Entry { name: string; path: string; dir: boolean; size: number }
interface Workshop { id: string; name: string }

function letter(file: Status['files'][number]) {
  if (file.index === '?' && file.work === '?') return 'U';
  const ch = file.index !== ' ' ? file.index : file.work;
  return ch === 'R' ? 'M' : ch;
}

export function Workspace() {
  const [roots, setRoots] = useState<Root[]>([]);
  const [github, setGithub] = useState(false);
  const [rootId, setRootId] = useState(() => new URLSearchParams(window.location.search).get('root') || localStorage.getItem('la-ws-root') || '');
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState('');
  const [pr, setPr] = useState({ title: '', body: '', base: 'main' });
  const [clone, setClone] = useState({ url: '', label: '', workshopId: '' });
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [viewer, setViewer] = useState<ViewerSource | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [prLink, setPrLink] = useState('');

  async function loadRoots() {
    const data = await api<{ roots: Root[]; github: boolean }>('/api/git/roots');
    setRoots(data.roots);
    setGithub(data.github);
    setRootId((value) => (value && data.roots.some((r) => r.id === value) ? value : data.roots.find((r) => r.kind === 'project')?.id || data.roots[0]?.id || ''));
  }
  async function refresh() {
    if (!rootId) return;
    const data = await api<{ status: Status }>(`/api/git/${encodeURIComponent(rootId)}/status`);
    setStatus(data.status);
    if (selected && !data.status.files.some((f) => f.path === selected)) { setSelected(null); setDiff(''); }
  }
  useEffect(() => { void loadRoots(); if (isOwner()) api<{ workshops: Workshop[] }>('/api/workshops').then((d) => setWorkshops(d.workshops)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!rootId) return;
    localStorage.setItem('la-ws-root', rootId);
    setSelected(null); setDiff(''); setDir(''); setPrLink('');
    void refresh();
  }, [rootId]);
  useEffect(() => {
    if (!rootId) return;
    api<{ entries: Entry[] }>(`/api/git/${encodeURIComponent(rootId)}/tree?path=${encodeURIComponent(dir || '.')}`).then((d) => setEntries(d.entries)).catch(() => setEntries([]));
  }, [rootId, dir, status]);

  async function showDiff(file: string) {
    setSelected(file);
    const data = await api<{ diff: string }>(`/api/git/${encodeURIComponent(rootId)}/diff?path=${encodeURIComponent(file)}`);
    setDiff(data.diff || '(no textual changes)');
  }
  async function act(action: string, extra: Record<string, unknown> = {}, done?: string) {
    setBusy(action);
    try {
      const data = await post<{ output?: string; pr?: { url: string; number: number } }>(`/api/git/${encodeURIComponent(rootId)}/action`, { action, ...extra });
      if (data.pr) { setPrLink(data.pr.url); toast(`Opened PR #${data.pr.number}.`, 'ok'); }
      else toast(done || 'Done.', 'ok');
      await refresh();
      return true;
    } catch (error) {
      toast(errorText(error), 'error');
      return false;
    } finally { setBusy(''); }
  }
  async function push() {
    const onMain = status?.branch === 'main' || status?.branch === 'master';
    if (onMain && !window.confirm(`Push straight to ${status?.branch}? Most changes should go to a branch and a PR.`)) return;
    await act('push', { confirmMain: onMain }, `Pushed ${status?.branch}.`);
  }
  async function doClone(event: React.FormEvent) {
    event.preventDefault();
    setBusy('clone');
    try {
      const data = await post<{ label: string }>('/api/git/clone', { url: clone.url, label: clone.label || undefined, workshopId: clone.workshopId || undefined });
      toast(`Cloned into ${data.label}.`, 'ok');
      setClone({ url: '', label: '', workshopId: '' });
      await loadRoots();
      setRootId(`prj:${data.label}`);
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(''); }
  }

  const root = roots.find((r) => r.id === rootId);
  const isGithub = /github\.com/i.test(status?.remote || '');
  return (
    <div className="page">
      <h1>Workspace</h1>
      <p className="lede">Each persona's workspace and every shared project, with git. Commit, branch, pull and push here, or let an agent do it: its pushes and PRs wait for your approval.</p>
      <div className="ws-grid">
        <div className="card">
          <h3>Folders</h3>
          <div className="ws-roots">
            {roots.map((r) => (
              <button key={r.id} className={r.id === rootId ? 'ws-root active' : 'ws-root'} onClick={() => setRootId(r.id)}>
                <strong className="ellipsis">{r.kind === 'project' ? <GitBranch size={13} /> : <Folder size={13} />} {r.label}</strong>
                <span className="faint ellipsis">{r.workshops.length ? `Workshop: ${r.workshops.join(', ')}` : r.kind === 'workspace' ? 'Agent workspace' : 'Shared project'}</span>
              </button>
            ))}
          </div>
          <form onSubmit={doClone} style={{ marginTop: 14 }}>
            <h3>Clone a repo</h3>
            <input className="input" style={{ width: '100%' }} value={clone.url} onChange={(e) => setClone({ ...clone, url: e.target.value })} placeholder="https://github.com/you/repo.git or /path/to/repo" aria-label="Repository URL" required />
            <div className="form-row" style={{ marginTop: 8 }}>
              <input className="input" value={clone.label} onChange={(e) => setClone({ ...clone, label: e.target.value })} placeholder="label (optional)" aria-label="Label" />
              <select className="input" value={clone.workshopId} onChange={(e) => setClone({ ...clone, workshopId: e.target.value })} aria-label="Add to workshop">
                <option value="">No workshop</option>
                {workshops.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <button className="btn primary" style={{ marginTop: 8 }} disabled={busy === 'clone'}>{busy === 'clone' ? 'Cloning…' : 'Clone'}</button>
          </form>
          <p className="faint" style={{ fontSize: 13 }}>{github ? 'GitHub token saved: push over https and open PRs work.' : 'Save a GITHUB_TOKEN in Settings → Vault to push over https and open PRs.'}</p>
        </div>
        <div className="grid">
          <div className="card" id="git-panel">
            <div className="card-head">
              <h3 className="ellipsis">{root?.label || 'Pick a folder'}</h3>
              <button className="btn ghost small" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={14} /> Refresh</button>
            </div>
            <p className="faint mono ellipsis" style={{ margin: '0 0 8px', fontSize: 12 }}>{root?.path}</p>
            {status && !status.isRepo && (
              <div className="banner">Not a git repo yet. <button className="btn small" onClick={() => void act('init', {}, 'Initialized.')}>git init</button></div>
            )}
            {status?.isRepo && (
              <>
                <div className="git-head">
                  <span className="branch-pill"><GitBranch size={14} /> {status.branch || 'detached'}</span>
                  {status.upstream ? <span className="faint">{status.ahead ? <><ArrowUp size={12} /> {status.ahead} </> : null}{status.behind ? <><ArrowDown size={12} /> {status.behind} </> : null}{!status.ahead && !status.behind ? `in sync with ${status.upstream}` : `vs ${status.upstream}`}</span> : <span className="faint">{status.remote ? 'not pushed yet' : 'no remote'}</span>}
                  <span className="spacer" style={{ flex: 1 }} />
                  <button className="btn small" disabled={!!busy || !status.remote} onClick={() => void act('fetch', {}, 'Fetched.')}>Fetch</button>
                  <button className="btn small" disabled={!!busy || !status.remote} onClick={() => void act('pull', {}, 'Pulled.')}><Download size={14} /> Pull</button>
                  <button className="btn small" disabled={!!busy || !status.remote} onClick={() => void push()}><Upload size={14} /> {busy === 'push' ? 'Pushing…' : 'Push'}</button>
                </div>
                {status.remote && <p className="faint mono ellipsis" style={{ fontSize: 12, margin: '6px 0 0' }}>origin {status.remote}</p>}
                {!status.remote && (
                  <form className="form-row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void act('remote', { url: remoteUrl }, 'Remote set.').then((ok) => ok && setRemoteUrl('')); }}>
                    <input className="input" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="Add origin: https://github.com/you/repo.git" aria-label="Remote URL" />
                    <button className="btn small">Set origin</button>
                  </form>
                )}
                <h3 style={{ marginTop: 14 }}>Changes <span className="faint">({status.files.length})</span></h3>
                {status.files.length === 0 ? <p className="faint">Working tree clean.</p> : (
                  <ul className="git-files">
                    {status.files.map((file) => (
                      <li key={file.path}><button className={selected === file.path ? 'active' : ''} onClick={() => void showDiff(file.path)}><span className={`git-st ${letter(file)}`}>{letter(file)}</span><span className="mono ellipsis" dir="auto">{file.path}</span></button></li>
                    ))}
                  </ul>
                )}
                {selected && <DiffView text={diff} />}
                <form className="form-row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void act('commit', { message }, 'Committed.').then((ok) => ok && setMessage('')); }}>
                  <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" aria-label="Commit message" />
                  <button className="btn primary" disabled={!message.trim() || !status.files.length || !!busy}>Commit all</button>
                </form>
                <form className="form-row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void act('branch', { name: branch }, `On ${branch}.`).then((ok) => ok && setBranch('')); }}>
                  <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="new-branch-name" aria-label="New branch" />
                  <button className="btn" disabled={!branch.trim() || !!busy}>New branch</button>
                  {status.branches.length > 1 && (
                    <select className="input" value={status.branch || ''} onChange={(e) => void act('checkout', { name: e.target.value }, `On ${e.target.value}.`)} aria-label="Switch branch">
                      {status.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  )}
                </form>
                {isGithub && (
                  <details style={{ marginTop: 12 }} open={Boolean(prLink)}>
                    <summary><GitPullRequest size={14} /> Open a pull request</summary>
                    {!github && <p className="badge warn">Needs a GITHUB_TOKEN in the vault.</p>}
                    <div className="form-row" style={{ marginTop: 8 }}>
                      <input className="input" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} placeholder={`Title (from ${status.branch})`} aria-label="PR title" />
                      <input className="input" style={{ maxWidth: 140 }} value={pr.base} onChange={(e) => setPr({ ...pr, base: e.target.value })} aria-label="Base branch" />
                    </div>
                    <textarea className="input" style={{ width: '100%', marginTop: 8, minHeight: 80 }} value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} placeholder="What changed and why" aria-label="PR description" />
                    <button className="btn primary" style={{ marginTop: 8 }} disabled={!github || !!busy || status.branch === 'main'} onClick={() => void act('open_pr', { title: pr.title || status.branch, body: pr.body, base: pr.base })}>Open PR</button>
                    {prLink && <p><a href={prLink} target="_blank" rel="noreferrer">{prLink}</a></p>}
                  </details>
                )}
                {status.log.length > 0 && (
                  <>
                    <h3 style={{ marginTop: 14 }}>Recent commits</h3>
                    <ul className="git-log">{status.log.map((c) => <li key={c.sha}><span className="mono">{c.sha}</span><span className="ellipsis" dir="auto">{c.subject}</span></li>)}</ul>
                  </>
                )}
              </>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h3>Files</h3>{dir && <button className="btn ghost small" onClick={() => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')}><ChevronLeft size={14} /> Up</button>}</div>
            <p className="faint mono ellipsis" style={{ fontSize: 12, margin: 0 }}>/{dir}</p>
            <ul className="tree-list">
              {entries.map((entry) => (
                <li key={entry.path}><button onClick={() => (entry.dir ? setDir(entry.path) : setViewer({ kind: 'path', root: rootId, path: entry.path }))}>{entry.dir ? <Folder size={15} /> : <File size={15} />}<span className="ellipsis" dir="auto">{entry.name}</span>{!entry.dir && <span className="faint">{humanSize(entry.size)}</span>}</button></li>
              ))}
              {entries.length === 0 && <li className="faint">Empty folder.</li>}
            </ul>
          </div>
        </div>
      </div>
      {viewer && <FileViewer source={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff" aria-label="Diff">
      {text.split('\n').map((line, i) => <div key={i} className={line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}>{line || ' '}</div>)}
    </pre>
  );
}
