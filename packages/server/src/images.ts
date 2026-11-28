import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { imageCatalog, imageFileName, isBlockedUrl, type ImageModelSpec } from '@local-agent/shared';
import type { Store } from './db.js';
import type { ImageGenSettings, Settings } from './settings.js';
import type { Tool } from './tools.js';
import { OWNER_ID, getAccount } from './accounts.js';
import { saveFile } from './files.js';
import type { MemoryBudget } from './memory.js';

/**
 * The image role. Two kinds of backend:
 *  - local: stable-diffusion.cpp (sd-cli with SD-Turbo, CPU or iGPU via Vulkan) or any AUTOMATIC1111-compatible HTTP API.
 *  - gemini: Gemini image generation, only for accounts allowed to use Gemini, counted in the shared quota.
 * Video generation is deliberately not offered (see docs/images.md).
 */

export type ImageBackend = 'local' | 'gemini';
export interface ImageResult { bytes: Buffer; mime: string; backend: ImageBackend; ms: number; detail: string }
export interface LocalStatus { ready: boolean; kind: 'sdcpp' | 'http' | 'mock'; detail: string; binary?: string; model?: string; url?: string }

export const imageDir = (dataDir: string) => path.join(dataDir, 'image');
export const defaultBinary = (dataDir: string) => path.join(imageDir(dataDir), 'bin', process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli');
export const modelsDir = (dataDir: string) => path.join(imageDir(dataDir), 'models');
export const specFor = (cfg: ImageGenSettings): ImageModelSpec | undefined => imageCatalog(cfg.extraModels).find((spec) => spec.id === cfg.localModel) ?? imageCatalog(cfg.extraModels)[0];
/** A model is installed when every file is fully downloaded (no .part left). */
export const modelInstalled = (dataDir: string, spec: ImageModelSpec) => spec.files.every((file) => { const full = path.join(modelsDir(dataDir), imageFileName(file)); return fs.existsSync(full) && fs.statSync(full).size > 0; });
const mocked = () => process.env.LA_IMAGE_MOCK === '1';

export async function localStatus(dataDir: string, cfg: ImageGenSettings, fetchImpl: typeof fetch = fetch): Promise<LocalStatus> {
  if (mocked()) return { ready: true, kind: 'mock', detail: 'Mock image runner (LA_IMAGE_MOCK=1). Draws a placeholder instead of running Stable Diffusion.' };
  if (cfg.backend === 'http') {
    if (!cfg.httpUrl) return { ready: false, kind: 'http', detail: 'No image server URL set.' };
    try {
      const response = await fetchImpl(`${cfg.httpUrl.replace(/\/$/, '')}/sdapi/v1/options`, { signal: AbortSignal.timeout(2500) });
      return { ready: response.ok, kind: 'http', url: cfg.httpUrl, detail: response.ok ? `Image server answered at ${cfg.httpUrl}.` : `Image server returned ${response.status}.` };
    } catch {
      return { ready: false, kind: 'http', url: cfg.httpUrl, detail: `Image server at ${cfg.httpUrl} did not answer.` };
    }
  }
  const binary = cfg.sdBinary || defaultBinary(dataDir);
  const spec = specFor(cfg);
  if (!fs.existsSync(binary)) return { ready: false, kind: 'sdcpp', binary, model: spec?.name, detail: 'stable-diffusion.cpp is not installed. Install it from the setup site (Image card).' };
  if (!spec || !modelInstalled(dataDir, spec)) return { ready: false, kind: 'sdcpp', binary, model: spec?.name, detail: `${spec?.name || 'The image model'} is not downloaded yet. Download it from the setup site.` };
  return { ready: true, kind: 'sdcpp', binary, model: spec.name, detail: `stable-diffusion.cpp with ${spec.name} is installed.` };
}

export interface ImageRoute { backend: ImageBackend | null; reason: string; slow: boolean }

/** Auto: local first, then Gemini. Members with Gemini off never reach Gemini. */
export function chooseBackend(cfg: ImageGenSettings, want: 'auto' | ImageBackend, opts: { localReady: boolean; cloudAllowed: boolean; keyed: boolean }): ImageRoute {
  if (cfg.mode === 'off') return { backend: null, reason: 'Image generation is turned off in Models.', slow: false };
  const geminiOk = opts.cloudAllowed && opts.keyed;
  const geminiWhyNot = !opts.cloudAllowed ? 'Gemini is not allowed for this account.' : 'Gemini is not connected (no API key).';
  const pick = want === 'auto' ? (cfg.mode === 'auto' ? null : cfg.mode) : want;
  if (pick === 'local') return opts.localReady ? { backend: 'local', reason: 'Local runner.', slow: true } : { backend: null, reason: 'The local image runner is not installed. Install it from the setup site.', slow: false };
  if (pick === 'gemini') return geminiOk ? { backend: 'gemini', reason: 'Gemini.', slow: false } : { backend: null, reason: geminiWhyNot, slow: false };
  if (opts.localReady) return { backend: 'local', reason: 'Auto picked the local runner.', slow: true };
  if (geminiOk) return { backend: 'gemini', reason: 'Auto picked Gemini because no local runner is installed.', slow: false };
  return { backend: null, reason: `No image backend is available. The local runner is not installed and ${geminiWhyNot.toLowerCase()}`, slow: false };
}

const FLAG: Record<string, string> = { model: '-m', diffusion: '--diffusion-model', vae: '--vae', clip_l: '--clip_l', t5xxl: '--t5xxl' };
/** stable-diffusion.cpp arguments for a catalog model. */
export function sdArgs(dataDir: string, spec: ImageModelSpec) {
  const args = spec.files.flatMap((file) => [FLAG[file.role]!, path.join(modelsDir(dataDir), imageFileName(file))]);
  args.push('--steps', String(spec.steps), '--cfg-scale', String(spec.cfg), '--sampling-method', spec.sampler);
  if (spec.files.some((file) => file.role === 'diffusion')) args.push('--vae-tiling');
  return args;
}

function sizeFor(cfg: ImageGenSettings, shape?: string) {
  const base = Math.max(256, Math.min(1024, specFor(cfg)?.size || cfg.size || 512));
  const long = Math.round((base * 1.5) / 64) * 64;
  if (shape === 'portrait') return { width: base, height: long };
  if (shape === 'landscape') return { width: long, height: base };
  return { width: base, height: base };
}

export async function generateLocal(dataDir: string, cfg: ImageGenSettings, prompt: string, shape: string | undefined, fetchImpl: typeof fetch, signal?: AbortSignal, onSpawn?: (pid: number) => void): Promise<Buffer> {
  const { width, height } = sizeFor(cfg, shape);
  if (mocked()) return mockPng(prompt, width, height);
  if (cfg.backend === 'http') {
    const response = await fetchImpl(`${cfg.httpUrl.replace(/\/$/, '')}/sdapi/v1/txt2img`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ prompt, steps: cfg.steps || 1, cfg_scale: 1, width, height, sampler_name: 'Euler a' }),
    });
    if (!response.ok) throw new Error(`Image server returned ${response.status}.`);
    const data = await response.json() as { images?: string[] };
    if (!data.images?.[0]) throw new Error('Image server returned no image.');
    return Buffer.from(data.images[0].replace(/^data:image\/\w+;base64,/, ''), 'base64');
  }
  const binary = cfg.sdBinary || defaultBinary(dataDir);
  const spec = specFor(cfg);
  if (!spec) throw new Error('No local image model is configured.');
  const out = path.join(os.tmpdir(), `la-img-${process.pid}-${Date.now()}.png`);
  const args = [...sdArgs(dataDir, spec), '-p', prompt, '-W', String(width), '-H', String(height), '-s', String(Math.floor(Math.random() * 2 ** 31)), '-t', String(Math.max(1, os.cpus().length - 1)), '-o', out];
  await new Promise<void>((resolve, reject) => {
    const child = execFile(binary, args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LD_LIBRARY_PATH: path.dirname(binary) } }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`stable-diffusion.cpp failed: ${String(stderr || error.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
      else resolve();
    });
    if (child.pid) onSpawn?.(child.pid);
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
  try { return fs.readFileSync(out); } finally { fs.rmSync(out, { force: true }); }
}

export async function generateGemini(prompt: string, model: string, key: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
  });
  if (response.status === 429) throw new Error('Gemini image quota is used up for now.');
  if (!response.ok) throw new Error(`Gemini image generation failed (${response.status}).`);
  const data = await response.json() as { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] };
  const part = data.candidates?.flatMap((candidate) => candidate.content?.parts || []).find((item) => item.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error('Gemini returned no image. Try rewording the prompt.');
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType || 'image/png' };
}

/** Shared Gemini quota for the image model: the owner's per-model limit, else a conservative free-tier default. */
export function imageQuota(store: Store, settings: Settings) {
  const apiName = settings.imageGen.geminiModel;
  const configured = settings.quotaLimits[apiName];
  const limit = configured?.rpd ?? (settings.geminiTier === 'paid' ? null : 20);
  const day = new Date().toISOString().slice(0, 10);
  const used = store.quotaUse(apiName, day).rpd;
  return { apiName, limit, used, remaining: limit == null ? null : Math.max(0, limit - used), day };
}

export interface GenerateDeps { store: Store; dataDir: string; fetchImpl: typeof fetch; geminiKey?: () => string | undefined; memory?: MemoryBudget | null }

/** One generation for an account, saved to that account's files. */
export async function generateImage(deps: GenerateDeps, input: { prompt: string; ownerId: string; backend?: 'auto' | ImageBackend; shape?: string; sessionId?: string | null; agentId?: string | null; signal?: AbortSignal; onWait?: (ahead: number) => void }) {
  const prompt = input.prompt.trim().slice(0, 2000);
  if (!prompt) throw new Error('Describe the image to make.');
  const settings = deps.store.getSettings();
  const cfg = settings.imageGen;
  const account = getAccount(deps.store, input.ownerId);
  if (!account) throw new Error('Unknown account.');
  const cloudAllowed = account.role === 'owner' || account.limits.cloud !== false;
  const key = (deps.geminiKey ?? (() => process.env.GEMINI_API_KEY))();
  const local = await localStatus(deps.dataDir, cfg, deps.fetchImpl);
  const route = chooseBackend(cfg, input.backend || 'auto', { localReady: local.ready, cloudAllowed, keyed: Boolean(key) });
  if (!route.backend) throw new Error(route.reason);
  const started = Date.now();
  let bytes: Buffer; let mime = 'image/png'; let detail: string;
  if (route.backend === 'local') {
    bytes = await runLocalWithBudget(deps, cfg, local, prompt, input.shape, input.signal, input.onWait);
    detail = local.kind === 'mock' ? 'mock runner' : local.kind === 'http' ? 'local image server' : `${local.model} on this machine`;
  } else {
    const quota = imageQuota(deps.store, settings);
    if (quota.remaining === 0) throw new Error(`The shared Gemini image quota for today is used up (${quota.limit}).`);
    const result = await generateGemini(prompt, cfg.geminiModel, key!, deps.fetchImpl, input.signal);
    bytes = result.bytes; mime = result.mime;
    deps.store.bumpQuota(quota.apiName, quota.day, new Date().toISOString().slice(0, 16), 0);
    detail = `Gemini (${cfg.geminiModel})`;
  }
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  const file = saveFile(deps.store, deps.dataDir, { name: `${slug}.${ext}`, bytes, mime, sessionId: input.sessionId ?? null, agentId: input.agentId ?? null, source: 'agent', ownerId: input.ownerId });
  return { file, backend: route.backend, ms: Date.now() - started, detail, slow: route.slow, reason: route.reason };
}

/** The local runner under the shared RAM budget: wait for room, track the process RSS, calibrate from its peak. */
async function runLocalWithBudget(deps: GenerateDeps, cfg: ImageGenSettings, local: LocalStatus, prompt: string, shape: string | undefined, signal?: AbortSignal, onWait?: (ahead: number) => void) {
  const spec = specFor(cfg);
  if (!deps.memory || local.kind !== 'sdcpp' || !spec) return generateLocal(deps.dataDir, cfg, prompt, shape, deps.fetchImpl, signal);
  const { width, height } = sizeFor(cfg, shape);
  const modelBytes = spec.files.reduce((sum, file) => sum + file.bytes, 0);
  const key = `image:${spec.id}`;
  const estimate = deps.memory.estimateImage(spec.id, modelBytes, width, height, spec.files.some((file) => file.role === 'diffusion'));
  const lease = await deps.memory.admit({ kind: 'image', label: `${spec.name} image`, bytes: estimate, onWait, signal });
  const sampler = setInterval(() => deps.memory!.peakOf(lease), 500);
  try {
    const png = await generateLocal(deps.dataDir, cfg, prompt, shape, deps.fetchImpl, signal, (pid) => lease.setPid(pid));
    const peak = deps.memory.peakOf(lease);
    if (peak) deps.memory.calibrate(key, estimate / deps.memory.factor(key), peak);
    return png;
  } finally {
    clearInterval(sampler);
    lease.release();
  }
}

export function imageTool(deps: Omit<GenerateDeps, 'store'>): Tool {
  return {
    name: 'generate_image',
    description: 'Make a picture from a text description. Saves it to the user\'s files and returns a [file:<id>] reference to put in the reply so it shows as a preview with a download button. backend "auto" uses the local Stable Diffusion runner first (slow on a CPU, often 20-90 s; tell the user it is on its way) and Gemini only when this account may use it. Write a vivid English prompt: subject, style, colours, lighting.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' }, shape: { type: 'string', enum: ['square', 'portrait', 'landscape'] }, backend: { type: 'string', enum: ['auto', 'local', 'gemini'] } }, required: ['prompt'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const result = await generateImage({ ...deps, store: ctx.store }, {
        prompt: String(args.prompt || ''), ownerId: ctx.agent.ownerId || OWNER_ID, backend: (args.backend as 'auto' | ImageBackend) || 'auto', shape: args.shape ? String(args.shape) : undefined,
        sessionId: ctx.sessionId, agentId: ctx.agent.id, signal: ctx.signal,
      });
      const secs = Math.round(result.ms / 1000);
      return `Made [file:${result.file.id}] with ${result.detail} in ${secs} s.${result.slow && secs > 15 ? ' Local generation is slow on this machine; say so if the user asks for many.' : ''} Mention [file:${result.file.id}] in the reply.`;
    },
  };
}

function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

async function downloadValidImage(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: 'image/png' | 'image/jpeg' } | null> {
  if (!url || !/^https?:\/\//i.test(url) || isBlockedUrl(url)) return null;
  try {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const res = await fetchImpl(url, {
      signal: combined,
      headers: { 'User-Agent': 'local-agent/0.1 (https://github.com/acid-code/local-agent)' },
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 8 * 1024 * 1024) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return null;
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    return { bytes, mime };
  } catch {
    return null;
  }
}

/** Search Wikimedia Commons first (great for science, medical diagrams & photos), then local SearXNG image search, and save a verified PNG/JPEG to the user's Library. */
export async function fetchWebImage(
  deps: { store: Store; dataDir: string; fetchImpl: typeof fetch; searxngUrl?: string },
  input: { query: string; ownerId: string; sessionId?: string | null; agentId?: string | null; signal?: AbortSignal; primaryOnly?: boolean },
) {
  const query = input.query.trim().slice(0, 200);
  if (!query) throw new Error('Provide an image search query.');
  const candidates: Array<{ url: string; provider: string }> = [];

  // 1. Wikimedia Commons (high-res diagrams & photography, free, no API key)
  const ALLOWED_WIKI_MIMES = new Set(['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
  const BAD_MEDIA_RE = /\.(?:pdf|djvu|ogv|ogg|webm|mp4|tif|tiff)\b|\(IA_/i;
  try {
    const wikiQuery = `${query} filetype:bitmap|drawing`;
    const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1280&format=json&gsrsearch=${encodeURIComponent(wikiQuery)}`;
    const combined = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    const res = await deps.fetchImpl(wikiUrl, { signal: combined, headers: { 'User-Agent': 'local-agent/0.1 (https://github.com/acid-code/local-agent)' } });
    if (res.ok) {
      type WikiPage = { index?: number; title?: string; imageinfo?: Array<{ url?: string; thumburl?: string; mime?: string; width?: number; height?: number }> };
      const data = await res.json() as { query?: { pages?: Record<string, WikiPage> } };
      const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info || !info.mime || !ALLOWED_WIKI_MIMES.has(info.mime)) continue;
        if (BAD_MEDIA_RE.test(page.title || '') || BAD_MEDIA_RE.test(info.url || '')) continue;
        if (info.mime !== 'image/svg+xml' && typeof info.width === 'number' && typeof info.height === 'number' && (info.width < 300 || info.height < 200)) continue;
        // Prefer thumburl (Wikimedia renders SVG/huge images to 1280px PNG/JPEG automatically!)
        const pick = info.thumburl || (info.mime === 'image/png' || info.mime === 'image/jpeg' ? info.url : undefined);
        if (pick) candidates.push({ url: pick, provider: 'Wikimedia Commons' });
      }
    }
  } catch { /* fall through to SearXNG */ }

  // 2. Local SearXNG image search fallback
  const searx = input.primaryOnly ? '' : (deps.searxngUrl || process.env.SEARXNG_URL || '').replace(/\/$/, '');
  if (searx) {
    try {
      const combined = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
      const res = await deps.fetchImpl(`${searx}/search?q=${encodeURIComponent(query)}&categories=images&format=json`, { signal: combined });
      if (res.ok) {
        const data = await res.json() as { results?: Array<{ img_src?: string; thumbnail_src?: string }> };
        for (const r of (data.results || []).slice(0, 8)) {
          if (r.img_src) candidates.push({ url: r.img_src, provider: 'SearXNG' });
          if (r.thumbnail_src) candidates.push({ url: r.thumbnail_src, provider: 'SearXNG' });
        }
      }
    } catch { /* ignore */ }
  }

  for (const cand of candidates) {
    const img = await downloadValidImage(deps.fetchImpl, cand.url, input.signal);
    if (!img) continue;
    const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'web-image';
    const file = saveFile(deps.store, deps.dataDir, {
      name: `${slug}.${ext}`,
      bytes: img.bytes,
      mime: img.mime,
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? null,
      source: 'agent',
      ownerId: input.ownerId,
    });
    return { file, sourceUrl: cand.url, provider: cand.provider };
  }
  throw new Error(`No downloadable PNG/JPEG image found for "${query}".`);
}

