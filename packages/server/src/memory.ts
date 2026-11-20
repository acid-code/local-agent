import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ollamaRoot } from './ollama.js';

/**
 * One RAM budget for everything local-agent runs: Ollama models (weights + KV cache), the image runner, and this server.
 * Jobs run concurrently. Admission only checks that a new job fits; if not, it unloads idle models, then waits in a
 * FIFO queue per priority (chat before images before background) until it fits. A job that can never fit fails fast.
 */

export const GiB = 1024 ** 3;
export type JobKind = 'chat' | 'image' | 'background';
const PRIORITY: Record<JobKind, number> = { chat: 0, image: 1, background: 2 };

export interface LoadedInfo { name: string; sizeBytes: number; contextLength: number | null }
export interface ModelShape { fileBytes: number; layers: number; kvHeads: number; headDim: number }

/** Everything that touches the machine, so tests can swap in fakes. */
export interface MemoryProbe {
  loaded(): Promise<LoadedInfo[]>;
  shape(model: string): Promise<ModelShape | null>;
  unload(model: string): Promise<void>;
  serverRss(): number;
  pidRss(pid: number): number;
  systemAvailable(): number;
}

export interface BudgetConfig { budgetBytes: number; systemReserveBytes: number }

export interface WaitInfo {
  ahead: number;
  neededBytes: number;
  availableBytes: number;
  usedBytes: number;
  budgetBytes: number;
  reason: string;
}

export interface JobRequest {
  kind: JobKind;
  label: string;
  /** Optional run id so the user can cancel or force-admit a queued run. */
  runId?: string;
  /** Ollama model name for chat/background jobs (shared memory: concurrent jobs on one model count it once). */
  model?: string;
  /** Estimated bytes this job needs while it runs. */
  bytes: number;
  /** Called with queue position and memory info while waiting. */
  onWait?: (ahead: number, info?: WaitInfo) => void;
  signal?: AbortSignal;
}

export interface Lease { id: string; bytes: number; release: () => void; setPid: (pid: number) => void }

export class BudgetError extends Error {
  constructor(message: string, readonly neverFits = true) { super(message); }
}

interface Active { id: string; kind: JobKind; label: string; model?: string; bytes: number; pid?: number; peakRss: number }
interface Waiter { id: string; req: JobRequest; seq: number; resolve: (lease: Lease) => void; reject: (error: Error) => void }

const gb = (bytes: number) => `${(bytes / GiB).toFixed(1)} GB`;

