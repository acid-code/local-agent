import type { MemoryBudget } from './memory.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { imageCatalog } from '@local-agent/shared';
import { OWNER_ID, accountOf } from './accounts.js';
import type { Store } from './db.js';
import type { Vault } from './vault.js';
import { generateImage, imageQuota, localStatus, specFor } from './images.js';
import { diskFree, listImageJobs, modelState, startModelDownload, startRunnerInstall } from './image-install.js';

const http = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw http(400, result.error.issues[0]?.message || 'Invalid input.');
  return result.data;
};

/** Uploaded wallpapers live in <dataDir>/users/<accountId>/ for every account, the owner included. */
export const wallpaperDir = (dataDir: string, accountId: string) => {
  if (accountId !== OWNER_ID && !/^usr_[A-Za-z0-9]+$/.test(accountId)) throw new Error('Bad account id.');
  return path.join(dataDir, 'users', accountId);
};
const WALL_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const MAX_WALL = 8 * 1024 * 1024;

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
const findWallpaper = (dataDir: string, accountId: string) => {
  const dir = wallpaperDir(dataDir, accountId);
  for (const ext of Object.values(WALL_TYPES)) { const full = path.join(dir, `wallpaper.${ext}`); if (fs.existsSync(full)) return full; }
  return null;
};

/** Image admin: status, model downloads and runner install. Used by the main app (owner) and the setup site. */
export function imageAdminState(store: Store, dataDir: string, vault: Vault) {
  const cfg = store.getSettings().imageGen;
  const catalog = imageCatalog(cfg.extraModels).map((spec) => modelState(dataDir, spec));
  return { selected: specFor(cfg)?.id, catalog, diskFreeBytes: diskFree(path.join(dataDir, 'image')), hfToken: Boolean(vault.valueByName('HF_TOKEN') || process.env.HF_TOKEN), jobs: listImageJobs() };
}

export function registerImageAdmin(app: FastifyInstance, base: string, deps: { store: Store; dataDir: string; vault: Vault; fetchImpl: typeof fetch }, guard: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean> | boolean) {
  const { store, dataDir, vault } = deps;
  app.get(`${base}/image`, async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return { ...imageAdminState(store, dataDir, vault), local: await localStatus(dataDir, store.getSettings().imageGen, deps.fetchImpl), imageGen: store.getSettings().imageGen };
  });
  app.post(`${base}/image/download`, async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const body = parse(z.object({ id: z.string() }), req.body);
    const spec = imageCatalog(store.getSettings().imageGen.extraModels).find((item) => item.id === body.id);
    if (!spec) throw http(404, 'No such image model.');
    return { job: startModelDownload(dataDir, spec, { token: vault.valueByName('HF_TOKEN') || process.env.HF_TOKEN, fetchImpl: deps.fetchImpl }) };
  });
  app.post(`${base}/image/runner`, async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return { job: startRunnerInstall(dataDir, deps.fetchImpl) };
  });
  app.post(`${base}/image/select`, async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const body = parse(z.object({ id: z.string() }), req.body);
    const settings = store.getSettings();
    if (!imageCatalog(settings.imageGen.extraModels).some((item) => item.id === body.id)) throw http(404, 'No such image model.');
    store.saveSettings({ ...settings, imageGen: { ...settings.imageGen, localModel: body.id } }, 'Image model changed', {});
    return { ok: true };
  });
}

export function registerMedia(app: FastifyInstance, deps: { store: Store; dataDir: string; vault: Vault; fetchImpl: typeof fetch; memory?: () => MemoryBudget | null }) {
  const { store, dataDir } = deps;

  // ----- Wallpaper upload (per account) -----
  app.post('/api/me/wallpaper', async (req) => {
    const account = accountOf(req);
    const body = parse(z.object({ contentBase64: z.string().min(10).max(12_000_000) }), req.body);
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.length > MAX_WALL) throw http(413, 'Wallpapers are limited to 8 MB.');
    const mime = sniff(bytes);
    if (!mime) throw http(400, 'Use a PNG, JPEG or WebP photo.');
    const dir = wallpaperDir(dataDir, account.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const ext of Object.values(WALL_TYPES)) fs.rmSync(path.join(dir, `wallpaper.${ext}`), { force: true });
    fs.writeFileSync(path.join(dir, `wallpaper.${WALL_TYPES[mime]}`), bytes, { mode: 0o600 });
    return { ok: true, version: Date.now() };
  });
  app.get('/api/me/wallpaper', async (req, reply) => {
    const file = findWallpaper(dataDir, accountOf(req).id);
    if (!file) throw http(404, 'No wallpaper uploaded.');
    const ext = path.extname(file).slice(1);
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    return reply.send(fs.readFileSync(file));
  });
  app.delete('/api/me/wallpaper', async (req) => {
    const file = findWallpaper(dataDir, accountOf(req).id);
    if (file) fs.rmSync(file, { force: true });
    return { ok: true };
  });

  // ----- Image generation -----
  app.get('/api/images/status', async (req) => {
    const account = accountOf(req);
    const settings = store.getSettings();
    const cloudAllowed = account.role === 'owner' || account.limits.cloud !== false;
    const keyed = Boolean(process.env.GEMINI_API_KEY);
    const local = await localStatus(dataDir, settings.imageGen, deps.fetchImpl);
    const quota = imageQuota(store, settings);
    return {
      mode: settings.imageGen.mode,
      local: { ready: local.ready, kind: local.kind, detail: local.detail, model: local.model },
      gemini: { allowed: cloudAllowed, keyed, model: settings.imageGen.geminiModel, remaining: quota.remaining, limit: quota.limit },
      ...(account.role === 'owner' ? { admin: imageAdminState(store, dataDir, deps.vault), imageGen: settings.imageGen } : {}),
    };
  });
  app.post('/api/images/generate', async (req) => {
    const account = accountOf(req);
    const body = parse(z.object({ prompt: z.string().min(1).max(2000), backend: z.enum(['auto', 'local', 'gemini']).optional(), shape: z.enum(['square', 'portrait', 'landscape']).optional() }), req.body);
    let result: Awaited<ReturnType<typeof generateImage>>;
    try {
      result = await generateImage({ store, dataDir, fetchImpl: deps.fetchImpl, memory: deps.memory?.() }, { prompt: body.prompt, ownerId: account.id, backend: body.backend, shape: body.shape });
    } catch (error) {
      // Routing refusals, quota and backend failures are all things the user can read and act on.
      throw http(422, error instanceof Error ? error.message : String(error));
    }
    return { file: { id: result.file.id, name: result.file.name, mime: result.file.mime, size: result.file.size }, backend: result.backend, detail: result.detail, ms: result.ms };
  });
  registerImageAdmin(app, '/api/images', deps, (req) => {
    if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can do that.');
    return true;
  });
}
