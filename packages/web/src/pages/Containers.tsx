import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Container { id: string; name: string; image: string; state: string; status: string }
interface Agent { id: string; name: string }

export function Containers() {
  const [containers, setContainers] = useState<Container[]>([]);
  const [available, setAvailable] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);

  async function load() {
    const data = await api<{ available: boolean; containers: Container[] }>('/api/containers');
    setAvailable(data.available);
    setContainers(data.containers);
    setAgents((await api<{ agents: Agent[] }>('/api/agents')).agents);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Containers</h1>
      <p className="lede">{available ? 'Docker is reachable. Sandboxes mount only that persona’s workspace.' : 'The Docker socket is not visible. Shell falls back to a workspace jail, and MCP servers stay off.'}</p>
      <div className="grid cards">
        {agents.map((agent) => (
          <button key={agent.id} className="btn" onClick={async () => { await post('/api/containers/sandbox', { agentId: agent.id }); await load(); }}>Sandbox for {agent.name}</button>
        ))}
      </div>
      {containers.map((container) => (
        <article key={container.id} className="card">
          <h3>{container.name || container.id.slice(0, 12)}</h3>
          <p className="faint">{container.state} · {container.image}</p>
          <button className="btn danger" onClick={async () => { await api(`/api/containers/${container.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); await load(); }}>Remove</button>
        </article>
      ))}
    </div>
  );
}
