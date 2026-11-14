import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Check, ChevronLeft, FolderGit2, FolderOpen, GitBranch, Settings2, X, Zap } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { ModelOptions, useUsableModels } from '../lib/models';
import { Face, FACE_IDS, type FaceAgent } from './Face';

export interface PanelAgent extends FaceAgent { id: string; name: string; title?: string; description?: string; systemPrompt?: string; modelId?: string | null; toolAllowlist?: string[]; workshopIds?: string[]; strategy?: string | null; notify?: 'all' | 'mute' }
interface Skill { slug: string; name: string; enabled?: boolean }
interface MemoryFile { kind: 'user' | 'notes'; title: string; cap: number; content: string }
export interface WorkspaceRow { id: string; label: string; path: string; kind: 'folder' | 'repo'; source: 'agent' | 'project'; remote: string | null; branch: string | null; dirty: number; sets: string[] }
export interface WorkspaceSet { id: string; name: string; projects: string[] }

const TOOL_GROUPS: { title: string; tools: string[] }[] = [
  { title: 'Files', tools: ['list_dir', 'read_file', 'write_file', 'grep', 'glob', 'apply_patch'] },
  { title: 'Code', tools: ['shell', 'git', 'repo_sync', 'plan'] },
  { title: 'Web', tools: ['web_search', 'web_fetch'] },
  { title: 'Memory and team', tools: ['remember', 'recall', 'kb_search', 'consult_agent'] },
];

/** Workspaces data shared by the panel and the composer chip. */
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [sets, setSets] = useState<WorkspaceSet[]>([]);
  const reload = () => api<{ workspaces: WorkspaceRow[]; sets: WorkspaceSet[] }>('/api/workspaces').then((data) => { setWorkspaces(data.workspaces); setSets(data.sets); return data; }).catch(() => null);
  useEffect(() => { void reload(); }, []);
  return { workspaces, sets, reload };
}

export type PersonaTab = 'persona' | 'settings' | 'workspace';
const ACCENTS = ['#e4b56a', '#e39486', '#9dccb4', '#9ec0e0', '#d7b4e8', '#e88aa8', '#b89cf0', '#7cc59a', '#ffb08a', '#a3a3a3'];
interface Routine { id: string; name: string; cron: string; agentId: string; nextRunAt?: string | null; lastStatus?: string | null }
interface Channel { id: string; name: string; kind: string; agentId: string; enabled?: boolean }

/**
 * Right pane for one persona, opened by clicking its name in the chat header (Ctrl/Cmd+Shift+I).
 * Overview first (status, routines, channels, workspaces); the gear opens a short settings page
 * (face, name, title, description, notifications) with model, instructions and tools tucked below.
 */
