import { useEffect, useRef, useState } from 'react';
import { api, post } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { Face, type FaceAgent } from '../components/Face';

interface Session { id: string; title: string; agentId: string | null; mode: 'chat' | 'code'; workshopId?: string | null }
interface ProjectDraft { label: string; path: string }
interface Agent extends FaceAgent { id: string; name: string }
interface Message { id: string; role: string; content: string; agentId?: string | null; toolName?: string | null; routingNote?: string | null; toolCalls?: { name: string }[] | null }
interface Step { id: string; kind: string; name: string; status: string; latencyMs?: number; output?: unknown; error?: string | null }
interface Plan { id: string; items: { id: string; text: string; status: string }[] }
interface Edit { id: string; label: string; diff: string; revertedAt: string | null }
interface Offer { id: string; kind: string; masked: string }

export function Chat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [secret, setSecret] = useState<{ id: string; name: string; reason: string } | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const [projects, setProjects] = useState<ProjectDraft[]>([{ label: 'server', path: '' }, { label: 'apk', path: '' }]);
  const [shopName, setShopName] = useState('Server and app');
  const [shopNote, setShopNote] = useState('');
  const [rail, setRail] = useState(false);
  const [trace, setTrace] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  async function refreshLists() {
    const [sessionRes, agentRes] = await Promise.all([
      api<{ sessions: Session[] }>('/api/sessions'),
      api<{ agents: Agent[] }>('/api/agents'),
    ]);
    setSessions(sessionRes.sessions);
    setAgents(agentRes.agents);
    return sessionRes.sessions;
  }

  async function openSession(id: string) {
    setCurrent(id);
    const data = await api<{ session: Session; messages: Message[]; plan: Plan | null; edits: Edit[] }>(`/api/sessions/${id}`);
    setMessages(data.messages);
    setPlan(data.plan);
    setEdits(data.edits);
    setMode(data.session.mode);
    setStreaming('');
    if (data.session.agentId) await post(`/api/agents/${data.session.agentId}/read`, {}).catch(() => undefined);
  }

  useEffect(() => {
    const share = new URLSearchParams(window.location.search).get('share');
    if (share) setDraft(share);
    const persona = new URLSearchParams(window.location.search).get('persona');
    refreshLists().then(async (rows) => {
      if (persona) {
        const existing = rows.find((session) => session.agentId === persona);
        if (existing) await openSession(existing.id);
        else {
          const created = await post<{ session: Session }>('/api/sessions', { agentId: persona, title: 'New chat' });
          await openSession(created.session.id);
        }
        await post(`/api/agents/${persona}/read`, {});
        return;
      }
      if (rows[0]) void openSession(rows[0].id);
    }).catch(() => undefined);
  }, []);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages, streaming]);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        setSteps(data.steps || []);
        setStatus(data.run?.status || '');
      }
      if (data.type === 'token') setStreaming((value) => value + data.text);
      if (data.type === 'step' && data.step) setSteps((value) => [...value.filter((step) => step.id !== data.step.id), data.step]);
      if (data.type === 'message') {
        setMessages((value) => [...value, data.message]);
        setStreaming('');
      }
      if (data.type === 'status') setStatus(data.status);
      if (data.type === 'secret' && data.request) setSecret(data.request);
      if (data.type === 'done') {
        setStatus(data.run?.status || 'completed');
        if (current) void openSession(current);
        source.close();
      }
    };
    return () => source.close();
  }, [runId]);

  async function createWorkshop(event: { preventDefault(): void }) {
    event.preventDefault();
    const filled = projects.filter((project) => project.path.trim());
    try {
      const created = await post<{ session: Session }>('/api/workshops', { name: shopName, projects: filled });
      setShopNote('');
      await refreshLists();
      await openSession(created.session.id);
    } catch (error) {
      setShopNote(error instanceof Error ? error.message : 'Could not open the workshop.');
    }
  }

  async function createChat(nextMode: 'chat' | 'code') {
    if (!agents[0]) return;
    const created = await post<{ session: Session }>('/api/sessions', { agentId: agents[0].id, mode: nextMode, title: nextMode === 'code' ? 'Coding session' : 'New chat' });
    await refreshLists();
    await openSession(created.session.id);
  }

  async function send(event?: { preventDefault(): void }) {
    event?.preventDefault();
    if (!current || !draft.trim()) return;
    const content = draft;
    setDraft('');
    setMessages((value) => [...value, { id: 'local', role: 'user', content }]);
    const agentId = sessions.find((session) => session.id === current)?.agentId || agents[0]?.id;
    const result = await post<{ run: { id: string }; offers: Offer[] }>(`/api/sessions/${current}/messages`, { content, agentId });
    setOffers(result.offers || []);
    setRunId(result.run.id);
    setStatus('running');
    setTrace(true);
  }

  async function holdTalk(start: boolean) {
    if (start) {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        setVoiceNote(error instanceof Error ? error.message : 'Microphone unavailable.');
        return;
      }
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const response = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const data = await response.json();
        if (!response.ok) setVoiceNote(data.error || 'Voice is not available.');
        else setDraft((value) => `${value} ${data.text || ''}`.trim());
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } else {
      recorder.current?.stop();
      setRecording(false);
    }
  }

  async function control(action: string) {
    if (!runId) return;
    await post(`/api/runs/${runId}/control`, { action });
  }

  return (
    <div className="chat">
      <aside className={rail ? 'rail open' : 'rail'}>
        <div className="row">
          <button className="btn" onClick={() => createChat('chat')}>New chat</button>
          <button className="btn" onClick={() => createChat('code')}>Code</button>
        </div>
        <form className="card" onSubmit={createWorkshop}>
          <strong>Workshop</strong>
          <p className="faint">Several projects in one coding chat. The turn goes to a model that can code.</p>
          <input value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Name" />
          {projects.map((project, index) => (
            <div key={project.label + index} className="row">
              <input value={project.label} onChange={(event) => setProjects((rows) => rows.map((row, i) => i === index ? { ...row, label: event.target.value } : row))} placeholder="label" />
              <input value={project.path} onChange={(event) => setProjects((rows) => rows.map((row, i) => i === index ? { ...row, path: event.target.value } : row))} placeholder="/home/asaf/src/server" />
            </div>
          ))}
          <div className="row">
            <button className="btn" type="button" onClick={() => setProjects((rows) => [...rows, { label: '', path: '' }])}>Add project</button>
            <button className="btn primary" type="submit">Open workshop</button>
          </div>
          {shopNote && <p className="muted">{shopNote}</p>}
        </form>
        {sessions.map((session) => (
          <button key={session.id} className={session.id === current ? 'session-item active' : 'session-item'} onClick={() => openSession(session.id)}>
            <strong>{session.title}</strong>
            <div className="faint">{session.workshopId ? 'Workshop' : session.mode === 'code' ? 'Coding' : 'Chat'}</div>
          </button>
        ))}
        {agents.length < 2 && <p className="muted">Create two personas under Agents. The house operator and the researcher are one click each.</p>}
      </aside>
      <section className="thread">
        <div className="row" style={{ padding: '10px 16px' }}>
          <button className="btn ghost" onClick={() => setRail((value) => !value)}>Chats</button>
          <button className="btn ghost" onClick={() => setTrace((value) => !value)}>Trace</button>
          {status && <span className="badge">{status}</span>}
          {mode === 'code' && <span className="badge warn">{sessions.find((session) => session.id === current)?.workshopId ? 'workshop' : 'coding'}</span>}
        </div>
        <div className="messages" ref={box}>
          {messages.length === 0 && (
            <div className="card">
              <h3>The workshop is quiet.</h3>
              <p className="muted">With no model connected, Rehearsal still streams and calls tools. Try “list files” or “remember that this box has 48 GB”.</p>
              <div className="row">
                {['list files', 'remember that this box has 48 GB', 'search local agents'].map((prompt) => (
                  <button key={prompt} className="btn" onClick={() => setDraft(prompt)}>{prompt}</button>
                ))}
              </div>
            </div>
          )}
          {offers.length > 0 && (
            <div className="banner">
              A key-shaped string was moved out of the message. Save it in the vault?
              {offers.map((offer) => (
                <button key={offer.id} className="btn" onClick={async () => { await post(`/api/vault/captures/${offer.id}/accept`, { name: 'PASTED_KEY' }); setOffers((value) => value.filter((item) => item.id !== offer.id)); }}>{offer.kind} {offer.masked}</button>
              ))}
            </div>
          )}
          {secret && (
            <form className="banner" onSubmit={async (event) => { event.preventDefault(); await post(`/api/secret-requests/${secret.id}`, { value: secretValue }); setSecret(null); setSecretValue(''); }}>
              <strong>Secret needed: {secret.name}</strong>
              <p className="muted">{secret.reason} The model will only see a handle.</p>
              <input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="Paste the key" />
              <div className="row">
                <button className="btn primary" type="submit">Save and resume</button>
                <button className="btn danger" type="button" onClick={async () => { await post(`/api/secret-requests/${secret.id}`, { deny: true }); setSecret(null); }}>Deny</button>
              </div>
            </form>
          )}
          {messages.map((message) => {
            const speaker = message.agentId ? agents.find((agent) => agent.id === message.agentId) : undefined;
            const fromAgent = message.role !== 'user' && speaker;
            return (
            <article key={message.id} className={message.role === 'user' ? 'msg user' : fromAgent ? 'msg from-agent' : 'msg'} style={fromAgent ? { ['--accent' as string]: speaker.accent || '#e4b56a' } : undefined}>
              {fromAgent ? <div className="who"><Face agent={speaker} size={28} /><span className="meta">{speaker.emoji ? `${speaker.emoji} ` : ''}{speaker.name}{message.toolName ? ` · ${message.toolName}` : ''}</span></div> : <div className="meta"><span>{message.role}</span>{message.toolName && <span className="mono">{message.toolName}</span>}</div>}
              {message.routingNote && <div className="switch">{message.routingNote}</div>}
              {message.role === 'tool' ? <pre className="mono">{message.content}</pre> : <Markdown text={message.content} />}
            </article>
            );
          })}
          {streaming && <article className="msg"><Markdown text={streaming} streaming /></article>}
          {mode === 'code' && plan && (
            <div className="card">
              <h3>Plan</h3>
              {plan.items.map((item) => (
                <label key={item.id} className="row">
                  <input type="checkbox" checked={item.status === 'done'} onChange={async (event) => { await api(`/api/plan-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.checked ? 'done' : 'pending' }) }); if (current) void openSession(current); }} />
                  <span>{item.text}</span>
                </label>
              ))}
            </div>
          )}
          {mode === 'code' && edits.map((edit) => (
            <div key={edit.id} className="card">
              <div className="row"><strong>{edit.label}</strong>{edit.revertedAt ? <span className="badge">reverted</span> : <button className="btn" onClick={async () => { await post(`/api/edits/${edit.id}/revert`); if (current) void openSession(current); }}>Revert checkpoint</button>}</div>
              <pre className="command">{edit.diff}</pre>
            </div>
          ))}
        </div>
        <div className="composer">
          <form onSubmit={send}>
            <textarea value={draft} placeholder={mode === 'code' ? 'Ask for a plan, then an edit…' : 'Message'} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event); } }} />
            {voiceNote && <p className="faint">{voiceNote}</p>}
            <button className="btn" type="button" onPointerDown={() => void holdTalk(true)} onPointerUp={() => void holdTalk(false)}>{recording ? 'Listening' : 'Hold to talk'}</button>
            {status === 'running' ? <button className="btn danger" type="button" onClick={() => control('stop')}>Stop</button> : <button className="btn primary" type="submit">Send</button>}
            {status === 'running' && <button className="btn" type="button" onClick={() => control('pause')}>Pause</button>}
          </form>
        </div>
      </section>
      <aside className={trace ? 'trace open' : 'trace'}>
        <h3>Trace</h3>
        <p className="faint">Every model call and tool call lands here, with the arguments the model actually sent.</p>
        {steps.map((step) => (
          <div key={step.id} className="step">
            <div className="row"><span className={`dot ${step.status === 'completed' ? 'ok' : step.status === 'failed' ? 'bad' : 'live'}`} /><strong>{step.kind}</strong> <span className="muted">{step.name}</span></div>
            <div className="faint">{step.status}{step.latencyMs ? ` · ${step.latencyMs} ms` : ''}</div>
            {step.error && <div className="badge bad">{step.error}</div>}
          </div>
        ))}
      </aside>
    </div>
  );
}
