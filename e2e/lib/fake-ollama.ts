/**
 * A scriptable stand-in for Ollama's HTTP API, so the real server code (provider, discovery, pulls, memory probes) runs
 * end to end without a GPU. The model's behaviour comes from the last user message:
 *   [[tool:NAME {json}]]  → asks for that tool once, then replies "Done: <tool result>"
 *   [[slow]]              → streams slowWords words 400 ms apart, then "Slow done."
 *   anything else         → "Echo: <text>"
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Msg { role: string; content?: string; tool_calls?: unknown[] }

export class FakeOllama {
  private server: http.Server | null = null;
  port = 0;
  models = ['qwen3:4b'];
  /** How many words a [[slow]] reply streams, 400 ms apart. */
  slowWords = 15;
  pullable: Record<string, number> = { 'llama3.2:1b': 1_300_000_000 };
  chats = 0;
  private sockets = new Set<import('node:net').Socket>();

  get url() { return `http://127.0.0.1:${this.port}`; }

  async start(port = this.port) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (socket) => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  /** Simulates Ollama crashing: closes the port and drops in-flight streams. */
  async stop() {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async body(req: http.IncomingMessage) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }

  // A tiny model (200 MB, 4 layers): the RAM gate admits it on any machine or CI runner.
  private tag(name: string) {
    return { name, model: name, size: 200_000_000, digest: 'sha256:fake', modified_at: new Date().toISOString(), details: { family: 'qwen3', parameter_size: '4B', quantization_level: 'Q4_K_M', format: 'gguf' } };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url || '/';
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url === '/api/version') return json(200, { version: '0.12.0' });
    if (url === '/api/tags') return json(200, { models: this.models.map((name) => this.tag(name)) });
    if (url === '/api/ps') return json(200, { models: [] });
    if (url === '/api/show') { const body = await this.body(req); return this.models.includes(body.model || body.name) ? json(200, { capabilities: ['completion', 'tools'], details: this.tag(body.model).details, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096, 'qwen3.block_count': 4, 'qwen3.attention.head_count': 4, 'qwen3.attention.head_count_kv': 2, 'qwen3.attention.key_length': 64 } }) : json(404, { error: 'model not found' }); }
    if (url === '/api/generate') { await this.body(req); return json(200, { done: true }); }
    if (url === '/api/embed') { const body = await this.body(req); const input = Array.isArray(body.input) ? body.input : [body.input]; return json(200, { embeddings: input.map((text: string) => vector(String(text))) }); }
    if (url === '/api/pull') {
      const body = await this.body(req);
      const name = body.name || body.model;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // Like real Ollama: an unknown model is a 200 stream that ends in an error line.
      if (!(name in this.pullable)) { res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`); res.end(`${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`); return; }
      const total = this.pullable[name]!;
      res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      for (const done of [0.25, 0.5, 1]) { await wait(120); res.write(`${JSON.stringify({ status: 'downloading', digest: 'sha256:x', total, completed: Math.round(total * done) })}\n`); }
      if (!this.models.includes(name)) this.models.push(name);
      res.end(`${JSON.stringify({ status: 'success' })}\n`);
      return;
    }
    if (url === '/api/chat') return this.chat(await this.body(req), res);
    json(404, { error: 'not found' });
  }

  private async chat(body: { model?: string; messages?: Msg[] }, res: http.ServerResponse) {
    this.chats += 1;
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((row) => row.role === 'user')?.content ?? '';
    const last = messages.at(-1);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const send = (message: Record<string, unknown>, done = false) => res.write(`${JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 40, eval_count: 12 } : {}) })}\n`);
    const tool = /\[\[tool:([a-z_]+)\s*(\{[\s\S]*?\})?\]\]/.exec(lastUser);
    if (tool && last?.role !== 'tool') {
      send({ tool_calls: [{ function: { name: tool[1], arguments: JSON.parse(tool[2] || '{}') } }] });
      send({}, true);
      return res.end();
    }
    if (last?.role === 'tool') {
      send({ content: `Done: ${String(last.content ?? '').slice(0, 200)}` });
      send({}, true);
      return res.end();
    }
    if (lastUser.includes('[[slow]]')) {
      for (let i = 0; i < this.slowWords && !res.destroyed; i += 1) { send({ content: `word${i} ` }); await wait(400); }
      send({ content: 'Slow done.' });
      send({}, true);
      return res.end();
    }
    const text = lastUser.split('\n').find((line) => line.trim())?.slice(0, 300) || 'hello';
    for (const word of `Echo: ${text}`.split(/(?<= )/)) send({ content: word });
    send({}, true);
    res.end();
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function vector(text: string) {
  const out = new Array(64).fill(0);
  for (let i = 0; i < text.length; i += 1) out[(text.charCodeAt(i) * 7 + i) % 64] += 1;
  const norm = Math.hypot(...out) || 1;
  return out.map((value) => value / norm);
}
