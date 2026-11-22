import type { ChatMessage, ToolCall, ToolDefinition } from '@local-agent/shared';
import type { ModelRow, ProviderRow } from './db.js';
import { isLlamaServerProvider } from './coexist.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Telemetry {
  tokPerSec?: number;
  promptTokens?: number;
  cachedTokens?: number;
  cacheHitPct?: number;
}

export type ProviderEvent =
  | { type: 'token'; text: string }
  /** Reasoning text from thinking models. Never part of the answer. */
  | { type: 'thinking'; text: string }
  | { type: 'done'; finishReason: string; toolCalls?: ToolCall[]; usage?: Usage; telemetry?: Telemetry };

export interface ModelProvider {
  complete(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    signal?: AbortSignal;
    paceMs?: number;
    /** Ollama context window. practicalBudget already includes the output reserve. */
    numCtx?: number;
    keepAlive?: string | number;
    think?: boolean;
    /** Send think:false explicitly. Used to retry a thinking model that gave no answer. */
    noThink?: boolean;
  }): AsyncIterable<ProviderEvent>;
}

/** The full practical budget, which already includes the output reserve, capped by the model's window. */
export function ollamaNumCtx(practicalBudget: number, outputReserve: number, contextWindow: number): number {
  const withReserve = practicalBudget >= outputReserve ? practicalBudget : practicalBudget + outputReserve;
  return Math.max(2048, Math.min(contextWindow, withReserve));
}

export class ScriptedProvider implements ModelProvider {
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly steps: Array<{ text?: string; toolCalls?: ToolCall[]; error?: Error }>) {}

  async *complete(req: { messages: ChatMessage[] }): AsyncIterable<ProviderEvent> {
    this.calls.push(req.messages);
    const step = this.steps.shift();
    if (!step) throw new Error('Scripted provider has no steps left.');
    if (step.error) throw step.error;
    if (step.text) yield { type: 'token', text: step.text };
    yield {
      type: 'done',
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
      toolCalls: step.toolCalls,
      usage: { inputTokens: 12, outputTokens: step.text?.length ?? 4 },
    };
  }
}