export class MemoryBudget {
  private active = new Map<string, Active>();
  private queue: Waiter[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  /** Measured / estimated, per model key. Starts at 1 and follows real runs. */
  private calibration: Record<string, number> = {};
  private lastLoaded: LoadedInfo[] = [];
  private again = false;

  constructor(private readonly probe: MemoryProbe, private readonly config: () => BudgetConfig, private readonly calibrationFile?: string, private readonly pollMs = 1500) {
    if (calibrationFile) { try { this.calibration = JSON.parse(fs.readFileSync(calibrationFile, 'utf8')); } catch { /* first run */ } }
  }

  factor(key: string) { return Math.max(0.5, Math.min(3, this.calibration[key] ?? 1)); }

  /** Record a measurement: the factor moves 50% toward measured/estimated. */
  calibrate(key: string, estimated: number, measured: number) {
    if (!(estimated > 0) || !(measured > 0)) return;
    const ratio = measured / estimated;
    const previous = this.calibration[key] ?? 1;
    this.calibration[key] = Math.round((previous + (ratio - previous) * 0.5) * 1000) / 1000;
    if (this.calibrationFile) { try { fs.mkdirSync(path.dirname(this.calibrationFile), { recursive: true }); fs.writeFileSync(this.calibrationFile, JSON.stringify(this.calibration, null, 2)); } catch { /* best effort */ } }
  }

  // ----- Estimates -----

  /** Weights + KV cache for num_ctx + 10% and 300 MB overhead, scaled by what earlier loads of this model really used. */
  async estimateModel(model: string, numCtx: number): Promise<number> {
    const shape = await this.probe.shape(model);
    if (!shape) return 0;
    const kvType = (process.env.OLLAMA_KV_CACHE_TYPE || '').toLowerCase();
    const kvBytesPerElem = kvType.startsWith('q4') ? 0.5 : kvType.startsWith('q8') ? 1 : 2;
    const isSliding = /gemma[-_.: ]?4/i.test(model);
    const effectiveCtx = isSliding ? Math.min(numCtx, 4096) + Math.max(0, numCtx - 4096) * 0.25 : numCtx;
    const kv = 2 * shape.layers * effectiveCtx * shape.kvHeads * shape.headDim * kvBytesPerElem;
    const raw = (shape.fileBytes + kv) * 1.1 + 300 * 1024 ** 2;
    return Math.round(raw * this.factor(`ollama:${model}`));
  }

  /** Image model files + working memory that grows with pixels (VAE decode dominates), calibrated by peak RSS. */
  estimateImage(key: string, modelBytes: number, width: number, height: number, heavy = false): number {
    const megapixels = (width * height) / (512 * 512);
    const working = (heavy ? 3 : 1.2) * GiB * megapixels;
    return Math.round((modelBytes * 1.05 + working + 200 * 1024 ** 2) * this.factor(`image:${key}`));
  }

  // ----- Usage -----

  async usage() {
    const loaded = await this.probe.loaded();
    this.lastLoaded = loaded;
    const server = this.probe.serverRss();
    // Models: max of measured (Ollama /api/ps size) and what running jobs reserved, counted once per model.
    const perModel = new Map<string, number>();
    for (const model of loaded) perModel.set(model.name, model.sizeBytes);
    for (const job of this.active.values()) {
      if (!job.model) continue;
      perModel.set(job.model, Math.max(perModel.get(job.model) ?? 0, job.bytes));
    }
    let images = 0;
    for (const job of this.active.values()) {
      if (job.model) continue;
      const rss = job.pid ? this.probe.pidRss(job.pid) : 0;
      if (rss > job.peakRss) job.peakRss = rss;
      images += Math.max(rss, job.bytes);
    }
    const models = [...perModel.values()].reduce((sum, value) => sum + value, 0);
    const cfg = this.config();
    return { usedBytes: server + models + images, server, models, images, loaded, budgetBytes: cfg.budgetBytes, systemAvailable: this.probe.systemAvailable(), active: this.active.size, waiting: this.queue.length };
  }

  /** What a request adds on top of current usage. A chat on a model already loaded with enough context adds nothing. */
  private extraFor(req: JobRequest, loaded: LoadedInfo[]) {
    if (!req.model) return req.bytes;
    const resident = loaded.find((model) => model.name === req.model);
    const reserved = [...this.active.values()].filter((job) => job.model === req.model).reduce((max, job) => Math.max(max, job.bytes), 0);
    const have = Math.max(resident?.sizeBytes ?? 0, reserved);
    return Math.max(0, req.bytes - have);
  }

  private fits(extra: number, used: number, systemAvailable: number) {
    const cfg = this.config();
    return used + extra <= cfg.budgetBytes && extra <= Math.max(0, systemAvailable - cfg.systemReserveBytes);
  }

  // ----- Admission -----

  async admit(req: JobRequest): Promise<Lease> {
    const cfg = this.config();
    const server = this.probe.serverRss();
    if (req.bytes + server > cfg.budgetBytes) {
      throw new BudgetError(`${req.label} needs about ${gb(req.bytes)} of RAM, more than the ${gb(cfg.budgetBytes)} budget allows. Pick a smaller model or context, or raise the budget in the setup site.`);
    }
    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = { id: `job_${++this.seq}`, req, seq: this.seq, resolve, reject };
      this.queue.push(waiter);
      this.queue.sort((a, b) => PRIORITY[a.req.kind] - PRIORITY[b.req.kind] || a.seq - b.seq);
      req.signal?.addEventListener('abort', () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) { this.queue.splice(index, 1); reject(new BudgetError('Stopped while waiting for memory.', false)); this.notifyPositions(); }
      }, { once: true });
      void this.pump();
    });
  }

  /** Start every queued job that fits, in order. A job never jumps ahead of an earlier one of the same or higher priority. */
  private async pump() {
    if (this.pumping) { this.again = true; return; }
    this.pumping = true;
    try {
      do {
        this.again = false;
        let lastState: Awaited<ReturnType<MemoryBudget['usage']>> | null = null;
        while (this.queue.length) {
          const head = this.queue[0]!;
          let state = await this.usage();
          lastState = state;
          let extra = this.extraFor(head.req, state.loaded);
          if (!this.fits(extra, state.usedBytes, state.systemAvailable)) {
            // Free idle models first (loaded in Ollama, no running job uses them), largest first.
            const busy = new Set([...this.active.values()].map((job) => job.model).filter(Boolean));
            const idle = state.loaded.filter((model) => !busy.has(model.name) && model.name !== head.req.model).sort((a, b) => b.sizeBytes - a.sizeBytes);
            for (const model of idle) {
              await this.probe.unload(model.name);
              state = await this.usage();
              lastState = state;
              extra = this.extraFor(head.req, state.loaded);
              if (this.fits(extra, state.usedBytes, state.systemAvailable)) break;
            }
          }
          if (!this.fits(extra, state.usedBytes, state.systemAvailable)) break;
          this.queue.shift();
          head.resolve(this.start(head));
        }
        this.notifyPositions(lastState);
      } while (this.again);
    } finally {
      this.pumping = false;
      if (this.queue.length && !this.timer) this.timer = setInterval(() => void this.pump(), this.pollMs);
      if (!this.queue.length && this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  }

  /** Force a queued run to start immediately, bypassing the admission check (useful when MemAvailable estimates are conservative). */
  forceAdmit(runId: string): boolean {
    const index = this.queue.findIndex((waiter) => waiter.req.runId === runId || waiter.id === runId);
    if (index < 0) return false;
    const [waiter] = this.queue.splice(index, 1);
    if (!waiter) return false;
    waiter.resolve(this.start(waiter));
    this.notifyPositions(null);
    if (!this.queue.length && this.timer) { clearInterval(this.timer); this.timer = null; }
    return true;
  }

  /** Cancel a queued run while waiting for memory. */
  cancelWait(runId: string): boolean {
    const index = this.queue.findIndex((waiter) => waiter.req.runId === runId || waiter.id === runId);
    if (index < 0) return false;
    const [waiter] = this.queue.splice(index, 1);
    if (!waiter) return false;
    waiter.reject(new BudgetError('Cancelled while waiting for memory.', false));
    this.notifyPositions(null);
    if (!this.queue.length && this.timer) { clearInterval(this.timer); this.timer = null; }
    return true;
  }

  /** Trigger an immediate re-check of available memory and queued jobs. */
  async recheck(): Promise<void> {
    await this.pump();
  }

  /** Tell each waiter how many queued jobs are in front of it and current MemAvailable. */
  private notifyPositions(state: Awaited<ReturnType<MemoryBudget['usage']>> | null = null) {
    const cfg = this.config();
    const availableBytes = state?.systemAvailable ?? this.probe.systemAvailable();
    const usedBytes = state?.usedBytes ?? 0;
    const loaded = state?.loaded ?? this.lastLoaded;
    this.queue.forEach((waiter, index) => {
      const neededBytes = this.extraFor(waiter.req, loaded);
      const reason = index > 0
        ? `Waiting for memory, ${index} ahead (${gb(availableBytes)} available)`
        : `Waiting for memory (${gb(neededBytes)} needed, ${gb(availableBytes)} available)`;
      waiter.req.onWait?.(index, { ahead: index, neededBytes, availableBytes, usedBytes, budgetBytes: cfg.budgetBytes, reason });
    });
  }

  private start(waiter: Waiter): Lease {
    const job: Active = { id: waiter.id, kind: waiter.req.kind, label: waiter.req.label, model: waiter.req.model, bytes: waiter.req.bytes, peakRss: 0 };
    this.active.set(job.id, job);
    let released = false;
    return {
      id: job.id, bytes: job.bytes,
      setPid: (pid) => { job.pid = pid; },
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(job.id);
        void this.pump();
      },
    };
  }

  /** Peak RSS seen for a running job (image runner), for calibration after it finishes. */
  peakOf(lease: Lease) { const job = this.active.get(lease.id); if (job?.pid) { const rss = this.probe.pidRss(job.pid); if (rss > job.peakRss) job.peakRss = rss; } return job?.peakRss ?? 0; }

  snapshotQueue() { return this.queue.map((waiter, index) => ({ id: waiter.id, runId: waiter.req.runId ?? null, position: index + 1, kind: waiter.req.kind, label: waiter.req.label, bytes: waiter.req.bytes })); }
  snapshotActive() { return [...this.active.values()].map((job) => ({ kind: job.kind, label: job.label, model: job.model, bytes: job.bytes })); }
  lastLoadedModels() { return this.lastLoaded; }
}

