import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Eye, EyeOff, MessageSquare, Pencil, Plus, Users } from 'lucide-react';
import { api, post } from '../lib/api';
import { toast } from '../lib/toast';
import { EmptyState, Menu, PageHeader, Section } from '../components/ui';
import { ModelOptions, useUsableModels } from '../lib/models';
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
interface Skill { slug: string; name: string; enabled?: boolean }
interface Workshop { id: string; name: string }

const TOOLS = ['list_dir', 'read_file', 'write_file', 'shell', 'web_search', 'web_fetch', 'remember', 'recall', 'grep', 'glob', 'apply_patch', 'git', 'plan', 'consult_agent', 'repo_sync'];
const ACCENTS = ['#e4b56a', '#e39486', '#9dccb4', '#9ec0e0', '#d7b4e8', '#f0e2b6', '#e88aa8', '#b89cf0', '#7cc59a', '#ffb08a'];

const empty = (): Agent => ({
  id: '', name: '', title: '', description: '', systemPrompt: 'You are a careful local agent.', modelId: null,
  toolAllowlist: ['read_file', 'remember', 'recall'], emoji: '', accent: '#e4b56a', avatarKind: 'initials', avatarRef: '',
  pinned: false, hidden: false, workshopIds: [],
});

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const { models: usable } = useUsableModels();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [draft, setDraft] = useState<Agent>(empty());
  const [loaded, setLoaded] = useState(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const editId = params.get('edit');
  const creating = params.get('new') === '1';

  async function load() {
    const data = await api<{ agents: Agent[]; templates: Template[] }>('/api/agents');
    setAgents(data.agents);
    setTemplates(data.templates);
    setLoaded(true);
    setSkills((await api<{ skills: Skill[] }>('/api/skills').catch(() => ({ skills: [] }))).skills);
    setWorkshops((await api<{ workshops: Workshop[] }>('/api/workshops').catch(() => ({ workshops: [] }))).workshops);
    return data.agents;
  }
  useEffect(() => { void load().catch((error: Error) => toast(error.message, 'error')); }, []);
  useEffect(() => {
    if (creating) setDraft(empty());
    else if (editId) { const found = agents.find((agent) => agent.id === editId); if (found) setDraft(found); }
  }, [editId, creating, agents]);

  const open = (agent: Agent) => setParams({ edit: agent.id });
  const close = () => setParams({});

  async function fromTemplate(template: Template) {
    const created = await post<{ agent: Agent }>('/api/agents', { name: template.name, description: template.description, systemPrompt: template.systemPrompt, toolAllowlist: template.tools, template: template.id });
    await load();
    toast(`Added ${template.name}.`, 'ok');
    if (created?.agent?.id) setParams({ edit: created.agent.id });
  }

  async function save(event: { preventDefault(): void }) {
    event.preventDefault();
    const body = {
      name: draft.name, title: draft.title, description: draft.description, systemPrompt: draft.systemPrompt,
      modelId: draft.modelId, strategy: draft.strategy || null, toolAllowlist: draft.toolAllowlist, emoji: draft.emoji, accent: draft.accent,
      avatarKind: draft.avatarKind, avatarRef: draft.avatarRef, pinned: draft.pinned, hidden: draft.hidden,
      workshopIds: draft.workshopIds,
    };
    try {
      const saved = draft.id
        ? await api<{ agent: Agent }>(`/api/agents/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await post<{ agent: Agent }>('/api/agents', body);
      setDraft(saved.agent);
      await load();
      toast(`Saved ${saved.agent.name}.`, 'ok');
      if (!draft.id) setParams({ edit: saved.agent.id });
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save.', 'error'); }
  }

  async function upload(file: File) {
    if (!draft.id) { toast('Save the agent before uploading a face.', 'error'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    try {
      const saved = await post<{ agent: Agent }>(`/api/agents/${draft.id}/avatar`, { contentBase64: btoa(binary) });
      setDraft(saved.agent);
      toast('Face saved on this machine.', 'ok');
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Upload failed.', 'error');
    }
  }

  const toggleHidden = async (agent: Agent) => { await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: !agent.hidden }) }); await load(); };
  const templateItems = templates.map((template) => ({ label: template.name, hint: template.description.split('.')[0]?.slice(0, 40), onSelect: () => void fromTemplate(template) }));

  if (editId || creating) {
    const title = draft.id ? (draft.name || 'Agent') : 'New agent';
    return (
      <div className="page">
        <PageHeader crumbs={[{ label: 'Agents', to: '/agents' }, { label: title }]} title={title} description={draft.id ? 'Changes apply from the next message.' : 'Give it a name, a face and a job. You can change everything later.'}
          actions={<><button className="btn ghost" type="button" onClick={close}>Back to agents</button><button className="btn primary" type="submit" form="agent-form" disabled={!draft.name.trim()}>{draft.id ? 'Save changes' : 'Create agent'}</button></>} />
        <form id="agent-form" className="agent-form" onSubmit={save}>
          <Section title="Identity" description="How it appears in chats and the sidebar.">
            <div className="preview-bubble" style={{ ['--accent' as string]: draft.accent, marginBottom: 12 }}>
              <div className="who"><Face agent={draft.id ? draft : { ...draft, id: 'preview' }} size={36} /><div><strong>{draft.emoji ? `${draft.emoji} ` : ''}{draft.name || 'Name'}</strong><div className="faint">{draft.title || draft.description || 'Title'}</div></div></div>
              <p>This is how a message from this agent looks.</p>
            </div>
            <div className="form-grid">
              <label className="field"><span>Name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required autoFocus={!draft.id} /></label>
              <label className="field"><span>Title</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="House operator" /></label>
              <label className="field"><span>Short description</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="What it is for" /></label>
              <label className="field"><span>Emoji (optional)</span><input value={draft.emoji} onChange={(event) => setDraft({ ...draft, emoji: event.target.value })} placeholder="🌱" /></label>
            </div>
          </Section>
          <Section title="Look" description="Accent color and face. Uploaded faces stay on this machine.">
            <p className="faint">Accent</p>
            <div className="row">{ACCENTS.map((color) => <button type="button" key={color} aria-label={`Accent ${color}`} aria-pressed={draft.accent === color} className="face initials swatch" style={{ background: color }} onClick={() => setDraft({ ...draft, accent: color })} />)}</div>
            <p className="faint">Face</p>
            <div className="row">
              <button type="button" className="btn small" aria-pressed={draft.avatarKind === 'initials'} onClick={() => setDraft({ ...draft, avatarKind: 'initials', avatarRef: '' })}>Initials</button>
              {FACE_IDS.map((id) => (
                <button type="button" className="face-pick" key={id} aria-label={`Face ${id}`} aria-pressed={draft.avatarKind === 'builtin' && draft.avatarRef === id} onClick={() => setDraft({ ...draft, avatarKind: 'builtin', avatarRef: id })}><Face agent={{ ...draft, avatarKind: 'builtin', avatarRef: id }} size={36} /></button>
              ))}
            </div>
            <label className="field" style={{ marginTop: 12 }}><span>Upload a face (PNG, JPEG, WebP or GIF, up to 512 KB){draft.id ? '' : ' — save first'}</span>
              <input type="file" disabled={!draft.id} accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
            </label>
          </Section>
          <Section title="Behavior" description="Which model answers and how it is told to behave.">
            <div className="form-grid">
              <label className="field"><span>Default model</span>
                <select value={draft.modelId || ''} onChange={(event) => setDraft({ ...draft, modelId: event.target.value || null })}>
                  <option value="">{usable.empty ? 'No model yet — set one up' : 'Auto (recommended)'}</option>
                  <ModelOptions models={usable} />
                </select>
              </label>
              <label className="field"><span>Memory strategy</span>
                <select value={draft.strategy || ''} onChange={(event) => setDraft({ ...draft, strategy: event.target.value || null })}>
                  <option value="">Model default</option>
                  <option value="rolling">Rolling window</option>
                  <option value="hierarchical">Summaries</option>
                  <option value="hierarchical+retrieval">Summaries + retrieval</option>
                  <option value="retrieval">Retrieval</option>
                  <option value="pinned">Pinned</option>
                </select>
              </label>
            </div>
            <label className="field"><span>Instructions (system prompt)</span><textarea rows={8} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></label>
          </Section>
          <Section title="Tools" description="What it may do. Anything that changes files outside its workspace still asks first.">
            <div className="check-grid">
              {TOOLS.map((tool) => (
                <label key={tool}><input type="checkbox" checked={draft.toolAllowlist.includes(tool)} onChange={(event) => setDraft({ ...draft, toolAllowlist: event.target.checked ? [...draft.toolAllowlist, tool] : draft.toolAllowlist.filter((item) => item !== tool) })} /> <span className="mono">{tool}</span></label>
              ))}
            </div>
          </Section>
          {(draft.id && skills.length > 0) || workshops.length > 0 ? (
            <Section title="Skills and workshops">
              {draft.id && skills.length > 0 && (
                <fieldset className="field"><legend className="faint">Skills</legend>
                  <div className="check-grid">{skills.map((skill) => (
                    <label key={skill.slug}><input type="checkbox" defaultChecked={skill.enabled !== false} onChange={(event) => post(`/api/skills/${skill.slug}/enable`, { agentId: draft.id, enabled: event.target.checked })} /> {skill.name}</label>
                  ))}</div>
                </fieldset>
              )}
              {workshops.length > 0 && (
                <fieldset className="field"><legend className="faint">Workshops</legend>
                  <div className="check-grid">{workshops.map((workshop) => (
                    <label key={workshop.id}><input type="checkbox" checked={draft.workshopIds.includes(workshop.id)} onChange={(event) => setDraft({ ...draft, workshopIds: event.target.checked ? [...draft.workshopIds, workshop.id] : draft.workshopIds.filter((id) => id !== workshop.id) })} /> {workshop.name}</label>
                  ))}</div>
                </fieldset>
              )}
            </Section>
          ) : null}
          <Section title="Sidebar">
            <label className="row"><input type="checkbox" checked={!draft.hidden} onChange={(event) => setDraft({ ...draft, hidden: !event.target.checked })} /> Show in the sidebar for quick chats</label>
          </Section>
          <div className="save-bar">
            <button className="btn ghost" type="button" onClick={close}>Cancel</button>
            <button className="btn primary" type="submit" disabled={!draft.name.trim()}>{draft.id ? 'Save changes' : 'Create agent'}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Agents" description="Each agent has its own face, voice, instructions, tools and workspace. Open one to edit it."
        actions={<span className="split">
          <button className="btn primary" onClick={() => setParams({ new: '1' })}><Plus size={16} aria-hidden /> New agent</button>
          <Menu label="Start from a template" icon={ChevronDown} items={[{ label: 'Blank agent', icon: Plus, onSelect: () => setParams({ new: '1' }) }, ...templateItems.map((item, index) => ({ ...item, separator: index === 0 }))]} />
        </span>} />
      {loaded && agents.length === 0 && (
        <EmptyState icon={Users} title="No agents yet" action={<>{templates.slice(0, 2).map((template) => <button key={template.id} className="btn" onClick={() => void fromTemplate(template)}>Add {template.name}</button>)}<button className="btn primary" onClick={() => setParams({ new: '1' })}>New agent</button></>}>
          Start with a ready-made one, or make your own.
        </EmptyState>
      )}
      <div className="grid cards agent-cards">
        {agents.map((agent) => (
          <article key={agent.id} className="card agent-card" style={{ ['--accent' as string]: agent.accent }}>
            <button className="agent-open" onClick={() => open(agent)} aria-label={`Edit ${agent.name}`}>
              <Face agent={agent} size={40} />
              <span className="grow"><strong>{agent.emoji ? `${agent.emoji} ` : ''}{agent.name}</strong><span className="faint">{agent.title || agent.description || 'No title yet'}</span></span>
            </button>
            {agent.hidden && <span className="badge">hidden</span>}
            <Menu label={`Options for ${agent.name}`} items={[
              { label: 'Edit', icon: Pencil, onSelect: () => open(agent) },
              { label: 'Chat with it', icon: MessageSquare, onSelect: () => navigate(`/?persona=${agent.id}`) },
              { label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar', icon: agent.hidden ? Eye : EyeOff, separator: true, onSelect: () => void toggleHidden(agent) },
            ]} />
          </article>
        ))}
      </div>
    </div>
  );
}