export function providerFor(model: ModelRow, provider: ProviderRow, fetchImpl: typeof fetch = fetch): ModelProvider {
  if (provider.kind === 'rehearsal' || model.profileId === 'rehearsal') return new RehearsalProvider();
  if (provider.kind === 'gemini') {
    const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
    if (!key) throw new Error(`Set ${provider.apiKeyEnv || 'GEMINI_API_KEY'} to call ${model.name}.`);
    return new GeminiProvider(key, fetchImpl);
  }
  const base = (provider.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
  if (provider.kind !== 'openrouter' && (provider.id === 'prov_ollama' || provider.name === 'Ollama' || /:11434(\/|$)/.test(base))) {
    return new OllamaProvider(base.replace(/\/v1$/, ''), fetchImpl);
  }
  // llama-server: keep the slot prefix cache on so a stable system prompt + tools are not re-prefilled each turn.
  const llama = isLlamaServerProvider(provider) || /uncensored|:8081(?:\/|$)/i.test(`${provider.name} ${provider.baseUrl || ''}`);
  const extra = llama ? { cache_prompt: true } : undefined;
  return new OpenAIProvider(base, key || '', fetchImpl, provider.kind === 'openrouter', extra, llama);
}

class OllamaProvider implements ModelProvider {
  constructor(private readonly root: string, private readonly fetchImpl: typeof fetch) {}

  async *complete(req: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal; numCtx?: number; keepAlive?: string | number; think?: boolean; noThink?: boolean }): AsyncIterable<ProviderEvent> {
    const response = await this.fetchImpl(`${this.root}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: req.messages.map(toOllama),
        tools: req.tools?.length ? req.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined,
        think: req.noThink ? false : req.think || undefined,
        keep_alive: req.keepAlive ?? '30m',
        options: { num_ctx: req.numCtx ?? 32768 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    yield* readOllama(response);
  }
}

/** First-token / headers timeout for llama-server (300s default so cold 16K–32K coding prefills never time out). */
export const LLAMA_TIMEOUT_MS = Number(process.env.LLAMA_TIMEOUT_MS || 300_000);
/** Slowest prompt-processing speed we plan for (tokens/s). Inkling measured ~41 t/s on the 780M, Qwen ~180 t/s. */
export const LLAMA_MIN_PREFILL_TPS = Number(process.env.LLAMA_MIN_PREFILL_TPS || 25);

/**
 * First-token timeout for one llama-server request. llama-server sends nothing until the whole prompt is processed,
 * so a fixed 300 s cut off a 16K-token uncensored prompt (386 s at 41 t/s) and the turn failed as "stuck".
 * Scale with the prompt size instead (rough 3.2 chars per token), never below LLAMA_TIMEOUT_MS.
 */
export function llamaFirstTokenTimeoutMs(payloadChars: number): number {
  const tokens = payloadChars / 3.2;
  return Math.max(LLAMA_TIMEOUT_MS, Math.round(60_000 + (tokens / Math.max(1, LLAMA_MIN_PREFILL_TPS)) * 1000));
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class OpenAIProvider implements ModelProvider {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
    private readonly openRouter: boolean,
    private readonly extra?: Record<string, unknown>,
    private readonly isLlama = false,
  ) {}

  async *complete(req: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal }): AsyncIterable<ProviderEvent> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.openRouter) {
      headers['http-referer'] = 'http://local-agent.local';
      headers['x-title'] = 'local-agent';
    }
    const payload = JSON.stringify({
      model: req.model,
      stream: true,
      messages: req.messages.map(toOpenAI),
      tools: req.tools?.length ? req.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined,
      ...this.extra,
    });
    const maxAttempts = this.isLlama ? 4 : 1;
    const retryMs = Number(process.env.LA_LLAMA_503_RETRY_MS ?? 4000);
    let response: Response | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Explicit 300s first-token / headers timeout for llama-server so cold 16K–32K prefills succeed.
      const timeoutCtrl = this.isLlama ? new AbortController() : null;
      const firstTokenMs = llamaFirstTokenTimeoutMs(payload.length);
      const timer = timeoutCtrl ? setTimeout(() => timeoutCtrl.abort(new Error(`llama-server gave no first token after ${Math.round(firstTokenMs / 1000)}s (prompt about ${Math.round(payload.length / 3200)}K tokens). It may be overloaded or stuck; your chat is kept.`)), firstTokenMs) : null;
      const signal = timeoutCtrl
        ? (req.signal ? AbortSignal.any([req.signal, timeoutCtrl.signal]) : timeoutCtrl.signal)
        : req.signal;
      try {
        response = await this.fetchImpl(`${this.base}/chat/completions`, {
          method: 'POST',
          headers,
          signal,
          body: payload,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (response.status === 503 && attempt < maxAttempts) {
        await response.text().catch(() => '');
        await waitAbortable(retryMs, req.signal);
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error(`Model request failed (${response?.status ?? 0}): ${(response ? await response.text() : 'no response').slice(0, 500)}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const json = await response.json() as OpenAIResponse;
      yield* fromOpenAI(json);
      return;
    }
    yield* readSSE(response);
  }
}

