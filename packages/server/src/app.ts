import { ensurePinned } from './pinned.js';
import { isDiskFullError } from './resources.js';
import { isLlamaServerProvider } from './coexist.js';
import { MemoryBudget, budgetConfig, systemProbe, type MemoryProbe } from './memory.js';
import { Workbench } from './workbench.js';
import { ManagedBrowser } from './browser.js';
import { ComputerControl, registerLiveComputer } from './live-computer.js';
import { toHostBindPath } from './tools.js';
import path from 'node:path';
import { ensureFilesTable } from './files.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import { VERSION } from '@local-agent/shared';
import { authenticate } from './auth.js';
import { MEMBER_ROUTES, type Account } from './accounts.js';
import { Bus } from './bus.js';
import { seedCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { DockerCtl } from './docker.js';
import { Store } from './db.js';
import { VectorIndex } from './embeddings.js';
import { Engine } from './engine.js';
import { McpRuntime } from './mcp.js';
import type { ModelProvider } from './providers.js';
import type { ModelRow } from './db.js';
import { registerRoutes } from './routes.js';
import { Scheduler } from './scheduler.js';
import { Notifier } from './notify.js';
import { backupIfDue, watchOnce } from './ops.js';
import { loadMasterKey, Vault } from './vault.js';
import { ollamaEmbedder, reindexRoots } from './kb.js';
import { TriggerRuntime } from './triggers.js';

import { checkMonitorToken, MONITOR_PREFIX } from './monitor.js';
const PUBLIC = new Set(['GET /api/health', 'GET /api/auth/me', 'POST /api/auth/login', 'POST /api/setup']);

export interface BuiltApp {
  app: ReturnType<typeof Fastify>;
  store: Store;
  engine: Engine;
  bus: Bus;
  vault: Vault;
  scheduler: Scheduler;
  mcp: McpRuntime;
  workbench: Workbench | null;
  browser: ManagedBrowser | null;
  computer: ComputerControl;
  config: ReturnType<typeof loadConfig>;
}

export async function buildApp(options: {
  dataDir: string;
  port?: number;
  fetchImpl?: typeof fetch;
  docker?: DockerCtl;
  providerOverride?: (model: ModelRow) => ModelProvider;
  /** RAM probe override (tests). Without one, mocked-provider builds and unit tests skip the RAM budget. */
  memoryProbe?: MemoryProbe;
  workbench?: Workbench | null;
  browser?: ManagedBrowser | null;
  startScheduler?: boolean;
  serveWeb?: boolean;
}): Promise<BuiltApp> {
  const config = loadConfig({ dataDir: options.dataDir, port: options.port });
  const store = new Store(path.join(config.dataDir, 'local-agent.db'));
  seedCatalog(store, config.dataDir);
  ensureFilesTable(store);
  const bus = new Bus();
  const docker = options.docker ?? new DockerCtl();
  const vectors = new VectorIndex(store.db);
  const vault = new Vault(store, loadMasterKey(config.dataDir));
  const engine = new Engine(store, bus, docker, vectors, vault, config.instanceId, options.fetchImpl ?? fetch, options.providerOverride);
  engine.libraryDir = config.dataDir;
  const memoryProbe = options.memoryProbe ?? (options.providerOverride || process.env.VITEST ? undefined : systemProbe(options.fetchImpl ?? fetch));
  // llama-server keeps its model resident outside Ollama: one per distinct enabled llama-server address counts toward the cap.
  if (memoryProbe && !options.memoryProbe) {
    memoryProbe.externalResident = () => process.env.LA_EXTERNAL_RESIDENT_MODELS != null
      ? Number(process.env.LA_EXTERNAL_RESIDENT_MODELS) || 0
      : new Set(store.listProviders().filter((provider) => provider.enabled && isLlamaServerProvider(provider)).map((provider) => provider.baseUrl || provider.id)).size;
  }
  engine.memory = memoryProbe ? new MemoryBudget(memoryProbe, () => budgetConfig(store.getSettings()), path.join(config.dataDir, 'memory-calibration.json')) : null;
  const workbench = options.workbench !== undefined
    ? options.workbench
    : new Workbench(docker, path.join(config.dataDir, 'workspaces'), () => engine.memory, toHostBindPath, process.env.LA_PROJECTS_DIR || '/projects');
  engine.workbench = workbench;
  const browser = options.browser !== undefined
    ? options.browser
    : new ManagedBrowser(docker, config.dataDir, () => engine.memory, toHostBindPath);
  engine.browser = browser;
  const computer = new ComputerControl(bus);
  engine.computer = computer;
  const triggers = new TriggerRuntime(store, engine, vault, bus);
  const mcp = new McpRuntime(store, docker, { secretsFor: (id) => vault.mcpEnv(id), cacheDir: path.join(config.dataDir, 'mcp-cache') });
  engine.mcpTools = () => mcp.agentTools();
  const scheduler = new Scheduler(store, engine);
  engine.recover();
  const notifier = new Notifier(store, bus, engine, config.dataDir, options.fetchImpl ?? fetch);
  if (options.startScheduler !== false) {
    scheduler.start();
    notifier.start();
    triggers.start();
    if (!process.env.VITEST) mcp.startAll();
  }

  const app = Fastify({ bodyLimit: 8 * 1024 * 1024, logger: false });
  app.addContentTypeParser(/^(audio|video)\//, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!req.url.startsWith('/api/hooks/')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    (req as { rawBody?: Buffer }).rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.addHook('preHandler', async (req, reply) => {
    const pathOnly = req.url.split('?')[0] ?? '';
    if (PUBLIC.has(`${req.method} ${pathOnly}`)) return;
    if (req.method === 'POST' && /^\/api\/hooks\/(?:github\/)?[A-Za-z0-9_-]+$/.test(pathOnly)) return;
    if (!req.url.startsWith('/api/')) return;
    // Remote monitoring: read-only, bearer token instead of a session (an owner session works too).
    if (pathOnly.startsWith(MONITOR_PREFIX)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(405).send({ error: 'The monitoring API is read-only.' });
      if (checkMonitorToken(store, req.headers.authorization)) return;
    }
    const ok = await authenticate(store, req);
    if (!ok) return reply.code(401).send({ error: 'Sign in required.' });
    // Members reach only their own corner of the API. Admin routes are owner-only.
    const account = (req as { account?: Account }).account;
    if (account?.role === 'member' && !MEMBER_ROUTES.has(`${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions?.url ?? pathOnly}`)) {
      return reply.code(403).send({ error: 'Only the owner can do that.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.authorization?.startsWith('Bearer ')) {
      const origin = req.headers.origin;
      if (typeof origin === 'string') {
        try {
          if (new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: 'Cross-origin write blocked.' });
        } catch {
          return reply.code(403).send({ error: 'Cross-origin write blocked.' });
        }
      }
    }
  });

  app.setErrorHandler((error: unknown, _req, reply) => {
    // A full disk is the user's to fix, so say so plainly (507) instead of "Internal error".
    const full = isDiskFullError(error);
    const status = full ? 507 : typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const message = full && !(error instanceof Error && /disk is full/i.test(error.message)) ? 'The disk is full. Free some space, then try again.' : error instanceof Error ? error.message : 'Internal error';
    if (status >= 500) store.addLog('error', message);
    reply.code(status || 500).send({ error: status >= 500 && status !== 507 ? 'Internal error' : message });
  });

  registerRoutes(app, { store, engine, bus, docker, mcp, vault, notifier, config, fetchImpl: options.fetchImpl ?? fetch, autoConnectors: options.startScheduler !== false && !process.env.VITEST });
  registerLiveComputer(app, { control: computer, browser });

  if (options.serveWeb !== false && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.header('Cache-Control', 'no-store, must-revalidate');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
      reply.header('Cache-Control', 'no-store, must-revalidate');
      return reply.sendFile('index.html');
    });
  }

  const pinFetch = options.fetchImpl ?? fetch;
  const pinOnce = async () => {
    for (const result of await ensurePinned(pinFetch).catch(() => [])) {
      if (result.action === 'pinned' || result.action === 'repinned') store.addLog('info', `Pinned ${result.model} in memory (keep_alive forever).`, undefined, 'pinned');
      else if (result.action === 'error') store.addLog('warn', `Could not pin ${result.model}: ${result.detail}`, undefined, 'pinned');
    }
  };
  if (options.startScheduler !== false) setTimeout(() => { void pinOnce(); }, 20_000).unref?.();
  const background = options.startScheduler === false ? [] : [
    setInterval(() => { void pinOnce(); }, 120_000),
    setInterval(() => {
      void watchOnce(docker, options.fetchImpl ?? fetch).then((report) => {
        for (const note of [...report.notes, ...report.restarted.map((name) => `Restarted ${name}`)]) {
          bus.publish({ type: 'watch', message: note });
        }
      }).catch(() => undefined);
    }, 30_000),
    setInterval(() => {
      void backupIfDue(config.dataDir, store.getSettings()).catch((error: Error) => store.addLog('error', error.message));
    }, 60_000),
    setInterval(() => {
      void reindexRoots(store, ollamaEmbedder(options.fetchImpl ?? fetch, store.getSettings().autoModels.embed || 'nomic-embed-text')).catch((error: Error) => store.addLog('error', error.message));
    }, 60_000),
  ];
  app.addHook('onClose', async () => {
    scheduler.stop();
    notifier.stop();
    triggers.stop();
    await workbench?.stop().catch(() => undefined);
    await browser?.stop().catch(() => undefined);
    await mcp.closeAll().catch(() => undefined);
    for (const timer of background) clearInterval(timer);
    store.close();
  });

  return { app, store, engine, bus, vault, scheduler, config, mcp, workbench, browser, computer };
}
