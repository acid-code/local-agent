import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { EmptyState, PageHeader } from '../components/ui';
import { Plus, Zap } from 'lucide-react';
import { t } from '../i18n';

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
  const [adding, setAdding] = useState(false);

  async function load() {
    setRows((await api<{ triggers: Trigger[] }>('/api/triggers')).triggers);
    const list = (await api<{ agents: Agent[] }>('/api/agents')).agents;
    setAgents(list);
    if (!agentId && list[0]) setAgentId(list[0].id);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <PageHeader title={t('Triggers')} description={t('Start a run from an event: a webhook, a GitHub push, a file in a folder, or new mail. The event becomes the message.')} actions={<button className="btn primary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><Plus size={16} aria-hidden />{' '}{t('New trigger')}</button>} />
      {adding && (
      <form className="card section" onSubmit={async (event) => {
        event.preventDefault();
        const config = kind === 'folder' ? { path, debounceMs: 1500 } : kind === 'imap' ? { host, userSecret, passwordSecret, mailbox: 'INBOX' } : {};
        const result = await post<{ url: string | null; secret: string }>('/api/triggers', { name, kind, agentId, prompt, config });
        setCreated(result);
        await load(); setAdding(false);
      }}>
        <label className="field"><span>{t('Persona')}</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field"><span>{t('Name')}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>{t('Kind')}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="webhook">{t('Webhook')}</option>
            <option value="github">{t('GitHub')}</option>
            <option value="folder">{t('Folder')}</option>
            <option value="imap">{t('IMAP inbox')}</option>
          </select>
        </label>
        {kind === 'folder' && <label className="field"><span>{t('Folder')}</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/asaf/inbox" /></label>}
        {kind === 'imap' && (
          <>
            <label className="field"><span>{t('Host')}</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" /></label>
            <label className="field"><span>{t('Vault user')}</span><input value={userSecret} onChange={(event) => setUserSecret(event.target.value)} /></label>
            <label className="field"><span>{t('Vault password')}</span><input value={passwordSecret} onChange={(event) => setPasswordSecret(event.target.value)} /></label>
          </>
        )}
        <label className="field"><span>{t('Prompt')}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <button className="btn primary">{t('Create trigger')}</button>
      </form>
      )}
      {!adding && rows.length === 0 && <EmptyState icon={Zap} title={t('No triggers yet')} action={<button className="btn primary" onClick={() => setAdding(true)}>{t('New trigger')}</button>}>{t('A trigger turns an outside event into a normal run with checkpoints, like a webhook from CI.')}</EmptyState>}
      {created && (
        <article className="card">
          <p>{t('Secret, shown once:')}{' '}<span className="mono">{created.secret}</span></p>
          {created.url && <p className="mono">{t('POST')}{' '}{created.url}</p>}
          <p className="muted">{t('Send the secret as X-Local-Agent-Secret. GitHub uses the same value as the webhook secret, and the signature header is checked.')}</p>
        </article>
      )}
      {rows.map((row) => (
        <article key={row.id} className="card">
          <h3>{row.name}</h3>
          <p className="muted">{row.kind} · {row.status}{row.lastError ? ` · ${row.lastError}` : ''}</p>
          {row.kind === 'webhook' && <p className="mono">/api/hooks/{row.id}</p>}
          {row.kind === 'github' && <p className="mono">/api/hooks/github/{row.id}</p>}
          {row.events.map((item) => <p key={item.id} className="faint">{item.createdAt} · {item.summary} · {item.runId || t('no run')}</p>)}
          <button className="btn" onClick={async () => { await post(`/api/triggers/${row.id}/test`, { event: { test: true } }); await load(); }}>{t('Test fire')}</button>
        </article>
      ))}
    </div>
  );
}
