import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';

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

  async function load() {
    setCollections((await api<{ collections: Collection[] }>('/api/kb/collections')).collections);
    setAgents((await api<{ agents: Agent[] }>('/api/agents')).agents);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <h1>Library</h1>
      <p className="lede">Drop PDF, DOCX, Markdown, text, HTML, or code. Collections are shared, or kept to one persona. Search mixes a local embedding with BM25 and cites the passage.</p>
      <form className="card" onSubmit={async (event) => {
        event.preventDefault();
        const created = await post<{ collection: Collection }>('/api/kb/collections', { name, agentId: agentId || null });
        setActive(created.collection.id);
        setName('Notes');
        await load();
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
      {collections.map((collection) => (
        <article key={collection.id} className="card">
          <h3>{collection.name}</h3>
          <p className="muted">{collection.agentId ? 'One persona' : 'Shared'} · {collection.documents} files · {collection.chunks} chunks · {collection.bytes} bytes · {collection.embedder}</p>
          <div className="row">
            <button className="btn" onClick={() => setActive(collection.id)}>{active === collection.id ? 'Selected' : 'Use this one'}</button>
            {collection.rootPath && <button className="btn" onClick={async () => { await post(`/api/kb/collections/${collection.id}/reindex`, {}); setNote('Re-indexed.'); await load(); }}>Re-index folder</button>}
          </div>
        </article>
      ))}
      {active && (
        <form className="card" onSubmit={async (event) => {
          event.preventDefault();
          const input = (event.currentTarget.elements.namedItem('files') as HTMLInputElement).files;
          if (!input?.length) return;
          const files = await Promise.all([...input].map(async (file) => ({ name: file.name, contentBase64: await toBase64(file) })));
          const result = await post<{ results: { name: string; skipped: boolean; chunks: number }[] }>(`/api/kb/collections/${active}/files`, { files });
          setNote(result.results.map((file) => `${file.name}: ${file.skipped ? 'unchanged' : `${file.chunks} chunks`}`).join(' · '));
          await load();
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