// ----- The real probe -----

function readKb(file: string, key: string) {
  try {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(fs.readFileSync(file, 'utf8'));
    return match ? Number(match[1]) * 1024 : 0;
  } catch { return 0; }
}

function readAvailableBytes(): number {
  const avail = readKb('/proc/meminfo', 'MemAvailable');
  if (avail > 0) return avail;
  // Older kernels without MemAvailable: MemFree + reclaimable page cache (Buffers + Cached + SReclaimable).
  const free = readKb('/proc/meminfo', 'MemFree');
  const buffers = readKb('/proc/meminfo', 'Buffers');
  const cached = readKb('/proc/meminfo', 'Cached');
  const reclaim = readKb('/proc/meminfo', 'SReclaimable');
  const computed = free + buffers + cached + reclaim;
  if (computed > 0) return computed;
  return os.freemem();
}

export function systemProbe(fetchImpl: typeof fetch): MemoryProbe {
  const shapes = new Map<string, ModelShape | null>();
  return {
    async loaded() {
      try {
        const response = await fetchImpl(`${ollamaRoot()}/api/ps`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return [];
        const json = await response.json() as { models?: { name?: string; model?: string; size?: number; context_length?: number }[] };
        return (json.models ?? []).map((model) => ({ name: model.name || model.model || 'model', sizeBytes: model.size ?? 0, contextLength: model.context_length ?? null }));
      } catch { return []; }
    },
    async shape(model) {
      if (shapes.has(model)) return shapes.get(model)!;
      try {
        const [show, tags] = await Promise.all([
          fetchImpl(`${ollamaRoot()}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(3000) }).then((r) => r.ok ? r.json() : null),
          fetchImpl(`${ollamaRoot()}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok ? r.json() : null),
        ]) as [{ model_info?: Record<string, unknown> } | null, { models?: { name: string; size: number }[] } | null];
        const fileBytes = tags?.models?.find((item) => item.name === model || item.name === `${model}:latest`)?.size ?? 0;
        const info = show?.model_info ?? {};
        const arch = String(info['general.architecture'] || '');
        const num = (key: string) => Number(info[`${arch}.${key}`]) || 0;
        const layers = num('block_count') || 32;
        const heads = num('attention.head_count') || 32;
        const kvHeads = num('attention.head_count_kv') || heads;
        const headDim = num('attention.key_length') || (num('embedding_length') ? num('embedding_length') / heads : 128);
        const shape = fileBytes ? { fileBytes, layers, kvHeads, headDim } : null;
        if (shape) shapes.set(model, shape);
        return shape;
      } catch { return null; }
    },
    async unload(model) {
      try { await fetchImpl(`${ollamaRoot()}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) }); } catch { /* best effort */ }
      // Ollama frees asynchronously; give it a moment before re-measuring.
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
    serverRss: () => process.memoryUsage().rss,
    pidRss: (pid) => readKb(`/proc/${pid}/status`, 'VmRSS'),
    systemAvailable: readAvailableBytes,
  };
}


/** Budget config from settings: a hard cap (default 40 GB) plus a free-RAM reserve. */
export function budgetConfig(settings: { ramBudgetGiB?: number; ramSystemReserveGiB?: number }): BudgetConfig {
  return { budgetBytes: Math.max(1, settings.ramBudgetGiB ?? 40) * GiB, systemReserveBytes: Math.max(0, settings.ramSystemReserveGiB ?? 1.5) * GiB };
}

/** One-line budget summary for Health and doctor. */
export async function budgetReport(budget: MemoryBudget, cfg: BudgetConfig): Promise<{ ok: boolean; detail: string }> {
  const usage = await budget.usage();
  const queued = budget.snapshotQueue().length;
  const detail = `Using ${gb(usage.usedBytes)} of ${gb(cfg.budgetBytes)} (models ${gb(usage.models)}, images ${gb(usage.images)}, server ${gb(usage.server)}); ${usage.active} running, ${queued} waiting; system free ${gb(usage.systemAvailable)}`;
  return { ok: usage.usedBytes <= cfg.budgetBytes, detail };
}