export function fetchImageTool(deps: { dataDir: string; fetchImpl: typeof fetch }): Tool {
  return {
    name: 'fetch_image',
    description:
      'Find and download a real high-resolution PNG/JPEG photo or scientific/medical diagram from Wikimedia Commons or SearXNG image search. '
      + 'Saves it to the user\'s Library and returns [file:<id>] so you can embed it in make_slides (image.fileId), inspect it with understand_image, or show it in chat. '
      + 'Works with zero API key and zero GPU RAM. Use concise English search keywords.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concise English search keywords for the photo or diagram (e.g. "osteoporosis bone remodeling osteoclast osteoblast diagram").' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const result = await fetchWebImage(
        { store: ctx.store, dataDir: deps.dataDir, fetchImpl: deps.fetchImpl, searxngUrl: ctx.searxngUrl },
        { query: String(args.query || ''), ownerId: ctx.agent.ownerId || OWNER_ID, sessionId: ctx.sessionId, agentId: ctx.agent.id, signal: ctx.signal },
      );
      return `Saved [file:${result.file.id}] from ${result.provider} (${result.sourceUrl}). You can embed it in make_slides using image: { fileId: "${result.file.id}" } or mention [file:${result.file.id}] in your reply.`;
    },
  };
}

// ---------- Mock runner: a soft gradient with a few circles, so the whole flow can be tested without a model. ----------

