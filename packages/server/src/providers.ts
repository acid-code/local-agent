import type { ChatMessage, ToolCall, ToolDefinition } from '@local-agent/shared';
import type { ModelRow, ProviderRow } from './db.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; finishReason: string; toolCalls?: ToolCall[]; usage?: Usage };

export interface ModelProvider {
  complete(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    signal?: AbortSignal;
    paceMs?: number;
  }): AsyncIterable<ProviderEvent>;
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
  return new OpenAIProvider(base, key || '', fetchImpl, provider.kind === 'openrouter');
}

class OpenAIProvider implements ModelProvider {
  constructor(private readonly base: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch, private readonly openRouter: boolean) {}

  async *complete(req: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal }): AsyncIterable<ProviderEvent> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.openRouter) {
      headers['http-referer'] = 'http://local-agent.local';
      headers['x-title'] = 'local-agent';
    }
    const response = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: req.messages.map(toOpenAI),
        tools: req.tools?.length ? req.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined,
      }),
    });
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
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

function toOpenAI(message: ChatMessage) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return { role: 'assistant', content: message.content || null, tool_calls: message.toolCalls.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) };
  }
  if (message.role === 'user' && message.imageUrl) {
    return { role: 'user', content: [{ type: 'text', text: message.content }, { type: 'image_url', image_url: { url: message.imageUrl } }] };
  }
  return { role: message.role, content: message.content };
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

interface OpenAIChunk {
  choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIResponse {
  choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function* fromOpenAI(json: OpenAIResponse): Generator<ProviderEvent> {
  const message = json.choices?.[0]?.message;
  if (message?.content) yield { type: 'token', text: message.content };
  const toolCalls = (message?.tool_calls ?? []).map((tool) => ({ id: tool.id || `call_${tool.function?.name}`, name: tool.function?.name || '', arguments: tool.function?.arguments || '{}' })).filter((tool) => tool.name);
  yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls, usage: json.usage ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 } : undefined };
}

async function* readSSE(response: Response): AsyncIterable<ProviderEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty model stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  const tools = new Map<number, ToolCall>();
  let usage: Usage | undefined;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, '');
      if (!data || !data.startsWith('{')) continue;
      const json = JSON.parse(data) as OpenAIChunk;
      const delta = json.choices?.[0]?.delta;
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
    }
  }
  const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, tool]) => ({ ...tool, id: tool.id || `call_${tool.name}` })).filter((tool) => tool.name);
  yield { type: 'done', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls, usage };
}
