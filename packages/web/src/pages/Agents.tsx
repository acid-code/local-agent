import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Agent { id: string; name: string; description: string; systemPrompt: string; routing: string; toolAllowlist: string[]; workspacePath: string }
interface Template { id: string; name: string; description: string; systemPrompt: string; tools: string[] }

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('You are a careful local agent.');

  async function load() {
    const data = await api<{ agents: Agent[]; templates: Template[] }>('/api/agents');
    setAgents(data.agents);
    setTemplates(data.templates);
  }
  useEffect(() => { void load(); }, []);

  async function fromTemplate(template: Template) {
    await post('/api/agents', { name: template.name, description: template.description, systemPrompt: template.systemPrompt, toolAllowlist: template.tools, template: template.id });
    await load();
  }

  return (
    <div className="page">
      <h1>Personas</h1>
      <p className="lede">Each persona keeps its own prompt, model, tools, memory, and workspace. Two is enough to start: one to operate the box, one to research.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        {templates.map((template) => <button key={template.id} className="btn" onClick={() => fromTemplate(template)}>Add {template.name}</button>)}
      </div>
      <div className="grid cards">
        {agents.map((agent) => (
          <article key={agent.id} className="card">
            <h3>{agent.name}</h3>
            <p className="muted">{agent.description}</p>
            <p className="mono faint">{agent.workspacePath}</p>
            <p className="faint">{agent.routing} · {agent.toolAllowlist.join(', ')}</p>
          </article>
        ))}
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={async (event) => { event.preventDefault(); await post('/api/agents', { name, systemPrompt: prompt, toolAllowlist: ['read_file', 'remember', 'recall'] }); setName(''); await load(); }}>
        <h3>Custom persona</h3>
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label className="field"><span>System prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <button className="btn primary" type="submit">Create</button>
      </form>
    </div>
  );
}
