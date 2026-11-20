import { inDockerContainer, type DockerCtl } from './docker.js';
import type { MemoryBudget } from './memory.js';
import { isHebrewText, scriptStats } from '@local-agent/shared';
import { OCR_CONTAINER, OCR_DOCKERFILE, OCR_IMAGE, OCR_PORT, OCR_SERVER, PIPER_CONTAINER, PIPER_DOCKERFILE, PIPER_IMAGE, PIPER_PORT, PIPER_SERVER } from './service-images.js';

/**
 * OCR for photos and handwriting in English and Hebrew.
 * Printed text: Tesseract (eng+heb) in local-agent's own container, after EXIF rotation, grayscale and deskew (HEIC too).
 * Handwriting: a vision model — Gemini when a key is set and the account may use it, else a local Ollama vision
 * model admitted through the RAM budget. Auto mode tries Tesseract first and hands low-confidence results to vision.
 */
export const OCR_URL = process.env.OCR_URL || (inDockerContainer() ? `http://${OCR_CONTAINER}:8080` : `http://127.0.0.1:${OCR_PORT}`);
export const PIPER_URL = process.env.PIPER_URL || (inDockerContainer() ? `http://${PIPER_CONTAINER}:8080` : `http://127.0.0.1:${PIPER_PORT}`);

const resolvedUrls: Partial<Record<ServiceId, string>> = {};

export function serviceUrlCandidates(id: ServiceId): string[] {
  const envUrl = id === 'ocr' ? process.env.OCR_URL : process.env.PIPER_URL;
  const container = id === 'ocr' ? OCR_CONTAINER : PIPER_CONTAINER;
  const port = id === 'ocr' ? OCR_PORT : PIPER_PORT;
  const list = inDockerContainer()
    ? [envUrl, `http://${container}:8080`, `http://host.docker.internal:${port}`, `http://127.0.0.1:${port}`]
    : [envUrl, `http://127.0.0.1:${port}`, `http://host.docker.internal:${port}`, `http://${container}:8080`];
  return [...new Set(list.filter((u): u is string => Boolean(u)).map((u) => u.replace(/\/$/, '')))];
}

export async function resolveServiceUrl(fetchImpl: typeof fetch, id: ServiceId): Promise<{ url: string; health: Record<string, unknown> } | null> {
  const cached = resolvedUrls[id];
  const candidates = cached ? [cached, ...serviceUrlCandidates(id).filter((u) => u !== cached)] : serviceUrlCandidates(id);
  for (const url of candidates) {
    const health = await serviceUp(fetchImpl, url);
    if (health) {
      resolvedUrls[id] = url;
      return { url, health };
    }
  }
  return null;
}

/** Attach already-running managed service containers to the app's Docker network so bridge containers can reach them by name. */
export async function ensureManagedContainersNetwork(docker: DockerCtl): Promise<void> {
  if (!docker.available()) return;
  const net = await docker.detectAppNetwork();
  if (!net) return;
  for (const name of ['local-agent-searxng', OCR_CONTAINER, PIPER_CONTAINER]) {
    await docker.connectToNetwork(name, net).catch(() => false);
  }
}

export type OcrMode = 'auto' | 'printed' | 'handwriting';
export interface TesseractResult { text: string; confidence: number; words: number; lowWords?: number; ms: number }
export interface VisionResult { text: string; model: string; ms: number }
export interface OcrResult {
  text: string; engine: 'tesseract' | 'vision'; model?: string; confidence: number | null; mode: OcrMode;
  direction: 'rtl' | 'ltr' | 'mixed'; lang: 'he' | 'en' | 'mixed' | 'unknown'; ms: number; notes: string[];
}

export interface OcrRunners {
  tesseract: ((image: Buffer, opts: { lang: string; psm?: number }) => Promise<TesseractResult>) | null;
  vision: ((image: Buffer, prompt: string) => Promise<VisionResult>) | null;
}

/** Below this mean word confidence (0-100), or with fewer letters than this, auto mode asks the vision model. */
export const LOW_CONFIDENCE = 60;
const MIN_LETTERS = 6;