export function PersonaPanel({ agent, tab, onTab, onClose, onSaved, ws, canManage, onAttach }: {
  agent: PanelAgent | null; tab: PersonaTab; onTab: (tab: PersonaTab) => void; onClose: () => void;
  onSaved: (agent: PanelAgent, what: string) => void; ws: ReturnType<typeof useWorkspaces>; canManage: boolean; onAttach?: (rootId: string, label: string) => void;
}) {
  const [draft, setDraft] = useState<PanelAgent | null>(agent);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<PanelAgent>>({});
  const models = useUsableModels();
  const [memory, setMemory] = useState<MemoryFile[] | null>(null);
  const memoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!agent?.id || tab !== 'settings') return;
    setMemory(null);
    api<{ files: MemoryFile[] }>(`/api/agents/${agent.id}/memory-files`).then((data) => setMemory(data.files)).catch(() => setMemory([]));
  }, [agent?.id, tab]);
  // The persona keeps these itself; edits here autosave the same way.
  const saveMemory = (kind: MemoryFile['kind'], content: string) => {
    if (!agent?.id) return;
    setMemory((rows) => rows?.map((row) => row.kind === kind ? { ...row, content } : row) ?? rows);
    setSaved('saving');
    if (memoryTimer.current) clearTimeout(memoryTimer.current);
    const id = agent.id;
    memoryTimer.current = setTimeout(async () => {
      try { await api(`/api/agents/${id}/memory-files/${kind}`, { method: 'PUT', body: JSON.stringify({ content }) }); setSaved('saved'); }
      catch (error) { setSaved('idle'); toast(errorText(error), 'error'); }
    }, 900);
  };
  useEffect(() => { setDraft(agent); setSaved('idle'); }, [agent?.id]);
  useEffect(() => {
    if (!agent?.id || !canManage) { setSkills([]); return; }
    api<{ skills: Skill[] }>(`/api/skills?agentId=${encodeURIComponent(agent.id)}`).then((data) => setSkills(data.skills)).catch(() => setSkills([]));
  }, [agent?.id, canManage]);
  useEffect(() => {
    if (!agent?.id) return;
    setRoutines(null); setChannels(null);
    api<{ schedules: Routine[] }>('/api/schedules').then((data) => setRoutines(data.schedules.filter((row) => row.agentId === agent.id))).catch(() => setRoutines([]));
    api<{ triggers: Channel[] }>('/api/triggers').then((data) => setChannels(data.triggers.filter((row) => row.agentId === agent.id))).catch(() => setChannels([]));
  }, [agent?.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement)?.closest?.('.menu-panel')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Autosave: edits batch for a moment, then one PATCH. Changes apply from the next message.
  const save = (patch: Partial<PanelAgent>, what: string, delay = 500) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaved('saving');
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = pending.current; pending.current = {};
      try {
        const result = await api<{ agent: PanelAgent }>(`/api/agents/${next.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setSaved('saved');
        onSaved(result.agent, what);
      } catch (error) { setSaved('idle'); toast(errorText(error), 'error'); }
    }, delay);
  };

  const tick = <span className="saved-tick" aria-live="polite">{saved === 'saving' ? 'Saving…' : saved === 'saved' ? <><Check size={14} aria-hidden /> Saved</> : ''}</span>;
  const close = <button className="icon-btn" aria-label="Close panel" title="Close (Esc)" onClick={onClose}><X size={18} /></button>;
  const back = (label: string) => <button className="icon-btn" aria-label={`Back to ${label}`} title="Back" onClick={() => onTab('persona')}><ChevronLeft size={18} /></button>;
  const modelName = draft?.modelId ? (models.models.local.concat(models.models.cloud, models.models.dev).find((model) => model.id === draft.modelId)?.name || draft.modelId) : 'Auto';
  const defaults = ws.sets.filter((set) => (draft?.workshopIds || []).includes(set.id));

  return (
    <aside className="side-panel open persona-pane" aria-label={tab === 'settings' ? 'Persona settings' : tab === 'workspace' ? 'Workspaces' : 'Persona info'}>
      {tab === 'persona' && (
        <div className="panel-head pane-head">
          {draft ? <><Face agent={draft} size={28} /><div className="grow pane-title"><strong dir="auto">{draft.emoji ? `${draft.emoji} ` : ''}{draft.name}</strong>{draft.title && <small className="faint">{draft.title}</small>}</div></> : <span className="grow" />}
          {canManage && draft && <button className="icon-btn" aria-label="Persona settings" title="Persona settings" onClick={() => onTab('settings')}><Settings2 size={17} /></button>}
          {close}
        </div>
      )}
      {tab === 'settings' && <div className="panel-head pane-head">{back('overview')}<strong className="grow">Persona settings</strong>{tick}{close}</div>}
      {tab === 'workspace' && <div className="panel-head pane-head">{back('overview')}<strong className="grow">Workspaces</strong>{close}</div>}

      {tab === 'persona' && (!draft ? <p className="faint panel-body">Pick a persona first.</p> : (
        <div className="panel-body pane-overview">
          <p className={draft.description ? 'pane-desc' : 'pane-desc faint'} dir="auto">{draft.description || 'No description yet.'}</p>
          <section className="pane-section">
            <h4>Status</h4>
            <dl className="pane-facts">
              <dt>Model</dt><dd>{modelName}</dd>
              <dt>Tools</dt><dd>{(draft.toolAllowlist || []).length} on</dd>
              <dt>Unread dot</dt><dd>{draft.notify === 'mute' ? 'Muted' : 'On'}</dd>
            </dl>
          </section>
          <section className="pane-section">
            <h4>Routines <Link className="pane-more" to="/schedules">Manage</Link></h4>
            {routines === null ? <div className="skeleton-lines"><span /></div> : routines.length === 0 ? <p className="faint">No routines. <Link to="/schedules">Schedule one</Link></p> : (
              <ul className="pane-list">{routines.map((row) => <li key={row.id}><CalendarClock size={14} aria-hidden /><span className="grow ellipsis">{row.name}</span><span className="faint mono">{row.cron}</span></li>)}</ul>
            )}
          </section>
          <section className="pane-section">
            <h4>Channels <Link className="pane-more" to="/triggers">Manage</Link></h4>
            {channels === null ? <div className="skeleton-lines"><span /></div> : channels.length === 0 ? <p className="faint">Chat only. <Link to="/triggers">Add a webhook, folder or inbox</Link></p> : (
              <ul className="pane-list">{channels.map((row) => <li key={row.id}><Zap size={14} aria-hidden /><span className="grow ellipsis">{row.name}</span><span className="faint">{row.kind}</span></li>)}</ul>
            )}
          </section>
          <section className="pane-section">
            <h4>Default workspaces {canManage && <button className="pane-more link-btn" onClick={() => onTab('workspace')}>Manage</button>}</h4>
            {defaults.length === 0 ? <p className="faint">None. New chats start without a workspace.</p> : <div className="chip-row">{defaults.map((set) => <span key={set.id} className="chip"><FolderGit2 size={13} aria-hidden /> {set.name}</span>)}</div>}
          </section>
        </div>
      ))}

      {tab === 'settings' && draft && (
        <div className="panel-body pane-settings">
          <div className="pane-avatar">
            <Face agent={draft} size={56} />
            <div className="grow">
              <div className="face-row" role="group" aria-label="Face">
                {[0, 1, 2, 3, 4, 5].map((shape) => <button type="button" key={`blob-${shape}`} className="face-pick" aria-label={`Blob face ${shape + 1}`} aria-pressed={draft.avatarKind !== 'builtin' && draft.avatarKind !== 'upload' && draft.avatarRef === `blob-${shape}`} onClick={() => save({ avatarKind: 'initials', avatarRef: `blob-${shape}` }, 'face', 0)}><Face agent={{ ...draft, avatarKind: 'initials', avatarRef: `blob-${shape}` }} size={28} /></button>)}
                {FACE_IDS.map((id) => <button type="button" key={id} className="face-pick" aria-label={`Face ${id}`} aria-pressed={draft.avatarKind === 'builtin' && draft.avatarRef === id} onClick={() => save({ avatarKind: 'builtin', avatarRef: id }, 'face', 0)}><Face agent={{ ...draft, avatarKind: 'builtin', avatarRef: id }} size={28} /></button>)}
              </div>
              <div className="swatch-row" role="group" aria-label="Colour">
                {ACCENTS.map((color) => <button type="button" key={color} className="swatch-dot" aria-label={`Colour ${color}`} aria-pressed={(draft.accent || '').toLowerCase() === color} style={{ background: color }} onClick={() => save({ accent: color }, 'colour', 0)} />)}
              </div>
            </div>
          </div>
          <label className="field"><span>Name</span><input value={draft.name} maxLength={80} onChange={(event) => save({ name: event.target.value }, 'name', 800)} /></label>
          <label className="field"><span>Title</span><input value={draft.title || ''} maxLength={80} placeholder="e.g. Research assistant" onChange={(event) => save({ title: event.target.value }, 'title', 800)} /></label>
          <label className="field"><span>Description</span><textarea rows={2} value={draft.description || ''} placeholder="One line on what this persona is for" onChange={(event) => save({ description: event.target.value }, 'description', 800)} /></label>
          <label className="field"><span>Emoji</span><input value={draft.emoji || ''} maxLength={4} placeholder="Optional" onChange={(event) => save({ emoji: event.target.value }, 'emoji', 600)} /></label>
          <label className="field toggle-field"><span>Unread dot for new replies</span>
            <input type="checkbox" role="switch" checked={draft.notify !== 'mute'} onChange={(event) => save({ notify: event.target.checked ? 'all' : 'mute' }, 'notifications', 0)} />
          </label>
          <p className="faint panel-note">Changes save as you type and apply from the next message.</p>

          <details className="pane-more-section">
            <summary>Model</summary>
            <label className="field"><span className="sr-only">Model</span>
              <select value={draft.modelId || ''} onChange={(event) => save({ modelId: event.target.value || null }, 'model', 0)}>
                <option value="">{models.models.empty ? 'No model yet — set one up' : 'Auto (recommended)'}</option>
                <ModelOptions models={models.models} />
              </select>
            </label>
          </details>
          <details className="pane-more-section">
            <summary>Instructions</summary>
            <textarea rows={6} aria-label="Instructions" value={draft.systemPrompt || ''} onChange={(event) => save({ systemPrompt: event.target.value }, 'instructions', 900)} />
          </details>
          <details className="pane-more-section">
            <summary>Memory</summary>
            <p className="faint panel-note">Two short files the persona reads every time and keeps up to date itself. When one gets full it merges and trims.</p>
            {memory === null ? <div className="skeleton-lines"><span /></div> : memory.map((file) => (
              <label key={file.kind} className="field memory-field">
                <span className="row"><span className="grow">{file.title}</span><span className={file.content.length > file.cap ? 'faint mono over' : 'faint mono'}>{file.content.length}/{file.cap}</span></span>
                <textarea rows={file.kind === 'user' ? 3 : 5} value={file.content} maxLength={file.cap} placeholder={file.kind === 'user' ? 'About you: preferences, context' : 'Its own working notes'} onChange={(event) => saveMemory(file.kind, event.target.value)} />
              </label>
            ))}
          </details>
          <details className="pane-more-section">
            <summary>Tools and skills</summary>
            {TOOL_GROUPS.map((group) => (
              <div key={group.title} className="tool-group">
                <small className="faint">{group.title}</small>
                <div className="chip-row">
                  {group.tools.map((tool) => {
                    const on = (draft.toolAllowlist || []).includes(tool);
                    return <button key={tool} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => save({ toolAllowlist: on ? (draft.toolAllowlist || []).filter((item) => item !== tool) : [...(draft.toolAllowlist || []), tool] }, 'tools', 300)}>{tool}</button>;
                  })}
                </div>
              </div>
            ))}
            {skills.length > 0 && (
              <div className="tool-group"><small className="faint">Skills</small>
                <div className="chip-row">
                  {skills.map((skill) => {
                    const on = skill.enabled !== false;
                    return <button key={skill.slug} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={async () => {
                      try { await post(`/api/skills/${skill.slug}/enable`, { agentId: draft.id, enabled: !on }); setSkills((rows) => rows.map((row) => row.slug === skill.slug ? { ...row, enabled: !on } : row)); setSaved('saved'); onSaved(draft, 'skills'); }
                      catch (error) { toast(errorText(error), 'error'); }
                    }}>{skill.name}</button>;
                  })}
                </div>
              </div>
            )}
          </details>
          {canManage && (
            <details className="pane-more-section">
              <summary>Default workspaces for new chats</summary>
              {ws.sets.length === 0 && <p className="faint">None yet. <button className="link-btn" onClick={() => onTab('workspace')}>Add a workspace</button></p>}
              <div className="chip-row">
                {ws.sets.map((set) => {
                  const on = (draft.workshopIds || []).includes(set.id);
                  return <button key={set.id} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} title={set.projects.join(' + ')} onClick={() => save({ workshopIds: on ? (draft.workshopIds || []).filter((id) => id !== set.id) : [...(draft.workshopIds || []), set.id] }, 'workspaces', 0)}><FolderGit2 size={13} aria-hidden /> {set.name}</button>;
                })}
              </div>
            </details>
          )}
          <p className="faint"><Link to={`/agents?edit=${draft.id}`}>All persona options</Link> (photo upload, memory, context strategy).</p>
        </div>
      )}
      {tab === 'workspace' && <WorkspaceTab ws={ws} canManage={canManage} onAttach={onAttach} />}
    </aside>
  );
}

function WorkspaceTab({ ws, canManage, onAttach }: { ws: ReturnType<typeof useWorkspaces>; canManage: boolean; onAttach?: (rootId: string, label: string) => void }) {
  const [mode, setMode] = useState<'folder' | 'clone' | 'set' | null>(null);
  const [pathValue, setPathValue] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState('');
  const [setName, setSetName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const projects = ws.workspaces.filter((row) => row.source === 'project');
  const reset = () => { setMode(null); setPathValue(''); setLabel(''); setUrl(''); setParent(''); setSetName(''); setPicked([]); };
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      const result = await action() as { workspace?: { label: string }; label?: string };
      await ws.reload(); toast(done, 'ok'); reset();
      const label = result?.workspace?.label || result?.label;
      if (label && onAttach) onAttach(`prj:${label}`, label);
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="panel-body">
      <p className="faint panel-note">A workspace is a folder or a git repo. Each chat has its own: what you add here is attached to this chat, and the agent works in exactly those. Repos get git (pulls, commits, branches; pushes need your approval). Save several as a set to attach them together, or make a set a persona default.</p>
      <div className="ws-list">
        {ws.workspaces.length === 0 && <p className="faint">No workspaces yet.</p>}
        {ws.workspaces.map((row) => (
          <div key={row.id} className="ws-row" title={row.path}>
            {row.kind === 'repo' ? <GitBranch size={15} aria-hidden /> : <FolderOpen size={15} aria-hidden />}
            <span className="grow"><strong>{row.label}</strong><small className="faint mono">{row.kind === 'repo' ? `${row.branch || 'detached'}${row.remote ? ' · remote' : ' · local'}` : 'folder'} · {row.path}</small></span>
            {row.dirty > 0 && <span className="dirty-dot" title={`${row.dirty} uncommitted change${row.dirty === 1 ? '' : 's'}`} aria-label={`${row.dirty} changes`} />}
          </div>
        ))}
      </div>
      {ws.sets.length > 0 && <>
        <p className="panel-sub">Sets</p>
        {ws.sets.map((set) => <div key={set.id} className="ws-row"><FolderGit2 size={15} aria-hidden /><span className="grow"><strong>{set.name}</strong><small className="faint">{set.projects.join(' + ')}</small></span></div>)}
      </>}
      {!canManage ? <p className="faint">Ask the owner to add shared folders or repos.</p> : mode === null ? (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn small" onClick={() => setMode('folder')}>Add folder or local repo</button>
          <button className="btn small" onClick={() => setMode('clone')}>Clone a repo</button>
          {projects.length > 1 && <button className="btn small ghost" onClick={() => setMode('set')}>Save a set</button>}
        </div>
      ) : (
        <form className="ws-form" onSubmit={(event) => {
          event.preventDefault();
          if (mode === 'folder') void run(() => post('/api/workspaces/folder', { path: pathValue.trim(), label: label.trim() || undefined }), onAttach ? 'Workspace added and attached to this chat.' : 'Workspace added.');
          if (mode === 'clone') void run(() => post('/api/git/clone', { url: url.trim(), label: label.trim() || undefined, parentDir: parent.trim() || undefined }), onAttach ? 'Cloned and attached to this chat. Pull from its panel to stay in sync.' : 'Cloned. Pull from Workspaces to keep it in sync.');
          if (mode === 'set') void run(() => post('/api/workspaces/sets', { name: setName.trim(), labels: picked }), 'Set saved.');
        }}>
          {mode === 'folder' && <>
            <label className="field"><span>Folder on this machine</span><input autoFocus required value={pathValue} onChange={(event) => setPathValue(event.target.value)} placeholder="/home/you/projects/api" /></label>
            <label className="field"><span>Short name (optional)</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="api" /></label>
          </>}
          {mode === 'clone' && <>
            <label className="field"><span>Git URL</span><input autoFocus required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/you/repo.git" /></label>
            <label className="field"><span>Clone into (optional)</span><input value={parent} onChange={(event) => setParent(event.target.value)} placeholder="Default: local-agent's repo cache" /></label>
            <label className="field"><span>Short name (optional)</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="repo" /></label>
          </>}
          {mode === 'set' && <>
            <label className="field"><span>Set name</span><input autoFocus required value={setName} onChange={(event) => setSetName(event.target.value)} placeholder="api + web" /></label>
            <div className="chip-row">{projects.map((row) => { const on = picked.includes(row.label); return <button key={row.id} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => setPicked((rows) => on ? rows.filter((item) => item !== row.label) : [...rows, row.label])}>{row.label}</button>; })}</div>
          </>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary small" disabled={busy || (mode === 'set' && picked.length === 0)}>{busy ? 'Working…' : mode === 'clone' ? 'Clone' : mode === 'set' ? 'Save set' : 'Add'}</button>
            <button type="button" className="btn ghost small" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}
      <p className="faint" style={{ marginTop: 16 }}><Link to="/workspace">Manage workspaces</Link>: git status, commits, pulls and pushes.</p>
    </div>
  );
}