class GeminiProvider implements ModelProvider {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch) {}

  async *complete(req: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal }): AsyncIterable<ProviderEvent> {
    const system = req.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const contents = req.messages.filter((message) => message.role !== 'system').map(toGemini);
    const response = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents,
          tools: req.tools?.length ? [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] : undefined,
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    let text = '';
    const toolCalls: ToolCall[] = [];
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Gemini returned an empty body.');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, '');
        if (!data || data === '[DONE]' || !data.startsWith('{')) continue;
        const json = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args?: unknown } }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
        for (const part of json.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            text += part.text;
            yield { type: 'token', text: part.text };
          }
          if (part.functionCall) {
            toolCalls.push({ id: `gem_${part.functionCall.name}_${toolCalls.length}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
          }
        }
        if (json.usageMetadata && (json.usageMetadata.promptTokenCount || json.usageMetadata.candidatesTokenCount)) {
          yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls, usage: { inputTokens: json.usageMetadata.promptTokenCount ?? 0, outputTokens: json.usageMetadata.candidatesTokenCount ?? 0 } };
          return;
        }
      }
    }
    yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls };
    void text;
  }
}

export async function countGeminiTokens(apiKey: string, model: string, text: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: text.slice(0, 200_000) }] }] }),
    });
    if (!response.ok) return null;
    const json = await response.json() as { totalTokens?: number };
    return json.totalTokens ?? null;
  } catch {
    return null;
  }
}

class RehearsalProvider implements ModelProvider {
  async *complete(req: { messages: ChatMessage[]; tools?: ToolDefinition[]; paceMs?: number }): AsyncIterable<ProviderEvent> {
    const last = req.messages.at(-1);
    const pace = req.paceMs ?? 0;
    if (last?.role === 'tool') {
      const text = `Done. The tool returned:\n\n${last.content.slice(0, 1600)}`;
      yield* paceText(text, pace);
      yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: text.length / 4 } };
      return;
    }
    const user = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const names = new Set((req.tools ?? []).map((tool) => tool.name));
    const call = pickTool(user, names);
    if (call) {
      yield { type: 'done', finishReason: 'tool_calls', toolCalls: [call], usage: { inputTokens: 16, outputTokens: 8 } };
      return;
    }
    const text = rehearsalText(user);
    yield* paceText(text, pace);
    yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 16, outputTokens: Math.ceil(text.length / 4) } };
  }
}

function pickTool(user: string, names: Set<string>): ToolCall | null {
  const search = user.match(/\bsearch(?: for)?\s+(.+)/i);
  if (search && names.has('web_search')) return call('web_search', { query: search[1]!.trim() });
  if (/\b(list|ls)\b.*\b(files|dir|workspace)\b/i.test(user) && names.has('list_dir')) return call('list_dir', { path: '.' });
  const read = user.match(/\bread\s+(\S+)/i);
  if (read && names.has('read_file')) return call('read_file', { path: read[1] });
  const remember = user.match(/\bremember\s+(.+)/i);
  if (remember && names.has('remember')) return call('remember', { content: remember[1]!.trim() });
  const shell = user.match(/\b(?:run|shell)\s+`([^`]+)`/i) || user.match(/\bshell:\s*(.+)/i);
  if (shell && names.has('shell')) return call('shell', { command: (shell[1] || '').trim() });
  if (/\bdocker\s+ps\b/i.test(user) && names.has('docker_ps')) return call('docker_ps', {});
  const ask = user.match(/\bask\s+@?([\w.-]+)\s+(.+)/i);
  if (ask && names.has('consult_agent')) return call('consult_agent', { agent: ask[1], question: ask[2] });
  return null;
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `reh_${name}`, name, arguments: JSON.stringify(args) };
}

function rehearsalText(user: string): string {
  const snippet = user.trim().slice(0, 240) || 'an empty note';
  return `Rehearsal model here. I can stream, call tools, and leave a trace, but I am not a language model.\n\nYou said: “${snippet}”\n\nConnect Ollama (or another OpenAI-compatible server) in Setup, or enable Gemini with GEMINI_API_KEY. Try “list files”, “search the docs”, or “remember that the mini PC has 48 GB”.`;
}

async function* paceText(text: string, paceMs: number): AsyncIterable<ProviderEvent> {
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs));
    yield { type: 'token', text: part };
  }
}

