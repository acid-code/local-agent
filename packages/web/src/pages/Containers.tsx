import { useEffect, useState } from 'react';
import { Box, Globe, Image as ImageIcon, Package, Play, Plug, Shield, Trash2, Wrench, type LucideIcon } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { EmptyState, Menu, PageHeader } from '../components/ui';

type Role = 'search' | 'mcp' | 'tool' | 'sandbox' | 'image' | 'app';
interface Container { id: string; name: string; image: string; state: string; status: string; role: Role }
interface Agent { id: string; name: string }

const GROUPS: { role: Role; title: string; icon: LucideIcon; blurb: string }[] = [
  { role: 'search', title: 'Search', icon: Globe, blurb: 'SearXNG for web_search.' },
  { role: 'mcp', title: 'MCP servers', icon: Plug, blurb: 'One container per installed tool server.' },
  { role: 'sandbox', title: 'Sandboxes', icon: Shield, blurb: 'Each agent’s isolated shell. Only its workspace is mounted.' },
  { role: 'tool', title: 'Tools and voice', icon: Wrench, blurb: 'Short-lived tool runs, Whisper and Kokoro.' },
  { role: 'image', title: 'Image builds', icon: ImageIcon, blurb: 'Builds of the local image runner.' },
  { role: 'app', title: 'local-agent', icon: Package, blurb: 'The app itself (docker compose).' },
];

export function Containers() {
  const [containers, setContainers] = useState<Container[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);

  async function load() {
    const data = await api<{ available: boolean; containers: Container[] }>('/api/containers');
    setAvailable(data.available);
    setContainers(data.containers);
    setAgents((await api<{ agents: Agent[] }>('/api/agents')).agents);
  }
  useEffect(() => { void load().catch((error) => toast(errorText(error), 'error')); }, []);

  const remove = async (container: Container) => {
    if (!window.confirm(`Remove ${container.name}? It is stopped and deleted.`)) return;
    try { await api(`/api/containers/${container.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); await load(); toast(`Removed ${container.name}.`, 'ok'); }
    catch (error) { toast(errorText(error), 'error'); }
  };
  const sandbox = async (agent: Agent) => {
    try { await post('/api/containers/sandbox', { agentId: agent.id }); await load(); toast(`Sandbox for ${agent.name} is running.`, 'ok'); }
    catch (error) { toast(errorText(error), 'error'); }
  };

  return (
    <div className="page">
      <PageHeader title="Containers" description="Only containers local-agent started or owns are shown here. Other containers on this machine are never listed or touched."
        actions={available && agents.length > 0 ? <Menu text="Start a sandbox" icon={Play} className="btn small" label="Start a sandbox" items={agents.map((agent) => ({ label: agent.name, icon: Shield, onSelect: () => void sandbox(agent) }))} /> : undefined} />
      {available === false && <EmptyState icon={Box} title="Docker is not reachable">Shell falls back to a workspace jail and MCP servers stay off. Install Docker (or Docker Desktop with WSL integration) and restart local-agent.</EmptyState>}
      {available && containers.length === 0 && <EmptyState icon={Box} title="Nothing running yet">Start SearXNG from Setup, install an MCP server under Tools, or start a sandbox for an agent.</EmptyState>}
      {GROUPS.map((group) => {
        const rows = containers.filter((container) => container.role === group.role);
        if (!rows.length) return null;
        return (
          <section key={group.role} className="group-block">
            <h2 className="group-title"><group.icon size={14} aria-hidden /> {group.title} <span className="count">{rows.length}</span></h2>
            <p className="faint group-blurb">{group.blurb}</p>
            <div className="card item-list">
              {rows.map((container) => (
                <div key={container.id} className="item-row">
                  <span className={container.state === 'running' ? 'dot on' : 'dot'} aria-label={container.state} />
                  <span className="grow"><strong>{container.name || container.id.slice(0, 12)}</strong><span className="faint">{container.status || container.state} · <span className="mono">{container.image}</span></span></span>
                  {group.role !== 'app' && <button className="btn danger small" onClick={() => void remove(container)}><Trash2 size={14} aria-hidden /> Remove</button>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