export const VISION_PROMPT = 'Transcribe all text in this image exactly as written, including handwriting. The text may be Hebrew, English or both: keep each word in its own language and script, and keep line breaks. Do not translate, explain or add anything. If there is no text, reply with an empty line.';

export function directionOf(text: string): OcrResult['direction'] {
  const { hebrew, latin } = scriptStats(text);
  if (!hebrew && !latin) return 'ltr';
  if (hebrew && latin && Math.min(hebrew, latin) / Math.max(hebrew, latin) > 0.15) return 'mixed';
  return hebrew > latin ? 'rtl' : 'ltr';
}

function langOf(text: string): OcrResult['lang'] {
  const { hebrew, latin } = scriptStats(text);
  if (!hebrew && !latin) return 'unknown';
  const dir = directionOf(text);
  return dir === 'mixed' ? 'mixed' : isHebrewText(text) ? 'he' : 'en';
}

function letters(text: string) { return (text.match(/\p{L}/gu) ?? []).length; }

/** Strip what vision models wrap around a transcription. */
export function cleanVision(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```[a-z]*\n?|\n?```$/g, '').replace(/^(?:here is the (?:text|transcription)[^:\n]*:|transcription:)\s*/i, '').trim();
}

/** Route one image. Runners are injected so tests can fake Tesseract and the vision model. */
export async function recognize(image: Buffer, opts: { mode?: OcrMode; lang?: string }, runners: OcrRunners): Promise<OcrResult> {
  const mode = opts.mode ?? 'auto';
  const lang = opts.lang || 'eng+heb';
  const started = Date.now();
  const notes: string[] = [];
  const tidy = (text: string) => text.replace(/[\u200e\u200f]/g, '');
  const done = (raw: string, engine: OcrResult['engine'], confidence: number | null, model?: string): OcrResult => {
    const text = tidy(raw).trim();
    return { text, engine, model, confidence, mode, direction: directionOf(text), lang: langOf(text), ms: Date.now() - started, notes };
  };
  const viaVision = async (why: string) => {
    if (!runners.vision) return null;
    notes.push(why);
    const result = await runners.vision(image, VISION_PROMPT);
    return done(cleanVision(result.text), 'vision', null, result.model);
  };

  if (mode === 'handwriting') {
    const result = await viaVision('Handwriting: read by a vision model.').catch((error) => { notes.push(`Vision model failed: ${(error as Error).message}`); return null; });
    if (result) return result;
    if (!runners.tesseract) throw new Error('No OCR engine is available. Start the OCR service on the Containers page, or add a Gemini key.');
    notes.push('No vision model is available, so Tesseract read it; handwriting may come out wrong.');
    const printed = await runners.tesseract(image, { lang });
    return done(printed.text, 'tesseract', printed.confidence);
  }

  if (!runners.tesseract) {
    if (mode === 'printed') throw new Error('The OCR service is not running. Start it on the Containers page.');
    const result = await viaVision('The OCR service is not running; a vision model read it.');
    if (result) return result;
    throw new Error('No OCR engine is available. Start the OCR service on the Containers page, or add a Gemini key.');
  }
  const printed = await runners.tesseract(image, { lang });
  if (mode === 'printed') return done(printed.text, 'tesseract', printed.confidence);
  // Handwriting often gets a fair mean confidence with many junk words, so a high share of unsure words counts too.
  const unsure = printed.words ? (printed.lowWords ?? 0) / printed.words : 0;
  const weak = printed.confidence < LOW_CONFIDENCE || letters(printed.text) < MIN_LETTERS || unsure > 0.3;
  if (!weak) return done(printed.text, 'tesseract', printed.confidence);
  try {
    const result = await viaVision(`Tesseract was unsure (confidence ${Math.round(printed.confidence)}, ${Math.round(unsure * 100)}% unsure words), so a vision model read it.`);
    if (result && letters(result.text) >= Math.min(letters(printed.text), MIN_LETTERS)) return result;
  } catch (error) {
    notes.push(`Vision model failed: ${(error as Error).message}. Kept the Tesseract text.`);
  }
  if (!runners.vision) notes.push('Low confidence and no vision model is available (add a Gemini key or pull a vision model).');
  return done(printed.text, 'tesseract', printed.confidence);
}

