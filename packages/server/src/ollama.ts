export interface LoadedModel {
  name: string;
  contextLength: number | null;
  sizeBytes: number | null;
}

export function ollamaRoot() {
  return (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

export async function ollamaLoaded(fetchImpl: typeof fetch): Promise<LoadedModel[]> {
  try {
    const response = await fetchImpl(`${ollamaRoot()}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const json = await response.json() as { models?: { name?: string; model?: string; size?: number; context_length?: number }[] };
    return (json.models ?? []).map((model) => ({
      name: model.name || model.model || 'model',
      contextLength: typeof model.context_length === 'number' ? model.context_length : null,
      sizeBytes: typeof model.size === 'number' ? model.size : null,
    }));
  } catch {
    return [];
  }
}

export async function toolCapabilityWarnings(fetchImpl: typeof fetch, models: { name: string; apiName: string; local: boolean; embedding: boolean }[]): Promise<string[]> {
  const chat = models.filter((model) => model.local && !model.embedding);
  if (!chat.length) return [];
  const warnings: string[] = [];
  let unanswered = 0;
  await Promise.all(chat.map(async (model) => {
    try {
      const response = await fetchImpl(`${ollamaRoot()}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.apiName }),
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        unanswered += 1;
        return;
      }
      const json = await response.json() as { capabilities?: string[] };
      if (!Array.isArray(json.capabilities)) warnings.push(`${model.name}: Ollama did not list capabilities, so tool support is unknown.`);
      else if (!json.capabilities.includes('tools')) warnings.push(`${model.name} does not support tool calls.`);
    } catch {
      unanswered += 1;
    }
  }));
  if (unanswered === chat.length) return ['Ollama did not answer /api/show, so tool support for local chat models is unknown.'];
  if (unanswered) warnings.push(`${unanswered} local model${unanswered === 1 ? '' : 's'} did not answer /api/show.`);
  return warnings;
}

/** Ollama /api/show capabilities. null when Ollama did not answer or did not list them. */
export async function ollamaCapabilities(fetchImpl: typeof fetch, apiName: string, root = ollamaRoot()): Promise<{ capabilities: string[] | null; missing: boolean }> {
  try {
    const response = await fetchImpl(`${root}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: apiName }),
      signal: AbortSignal.timeout(2500),
    });
    if (response.status === 404) return { capabilities: null, missing: true };
    if (!response.ok) return { capabilities: null, missing: false };
    const json = await response.json() as { capabilities?: unknown };
    return { capabilities: Array.isArray(json.capabilities) ? json.capabilities.map(String) : null, missing: false };
  } catch {
    return { capabilities: null, missing: false };
  }
}

export function isToolUnsupportedError(message: string) {
  return /does not support tools/i.test(message);
}

export function isMissingModelError(message: string) {
  return /\(404\)/.test(message) && /not found|no such model|pull/i.test(message)
    || /model ['"][^'"]+['"] not found/i.test(message);
}
