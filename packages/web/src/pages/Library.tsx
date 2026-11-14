import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { EmptyState, PageHeader } from '../components/ui';
import { FileText, Library as LibraryIcon, Plus } from 'lucide-react';
import { humanSize, rawUrl, type FileMeta } from '../lib/files';

interface KbFile { id: string; name: string; bytes: number }

interface Collection { id: string; name: string; agentId: string | null; rootPath: string | null; embedder: string; documents: number; bytes: number; chunks: number }
interface Agent { id: string; name: string }
interface Hit { collection: string; document: string; path: string | null; heading: string; text: string; score: number }

async function toBase64(file: File) {
  const data = await file.arrayBuffer();
  const bytes = new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface ChatRow { id: string; title: string }

/** Files from chats, both ways: what you uploaded and what personas produced. Filter by chat and direction. */
function ChatFiles() {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [chat, setChat] = useState('');
  const [source, setSource] = useState<'' | 'upload' | 'agent'>('');
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  useEffect(() => { api<{ sessions: ChatRow[] }>('/api/sessions?limit=200').then((data) => setChats(data.sessions)).catch(() => setChats([])); }, []);
  useEffect(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (chat) params.set('sessionId', chat);
    if (source) params.set('source', source);
    setFiles(null);
    api<{ files: FileMeta[] }>(`/api/files?${params}`).then((data) => setFiles(data.files)).catch(() => setFiles([]));
  }, [chat, source]);
  const title = new Map(chats.map((row) => [row.id, row.title]));
  return (
    <section className="card chat-files" aria-label="Chat files">
      <div className="row chat-files-head">
        <h3 className="grow">Chat files</h3>
        <select aria-label="Chat" value={chat} onChange={(event) => setChat(event.target.value)}>
          <option value="">All chats</option>
          {chats.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select>
        <div className="seg" role="group" aria-label="Direction">
          {([['', 'All'], ['upload', 'From you'], ['agent', 'From agents']] as const).map(([value, label]) => <button key={value} type="button" className={source === value ? 'on' : ''} aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>)}
        </div>
      </div>
      {files === null ? <div className="skeleton-lines"><span /></div> : files.length === 0 ? <p className="faint">No files here yet.</p> : (
        <ul className="pane-list">
          {files.map((file) => (
            <li key={file.id}>
              <FileText size={14} aria-hidden />
              <a className="grow ellipsis" href={rawUrl(file.id)} target="_blank" rel="noreferrer">{file.name}</a>
              <span className="faint">{file.source === 'upload' ? 'from you' : 'from agent'}</span>
              {!chat && file.sessionId && <span className="faint ellipsis chat-files-chat">{title.get(file.sessionId) || ''}</span>}
              <span className="faint mono">{humanSize(file.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Library() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('Notes');
  const [agentId, setAgentId] = useState('');
  const [folder, setFolder] = useState('');
  const [active, setActive] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<KbFile[]>([]);
  const [adding, setAdding] = useState(false);

  async function load() {
    setCollections((await api<{ collections: Collection[] }>('/api/kb/collections')).collections);
    setAgents((await api<{ agents: Agent[] }>('/api/agents')).agents);
  }
  useEffect(() => { void load(); }, []);
  async function loadFiles(id = active) {
    setFiles(id ? (await api<{ files: KbFile[] }>(`/api/kb/collections/${id}/files`)).files : []);
  }
  useEffect(() => { void loadFiles(); }, [active]);
  async function run(action: () => Promise<void>) {
    try { await action(); } catch (error) { setNote(error instanceof Error ? error.message : 'Failed.'); }
  }

  return (
    <div className="page">
      <PageHeader title="Library" description="Documents your personas can search and cite: PDF, DOCX, Markdown, text, HTML or code. Collections are shared or kept to one persona." actions={<button className="btn primary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><Plus size={16} aria-hidden /> New collection</button>} />
      {adding && (
      <form className="card section" onSubmit={async (event) => {
        event.preventDefault();
        const created = await post<{ collection: Collection }>('/api/kb/collections', { name, agentId: agentId || null });
        setActive(created.collection.id);
        setName('Notes');
        await load(); setAdding(false);
      }}>
        <label className="field"><span>Collection</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Scope</span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">Shared</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <button className="btn primary">Create collection</button>
      </form>
      )}
      <ChatFiles />
      {!adding && collections.length === 0 && <EmptyState icon={LibraryIcon} title="No collections yet" action={<button className="btn primary" onClick={() => setAdding(true)}>New collection</button>}>Create a collection, then drop files into it. Answers cite the passage they came from.</EmptyState>}
      {collections.map((collection) => (
        <article key={collection.id} className="card">
          <h3>{collection.name}</h3>
          <p className="muted">{collection.agentId ? 'One persona' : 'Shared'} · {collection.documents} files · {collection.chunks} chunks · {collection.bytes} bytes · {collection.embedder}</p>
          <div className="row">
            <button className="btn" onClick={() => setActive(collection.id)}>{active === collection.id ? 'Selected' : 'Use this one'}</button>
            {collection.rootPath && <button className="btn" onClick={async () => { await post(`/api/kb/collections/${collection.id}/reindex`, {}); setNote('Re-indexed.'); await load(); }}>Re-index folder</button>}
            <button className="btn" onClick={() => run(async () => {
              if (!window.confirm(`Delete ${collection.name} and its ${collection.documents} files from the index?`)) return;
              await api(`/api/kb/collections/${collection.id}`, { method: 'DELETE' });
              if (active === collection.id) setActive('');
              setNote(`Deleted ${collection.name}.`);
              await load();
            })}>Delete</button>
          </div>
          {active === collection.id && files.map((file) => (
            <p key={file.id} className="row faint">{file.name} · {file.bytes} bytes
              <button className="btn" onClick={() => run(async () => { await api(`/api/kb/collections/${collection.id}/files/${file.id}`, { method: 'DELETE' }); setNote(`Removed ${file.name}.`); await load(); await loadFiles(); })}>Remove</button>
            </p>
          ))}
        </article>
      ))}
      {active && (
        <form className="card" onSubmit={async (event) => {
          event.preventDefault();
          const input = (event.currentTarget.elements.namedItem('files') as HTMLInputElement).files;
          if (!input?.length) return;
          const files = await Promise.all([...input].map(async (file) => ({ name: file.name, contentBase64: await toBase64(file) })));
          await run(async () => {
            const result = await post<{ results: { name: string; skipped?: boolean; chunks?: number; error?: string }[] }>(`/api/kb/collections/${active}/files`, { files });
            setNote(result.results.map((file) => `${file.name}: ${file.error || (file.skipped ? 'unchanged' : `${file.chunks} chunks`)}`).join(' · '));
          });
          await load();
          await loadFiles();
        }}>
          <h3>Drop files</h3>
          <input name="files" type="file" multiple accept=".pdf,.docx,.md,.txt,.html,.htm,.ts,.tsx,.js,.py,.go,.rs,.json,.yml,.yaml" />
          <button className="btn primary">Index</button>
          <label className="field"><span>Or a folder on this machine</span><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/home/asaf/notes" /></label>
          <button className="btn" type="button" onClick={async () => { await post(`/api/kb/collections/${active}/folder`, { path: folder }); setNote('Folder indexed. Changes are picked up on the next re-index.'); await load(); }}>Index folder</button>
        </form>
      )}
      <form className="card" onSubmit={async (event) => { event.preventDefault(); setHits((await post<{ hits: Hit[] }>('/api/kb/search', { query, collectionId: active || undefined })).hits); }}>
        <label className="field"><span>Try a query</span><input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="btn">Search</button>
      </form>
      {note && <p className="muted">{note}</p>}
      {hits.map((hit) => (
        <article key={`${hit.document}-${hit.heading}-${hit.text.slice(0, 24)}`} className="card">
          <p className="mono faint">{hit.collection} · {hit.path || hit.document}{hit.heading ? ` · ${hit.heading}` : ''}</p>
          <p>{hit.text}</p>
        </article>
      ))}
    </div>
  );
}
