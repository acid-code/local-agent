import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, FolderGit2, FolderOpen, GitBranch, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { ModelOptions, useUsableModels } from '../lib/models';
import { Face, type FaceAgent } from './Face';

export interface PanelAgent extends FaceAgent { id: string; name: string; title?: string; description?: string; systemPrompt?: string; modelId?: string | null; toolAllowlist?: string[]; workshopIds?: string[]; strategy?: string | null }
interface Skill { slug: string; name: string; enabled?: boolean }
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

/**
 * Right panel opened from the persona chip. Edits apply to the next message and save as you go.
 * Tabs: the persona (name, model, tools, skills, workspaces, instructions) and workspaces (add a folder, a repo, or clone).
 */
export function PersonaPanel({ agent, tab, onTab, onClose, onSaved, ws, canManage }: {
  agent: PanelAgent | null; tab: 'persona' | 'workspace'; onTab: (tab: 'persona' | 'workspace') => void; onClose: () => void;
  onSaved: (agent: PanelAgent, what: string) => void; ws: ReturnType<typeof useWorkspaces>; canManage: boolean;
}) {
  const [draft, setDraft] = useState<PanelAgent | null>(agent);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const models = useUsableModels();
  useEffect(() => { setDraft(agent); setSaved('idle'); }, [agent?.id]);
  useEffect(() => {
    if (!agent?.id || !canManage) { setSkills([]); return; }
    api<{ skills: Skill[] }>(`/api/skills?agentId=${encodeURIComponent(agent.id)}`).then((data) => setSkills(data.skills)).catch(() => setSkills([]));
  }, [agent?.id, canManage]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement)?.closest?.('.menu-panel')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (patch: Partial<PanelAgent>, what: string, delay = 500) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaved('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const result = await api<{ agent: PanelAgent }>(`/api/agents/${next.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        setSaved('saved');
        onSaved(result.agent, what);
      } catch (error) { setSaved('idle'); toast(errorText(error), 'error'); }
    }, delay);
  };

  return (
    <aside className="side-panel open" aria-label="Persona and workspace settings">
      <div className="panel-head">
        <div className="panel-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'persona'} onClick={() => onTab('persona')}>Persona</button>
          <button role="tab" aria-selected={tab === 'workspace'} onClick={() => onTab('workspace')}>Workspaces</button>
        </div>
        <span className="saved-tick" aria-live="polite">{saved === 'saving' ? 'Saving…' : saved === 'saved' ? <><Check size={14} aria-hidden /> Saved</> : ''}</span>
        <button className="icon-btn" aria-label="Close panel" onClick={onClose}><X size={18} /></button>
      </div>
      {tab === 'persona' && (!draft ? <p className="faint panel-body">Pick a persona first.</p> : (
        <div className="panel-body">
          <div className="panel-id">
            <Face agent={draft} size={44} />
            <div className="grow">
              <input className="bare-input title" aria-label="Name" value={draft.name} onChange={(event) => save({ name: event.target.value }, 'name', 800)} />
              <input className="bare-input" aria-label="Title" placeholder="Add a title" value={draft.title || ''} onChange={(event) => save({ title: event.target.value }, 'title', 800)} />
            </div>
          </div>
          <p className="faint panel-note">Changes apply from the next message.</p>
          <label className="field"><span>Model</span>
            <select value={draft.modelId || ''} onChange={(event) => save({ modelId: event.target.value || null }, 'model', 0)}>
              <option value="">{models.models.empty ? 'No model yet — set one up' : 'Auto (recommended)'}</option>
              <ModelOptions models={models.models} />
            </select>
          </label>
          <label className="field"><span>Instructions</span>
            <textarea rows={6} value={draft.systemPrompt || ''} onChange={(event) => save({ systemPrompt: event.target.value }, 'instructions', 900)} />
          </label>
          <div className="field"><span>Tools</span>
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
          </div>
          {skills.length > 0 && (
            <div className="field"><span>Skills</span>
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
          {canManage && (
            <div className="field"><span>Workspace sets this persona can use</span>
              {ws.sets.length === 0 && <p className="faint">None yet. <button className="link-btn" onClick={() => onTab('workspace')}>Add a workspace</button></p>}
              <div className="chip-row">
                {ws.sets.map((set) => {
                  const on = (draft.workshopIds || []).includes(set.id);
                  return <button key={set.id} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} title={set.projects.join(' + ')} onClick={() => save({ workshopIds: on ? (draft.workshopIds || []).filter((id) => id !== set.id) : [...(draft.workshopIds || []), set.id] }, 'workspaces', 0)}><FolderGit2 size={13} aria-hidden /> {set.name}</button>;
                })}
              </div>
            </div>
          )}
          <p className="faint"><Link to={`/agents?edit=${draft.id}`}>Open full persona settings</Link> for face, color, memory and more.</p>
        </div>
      ))}
      {tab === 'workspace' && <WorkspaceTab ws={ws} canManage={canManage} />}
    </aside>
  );
}

function WorkspaceTab({ ws, canManage }: { ws: ReturnType<typeof useWorkspaces>; canManage: boolean }) {
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
    try { await action(); await ws.reload(); toast(done, 'ok'); reset(); } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="panel-body">
      <p className="faint panel-note">A workspace is a folder or a git repo the coder works in. Repos get git (branches, pulls, pushes with your approval); folders are plain files. Group several into a set, then attach the set to a chat from the composer.</p>
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
          if (mode === 'folder') void run(() => post('/api/workspaces/folder', { path: pathValue.trim(), label: label.trim() || undefined }), 'Workspace added.');
          if (mode === 'clone') void run(() => post('/api/git/clone', { url: url.trim(), label: label.trim() || undefined, parentDir: parent.trim() || undefined }), 'Cloned. Pull from Workspaces to keep it in sync.');
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
