/**
 * A real MCP client for stdio servers (which here always run in their own container).
 * MCP stdio is newline-delimited JSON-RPC; older servers that frame with Content-Length are understood too.
 */
export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }
export interface McpCallResult { text: string; isError: boolean }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class McpClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private framed = false;
  serverInfo: { name?: string; version?: string } = {};
  stderrTail = '';

  constructor(private readonly stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream, stderr?: NodeJS.ReadableStream, private readonly onClose?: (reason: string) => void) {
    stdout.on('data', (chunk: Buffer) => this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    stdout.on('end', () => this.close('The server closed its output.'));
    stdout.on('close', () => this.close('The server exited.'));
    stdout.on('error', (error: Error) => this.close(error.message));
    stderr?.on('data', (chunk: Buffer) => { this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000); });
  }

  get alive() { return !this.closed; }

  private push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const text = this.buffer.subarray(0, Math.min(this.buffer.length, 32)).toString('utf8');
      if (/^Content-Length:/i.test(text)) {
        this.framed = true;
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString('utf8'))?.[1] ?? 0);
        if (this.buffer.length < end + 4 + length) return;
        const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
        this.buffer = this.buffer.subarray(end + 4 + length);
        this.handle(body);
        continue;
      }
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.handle(line);
    }
  }

  private handle(raw: string) {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { message?: string; code?: number } };
    try { message = JSON.parse(raw); } catch { return; } // servers sometimes log to stdout; skip non-JSON lines
    if (message.method && message.id != null) {
      // Server-to-client requests (roots/list, sampling, ping): answer politely so the server doesn't hang.
      const result = message.method === 'ping' ? {} : message.method === 'roots/list' ? { roots: [] } : undefined;
      this.write(result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported by this client.' } });
      return;
    }
    if (message.id == null) return; // notifications
    const waiter = this.pending.get(Number(message.id));
    if (!waiter) return;
    this.pending.delete(Number(message.id));
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message || `MCP error ${message.error.code ?? ''}`.trim()));
    else waiter.resolve(message.result);
  }

  private write(message: unknown) {
    const body = JSON.stringify(message);
    this.stdin.write(this.framed ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The MCP server is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer);
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Stopped by the user.' } });
        reject(new Error('Stopped.'));
      }, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown = {}) { if (!this.closed) this.write({ jsonrpc: '2.0', method, params }); }

  async initialize(timeoutMs = 60_000) {
    const result = await this.request<{ serverInfo?: { name?: string; version?: string } }>('initialize', {
      protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'local-agent', version: '0.9.0' },
    }, timeoutMs);
    this.serverInfo = result?.serverInfo ?? {};
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<{ tools?: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000): Promise<McpCallResult> {
    const result = await this.request<{ content?: { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]; structuredContent?: unknown; isError?: boolean }>('tools/call', { name, arguments: args }, timeoutMs, signal);
    const parts = (result?.content ?? []).map((part) => part.type === 'text' ? part.text ?? ''
      : part.type === 'resource' ? (part.resource?.text ?? `[resource ${part.resource?.uri ?? ''}]`)
      : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ''}]`);
    if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    return { text: parts.join('\n').slice(0, 24_000) || '(no output)', isError: Boolean(result?.isError) };
  }

  close(reason = 'Closed.') {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error(`The MCP server stopped: ${reason}`)); this.pending.delete(id); }
    this.onClose?.(reason);
  }
}

/** Tool names agents see: mcp_<server>_<tool>, safe characters, at most 64 long. */
export function mcpToolName(server: string, tool: string) {
  const slug = (text: string) => text.toLowerCase().replace(/^.*\//, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `mcp_${slug(server).slice(0, 20)}_${slug(tool)}`.slice(0, 64);
}
