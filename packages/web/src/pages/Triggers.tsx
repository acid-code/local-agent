import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

interface Agent { id: string; name: string }
interface EventRow { id: string; status: string; summary: string; createdAt: string; runId: string | null }
interface Trigger {
  id: string; name: string; kind: string; prompt: string; enabled: boolean; status: string; lastError: string | null;
  config: { path?: string; host?: string; debounceMs?: number };
  events: EventRow[];
}

export function Triggers() {
  const [rows, setRows] = useState<Trigger[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('Inbox');
  const [kind, setKind] = useState('webhook');
  const [prompt, setPrompt] = useState('Read this event and tell me if I should do anything.\n\n{{event}}');
  const [path, setPath] = useState('');
  const [host, setHost] = useState('');
  const [userSecret, setUserSecret] = useState('IMAP_USER');
  const [passwordSecret, setPasswordSecret] = useState('IMAP_PASSWORD');
  const [created, setCreated] = useState<{ url: string | null; secret: string } | null>(null);

  async function load() {
    setRows((await api<{ triggers: Trigger[] }>('/api/triggers')).triggers);
    const list = (await api<{ agents: Agent[] }>('/api/agents')).agents;
    setAgents(list);
    if (!agentId && list[0]) setAgentId(list[0].id);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Triggers</h1>
      <p className="lede">A trigger starts a normal run. The event is the user message, and the run uses the same checkpoints as a chat. Webhook and GitHub URLs are on this box, so Tailscale can reach them. The inbox poll only examines the mailbox. It never sends mail.</p>
      <form className="card" onSubmit={async (event) => {
        event.preventDefault();
        const config = kind === 'folder' ? { path, debounceMs: 1500 } : kind === 'imap' ? { host, userSecret, passwordSecret, mailbox: 'INBOX' } : {};
        const result = await post<{ url: string | null; secret: string }>('/api/triggers', { name, kind, agentId, prompt, config });
        setCreated(result);
        await load();
      }}>
        <label className="field"><span>Persona</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="webhook">Webhook</option>
            <option value="github">GitHub</option>
            <option value="folder">Folder</option>
            <option value="imap">IMAP inbox</option>
          </select>
        </label>
        {kind === 'folder' && <label className="field"><span>Folder</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/asaf/inbox" /></label>}
        {kind === 'imap' && (
          <>
            <label className="field"><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" /></label>
            <label className="field"><span>Vault user</span><input value={userSecret} onChange={(event) => setUserSecret(event.target.value)} /></label>
            <label className="field"><span>Vault password</span><input value={passwordSecret} onChange={(event) => setPasswordSecret(event.target.value)} /></label>
          </>
        )}
        <label className="field"><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <button className="btn primary">Create trigger</button>
      </form>
      {created && (
        <article className="card">
          <p>Secret, shown once: <span className="mono">{created.secret}</span></p>
          {created.url && <p className="mono">POST {created.url}</p>}
          <p className="muted">Send the secret as X-Local-Agent-Secret. GitHub uses the same value as the webhook secret, and the signature header is checked.</p>
        </article>
      )}
      {rows.map((row) => (
        <article key={row.id} className="card">
          <h3>{row.name}</h3>
          <p className="muted">{row.kind} · {row.status}{row.lastError ? ` · ${row.lastError}` : ''}</p>
          {row.kind === 'webhook' && <p className="mono">/api/hooks/{row.id}</p>}
          {row.kind === 'github' && <p className="mono">/api/hooks/github/{row.id}</p>}
          {row.events.map((item) => <p key={item.id} className="faint">{item.createdAt} · {item.summary} · {item.runId || 'no run'}</p>)}
          <button className="btn" onClick={async () => { await post(`/api/triggers/${row.id}/test`, { event: { test: true } }); await load(); }}>Test fire</button>
        </article>
      ))}
    </div>
  );
}