function crc32(buf: Buffer) {
  let crc = ~0;
  for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function mockPng(prompt: string, width = 256, height = 256): Buffer {
  let seed = 0; for (const ch of prompt) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const hue = rand() * 360;
  const hsl = (h: number, s: number, l: number) => { const a = s * Math.min(l, 1 - l); const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
  const top = hsl(hue, 0.7, 0.86); const bottom = hsl((hue + 40) % 360, 0.65, 0.7);
  const blobs = Array.from({ length: 7 }, () => ({ x: rand() * width, y: rand() * height, r: (0.06 + rand() * 0.14) * Math.min(width, height), c: hsl((hue + 120 + rand() * 120) % 360, 0.7, 0.62) }));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1); raw[row] = 0; const t = y / height;
    for (let x = 0; x < width; x++) {
      let px = [0, 1, 2].map((i) => top[i]! * (1 - t) + bottom[i]! * t);
      for (const blob of blobs) { const d = Math.hypot(x - blob.x, y - blob.y); if (d < blob.r) { const a = Math.min(1, (blob.r - d) / 3) * 0.9; px = px.map((v, i) => v * (1 - a) + blob.c[i]! * a); } }
      raw[row + 1 + x * 3] = px[0]!; raw[row + 2 + x * 3] = px[1]!; raw[row + 3 + x * 3] = px[2]!;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