function toOllama(message: ChatMessage) {
  if (message.role === 'tool') return { role: 'tool', content: message.content };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.toolCalls.map((tool) => ({ type: 'function', function: { name: tool.name, arguments: safeJson(tool.arguments) } })),
    };
  }
  if (message.role === 'user' && message.imageUrl) {
    return { role: 'user', content: message.content, images: [message.imageUrl.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')] };
  }
  return { role: message.role, content: message.content };
}

interface OllamaChunk {
  error?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  message?: { content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
}

async function* readOllama(response: Response): AsyncIterable<ProviderEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Ollama returned an empty body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: Usage | undefined;
  const toolCalls: ToolCall[] = [];
  const take = (json: OllamaChunk) => {
    if (json.error) throw new Error(json.error);
    if (json.message?.content) return json.message.content;
    return '';
  };
  const collectTools = (json: OllamaChunk) => {
    for (const tool of json.message?.tool_calls ?? []) {
      const name = tool.function?.name || '';
      if (!name) continue;
      const args = tool.function?.arguments;
      toolCalls.push({ id: `ollama_${name}_${toolCalls.length}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
    }
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.trim();
      if (!data.startsWith('{')) continue;
      const json = JSON.parse(data) as OllamaChunk;
      const text = take(json);
      if (json.message?.thinking) yield { type: 'thinking', text: json.message.thinking };
      if (text) yield { type: 'token', text };
      // Newer Ollama streams tool calls in a chunk before the final done chunk.
      collectTools(json);
      if (json.done) usage = { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 };
    }
  }
  if (buffer.trim().startsWith('{')) {
    const json = JSON.parse(buffer) as OllamaChunk;
    const text = take(json);
    if (json.message?.thinking) yield { type: 'thinking', text: json.message.thinking };
    if (text) yield { type: 'token', text };
    collectTools(json);
    if (json.done) usage = { inputTokens: json.prompt_eval_count ?? usage?.inputTokens ?? 0, outputTokens: json.eval_count ?? usage?.outputTokens ?? 0 };
  }
  yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls, usage };
}

function toOpenAI(message: ChatMessage) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return { role: 'assistant', content: message.content || null, tool_calls: message.toolCalls.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: safeJsonString(tool.arguments) } })) };
  }
  if (message.role === 'user' && message.imageUrl) {
    return { role: 'user', content: [{ type: 'text', text: message.content }, { type: 'image_url', image_url: { url: message.imageUrl } }] };
  }
  return { role: message.role, content: message.content };
}

function safeJsonString(value: string): string {
  try {
    JSON.parse(value);
    return value;
  } catch {
    return JSON.stringify({ _malformed_arguments: (value || '').slice(0, 400) });
  }
}

function toGemini(message: ChatMessage) {
  if (message.role === 'tool') {
    return { role: 'user', parts: [{ functionResponse: { name: message.name || 'tool', response: { result: message.content } } }] };
  }
  if (message.toolCalls?.length) {
    return { role: 'model', parts: message.toolCalls.map((tool) => ({ functionCall: { name: tool.name, args: safeJson(tool.arguments) } })) };
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content || '' }] };
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

interface LlamaTimings {
  predicted_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  prompt_n?: number;
  cache_n?: number;
}

function parseTimings(t?: LlamaTimings): Telemetry | undefined {
  if (!t) return undefined;
  const tokPerSec = typeof t.predicted_per_second === 'number' && Number.isFinite(t.predicted_per_second)
    ? Math.round(t.predicted_per_second * 10) / 10
    : (t.predicted_n && t.predicted_ms ? Math.round((t.predicted_n / (t.predicted_ms / 1000)) * 10) / 10 : undefined);
  const promptN = typeof t.prompt_n === 'number' ? t.prompt_n : 0;
  const cacheN = typeof t.cache_n === 'number' ? t.cache_n : 0;
  const totalPrompt = promptN + cacheN;
  const cacheHitPct = totalPrompt > 0 ? Math.round((cacheN / totalPrompt) * 100) : undefined;
  if (tokPerSec == null && cacheHitPct == null) return undefined;
  return { tokPerSec, promptTokens: totalPrompt || undefined, cachedTokens: cacheN || undefined, cacheHitPct };
}

interface OpenAIChunk {
  choices?: { finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: LlamaTimings;
}

interface OpenAIResponse {
  choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: LlamaTimings;
}

function* fromOpenAI(json: OpenAIResponse): Generator<ProviderEvent> {
  const message = json.choices?.[0]?.message;
  const reasoning = message?.reasoning_content || message?.reasoning;
  if (reasoning) yield { type: 'thinking', text: reasoning };
  if (message?.content) yield { type: 'token', text: message.content };
  const toolCalls = (message?.tool_calls ?? []).map((tool) => ({ id: tool.id || `call_${tool.function?.name}`, name: tool.function?.name || '', arguments: tool.function?.arguments || '{}' })).filter((tool) => tool.name);
  yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls, usage: json.usage ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 } : undefined, telemetry: parseTimings(json.timings) };
}

async function* readSSE(response: Response): AsyncIterable<ProviderEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty model stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  const tools = new Map<number, ToolCall>();
  let usage: Usage | undefined;
  let telemetry: Telemetry | undefined;
  let sawEnd = false;
  let finishReason = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, '');
      if (data === '[DONE]') { sawEnd = true; continue; }
      if (!data || !data.startsWith('{')) continue;
      const json = JSON.parse(data) as OpenAIChunk;
      const choice = json.choices?.[0];
      if (choice?.finish_reason) { sawEnd = true; finishReason = choice.finish_reason; }
      const delta = choice?.delta;
      const reasoning = delta?.reasoning_content || delta?.reasoning;
      if (reasoning) yield { type: 'thinking', text: reasoning };
      if (delta?.content) yield { type: 'token', text: delta.content };
      for (const tool of delta?.tool_calls ?? []) {
        const index = tool.index ?? 0;
        const current = tools.get(index) ?? { id: '', name: '', arguments: '' };
        if (tool.id) current.id = tool.id;
        if (tool.function?.name) current.name += tool.function.name;
        if (tool.function?.arguments) current.arguments += tool.function.arguments;
        tools.set(index, current);
      }
      if (json.usage) usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
      if (json.timings) telemetry = parseTimings(json.timings) ?? telemetry;
    }
  }
  if (!sawEnd) throw new Error('Model stream ended unexpectedly (server disconnected mid-reply).');
  const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, tool]) => ({ ...tool, id: tool.id || `call_${tool.name}` })).filter((tool) => tool.name);
  yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : (finishReason || 'stop'), toolCalls, usage, telemetry };
}