// ── Real runners ─────────────────────────────────────────────────────────────

export async function serviceUp(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() as Record<string, unknown> : null;
  } catch { return null; }
}

export function tesseractRunner(fetchImpl: typeof fetch, url = OCR_URL): NonNullable<OcrRunners['tesseract']> {
  return async (image, opts) => {
    const response = await fetchImpl(`${url}/ocr?lang=${encodeURIComponent(opts.lang)}&psm=${opts.psm ?? 3}`, { method: 'POST', body: new Uint8Array(image), headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(150_000) });
    const json = await response.json() as TesseractResult & { error?: string };
    if (!response.ok) throw new Error(json.error || `OCR failed (HTTP ${response.status}).`);
    return json;
  };
}

/** Auto-oriented JPEG (and HEIC decoded) for vision models, when the OCR service is up. */
export async function prepareForVision(fetchImpl: typeof fetch, image: Buffer, url = OCR_URL): Promise<Buffer> {
  try {
    const response = await fetchImpl(`${url}/prepare`, { method: 'POST', body: new Uint8Array(image), signal: AbortSignal.timeout(60_000) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch { /* send the original */ }
  return image;
}

export function geminiVisionRunner(fetchImpl: typeof fetch, key: string, model = process.env.OCR_GEMINI_MODEL || 'gemini-2.5-flash'): NonNullable<OcrRunners['vision']> {
  return async (image, prompt) => {
    const started = Date.now();
    const jpeg = await prepareForVision(fetchImpl, image);
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: jpeg.toString('base64') } }] }], generationConfig: { temperature: 0 } }),
    });
    const json = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
    if (!response.ok) throw new Error(json.error?.message || `Gemini vision failed (HTTP ${response.status}).`);
    return { text: json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '', model: model, ms: Date.now() - started };
  };
}

/** Vision models local-agent knows. Lightweight models (<=4 GiB) are preferred when llama-server holds the GPU. */
export const LOCAL_VISION_MODELS = ['qwen2.5vl:7b', 'qwen2.5vl:3b', 'gemma3:12b', 'gemma3:4b', 'llama3.2-vision:11b', 'minicpm-v:8b'];
export const LIGHTWEIGHT_VISION_MODELS = ['qwen2.5vl:3b', 'gemma3:4b', 'qwen2.5vl:7b'];

export async function pickLocalVision(fetchImpl: typeof fetch, root: string, preferred?: string, preferLightweight = false): Promise<string | null> {
  try {
    const response = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const names = ((await response.json()) as { models?: { name: string }[] }).models?.map((row) => row.name) ?? [];
    if (preferred && names.includes(preferred)) return preferred;
    const list = preferLightweight ? LIGHTWEIGHT_VISION_MODELS : LOCAL_VISION_MODELS;
    return list.find((name) => names.includes(name)) ?? LOCAL_VISION_MODELS.find((name) => names.includes(name)) ?? null;
  } catch { return null; }
}

