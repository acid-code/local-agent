import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hebrewScore, isHebrewText } from '@local-agent/shared';
import { accountOf, getAccount, mustOwn, OWNER_ID } from './accounts.js';
import type { Store } from './db.js';
import type { DockerCtl } from './docker.js';
import type { Engine } from './engine.js';
import { roughModelGiB } from './engine.js';
import { filePath, getFile } from './files.js';
import { cleanupHebrew } from './hebrew-cleanup.js';
import { getLanguage } from './language.js';
import { ollamaRoot } from './ollama.js';
import { isUncensoredProvider, OLLAMA_SIDE_MAX_GIB } from './coexist.js';
import { buildService, IMAGE_EXT, liveRunners, recognize, serviceStatus, startService, understandImage, type OcrMode, type OcrResult, type ServiceId } from './ocr.js';
import { preChangeBackup } from './ops.js';

/**
 * OCR endpoints, the agent tool's reader, background indexing of uploaded images, and the app's own service containers
 * (OCR, Piper) with download-ahead and live job logs.
 */
export function registerOcr(app: FastifyInstance, deps: { store: Store; engine: Engine; docker: DockerCtl; fetchImpl: typeof fetch; dataDir: string }) {
  const { store, engine, docker, fetchImpl, dataDir } = deps;
  const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

  async function runnersFor(ownerId: string) {
    const account = getAccount(store, ownerId);
    const cloudAllowed = !account || account.role === 'owner' || account.limits.cloud !== false;
    const uncensoredProvider = store.listProviders().find((p) => p.enabled && isUncensoredProvider(p));
    const uncensoredModel = uncensoredProvider ? store.listModels().find((m) => m.providerId === uncensoredProvider.id && m.enabled && !m.embedding) : undefined;
    const uncensoredHasVision = Boolean(uncensoredModel && Array.isArray(uncensoredModel.modalities) && uncensoredModel.modalities.includes('image'));
    return liveRunners({
      fetchImpl, memory: engine.memory, ollamaRoot: ollamaRoot(), cloudAllowed,
      geminiKey: process.env.GEMINI_API_KEY, visionModel: process.env.OCR_VISION_MODEL,
      preferLightweight: engine.llama.isActive(),
      inklingVisionUrl: uncensoredHasVision ? (uncensoredProvider?.baseUrl || null) : null,
      inklingVisionModel: uncensoredModel?.apiName || 'inkling-2-mini-uncensored',
    });
  }

  /** Best local Hebrew writer that fits the RAM budget (and respects llama-server GTT coexistence), for the OCR cleanup pass. */
  async function cleanupModel(): Promise<string | null> {
    try {
      const response = await fetchImpl(`${ollamaRoot()}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const names = ((await response.json()) as { models?: { name: string }[] }).models?.map((row) => row.name) ?? [];
      const budget = store.getSettings().ramBudgetGiB;
      const maxGiB = engine.llama.isActive() ? Math.min(budget * 0.85, OLLAMA_SIDE_MAX_GIB) : budget * 0.85;
      return names.map((name) => ({ name, score: hebrewScore({ apiName: name, name, local: true, providerKind: 'ollama' }) }))
        .filter((row) => row.score > 0 && roughModelGiB(row.name) <= maxGiB && !/vl|vision|embed/.test(row.name))
        .sort((a, b) => b.score - a.score)[0]?.name ?? null;
    } catch { return null; }
  }

  async function polish(result: OcrResult, ownerId: string, want: boolean | undefined): Promise<OcrResult & { cleaned?: boolean }> {
    const setting = getLanguage(store, ownerId).cleanup;
    const on = want ?? (setting === 'on' || (setting === 'auto' && result.model?.startsWith('gemini') !== true));
    if (!on || !isHebrewText(result.text)) return result;
    const model = await cleanupModel();
    if (!model) return result;
    const numCtx = 4096;
    const bytes = engine.memory ? await engine.memory.estimateModel(model, numCtx) : 0;
    const lease = engine.memory && bytes ? await engine.memory.admit({ kind: 'background', label: `${model} (OCR cleanup)`, model, bytes }) : null;
    try {
      const cleaned = await cleanupHebrew(result.text, async (prompt) => {
        const response = await fetchImpl(`${ollamaRoot()}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000), body: JSON.stringify({ model, stream: false, think: false, keep_alive: '2m', options: { temperature: 0, num_ctx: numCtx }, messages: [{ role: 'user', content: prompt }] }) });
        const json = await response.json() as { message?: { content?: string }; error?: string };
        if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
        return json.message?.content || '';
      }, { kind: 'ocr' });
      if (!cleaned.changed) return { ...result, cleaned: false };
      return { ...result, text: cleaned.text, cleaned: true, notes: [...result.notes, `Hebrew cleaned up by ${model}.`] };
    } finally {
      lease?.release();
    }
  }

  async function readFile(fileId: string, mode: OcrMode, ownerId: string, cleanup?: boolean) {
    const file = getFile(store, fileId);
    const full = file ? filePath(store, dataDir, fileId) : null;
    if (!file || !full || (file.ownerId && file.ownerId !== ownerId)) throw fail(404, 'File not found.');
    if (!IMAGE_EXT.test(file.name) && !String(file.mime).startsWith('image/')) throw fail(400, 'That file is not an image.');
    const result = await polish(await recognize(fs.readFileSync(full), { mode }, await runnersFor(ownerId)), ownerId, cleanup);
    // Library search finds photos by their text from now on.
    if (result.text) store.db.prepare('UPDATE files SET text_index = ? WHERE id = ?').run(result.text.slice(0, 200_000), fileId);
    return result;
  }
  engine.ocrReader = (fileId, mode, ownerId) => readFile(fileId, mode, ownerId);

  async function analyzeFile(fileId: string, question: string | undefined, ownerId: string) {
    const file = getFile(store, fileId);
    const full = file ? filePath(store, dataDir, fileId) : null;
    if (!file || !full || (file.ownerId && file.ownerId !== ownerId)) throw fail(404, 'File not found.');
    if (!IMAGE_EXT.test(file.name) && !String(file.mime).startsWith('image/')) throw fail(400, 'That file is not an image.');
    return understandImage(fs.readFileSync(full), await runnersFor(ownerId), question);
  }
  engine.imageAnalyzer = (fileId, question, ownerId) => analyzeFile(fileId, question, ownerId);

  app.post('/api/vision/analyze', async (req) => {
    const parsed = z.object({ fileId: z.string().min(1), question: z.string().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw fail(400, parsed.error.issues[0]?.message || 'Invalid input.');
    mustOwn(store, req, 'file', parsed.data.fileId, 'File not found.');
    try {
      return { result: await analyzeFile(parsed.data.fileId, parsed.data.question, accountOf(req).id) };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      throw statusCode ? error : fail(502, error instanceof Error ? error.message : 'Vision analysis failed.');
    }
  });

  app.post('/api/ocr', async (req) => {
    const parsed = z.object({ fileId: z.string().min(1), mode: z.enum(['auto', 'printed', 'handwriting']).optional(), cleanup: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw fail(400, parsed.error.issues[0]?.message || 'Invalid input.');
    mustOwn(store, req, 'file', parsed.data.fileId, 'File not found.');
    try {
      return { result: await readFile(parsed.data.fileId, parsed.data.mode ?? 'auto', accountOf(req).id, parsed.data.cleanup) };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      throw statusCode ? error : fail(502, error instanceof Error ? error.message : 'OCR failed.');
    }
  });

  // The app's own services (owner only: not in the member allowlist).
  app.get('/api/services', async () => ({ services: await Promise.all((['ocr', 'piper'] as ServiceId[]).map((id) => serviceStatus(docker, fetchImpl, id))) }));
  app.post('/api/services/:id/:action', async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (id !== 'ocr' && id !== 'piper') throw fail(404, 'No such service.');
    if (action !== 'download' && action !== 'start' && action !== 'stop') throw fail(404, 'Unknown action.');
    if (!docker.available() || !(await docker.ping())) throw fail(503, 'Docker is not available.');
    const job = store.createJob(`service-${action}-${id}`, `${action} ${id}`);
    void (async () => {
      const log = (line: string) => store.appendJob(job.id, line);
      try {
        await preChangeBackup(dataDir, `pre-${id}-${action}`);
        if (action === 'download') await buildService(docker, id, log);
        else if (action === 'start') await startService(docker, id, log);
        else {
          const state = await docker.containerState(id === 'ocr' ? 'local-agent-ocr' : 'local-agent-piper');
          if (state) await docker.remove(state.id);
          log('stopped\n');
        }
        store.finishJob(job.id, 'completed');
      } catch (error) {
        log(`\n${error instanceof Error ? error.message : 'failed'}\n`);
        store.finishJob(job.id, 'failed');
      }
    })();
    return { job };
  });

  /** After an image upload: index its printed text in the background when the OCR service is up (no vision model, no wait). */
  return {
    indexImage(file: { id: string; name: string; mime?: string }, ownerId = OWNER_ID) {
      if (!IMAGE_EXT.test(file.name)) return;
      void (async () => {
        const runners = await runnersFor(ownerId);
        if (!runners.tesseract) return;
        const full = filePath(store, dataDir, file.id);
        if (!full) return;
        const result = await recognize(fs.readFileSync(full), { mode: 'printed' }, { tesseract: runners.tesseract, vision: null });
        if (result.text && (result.confidence ?? 0) >= 50) store.db.prepare('UPDATE files SET text_index = ? WHERE id = ?').run(result.text.slice(0, 200_000), file.id);
      })().catch(() => undefined);
    },
    async ocrBytesForKb(bytes: Buffer, ownerId: string) {
      const result = await recognize(bytes, { mode: 'auto' }, await runnersFor(ownerId));
      return result.text;
    },
  };
}
