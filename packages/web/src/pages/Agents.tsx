import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { Face, FACE_IDS, type FaceAgent } from '../components/Face';

interface Agent extends FaceAgent {
  id: string;
  title: string;
  description: string;
  systemPrompt: string;
  modelId: string | null;
  strategy?: string | null;
  toolAllowlist: string[];
  emoji: string;
  accent: string;
  pinned: boolean;
  hidden: boolean;
  workshopIds: string[];
}
interface Template { id: string; name: string; description: string; systemPrompt: string; tools: string[] }
interface Model { id: string; name: string }
interface Skill { slug: string; name: string; enabled?: boolean }
interface Workshop { id: string; name: string }

const TOOLS = ['list_dir', 'read_file', 'write_file', 'shell', 'web_search', 'web_fetch', 'remember', 'recall', 'grep', 'glob', 'apply_patch', 'git', 'plan', 'consult_agent', 'repo_sync'];
const ACCENTS = ['#e4b56a', '#e39486', '#9dccb4', '#9ec0e0', '#d7b4e8', '#f0e2b6'];

const empty = (): Agent => ({
  id: '', name: '', title: '', description: '', systemPrompt: 'You are a careful local agent.', modelId: null,
  toolAllowlist: ['read_file', 'remember', 'recall'], emoji: '', accent: '#e4b56a', avatarKind: 'initials', avatarRef: '',
  pinned: false, hidden: false, workshopIds: [],
});

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [draft, setDraft] = useState<Agent>(empty());
  const [note, setNote] = useState('');

  async function load() {
    const data = await api<{ agents: Agent[]; templates: Template[] }>('/api/agents');
    setAgents(data.agents);
    setTemplates(data.templates);
    setModels((await api<{ models: Model[] }>('/api/models')).models);
    setSkills((await api<{ skills: Skill[] }>('/api/skills')).skills);
    setWorkshops((await api<{ workshops: Workshop[] }>('/api/workshops')).workshops);
  }
  useEffect(() => { void load().catch((error: Error) => setNote(error.message)); }, []);

  function edit(agent: Agent) {
    setDraft(agent);
    setNote('');
  }

  async function save(event: { preventDefault(): void }) {
    event.preventDefault();
    const body = {
      name: draft.name, title: draft.title, description: draft.description, systemPrompt: draft.systemPrompt,
      modelId: draft.modelId, strategy: draft.strategy || null, toolAllowlist: draft.toolAllowlist, emoji: draft.emoji, accent: draft.accent,
      avatarKind: draft.avatarKind, avatarRef: draft.avatarRef, pinned: draft.pinned, hidden: draft.hidden,
      workshopIds: draft.workshopIds,
    };
    const saved = draft.id
      ? await api<{ agent: Agent }>(`/api/agents/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await post<{ agent: Agent }>('/api/agents', body);
    setDraft(saved.agent);
    setNote('Saved on this machine.');
    await load();
  }

  async function upload(file: File) {
    if (!draft.id) { setNote('Save the persona before uploading a face.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    try {
      const saved = await post<{ agent: Agent }>(`/api/agents/${draft.id}/avatar`, { contentBase64: btoa(binary) });
      setDraft(saved.agent);
      setNote('Face saved locally.');
      await load();
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Upload failed.');
    }
  }

  return (
    <div className="page">
      <h1>Personas</h1>
      <p className="lede">Give each persona a face, a color, and a voice. The preview is what their messages look like. Avatars stay on this machine.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        {templates.map((template) => (
          <button key={template.id} className="btn" onClick={async () => { await post('/api/agents', { name: template.name, description: template.description, systemPrompt: template.systemPrompt, toolAllowlist: template.tools, template: template.id }); await load(); }}>Add {template.name}</button>
        ))}
        <button className="btn" onClick={() => setDraft(empty())}>New persona</button>
      </div>
      <div className="grid cards">
        {agents.map((agent) => (
          <button key={agent.id} className="card" style={{ textAlign: 'left', borderLeft: `3px solid ${agent.accent}` }} onClick={() => edit(agent)}>
            <span className="who"><Face agent={agent} size={36} /><strong>{agent.emoji ? `${agent.emoji} ` : ''}{agent.name}</strong></span>
            <p className="muted">{agent.title || agent.description}</p>
          </button>
        ))}
      </div>
      <form className="card" onSubmit={save}>
        <h3>{draft.id ? 'Edit persona' : 'New persona'}</h3>
        <div className="preview-bubble" style={{ ['--accent' as string]: draft.accent }}>
          <div className="who"><Face agent={draft.id ? draft : { ...draft, id: 'preview' }} size={36} /><div><strong>{draft.emoji ? `${draft.emoji} ` : ''}{draft.name || 'Name'}</strong><div className="faint">{draft.title || draft.description || 'Title'}</div></div></div>
          <p>This is how a message from this persona looks.</p>
        </div>
        <label className="field"><span>Name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
        <label className="field"><span>Title</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="House operator" /></label>
        <label className="field"><span>Short description</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="field"><span>Emoji or icon</span><input value={draft.emoji} onChange={(event) => setDraft({ ...draft, emoji: event.target.value })} placeholder="Optional" /></label>
        <label className="field"><span>Accent</span>
          <span className="row">{ACCENTS.map((color) => <button type="button" key={color} aria-label={`Accent ${color}`} aria-pressed={draft.accent === color} className="face initials swatch" style={{ background: color }} onClick={() => setDraft({ ...draft, accent: color })} />)}</span>
          <input value={draft.accent} onChange={(event) => setDraft({ ...draft, accent: event.target.value })} />
        </label>
        <p className="faint">Face</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setDraft({ ...draft, avatarKind: 'initials', avatarRef: '' })}>Initials</button>
          {FACE_IDS.map((id) => (
            <button type="button" key={id} onClick={() => setDraft({ ...draft, avatarKind: 'builtin', avatarRef: id })}><Face agent={{ ...draft, avatarKind: 'builtin', avatarRef: id }} size={36} /></button>
          ))}
        </div>
        <label className="field"><span>Upload a face (PNG, JPEG, WebP, or GIF, up to 512 KB)</span>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        </label>
        <label className="field"><span>Context strategy</span>
          <select value={draft.strategy || ''} onChange={(event) => setDraft({ ...draft, strategy: event.target.value || null })}>
            <option value="">Contract default</option>
            <option value="rolling">Rolling</option>
            <option value="hierarchical">Hierarchical</option>
            <option value="hierarchical+retrieval">Hierarchical plus retrieval</option>
            <option value="retrieval">Retrieval</option>
            <option value="pinned">Pinned</option>
          </select>
        </label>
        <label className="field"><span>Default model</span>
          <select value={draft.modelId || ''} onChange={(event) => setDraft({ ...draft, modelId: event.target.value || null })}>
            <option value="">Automatic</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
        <fieldset className="field">
          <legend>Tools</legend>
          {TOOLS.map((tool) => (
            <label key={tool}><input type="checkbox" checked={draft.toolAllowlist.includes(tool)} onChange={(event) => setDraft({ ...draft, toolAllowlist: event.target.checked ? [...draft.toolAllowlist, tool] : draft.toolAllowlist.filter((item) => item !== tool) })} /> {tool}</label>
          ))}
        </fieldset>
        {draft.id && skills.length > 0 && (
          <fieldset className="field">
            <legend>Skills</legend>
            {skills.map((skill) => (
              <label key={skill.slug}><input type="checkbox" defaultChecked={skill.enabled !== false} onChange={(event) => post(`/api/skills/${skill.slug}/enable`, { agentId: draft.id, enabled: event.target.checked })} /> {skill.name}</label>
            ))}
          </fieldset>
        )}
        {workshops.length > 0 && (
          <fieldset className="field">
            <legend>Workshops</legend>
            {workshops.map((workshop) => (
              <label key={workshop.id}><input type="checkbox" checked={draft.workshopIds.includes(workshop.id)} onChange={(event) => setDraft({ ...draft, workshopIds: event.target.checked ? [...draft.workshopIds, workshop.id] : draft.workshopIds.filter((id) => id !== workshop.id) })} /> {workshop.name}</label>
            ))}
          </fieldset>
        )}
        <label className="field"><span>System prompt</span><textarea rows={8} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></label>
        <label><input type="checkbox" checked={draft.hidden} onChange={(event) => setDraft({ ...draft, hidden: event.target.checked })} /> Hide from the sidebar</label>
        <div className="row"><button className="btn primary" type="submit">Save persona</button></div>
        {note && <p className="muted">{note}</p>}
      </form>
    </div>
  );
}