export function ollamaVisionRunner(fetchImpl: typeof fetch, root: string, model: string, memory?: MemoryBudget | null): NonNullable<OcrRunners['vision']> {
  return async (image, prompt) => {
    const started = Date.now();
    const jpeg = await prepareForVision(fetchImpl, image);
    const numCtx = 4096;
    const bytes = memory ? await memory.estimateModel(model, numCtx) : 0;
    // Same admission queue as chat: waits for room under the RAM budget, refuses when it can never fit.
    const lease = memory && bytes ? await memory.admit({ kind: 'background', label: `${model} (OCR)`, model, bytes }) : null;
    try {
      const response = await fetchImpl(`${root}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0, num_ctx: numCtx }, messages: [{ role: 'user', content: prompt, images: [jpeg.toString('base64')] }] }),
      });
      const json = await response.json() as { message?: { content?: string }; error?: string };
      if (!response.ok) throw new Error(json.error || `Ollama vision failed (HTTP ${response.status}).`);
      return { text: json.message?.content || '', model, ms: Date.now() - started };
    } finally { lease?.release(); }
  };
}

// ── The app's own service containers ─────────────────────────────────────────

export type ServiceId = 'ocr' | 'piper';
export const SERVICES: Record<ServiceId, { image: string; container: string; port: number; dockerfile: string; server: string; title: string; detail: string }> = {
  ocr: { image: OCR_IMAGE, container: OCR_CONTAINER, port: OCR_PORT, dockerfile: OCR_DOCKERFILE, server: OCR_SERVER, title: 'OCR (Tesseract, English + Hebrew)', detail: 'Reads text from photos and scans: EXIF rotation, deskew, HEIC.' },
  piper: { image: PIPER_IMAGE, container: PIPER_CONTAINER, port: PIPER_PORT, dockerfile: PIPER_DOCKERFILE, server: PIPER_SERVER, title: 'Piper voices (Hebrew + English)', detail: 'Local text-to-speech with a Hebrew voice (Kokoro has none).' },
};

export async function serviceStatus(docker: DockerCtl, fetchImpl: typeof fetch, id: ServiceId) {
  const spec = SERVICES[id];
  const available = docker.available();
  const [image, container, found] = await Promise.all([
    available ? docker.hasImage(spec.image).catch(() => false) : false,
    available ? docker.containerState(spec.container).catch(() => null) : null,
    resolveServiceUrl(fetchImpl, id),
  ]);
  return { id, title: spec.title, detail: spec.detail, image: spec.image, port: spec.port, downloaded: image, container, healthy: Boolean(found?.health), health: found?.health ?? null, url: found?.url ?? null };
}

/** Download-ahead: build the image from the Dockerfile shipped in the app (no third-party image to trust). */
export async function buildService(docker: DockerCtl, id: ServiceId, log: (line: string) => void) {
  const spec = SERVICES[id];
  log(`building ${spec.image}\n`);
  await docker.build(spec.image, [{ name: 'Dockerfile', content: spec.dockerfile }, { name: 'server.py', content: spec.server }], (line) => log(`${line}\n`), { 'local-agent.role': id });
  log(`built ${spec.image}\n`);
}

export async function startService(docker: DockerCtl, id: ServiceId, log: (line: string) => void) {
  const spec = SERVICES[id];
  if (!(await docker.hasImage(spec.image))) await buildService(docker, id, log);
  const net = await docker.detectAppNetwork();
  const container = await docker.startDetached({
    Image: spec.image, name: spec.container, replace: true,
    network: net,
    Labels: { 'local-agent.role': id, 'local-agent.watch': '1' },
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(spec.port) }] }, RestartPolicy: { Name: 'unless-stopped' }, Memory: (id === 'ocr' ? 1024 : 1536) * 1024 * 1024 },
  });
  delete resolvedUrls[id];
  log(`started ${container.slice(0, 12)} on 127.0.0.1:${spec.port}${net ? ` (network ${net})` : ''}\n`);
}

export const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|bmp|gif)$/i;

export interface OcrDeps { fetchImpl: typeof fetch; memory?: MemoryBudget | null; ollamaRoot: string; cloudAllowed: boolean; geminiKey?: string; visionModel?: string; preferLightweight?: boolean }

/** Real runners for this account: Tesseract when the service answers; Gemini vision (if allowed and keyed), else a local vision model. */
export async function liveRunners(deps: OcrDeps): Promise<OcrRunners> {
  const ocrFound = await resolveServiceUrl(deps.fetchImpl, 'ocr');
  const tesseract = ocrFound ? tesseractRunner(deps.fetchImpl, ocrFound.url) : null;
  let vision: OcrRunners['vision'] = null;
  if (deps.cloudAllowed && deps.geminiKey) vision = geminiVisionRunner(deps.fetchImpl, deps.geminiKey);
  else {
    const model = await pickLocalVision(deps.fetchImpl, deps.ollamaRoot, deps.visionModel, Boolean(deps.preferLightweight));
    if (model) vision = ollamaVisionRunner(deps.fetchImpl, deps.ollamaRoot, model, deps.memory);
  }
  return { tesseract, vision };
}

export const UNDERSTAND_IMAGE_PROMPT = `Analyze this image thoroughly and return a structured visual breakdown:
1. **Scene & Subjects**: Full description of what is shown, objects, people, spatial layout, composition, and context.
2. **Colors, Shades & Lighting**: Dominant colors and shades with approximate hex codes (e.g. #1E293B) and rough visual percentages, lighting/contrast, and mood/style.
3. **Numbers, Charts, UI & Structure**: Any visible numbers, metrics, axes, tables, diagrams, icons, buttons, or counts.
4. **Visible Text (OCR)**: Exact transcription of any printed or handwritten text (English, Hebrew, or other languages) preserving layout.
Be concrete, observant, and accurate — do not invent details not visible in the image.`;

export interface ImageAnalysisResult {
  description: string;
  model: string;
  ms: number;
}

/** Full multimodal visual understanding of an image (scene, colors/shades, numbers/charts, and text). */
export async function understandImage(image: Buffer, runners: OcrRunners, question?: string): Promise<ImageAnalysisResult> {
  if (!runners.vision) {
    throw new Error('No vision model is available right now. Pull a local vision model like gemma3:4b in Ollama (or set GEMINI_API_KEY).');
  }
  const prompt = question?.trim()
    ? `${UNDERSTAND_IMAGE_PROMPT}\n\nAlso specifically answer this question about the image:\n${question.trim()}`
    : UNDERSTAND_IMAGE_PROMPT;
  const res = await runners.vision(image, prompt);
  return { description: res.text.trim(), model: res.model, ms: res.ms };
}

/** Agent tool: full multimodal vision understanding (scene, colors/shades/hex, numbers/charts, layout, and text). */
export function understandImageTool(analyze: (fileId: string, question: string | undefined, ownerId: string) => Promise<ImageAnalysisResult>): import('./tools.js').Tool {
  return {
    name: 'understand_image',
    description: 'Inspect and deeply understand an image file (photo, screenshot, chart, diagram, design, slide). Returns a full structured description of the scene, objects, layout, colors/shades with approximate hex codes and percentages, numbers/charts/UI details, and visible text. Pass file_id from a [file:<id>] reference and an optional specific question.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Image file id from [file:<id>].' },
        question: { type: 'string', description: 'Optional specific visual question to focus on (e.g., color palette, chart values, UI bug, layout details).' },
      },
      required: ['file_id'],
      additionalProperties: false,
    },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const res = await analyze(String(args.file_id || '').replace(/^file:/, ''), args.question ? String(args.question) : undefined, ctx.agent.ownerId || 'owner');
      return `Vision model: ${res.model} (${(res.ms / 1000).toFixed(1)}s)\n\n${res.description || '(empty response)'}`;
    },
  };
}

/** Agent tool: read the text in an image file the user shared (printed or handwritten, English or Hebrew). */
export function ocrTool(read: (fileId: string, mode: OcrMode, ownerId: string) => Promise<OcrResult>): import('./tools.js').Tool {
  return {
    name: 'read_image_text',
    description: 'Read the text in an image file (photo, scan, screenshot, handwriting) in English and/or Hebrew. Pass the file id from a [file:<id>] reference. mode "auto" uses Tesseract and falls back to a vision model when unsure; use "handwriting" for handwritten notes. Returns the text, the engine used and its confidence.',
    parameters: { type: 'object', properties: { file_id: { type: 'string' }, mode: { type: 'string', enum: ['auto', 'printed', 'handwriting'] } }, required: ['file_id'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const result = await read(String(args.file_id || '').replace(/^file:/, ''), (['printed', 'handwriting'].includes(String(args.mode)) ? args.mode : 'auto') as OcrMode, ctx.agent.ownerId || 'owner');
      const head = `Engine: ${result.engine}${result.model ? ` (${result.model})` : ''}${result.confidence != null ? `, confidence ${Math.round(result.confidence)}` : ''}; direction ${result.direction}.${result.notes.length ? ` ${result.notes.join(' ')}` : ''}`;
      return `${head}\n\n${result.text || '(no text found)'}`;
    },
  };
}
