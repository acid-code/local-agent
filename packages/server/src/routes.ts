import { needsTitle, previewOf } from './chat-titles.js';
import { execFile } from 'node:child_process';
import { safeInside } from './pathsafe.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MACHINE_PROFILES, autoMapFor, autoMapForPlan, planInstall, type InstallPlan, profileFor, residentGiB, FREE_TIER_OBSERVED_AT, FREE_TIER_SNAPSHOT, VERSION, geminiQuotaDay, nextCron, quotaAvailability } from '@local-agent/shared';
import { authenticate, hashPassword, noteFailure, rateLimit, setSession, verifyPassword } from './auth.js';
import { TEMPLATES } from './catalog.js';
import { detectCodingClis, keepBatch, listEdits, readPlan, replacePlan, undoPlan, revertBatch, revertBatchFile, RollbackConflict, scaffoldProject, updatePlanItem } from './coding.js';
import { secretDrift, secretNames, writeSecret } from './config.js';
import { inDockerContainer, type DockerCtl } from './docker.js';
import { checklist, findSearxng, readGpu, scanMachine, setupPreview } from './discovery.js';
import type { McpRuntime } from './mcp.js';
import type { McpServer } from './db.js';
import { importConfigs, searchRegistry, trustOf, vetSpec, type VettingReport } from './mcp.js';
import { cacheNpm, cacheStatus, dockerCatalog, officialCatalog, specFor, vetCatalogImage } from './mcp-catalog.js';
import { localReputationSummarizer } from './reputation.js';
import type { Notifier } from './notify.js';
import { createBackup, listBackups, preChangeBackup, shipBackup, stageRestore } from './ops.js';
import { deleteSessionPermanently, RESET_PHRASE, resetChats } from './reset.js';
import { telegramQueue } from './notify.js';
import { ollamaLoaded, ollamaRoot } from './ollama.js';
import { approvalView } from './approval-view.js';
import { doctorChecks, geminiStateOf, redactValue, searchLogs, zipStore, LOG_COMPONENTS, type LogComponent } from './debug.js';
import { autoRoleReport } from './auto-roles.js';
import { ensureDiskRoom, isDiskFullError, previewPrune, runPrune, snapshotResources } from './resources.js';
import { speak, transcribe, voiceStatus, VoiceError, KOKORO_COMMAND, WHISPER_COMMAND } from './voice.js';
import { formatSearch, listWorkspace, readWorkspaceFile, searxngHealth, searxngQuery } from './tools.js';
import {
  KbInputError, createCollection, deleteCollection, deleteDocument, embedRoleWarning, listDocuments, formatCitations, ingestBuffer, ingestFolder, kbUsage, listCollections, ollamaEmbedder, searchKnowledge,
} from './kb.js';
import {
  deleteSkill, exportSkill, importSkill, listSkills, parseSkillMd, restoreSkillVersion, saveSkill, setSkillEnabled, skillFit, skillVersions,
} from './skills.js';
import {
  createTrigger, fireTrigger, getTrigger, githubSignatureOk, listTriggerEvents, listTriggers, secretEquals, triggerSecret, updateTrigger,
  type TriggerKind,
} from './triggers.js';
import { secret as randomSecret } from './util.js';
import { RULE_FILE_CAP, RULE_TOTAL_CAP, disabledRules, discoverRules, setRuleEnabled } from './rules.js';
import { GALLERY, gallerySystemPrompt, galleryList, installGallerySkills, type GalleryPersona } from './gallery.js';
import { connectorStateFlag, BUILTIN_CONNECTORS, RECOMMENDED_CONNECTORS, recommendedSpec, connectorEnabled, connectorReport, connectorTools, recommendedConnected, setConnectorEnabled } from './connectors.js';
import { memoryFiles, rollbackRun, writeMemoryFile } from './learning.js';
import { createWorkshop, getWorkshop, listWorkshops } from './workshops.js';
import { ACCENT_DEFAULT, FACES, accentOk, avatarPath, saveAvatar } from './avatars.js';
import type { Bus } from './bus.js';
import type { Engine } from './engine.js';
import { git, listSharedRepos, registerSharedRepo } from './repos.js';
import { isInside } from '@local-agent/shared';
import { CONTEXT_MARK, expandMentions } from './mentions.js';
import { cloneInto, gitRoot, gitStatus, listDir, listGitRoots, openPullRequest, pushBranch, readExcerpt, validBranch } from './gitops.js';
import { MAX_FILE_BYTES, deleteFile, filePath, getFile, getMessageRow, listFiles, mimeFor, saveFile, searchMessages } from './files.js';
import type { Store } from './db.js';
import type { Vault } from './vault.js';
import { renderSlides } from './slides.js';
import { registerMonitor } from './monitor.js';
import { ensureManagedContainersNetwork, resolveServiceUrl } from './ocr.js';
import { runPreCommitSemgrep } from './semgrep.js';
import { benchRuntime, loadBench, machineInfo, saveBench } from './runtime-bench.js';
import { registerOcr } from './ocr-routes.js';
import { MEMBER_DENIED_TOOLS, OWNER_ID, accountOf, foreignPath, mustOwn, ownerOf, workspaceFor } from './accounts.js';
import { memberByUsername } from './accounts.js';
import { registerAccounts } from './members.js';
import { registerMedia } from './media.js';
import { getChatWorkspaces, prefillChatWorkspaces, resolveChatWorkspaces, setChatWorkspaces, chatWorkspacePaths } from './chat-workspaces.js';
import { usableModels } from './usable-models.js';
import { registerWorkspaceRoutes } from './workspaces.js';
import { listPersonaMessages } from './persona-messaging.js';
import { budgetConfig, budgetReport, readGtt, type MemoryBudget } from './memory.js';
import { isLlamaServerProvider } from './coexist.js';
import { localStatus } from './images.js';
import { activeRunOf, sessionEventFilter } from './session-events.js';

type Ctx = {
  autoConnectors?: boolean;
  store: Store;
  engine: Engine;
  bus: Bus;
  docker: DockerCtl;
  mcp: McpRuntime;
  vault: Vault;
  notifier: Notifier;
  config: { dataDir: string };
  fetchImpl: typeof fetch;
};

let lastScan: Awaited<ReturnType<typeof scanMachine>> | null = null;

export function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, engine, bus, docker, mcp, vault, notifier, config, fetchImpl } = ctx;

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));
  registerAccounts(app, { store, config });
  registerWorkspaceRoutes(app, { store });
  registerMedia(app, { store, dataDir: config.dataDir, vault, fetchImpl, memory: () => engine.memory });
  const ocr = registerOcr(app, { store, engine, docker, fetchImpl, dataDir: config.dataDir });

  app.get('/api/auth/me', async (req) => {
    const owner = store.getOwner();
    const header = req.headers.authorization;
    const cookieOk = Boolean(req.cookies?.la_session);
    let authenticated = false;
    if (header?.startsWith('Bearer ') || cookieOk) authenticated = await authenticate(store, req);
    const account = authenticated ? accountOf(req) : null;
    return {
      needsSetup: !owner, authenticated, username: account?.username, displayName: account?.displayName, role: account?.role, accountId: account?.id,
      limits: account?.role === 'member' ? account.limits : undefined,
      version: VERSION, restartKeys: account?.role === 'owner' ? secretDrift(config.dataDir) : [],
    };
  });

  app.post('/api/setup', async (req, reply) => {
    if (store.getOwner()) return reply.code(409).send({ error: 'An owner already exists.' });
    const body = parse(z.object({ username: z.string().regex(/^[a-zA-Z0-9._-]{1,32}$/), password: z.string().min(8).max(200) }), req.body);
    try {
      store.createOwner(body.username, await hashPassword(body.password));
    } catch (error) {
      const status = typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 0;
      if (status === 409 || (error instanceof Error && /already exists|UNIQUE/i.test(error.message))) return reply.code(409).send({ error: 'An owner already exists.' });
      throw error;
    }
    await setSession(reply, store);
    store.addLog('info', `Owner ${body.username} created.`);
    // One assistant to start with; the rest of the gallery is optional.
    if (!store.listAgents(OWNER_ID).length) await addFromGallery(GALLERY[0]!, OWNER_ID, false).catch((error) => store.addLog('warn', `Default assistant not created: ${(error as Error).message}`));
    return { username: body.username };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip || 'local';
    if (rateLimit(ip)) return reply.code(429).send({ error: 'Too many attempts. Wait a few minutes.' });
    const owner = store.getOwner();
    if (!owner) return reply.code(409).send({ error: 'Create the owner account first.' });
    const body = parse(z.object({ username: z.string(), password: z.string() }), req.body);
    if (body.username === owner.username && (await verifyPassword(body.password, owner.passwordHash))) {
      await setSession(reply, store, OWNER_ID);
      return { username: owner.username, role: 'owner' };
    }
    const member = body.username !== owner.username ? memberByUsername(store, body.username) : null;
    if (member && !member.disabled && (await verifyPassword(body.password, member.passwordHash))) {
      await setSession(reply, store, member.id);
      return { username: member.username, role: 'member' };
    }
    noteFailure(ip);
    return reply.code(401).send({ error: 'Wrong username or password.' });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies?.la_session;
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) store.deleteAuthSession(unsigned.value);
    }
    reply.clearCookie('la_session', { path: '/' });
    return { ok: true };
  });

  app.post('/api/account/password', async (req) => {
    const owner = store.getOwner();
    if (!owner) throw http(400, 'No owner.');
    const body = parse(z.object({ current: z.string(), next: z.string().min(8) }), req.body);
    const account = accountOf(req);
    if (account.role === 'member') {
      const member = memberByUsername(store, account.username);
      if (!member || !(await verifyPassword(body.current, member.passwordHash))) throw http(401, 'Current password is wrong.');
      store.db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(await hashPassword(body.next), member.id);
      return { ok: true };
    }
    if (!(await verifyPassword(body.current, owner.passwordHash))) throw http(401, 'Current password is wrong.');
    store.db.prepare('UPDATE owner SET password_hash = ? WHERE id = 1').run(await hashPassword(body.next));
    return { ok: true };
  });

  app.get('/api/tokens', async () => ({ tokens: store.listTokens() }));
  app.post('/api/tokens', async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(60) }), req.body);
    const token = `la_${randomBytes(24).toString('base64url')}`;
    const id = store.createToken(body.name, createHash('sha256').update(token).digest('hex'));
    return { id, name: body.name, token };
  });
  app.delete('/api/tokens/:id', async (req) => {
    store.deleteToken((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get('/api/settings', async () => ({
    settings: store.getSettings(),
    secrets: secretNames(config.dataDir),
    versions: store.listConfigVersions(),
    vault: vault.list(),
    audit: vault.auditLog(),
    clis: await detectCodingClis(),
  }));
  app.patch('/api/settings', async (req) => {
    const body = parse(z.object({
      goodModelId: z.string().nullable().optional(),
      autoResume: z.boolean().optional(),
      personaAutoStart: z.boolean().optional(),
      sandbox: z.enum(['docker-or-host', 'docker-only', 'host']).optional(),
      maxSteps: z.number().int().min(1).max(40).optional(),
      outputReserveTokens: z.number().int().min(128).max(32000).optional(),
      ramBudgetGiB: z.number().min(2).max(1024).optional(),
      ramSystemReserveGiB: z.number().min(0).max(64).optional(),
      summaryTriggerTokens: z.number().int().min(200).max(20000).optional(),
      searxngUrl: z.string().optional(),
      searchHits: z.number().int().min(1).max(20).optional(),
      approvalForDestructive: z.boolean().optional(),
      approvalMode: z.enum(['cautious', 'balanced', 'autonomous']).optional(),
      mcpAllowHost: z.boolean().optional(),
      geminiTier: z.enum(['free', 'paid']).optional(),
      codeApproval: z.enum(['sandbox-auto', 'always']).optional(),
      killed: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      dailyTokenLimit: z.number().nullable().optional(),
      dailySpendLimitUsd: z.number().nullable().optional(),
      debugLevel: z.enum(['info', 'debug']).optional(),
      quotaLimits: z.record(z.object({ rpm: z.number().optional(), rpd: z.number().optional() })).optional(),
      backupCron: z.string().optional(),
      backupTransport: z.enum(['none', 'rsync', 'rclone', 's3']).optional(),
      backupTarget: z.string().optional(),
      agentLimits: z.record(z.object({ maxTokensPerDay: z.number().optional(), maxSpendUsd: z.number().optional(), maxRunMs: z.number().optional(), readOnly: z.boolean().optional() })).optional(),
      imageGen: z.object({
        mode: z.enum(['auto', 'local', 'gemini', 'off']).optional(),
        backend: z.enum(['sdcpp', 'http']).optional(),
        sdBinary: z.string().max(500).optional(),
        localModel: z.string().max(80).optional(),
        httpUrl: z.string().max(500).refine((value) => !value || /^https?:\/\//.test(value), 'The image server URL must start with http:// or https://.').optional(),
        geminiModel: z.string().max(80).optional(),
        size: z.number().int().min(256).max(1024).optional(),
        extraModels: z.array(z.object({
          id: z.string().regex(/^[a-z0-9._-]{2,40}$/), name: z.string().max(60), blurb: z.string().max(200), speed: z.enum(['fast', 'medium', 'slow']),
          files: z.array(z.object({ role: z.enum(['model', 'diffusion', 'vae', 'clip_l', 't5xxl']), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), file: z.string().regex(/^[\w./-]+$/).refine((value) => !value.includes('..')), bytes: z.number().int().nonnegative(), gated: z.boolean().optional() })).min(1).max(6),
          steps: z.number().int().min(1).max(50), cfg: z.number().min(0).max(20), size: z.number().int().min(256).max(1024), sampler: z.string().regex(/^[a-z0-9_+]+$/), ramGiB: z.number().min(0).max(256), licence: z.string().max(80),
        })).max(20).optional(),
      }).optional(),
    }), req.body);
    const current = store.getSettings();
    const next = { ...current, ...body, imageGen: { ...current.imageGen, ...(body.imageGen ?? {}) } };
    const saved = store.saveSettings(next, 'Settings updated', { settings: next, agents: store.listAgents() });
    return { settings: saved };
  });

  app.get('/api/persona-messages', async (req) => {
    const q = req.query as { sessionId?: string; agentId?: string; limit?: string };
    return {
      messages: listPersonaMessages(store, {
        ownerId: accountOf(req).id,
        sessionId: q.sessionId || undefined,
        agentId: q.agentId || undefined,
        limit: q.limit ? Number(q.limit) : 50,
      }),
    };
  });
  app.post('/api/secrets', async (req) => {
    const body = parse(z.object({ key: z.string(), value: z.string().min(1) }), req.body);
    writeSecret(config.dataDir, body.key, body.value);
    if (body.key === 'GEMINI_API_KEY') store.updateProvider('prov_gemini', { enabled: true });
    if (body.key === 'OPENROUTER_API_KEY') store.updateProvider('prov_openrouter', { enabled: true });
    return { ok: true };
  });
  app.post('/api/config/rollback', async (req) => {
    const body = parse(z.object({ versionId: z.number().int() }), req.body);
    const version = store.getConfigVersion(body.versionId);
    if (!version) throw http(404, 'Version not found.');
    const snapshot = version.snapshot as { settings?: Record<string, unknown> };
    if (snapshot.settings) {
      store.saveSettings({ ...store.getSettings(), ...snapshot.settings }, `Rollback to version ${version.version}`, snapshot);
    }
    return { settings: store.getSettings() };
  });

  app.get('/api/vault', async () => { engine.sweepStaleWaits(); return { secrets: vault.list(), requests: vault.listRequests('pending'), audit: vault.auditLog() }; });
  app.post('/api/vault', async (req) => {
    const body = parse(z.object({ name: z.string(), value: z.string().min(1), scope: z.string().optional(), scopeId: z.string().nullable().optional() }), req.body);
    const secret = vault.put({ name: body.name, value: body.value, scope: body.scope, scopeId: body.scopeId, actor: 'owner' });
    for (const request of vault.listRequests('pending').filter((item) => item.name === secret.name)) {
      engine.provideSecret(request.id, body.value);
    }
    return { secret };
  });
  app.post('/api/vault/:id/reveal', async (req) => {
    const body = parse(z.object({ password: z.string() }), req.body);
    const owner = store.getOwner();
    if (!owner || !(await verifyPassword(body.password, owner.passwordHash))) throw http(401, 'Password required to reveal a secret.');
    return { value: vault.reveal((req.params as { id: string }).id, 'owner') };
  });
  app.post('/api/vault/:id/rotate', async (req) => {
    const body = parse(z.object({ value: z.string().min(1) }), req.body);
    const current = vault.list().find((secret) => secret.id === (req.params as { id: string }).id);
    if (!current) throw http(404, 'Secret not found.');
    return { secret: vault.put({ name: current.name, value: body.value, scope: current.scope, scopeId: current.scopeId, actor: 'owner' }) };
  });
  app.post('/api/vault/:id/revoke', async (req) => {
    vault.revoke((req.params as { id: string }).id, 'owner');
    return { ok: true };
  });
  app.post('/api/vault/captures/:id/accept', async (req) => {
    const body = parse(z.object({ name: z.string(), scope: z.string().optional() }), req.body);
    return { secret: vault.acceptCapture((req.params as { id: string }).id, body.name, 'owner', body.scope) };
  });
  app.post('/api/secret-requests/:id', async (req) => {
    const body = parse(z.object({ value: z.string().min(1).optional(), deny: z.boolean().optional() }), req.body);
    const id = (req.params as { id: string }).id;
    const request = vault.getRequest(id);
    if (!request) throw http(404, 'Secret request not found.');
    // Already answered, expired or dismissed elsewhere: nothing to do (a second tap is not an error).
    if (request.status !== 'pending') return { ok: true, status: request.status };
    engine.provideSecret(id, body.deny ? null : body.value || null);
    return { ok: true, status: body.deny || !body.value ? 'denied' : 'provided' };
  });

  const me = (req: Parameters<typeof accountOf>[0]) => accountOf(req).id;
  // Built-in connectors (offline, no secrets) and recommended account connectors.
  const healthEnv = () => ({ store, dataDir: config.dataDir, searxngUrl: store.getSettings().searxngUrl || process.env.SEARXNG_URL || '', fetchImpl, dockerAvailable: () => docker.available() });
  const connectorBrief = (id: string, member: boolean) => {
    const builtin = BUILTIN_CONNECTORS.find((row) => row.id === id);
    if (builtin) return member && builtin.ownerOnly ? null : { name: builtin.name, builtIn: true, status: connectorEnabled(store, id) ? 'on' : 'off' };
    const rec = RECOMMENDED_CONNECTORS.find((row) => row.id === id);
    return rec ? { name: rec.name, builtIn: false, status: recommendedConnected(store, id) ? 'connected' : 'not connected' } : null;
  };
  // Startup auto-discovery: attach existing managed containers to our Docker network, auto-detect/heal SearXNG,
  // and retry scanning Ollama / llama-server until a model server answers so the UI never stays stuck on "no models".
  if (ctx.autoConnectors) {
    void ensureManagedContainersNetwork(docker).catch(() => undefined);
    // Background model discovery with retry backoff until Ollama / llama-server answers.
    const delays = [0, 2000, 4000, 8000, 15000, 30000, 30000, 60000];
    let attempt = 0;
    const scanStartup = () => {
      void (async () => {
        try {
          const report = await scanMachine(fetchImpl, docker, store);
          lastScan = report;
          engine.residentLarge = report.resident;
          const foundLocal = store.listModels().some((m) => m.enabled && m.local && m.providerId !== 'prov_rehearsal');
          if (report.ollama || foundLocal) {
            bus.publish({ type: 'models_updated' });
            return;
          }
        } catch { /* retry */ }
        attempt += 1;
        if (attempt < delays.length) setTimeout(scanStartup, delays[attempt]!);
      })();
    };
    setTimeout(scanStartup, 500);

    setTimeout(() => void (async () => {
      await ensureManagedContainersNetwork(docker).catch(() => undefined);
      const current = store.getSettings();
      // Self-heal broken 127.0.0.1:8088 saved inside a bridge Docker container.
      const savedUrl = (current.searxngUrl || '').trim();
      const savedBrokenInDocker = inDockerContainer() && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(savedUrl);
      if (savedUrl && !savedBrokenInDocker) {
        const ok = await findSearxng(fetchImpl, savedUrl);
        if (ok) return;
      }
      const detected = await findSearxng(fetchImpl, savedBrokenInDocker ? undefined : savedUrl);
      if (detected) {
        store.saveSettings({ ...store.getSettings(), searxngUrl: detected }, 'SearXNG detected', { searxngUrl: detected });
        connectorStateFlag(store, 'search:auto', true);
        return;
      }
      if (connectorStateFlag(store, 'search:auto')) return;
      if (await docker.ping().catch(() => false)) {
        connectorStateFlag(store, 'search:auto', true);
        const job = store.createJob('start-searxng', 'built-in web search');
        await runSetup('start-searxng', undefined, job.id, ctx);
      }
    })().catch((error: Error) => store.addLog('warn', `Built-in search: ${error.message}`)), 2500);
  }
  app.get('/api/connectors', async (req) => connectorReport(healthEnv(), accountOf(req).role === 'member'));
  app.patch('/api/connectors/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!BUILTIN_CONNECTORS.some((row) => row.id === id)) throw http(404, 'No such built-in connector.');
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    setConnectorEnabled(store, id, body.enabled);
    return connectorReport(healthEnv(), false);
  });
  /** One click: vet the recommended server's pinned image or package; the Tools page shows the report and installs on approval. */
  app.post('/api/connectors/:id/connect', async (req) => {
    const item = RECOMMENDED_CONNECTORS.find((row) => row.id === (req.params as { id: string }).id);
    if (!item) throw http(404, 'No such connector.');
    const spec = recommendedSpec(item);
    let report: VettingReport;
    if (item.image) {
      report = vetCatalogImage({ source: 'docker', id: item.id, title: item.name, description: item.description, trust: item.trust, image: item.image, secrets: item.secrets.map((env) => ({ env })), env: [], installable: true });
    } else {
      const settings = store.getSettings();
      report = await vetSpec({ name: item.name, transport: 'stdio', command: 'npx', args: ['-y', item.npm!], source: spec.source }, fetchImpl, {
        reputation: true, searxngUrl: settings.searxngUrl || process.env.SEARXNG_URL || '', summarize: localReputationSummarizer(store, fetchImpl),
      });
    }
    report.spec = spec;
    report.name = item.name;
    store.saveVetting(report.id, report);
    return { report, needs: item.needs, trust: item.trust, secrets: item.secrets, note: item.note ?? null };
  });
  /** What "Download all recommended" would fetch, and what is already on disk. */
  const cacheItems = () => RECOMMENDED_CONNECTORS.map((item) => ({ id: item.id, image: item.image, npm: item.npm }));
  const mcpCacheDir = path.join(config.dataDir, 'mcp-cache');
  let cacheJob: { id: string; running: boolean; current: string | null; errors: Record<string, string> } | null = null;
  app.get('/api/connectors/cache', async () => ({
    items: (await cacheStatus(cacheItems(), docker, mcpCacheDir)).map((row) => ({ ...row, status: cacheJob?.running && cacheJob.current === row.id ? 'downloading' : cacheJob?.errors[row.id] && row.status !== 'ready' ? 'failed' : row.status, detail: cacheJob?.errors[row.id] })),
    running: Boolean(cacheJob?.running), dockerAvailable: docker.available(),
  }));
  app.post('/api/connectors/cache', async () => {
    if (cacheJob?.running) return { started: false, running: true };
    const job = store.createJob('mcp-cache', 'Download all recommended connectors');
    cacheJob = { id: job.id, running: true, current: null, errors: {} };
    const state = cacheJob;
    void (async () => {
      for (const row of await cacheStatus(cacheItems(), docker, mcpCacheDir)) {
        if (row.status === 'ready') continue;
        state.current = row.id;
        try {
          if (row.kind === 'image') {
            if (!docker.available()) throw new Error('Docker is not reachable.');
            await docker.pull(row.ref);
          } else await cacheNpm(row.ref, mcpCacheDir);
          store.appendJob(job.id, `${row.id}: ready\n`);
        } catch (error) {
          state.errors[row.id] = error instanceof Error ? error.message.slice(0, 200) : 'failed';
          store.appendJob(job.id, `${row.id}: ${state.errors[row.id]}\n`);
        }
      }
      state.current = null;
      state.running = false;
      store.finishJob(job.id, Object.keys(state.errors).length ? 'failed' : 'done');
    })();
    return { started: true, running: true, jobId: job.id };
  });

  async function addFromGallery(item: GalleryPersona, accountId: string, member: boolean) {
    const taken = new Set(store.listAgents(accountId).map((agent) => agent.name));
    let name = item.name;
    for (let n = 2; taken.has(name); n += 1) name = `${item.name} ${n}`;
    const workspace = workspaceFor(config.dataDir, accountId, name);
    fs.mkdirSync(workspace, { recursive: true });
    const agent = store.createAgent({
      name, description: item.description, systemPrompt: gallerySystemPrompt(item), ownerId: accountId, workspacePath: workspace,
      toolAllowlist: [...new Set([...item.tools, ...connectorTools(item.connectors, member)])].filter((tool) => !member || !MEMBER_DENIED_TOOLS.has(tool)),
    });
    store.updateAgent(agent.id, { title: item.title, accent: item.accent, avatarKind: 'initials', avatarRef: `blob-${item.shape}`, templateId: item.id });
    await installGallerySkills(store, config.dataDir, agent.id, item);
    return store.getAgent(agent.id)!;
  }
  const memberTools = (req: Parameters<typeof accountOf>[0], tools: string[]) => accountOf(req).role === 'member' ? tools.filter((tool) => !MEMBER_DENIED_TOOLS.has(tool)) : tools;
  // Each persona's latest message, for the sidebar preview.
  // Newest messages first; the preview skips our own notices and markers (see previewOf).
  const lastMessages = store.db.prepare(`SELECT m.content AS content, m.role AS role, m.created_at AS at FROM messages m JOIN chat_sessions s ON s.id = m.session_id
    WHERE s.agent_id = ? AND s.helper_of IS NULL AND s.archived = 0 AND m.role IN ('user', 'assistant') AND m.content <> '' ORDER BY m.rowid DESC LIMIT 12`);
  app.get('/api/agents', async (req) => {
    const owner = me(req);
    const untitled: string[] = [];
    const agents = store.listAgents(owner).map((agent) => {
      const rows = (lastMessages.all(agent.id) as { content: string; role: string; at: string }[]).reverse().map((row) => {
        const pm = row.content.match(/^\[persona-message\|[^|\]]+\|[^|\]]+\|[^|\]]+\|([^|\]]+)\|[^\]]*\]\s*/);
        return pm ? { ...row, role: 'assistant', content: `From ${pm[1]}: ${row.content.slice(pm[0].length)}` } : row;
      });
      const preview = previewOf(rows);
      const at = rows.at(-1)?.at;
      const chat = store.latestSessionForAgent(agent.id, owner);
      if (chat && needsTitle(chat.titleSource) && rows.length) untitled.push(chat.id);
      return {
        ...agent,
        lastMessage: preview && at ? { text: preview.text, role: preview.role, at } : null,
        chat: chat ? { id: chat.id, title: chat.title, titleSource: chat.titleSource } : null,
      };
    });
    // Old chats get their generated title lazily, the first time a list shows them.
    if (untitled.length) engine.queueTitles(untitled.slice(0, 10));
    return { agents, templates: TEMPLATES, faces: FACES };
  });
  // Persona gallery: ready-made personas with skills, rules, tools and connectors. One click adds one.
  app.get('/api/gallery', async (req) => {
    const mine = store.listAgents(me(req));
    const member = accountOf(req).role === 'member';
    return {
      personas: galleryList(store, (id) => connectorBrief(id, member)).map((item) => ({
        ...item, tools: member ? item.tools.filter((tool) => !MEMBER_DENIED_TOOLS.has(tool)) : item.tools,
        added: mine.some((agent) => agent.templateId === item.id),
      })),
    };
  });
  app.post('/api/gallery/:id', async (req) => {
    const item = GALLERY.find((row) => row.id === (req.params as { id: string }).id);
    if (!item) throw http(404, 'No such persona in the gallery.');
    const account = accountOf(req);
    if (account.role === 'member' && store.listAgents(account.id).length >= account.limits.maxAgents) throw http(400, `You can have up to ${account.limits.maxAgents} personas.`);
    return { agent: await addFromGallery(item, account.id, account.role === 'member') };
  });

  app.post('/api/agents/reorder', async (req) => {
    const body = parse(z.object({ ids: z.array(z.string()).min(1) }), req.body);
    store.reorderAgents(body.ids.filter((id) => ownerOf(store, 'agent', id) === me(req)));
    return { agents: store.listAgents(me(req)) };
  });
  app.post('/api/agents', async (req) => {
    const body = parse(z.object({
      name: z.string().min(1).max(80),
      description: z.string().optional(),
      systemPrompt: z.string().min(1),
      modelId: z.string().nullable().optional(),
      routing: z.enum(['auto', 'pinned']).optional(),
      strategy: z.enum(['rolling', 'hierarchical', 'hierarchical+retrieval', 'pinned', 'retrieval']).nullable().optional(),
      toolAllowlist: z.array(z.string()),
      memoryEnabled: z.boolean().optional(),
      template: z.string().optional(),
    }), req.body);
    const template = TEMPLATES.find((item) => item.id === body.template);
    const name = body.name || template?.name || 'Agent';
    const account = accountOf(req);
    if (account.role === 'member' && store.listAgents(account.id).length >= account.limits.maxAgents) throw http(400, `You can have up to ${account.limits.maxAgents} personas.`);
    // Each account's workspaces live in its own folder.
    const workspace = workspaceFor(config.dataDir, account.id, name);
    fs.mkdirSync(workspace, { recursive: true });
    return {
      agent: store.createAgent({
        name, description: body.description ?? template?.description, systemPrompt: body.systemPrompt || template?.systemPrompt || 'You are a local agent.',
        modelId: body.modelId, routing: body.routing, strategy: body.strategy, toolAllowlist: memberTools(req, body.toolAllowlist.length ? body.toolAllowlist : template?.tools || []),
        memoryEnabled: body.memoryEnabled, workspacePath: workspace, ownerId: account.id,
      }),
    };
  });
  app.patch('/api/agents/:id', async (req) => {
    const body = parse(z.object({
      name: z.string().optional(), description: z.string().optional(), systemPrompt: z.string().optional(),
      modelId: z.string().nullable().optional(), routing: z.enum(['auto', 'pinned']).optional(),
      strategy: z.enum(['rolling', 'hierarchical', 'hierarchical+retrieval', 'pinned', 'retrieval']).nullable().optional(),
      toolAllowlist: z.array(z.string()).optional(), memoryEnabled: z.boolean().optional(),
      title: z.string().max(80).optional(),
      avatarKind: z.enum(['initials', 'builtin', 'upload']).optional(),
      avatarRef: z.string().max(80).optional(),
      accent: z.string().optional(),
      emoji: z.string().max(16).optional(),
      pinned: z.boolean().optional(),
      hidden: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      workshopIds: z.array(z.string()).optional(),
      notify: z.enum(['all', 'mute']).optional(),
      language: z.enum(['auto', 'match', 'en', 'he']).optional(),
      hebrewCleanup: z.enum(['inherit', 'auto', 'on', 'off']).optional(),
      voiceReply: z.boolean().optional(),
      voiceName: z.string().max(80).optional(),
    }), req.body);
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    if (body.toolAllowlist) body.toolAllowlist = memberTools(req, body.toolAllowlist);
    if (body.workshopIds) body.workshopIds = body.workshopIds.filter((id) => ownerOf(store, 'workshop', id) === me(req));
    if (body.accent && !accentOk(body.accent)) throw http(400, 'Accent colors look like #e4b56a.');
    if (body.avatarKind === 'builtin' && body.avatarRef && !FACES.some((face) => face.id === body.avatarRef)) throw http(400, 'That face is not in the built-in set.');
    const agent = store.updateAgent((req.params as { id: string }).id, body);
    if (!agent) throw http(404, 'Persona not found.');
    return { agent };
  });
  app.get('/api/agents/:id', async (req) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    return { agent };
  });
  // Quick chat: the persona's latest chat, or a new one. Find-or-create runs synchronously on one
  // connection, so rapid or repeated clicks (or two tabs) never make duplicate chats.
  app.post('/api/agents/:id/open-chat', async (req) => {
    const agentId = (req.params as { id: string }).id;
    mustOwn(store, req, 'agent', agentId, 'Persona not found.');
    let session = store.latestSessionForAgent(agentId, me(req));
    const created = !session;
    if (!session) {
      session = store.createSession({ agentId, ownerId: me(req), title: 'New chat' });
      prefillChatWorkspaces(store, session.id, agentId);
      session = store.getSession(session.id)!;
    }
    store.markAgentRead(agentId);
    return { session, created };
  });
  // Capped memory files (USER, NOTES): readable and editable by the persona's owner.
  app.get('/api/agents/:id/memory-files', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'agent', id, 'Persona not found.');
    return { files: memoryFiles(store, id) };
  });
  app.put('/api/agents/:id/memory-files/:kind', async (req) => {
    const { id, kind } = req.params as { id: string; kind: string };
    mustOwn(store, req, 'agent', id, 'Persona not found.');
    if (kind !== 'user' && kind !== 'notes') throw http(404, 'No such memory file.');
    const body = parse(z.object({ content: z.string().max(10_000) }), req.body);
    writeMemoryFile(store, id, kind, body.content);
    return { files: memoryFiles(store, id) };
  });
  app.post('/api/agents/:id/read', async (req) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    store.markAgentRead((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/agents/:id/avatar', async (req) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    const body = parse(z.object({ contentBase64: z.string().min(1) }), req.body);
    const bytes = Buffer.from(body.contentBase64, 'base64');
    let saved;
    try { saved = saveAvatar(config.dataDir, agent.id, bytes); }
    catch (error) { throw http(400, error instanceof Error ? error.message : 'Could not save that image.'); }
    return { agent: store.updateAgent(agent.id, { avatarKind: 'upload', avatarRef: saved.file }) };
  });
  app.get('/api/agents/:id/avatar', async (req, reply) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'No uploaded face.');
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent || agent.avatarKind !== 'upload') throw http(404, 'No uploaded face.');
    const file = avatarPath(config.dataDir, agent.avatarRef);
    if (!file) throw http(404, 'No uploaded face.');
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
    reply.type(type);
    return reply.send(fs.readFileSync(file));
  });
  app.delete('/api/agents/:id', async (req) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    store.deleteAgent((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/agents/:id/files', async (req) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    return { workspace: agent.workspacePath, entries: await listWorkspace(agent.workspacePath) };
  });
  app.get('/api/agents/:id/file', async (req) => {
    mustOwn(store, req, 'agent', (req.params as { id: string }).id, 'Persona not found.');
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    const relative = String((req.query as { path?: string }).path || '');
    try { return { path: relative, content: await readWorkspaceFile(agent.workspacePath, relative) }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'ERR_INVALID_ARG_VALUE') throw http(404, 'File not found.');
      throw http(400, error instanceof Error ? error.message : 'Bad path.');
    }
  });

  app.get('/api/rooms', async (req) => ({ rooms: store.listRooms(me(req)) }));
  app.post('/api/rooms', async (req) => {
    const body = parse(z.object({ name: z.string().min(1), agentIds: z.array(z.string()).min(1) }), req.body);
    for (const id of body.agentIds) mustOwn(store, req, 'agent', id, 'Persona not found.');
    return { room: store.createRoom(body.name, body.agentIds, me(req)) };
  });

  // Files: uploads and agent outputs.
  app.post('/api/files', { bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4) + 4096 }, async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(200), contentBase64: z.string().min(1), sessionId: z.string().optional() }), req.body);
    if (body.sessionId) mustOwn(store, req, 'session', body.sessionId, 'Chat not found.');
    const bytes = Buffer.from(body.contentBase64, 'base64');
    ensureDiskRoom(config.dataDir, bytes.length);
    try {
      const file = saveFile(store, config.dataDir, { name: body.name, bytes, sessionId: body.sessionId ?? null, source: 'upload', ownerId: me(req) });
      ocr.indexImage(file, me(req));
      return { file };
    } catch (error) {
      if (isDiskFullError(error)) throw http(507, 'The disk is full. Free some space, then try again.');
      throw http(400, error instanceof Error ? error.message : 'Could not save the file.');
    }
  });
  app.get('/api/files', async (req) => {
    const query = parse(z.object({ sessionId: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().int().optional(), source: z.enum(['upload', 'agent']).optional() }), req.query);
    if (query.sessionId) mustOwn(store, req, 'session', query.sessionId, 'Chat not found.');
    return { files: listFiles(store, { sessionId: query.sessionId, query: query.q, limit: query.limit, ownerId: me(req), source: query.source }) };
  });
  app.get('/api/files/:id', async (req) => {
    mustOwn(store, req, 'file', (req.params as { id: string }).id, 'File not found.');
    const file = getFile(store, (req.params as { id: string }).id);
    if (!file) throw http(404, 'File not found.');
    return { file };
  });
  // Slide pictures for .pptx previews (rendered once with LibreOffice when it is installed).
  app.get('/api/files/:id/slides', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'file', id, 'File not found.');
    const file = getFile(store, id);
    const full = file ? filePath(store, config.dataDir, id) : null;
    if (!file || !full || !/\.pptx$/i.test(file.name)) throw http(404, 'File not found.');
    const pages = await renderSlides(config.dataDir, id, full).catch((error: Error) => { store.addLog('warn', `Slide preview failed: ${error.message}`); return [] as string[]; });
    return { pages: pages.length, renderer: pages.length ? 'libreoffice' : null };
  });
  app.get('/api/files/:id/slides/:n', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    mustOwn(store, req, 'file', id, 'File not found.');
    const full = filePath(store, config.dataDir, id);
    if (!full) throw http(404, 'File not found.');
    const pages = await renderSlides(config.dataDir, id, full).catch(() => [] as string[]);
    const page = pages[Number(n) - 1];
    if (!page) throw http(404, 'No such slide.');
    reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=3600');
    return reply.send(fs.readFileSync(page));
  });
  app.get('/api/files/:id/raw', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'file', id, 'File not found.');
    const file = getFile(store, id);
    const full = file ? filePath(store, config.dataDir, id) : null;
    if (!file || !full) throw http(404, 'File not found.');
    const download = (req.query as { download?: string }).download === '1';
    const mime = file.mime || mimeFor(file.name);
    // Active types never render as pages on this origin.
    const risky = /html|svg|xml|javascript/.test(mime);
    const encoded = encodeURIComponent(file.name);
    reply.header('content-type', risky && !download ? 'text/plain; charset=utf-8' : mime);
    reply.header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${file.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encoded}`);
    reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('accept-ranges', 'bytes');
    const size = fs.statSync(full).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) { reply.header('content-range', `bytes */${size}`); return reply.code(416).send(); }
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', String(end - start + 1));
      return reply.send(fs.createReadStream(full, { start, end }));
    }
    reply.header('content-length', String(size));
    return reply.send(fs.createReadStream(full));
  });
  app.delete('/api/files/:id', async (req) => {
    mustOwn(store, req, 'file', (req.params as { id: string }).id, 'File not found.');
    if (!deleteFile(store, config.dataDir, (req.params as { id: string }).id)) throw http(404, 'File not found.');
    return { ok: true };
  });
  app.get('/api/messages/:id', async (req) => {
    const message = getMessageRow(store, (req.params as { id: string }).id, me(req));
    if (!message) throw http(404, 'Message not found.');
    return { message };
  });
  app.get('/api/context/search', async (req) => {
    const query = parse(z.object({ q: z.string().min(1), sessionId: z.string().optional(), scope: z.enum(['session', 'all']).optional() }), req.query);
    return { messages: searchMessages(store, { sessionId: query.sessionId, query: query.q, scope: query.scope ?? 'all', limit: 20, ownerId: me(req) }), files: listFiles(store, { query: query.q, limit: 20, ownerId: me(req) }) };
  });
  // Git and the workspace browser: agent workspaces and shared repos / workshop projects.
  const gitToken = () => vault.valueByName('GITHUB_TOKEN') || null;
  // The owner's GitHub token and SSH key never serve a member's repos.
  const identFor = (req: Parameters<typeof accountOf>[0]) => {
    const account = accountOf(req);
    const s = store.getSettings();
    if (account.role === 'member') return { name: account.displayName, email: `${account.username}@local-agent.invalid`, token: null };
    return { name: s.gitName, email: s.gitEmail, sshKey: s.gitSshKey || undefined, token: gitToken() };
  };
  const rootFor = (req: Parameters<typeof accountOf>[0], id: string) => { try { return gitRoot(store, id, me(req)); } catch { throw http(404, 'Unknown folder.'); } };
  app.get('/api/git/roots', async (req) => ({ roots: listGitRoots(store, me(req)).map((root) => ({ ...root, remote: root.remote ? root.remote.replace(/(https?:\/\/)[^@/\s]+@/i, '$1***@') : null })), github: accountOf(req).role === 'owner' && Boolean(gitToken()) }));
  app.get('/api/git/:root/status', async (req) => ({ status: await gitStatus(rootFor(req, (req.params as { root: string }).root).path) }));
  app.get('/api/git/:root/diff', async (req) => {
    const root = rootFor(req, (req.params as { root: string }).root);
    const file = String((req.query as { path?: string }).path || '');
    if (file && (file.startsWith('-') || !isInside(root.path, path.resolve(root.path, file)))) throw http(400, 'Bad path.');
    if (!fs.existsSync(path.join(root.path, '.git'))) return { diff: '' };
    const staged = await git(root.path, ['diff', '--cached', '--', file || '.']);
    const work = await git(root.path, ['diff', '--', file || '.']);
    let untracked = '';
    if (file && !/^exit 0\n\S/.test(work) && fs.existsSync(path.resolve(root.path, file))) {
      const tracked = await git(root.path, ['ls-files', '--error-unmatch', '--', file]);
      if (!/^exit 0\n/.test(tracked)) untracked = `New file ${file}\n` + readExcerpt(root.path, file).text.split('\n').map((line) => `+${line}`).join('\n');
    }
    const strip = (raw: string) => raw.replace(/^exit \d+\n/, '');
    return { diff: [strip(staged), strip(work), untracked].filter((part) => part.trim()).join('\n').slice(0, 200_000) };
  });
  app.get('/api/git/:root/tree', async (req) => {
    const root = rootFor(req, (req.params as { root: string }).root);
    try { return { entries: listDir(root.path, String((req.query as { path?: string }).path || '.')) }; } catch (error) { throw http(400, error instanceof Error ? error.message : 'Bad path.'); }
  });
  app.get('/api/git/:root/raw', async (req, reply) => {
    const root = rootFor(req, (req.params as { root: string }).root);
    const q = req.query as { path?: string; download?: string };
    const full = path.resolve(root.path, String(q.path || ''));
    if (!safeInside(root.path, full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw http(404, 'File not found.');
    const name = path.basename(full);
    const download = q.download === '1';
    const mime = mimeFor(name);
    reply.header('content-type', /html|svg|xml|javascript/.test(mime) && !download ? 'text/plain; charset=utf-8' : mime);
    reply.header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    reply.header('content-length', String(fs.statSync(full).size));
    return reply.send(fs.createReadStream(full));
  });
  app.get('/api/git/:root/file', async (req) => {
    const root = rootFor(req, (req.params as { root: string }).root);
    const q = req.query as { path?: string; start?: string; end?: string };
    try { return { file: readExcerpt(root.path, String(q.path || ''), { start: Number(q.start) || undefined, end: Number(q.end) || undefined }) }; } catch (error) { throw http(400, error instanceof Error ? error.message : 'Bad path.'); }
  });
  /** Save a text file from the workspace editor. Stays inside the root; refused in read-only mode. */
  app.put('/api/git/:root/file', async (req) => {
    const root = rootFor(req, (req.params as { root: string }).root);
    const body = parse(z.object({ path: z.string().min(1).max(1000), content: z.string().max(2_000_000) }), req.body);
    if (store.getSettings().readOnly) throw http(423, 'Read-only mode is on. Turn it off in Settings to save files.');
    const full = path.resolve(root.path, body.path);
    if (body.path.startsWith('-') || !isInside(root.path, full) || full === root.path) throw http(400, 'Bad path.');
    if (full.split(path.sep).includes('.git')) throw http(400, 'Files inside .git cannot be edited here.');
    if (fs.existsSync(full) && !fs.statSync(full).isFile()) throw http(400, 'That is a folder.');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body.content);
    return { ok: true, bytes: Buffer.byteLength(body.content) };
  });
  app.post('/api/git/clone', async (req) => {
    const body = parse(z.object({ url: z.string().min(1), label: z.string().optional(), workshopId: z.string().optional(), parentDir: z.string().max(500).optional() }), req.body);
    if (body.parentDir && accountOf(req).role === 'member') throw http(403, 'Only the owner can pick a clone location.');
    try { return await cloneInto(store, config.dataDir, body); } catch (error) { throw http(400, error instanceof Error ? error.message : 'Clone failed.'); }
  });
  app.post('/api/git/:root/action', async (req) => {
    const root = rootFor(req, (req.params as { root: string }).root);
    const body = parse(z.object({
      action: z.enum(['init', 'fetch', 'pull', 'commit', 'branch', 'checkout', 'push', 'open_pr', 'remote']),
      message: z.string().optional(), name: z.string().optional(), url: z.string().optional(), title: z.string().optional(), body: z.string().optional(), base: z.string().optional(),
      paths: z.array(z.string()).optional(), confirmMain: z.boolean().optional(),
    }), req.body);
    const cwd = root.path;
    const strip = (raw: string) => raw.replace(/^exit \d+\n/, '');
    const fail = (raw: string, what: string) => { if (!/^exit 0\n/.test(raw)) throw http(400, `${what} failed.\n${strip(raw).slice(0, 1200)}`); return strip(raw); };
    if (body.action === 'init') return { output: fail(await git(cwd, ['init', '-b', 'main']), 'git init') };
    if (body.action === 'fetch') return { output: fail(await git(cwd, ['fetch', '--prune'], identFor(req)), 'Fetch') };
    if (body.action === 'pull') {
      const out = await git(cwd, ['pull', '--ff-only'], identFor(req));
      if (!/^exit 0\n/.test(out)) throw http(409, /diverg|fast-forward|CONFLICT/i.test(out) ? 'Pull stopped: the histories diverged. Nothing was merged.' : `Pull failed.\n${strip(out).slice(0, 1200)}`);
      return { output: strip(out) };
    }
    if (body.action === 'commit') {
      const message = (body.message || '').trim();
      if (!message) throw http(400, 'Write a commit message.');
      const scan = await runPreCommitSemgrep(docker, cwd, { dataDir: config.dataDir });
      if (!scan.ok) throw http(400, scan.summary);
      const paths = (body.paths || []).filter((p) => p && !p.startsWith('-') && isInside(cwd, path.resolve(cwd, p)));
      fail(await git(cwd, ['add', '-A', '--', ...(paths.length ? paths : ['.'])]), 'Staging');
      const out = await git(cwd, ['commit', '-m', message], identFor(req));
      if (/nothing to commit/i.test(out)) throw http(400, 'Nothing to commit.');
      return { output: fail(out, 'Commit'), securityScan: scan.summary };
    }
    if (body.action === 'branch' || body.action === 'checkout') {
      const name = (body.name || '').trim();
      if (!validBranch(name)) throw http(400, 'Branch names look like feature/login-fix.');
      return { output: fail(await git(cwd, body.action === 'branch' ? ['checkout', '-b', name] : ['checkout', name]), body.action === 'branch' ? 'New branch' : 'Checkout') };
    }
    if (body.action === 'remote') {
      const url = (body.url || '').trim();
      if (!url || /[\s;&|`$]/.test(url)) throw http(400, 'Give a remote URL.');
      // A member's remote is a network URL: local paths could reach someone else's folders.
      if (accountOf(req).role === 'member' && !/^(https:\/\/|ssh:\/\/|git@)/i.test(url)) throw http(400, 'Use an https:// or ssh remote.');
      const has = await git(cwd, ['remote', 'get-url', 'origin']);
      return { output: fail(await git(cwd, /^exit 0\n/.test(has) ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]), 'Setting origin') };
    }
    if (body.action === 'push') {
      try {
        const pushed = await pushBranch(cwd, identFor(req), { allowMain: body.confirmMain === true });
        if (!pushed.ok) throw http(409, pushed.output.slice(0, 1500));
        return { output: pushed.output, branch: pushed.branch };
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode) throw error;
        throw http(400, error instanceof Error ? error.message : 'Push failed.');
      }
    }
    try {
      const pr = await openPullRequest(cwd, identFor(req).token ?? null, fetchImpl, { title: (body.title || '').trim() || 'Changes from local-agent', body: body.body, base: body.base });
      return { pr };
    } catch (error) {
      throw http(400, error instanceof Error ? error.message : 'Could not open the PR.');
    }
  });
  app.get('/api/workshops', async (req) => ({ workshops: listWorkshops(store).filter((workshop) => ownerOf(store, 'workshop', workshop.id) === me(req)) }));
  app.post('/api/workshops', async (req) => {
    const body = parse(z.object({
      name: z.string().min(1),
      agentId: z.string().optional(),
      projects: z.array(z.object({ label: z.string().min(1), path: z.string().min(1) })).min(1).max(8),
    }), req.body);
    let workshop;
    try {
      workshop = createWorkshop(store, body);
    } catch (error) {
      throw http(400, error instanceof Error ? error.message : 'Could not open that workshop.');
    }
    if (body.agentId) mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    const coder = store.listAgents(me(req)).find((agent) => agent.toolAllowlist.includes('git')) ?? store.listAgents(me(req))[0];
    const agentId = body.agentId || coder?.id;
    if (!agentId) throw http(400, 'Create a persona first. The coder is the one that should own a workshop.');
    const session = store.createSession({ agentId, title: workshop.name });
    store.updateSession(session.id, { mode: 'code', workshopId: workshop.id });
    return { workshop, session: store.getSession(session.id) };
  });
  app.get('/api/sessions', async (req) => {
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), cursor: z.string().optional() }), req.query);
    const page = store.pageSessions({ limit: query.limit ?? 100, cursor: query.cursor || null, ownerId: me(req) });
    const untitled = page.sessions.filter((row) => needsTitle(row.titleSource) && row.title !== 'New chat').slice(0, 10).map((row) => row.id);
    if (untitled.length) engine.queueTitles(untitled);
    return page;
  });
  app.post('/api/sessions', async (req) => {
    const body = parse(z.object({ agentId: z.string().optional(), roomId: z.string().optional(), title: z.string().optional(), mode: z.enum(['chat', 'code']).optional() }), req.body);
    if (body.agentId) mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    if (body.roomId) mustOwn(store, req, 'room', body.roomId, 'Room not found.');
    if (!body.agentId && !body.roomId) body.agentId = store.listAgents(me(req))[0]?.id;
    const session = store.createSession({ ...body, ownerId: me(req) });
    if (body.mode) store.updateSession(session.id, { mode: body.mode });
    // The persona's default workspaces pre-fill a new chat.
    prefillChatWorkspaces(store, session.id, body.agentId);
    return { session: store.getSession(session.id) };
  });
  // Everything this chat set in motion: helpers, timers/triggers it created, and files in both directions.
  app.get('/api/sessions/:id/context', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const helpers = engine.autonomy.listHelpers(id).map((h) => {
      const childRun = h.childRunId ? store.getRun(h.childRunId) : null;
      const modelName = childRun?.modelId ? (store.getModel(childRun.modelId)?.name || childRun.modelId) : null;
      return { ...h, modelName };
    });
    const files = listFiles(store, { sessionId: id, limit: 200, ownerId: me(req) });
    // Files a helper produced count as this chat's output too.
    const helperFiles = helpers.flatMap((row) => listFiles(store, { sessionId: row.childSessionId, limit: 50, ownerId: me(req), source: 'agent' }).map((file) => ({ ...file, helperId: row.id })));
    const childRuns = new Set(helpers.map((row) => row.childRunId).filter(Boolean));
    const waiting = store.listApprovals('pending').filter((approval) => childRuns.has(approval.runId));
    return {
      helpers, approvals: waiting,
      breakdown: engine.getSessionContextBreakdown(id),
      timers: engine.autonomy.timersFor(id), triggers: accountOf(req).role === 'member' ? [] : engine.autonomy.triggersFor(id),
      files: { uploads: files.filter((file) => file.source === 'upload'), produced: [...files.filter((file) => file.source !== 'upload'), ...helperFiles] },
      // One entry per reply that changed files and can still be rolled back.
      checkpoints: (store.db.prepare(`SELECT run_id AS runId, COUNT(*) AS edits, GROUP_CONCAT(label, ', ') AS labels, MAX(created_at) AS createdAt FROM edit_batches
        WHERE session_id = ? AND run_id IS NOT NULL AND reverted_at IS NULL GROUP BY run_id ORDER BY createdAt DESC LIMIT 20`).all(id) as { runId: string; edits: number; labels: string; createdAt: string }[])
        .map((row) => ({ ...row, edits: Number(row.edits), labels: String(row.labels || '').slice(0, 200) })),
    };
  });
  // One click: undo every file edit a reply made (newest checkpoint first).
  app.post('/api/runs/:id/rollback', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'run', id, 'Run not found.');
    if (store.getSettings().readOnly) throw http(423, 'Read-only mode is on.');
    try { return { reverted: await rollbackRun(store, id) }; }
    catch (error) { if (error instanceof RollbackConflict) throw http(409, error.message); throw error; }
  });
  // Rule files the chat's workspaces bring (AGENTS.md, .cursor/rules, CLAUDE.md…), each switchable per chat.
  app.get('/api/sessions/:id/rules', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const rules = discoverRules(chatWorkspacePaths(store, id, me(req)), disabledRules(store, id));
    return { rules: rules.map(({ text, ...rule }) => ({ ...rule, preview: text.slice(0, 400) })), caps: { file: RULE_FILE_CAP, total: RULE_TOTAL_CAP } };
  });
  app.put('/api/sessions/:id/rules', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const body = parse(z.object({ key: z.string().min(1).max(2000), enabled: z.boolean() }), req.body);
    setRuleEnabled(store, id, body.key, body.enabled);
    return { ok: true };
  });
  app.post('/api/helpers/:id/stop', async (req) => {
    const helper = engine.autonomy.getHelper((req.params as { id: string }).id);
    if (!helper || helper.ownerId !== me(req)) throw http(404, 'Helper not found.');
    return { helper: engine.autonomy.stop(helper.id) };
  });
  app.get('/api/sessions/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const session = store.getSession(id);
    if (!session) throw http(404, 'Chat not found.');
    const workshop = session.workshopId ? getWorkshop(store, session.workshopId) : null;
    // ?limit=N returns only the newest N messages (and hasMore); older pages come from /messages?before=.
    const limit = Number((req.query as { limit?: string }).limit);
    const page = Number.isFinite(limit) && limit > 0 ? store.pageMessages(id, Math.min(500, Math.floor(limit))) : { messages: store.listMessages(id), hasMore: false };
    // A reply still running here (another tab, or a reload mid-run), so the page can attach to its stream.
    const activeRun = (store.db.prepare(`SELECT id, status FROM runs WHERE session_id = ? AND parent_run_id IS NULL AND status IN ('running', 'awaiting_approval', 'paused') ORDER BY started_at DESC LIMIT 1`).get(id) as { id: string; status: string } | undefined) ?? null;
    const live = activeRun ? engine.getLiveStream(activeRun.id) : null;
    return { session, activeRun, live, breakdown: engine.getSessionContextBreakdown(id), messages: page.messages, hasMore: page.hasMore, summaries: store.listSummaries(id), plan: readPlan(store, id), edits: listEdits(store, id), archived: store.listArchived(id), workshop };
  });
  app.get('/api/sessions/:id/messages', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const query = parse(z.object({ before: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return store.pageMessages(id, query.limit ?? 100, query.before ?? null);
  });
  app.patch('/api/sessions/:id', async (req) => {
    const body = parse(z.object({
      title: z.string().optional(),
      mode: z.enum(['chat', 'code']).optional(),
      modelPin: z.string().nullable().optional(),
      effort: z.enum(['auto', 'off', 'low', 'medium', 'high']).nullable().optional(),
      agentId: z.string().optional(),
      workshopId: z.string().nullable().optional(),
    }), req.body);
    if (body.workshopId) { mustOwn(store, req, 'workshop', body.workshopId, 'Workspace set not found.'); body.mode = body.mode ?? 'code'; }
    mustOwn(store, req, 'session', (req.params as { id: string }).id, 'Chat not found.');
    if (body.agentId) mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    if (body.modelPin) body.modelPin = allowedModel(req, chatModelId(store, body.modelPin));
    const id = (req.params as { id: string }).id;
    // A title typed by the user is theirs: generated titles never replace it.
    if (body.title !== undefined) { const title = body.title.trim().slice(0, 120); delete body.title; if (title) store.setSessionTitle(id, title, 'user'); }
    const effort = body.effort !== undefined ? (body.effort === 'auto' ? null : body.effort) : undefined;
    const { effort: _ignored, ...rest } = body;
    const patch = effort !== undefined ? { ...rest, effort } : rest;
    return { session: store.updateSession(id, patch) };
  });
  /** The workspaces this chat works in (its context), sets expanded, with branch and uncommitted count. */
  app.get('/api/sessions/:id/workspaces', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    return resolveChatWorkspaces(store, id, me(req));
  });
  app.put('/api/sessions/:id/workspaces', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const body = parse(z.object({ items: z.array(z.object({ kind: z.enum(['root', 'set']), id: z.string().min(1).max(200) })).max(24) }), req.body);
    const roots = new Set(listGitRoots(store, me(req)).map((root) => root.id));
    for (const item of body.items) {
      if (item.kind === 'set') mustOwn(store, req, 'workshop', item.id, 'Workspace set not found.');
      else if (!roots.has(item.id)) throw http(404, 'Unknown workspace.');
    }
    setChatWorkspaces(store, id, body.items);
    return { ...(await resolveChatWorkspaces(store, id, me(req))), session: store.getSession(id) };
  });
  app.post('/api/sessions/:id/compact', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    if (engine.sessionBusy(id)) throw http(409, 'Wait for the current reply to finish or press Stop before compacting.');
    return engine.compactSession(id);
  });
  app.post('/api/sessions/:id/handoff', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    return engine.handoffSession(id);
  });
  app.get('/api/projects/discover', async (req) => {
    if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can discover local projects.');
    const root = process.env.LA_PROJECTS_DIR || '/projects';
    if (!fs.existsSync(root)) return { root, repos: [] };
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    const repos: { name: string; path: string; isGit: boolean }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(root, entry.name);
      const isGit = fs.existsSync(path.join(full, '.git'));
      repos.push({ name: entry.name, path: full, isGit });
    }
    repos.sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));
    return { root, repos };
  });
  app.post('/api/projects/attach', async (req) => {
    if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can attach local projects.');
    const body = parse(z.object({ path: z.string().min(1), name: z.string().optional(), sessionId: z.string().optional() }), req.body);
    const root = path.resolve(process.env.LA_PROJECTS_DIR || '/projects');
    const target = path.resolve(body.path);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) throw http(400, 'Project must live inside the mounted projects directory.');
    if (!fs.existsSync(target)) throw http(404, 'Project folder not found.');
    const label = (body.name || path.basename(target)).trim().slice(0, 60);
    const existing = listSharedRepos(store).find((r) => path.resolve(r.path) === target);
    const repo = existing ?? registerSharedRepo(store, { label, path: target, remote: null });
    if (body.sessionId) {
      mustOwn(store, req, 'session', body.sessionId, 'Chat not found.');
      const rootEntry = listGitRoots(store, me(req)).find((r) => path.resolve(r.path) === target);
      const rootId = rootEntry?.id ?? `repo:${repo.label}`;
      const current = getChatWorkspaces(store, body.sessionId);
      if (!current.some((item) => item.kind === 'root' && item.id === rootId)) {
        setChatWorkspaces(store, body.sessionId, [...current, { kind: 'root', id: rootId }]);
      }
      return { repo, ...(await resolveChatWorkspaces(store, body.sessionId, me(req))) };
    }
    return { repo };
  });
  app.get('/api/github/repos', async (req) => {
    if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can browse GitHub repos.');
    const token = gitToken() || process.env.GITHUB_TOKEN || '';
    const userParam = String((req.query as { user?: string }).user || '').trim();
    const headers: Record<string, string> = { 'user-agent': 'local-agent', accept: 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const url = token && !userParam
      ? 'https://api.github.com/user/repos?sort=updated&per_page=40&affiliation=owner,collaborator'
      : `https://api.github.com/users/${encodeURIComponent(userParam || 'acid-code')}/repos?sort=updated&per_page=30`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw http(res.status === 401 ? 401 : 502, `GitHub API returned ${res.status}. ${token ? 'Check GITHUB_TOKEN in Settings → Vault.' : 'Save GITHUB_TOKEN in Settings → Vault for private repos.'}`);
    const list = await res.json() as { name: string; full_name: string; clone_url: string; private: boolean; description?: string | null; default_branch?: string }[];
    const root = path.resolve(process.env.LA_PROJECTS_DIR || '/projects');
    return {
      authenticated: Boolean(token),
      repos: list.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        isPrivate: Boolean(r.private),
        description: r.description || '',
        defaultBranch: r.default_branch || 'main',
        cloned: fs.existsSync(path.join(root, r.name)),
      })),
    };
  });
  app.post('/api/github/clone', async (req) => {
    if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can clone GitHub repos.');
    const body = parse(z.object({ cloneUrl: z.string().url(), name: z.string().min(1).max(80), sessionId: z.string().optional() }), req.body);
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/i.test(body.cloneUrl)) throw http(400, 'Only https://github.com/<owner>/<repo> URLs are allowed.');
    const safeName = path.basename(body.name).replace(/[^a-zA-Z0-9._-]+/g, '-');
    const root = path.resolve(process.env.LA_PROJECTS_DIR || '/projects');
    await fs.promises.mkdir(root, { recursive: true });
    const target = path.resolve(root, safeName);
    if (!target.startsWith(`${root}${path.sep}`)) throw http(400, 'Invalid repo name.');
    if (!fs.existsSync(target)) {
      const token = gitToken() || process.env.GITHUB_TOKEN || '';
      const authUrl = token ? body.cloneUrl.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(token)}@`) : body.cloneUrl;
      await git(root, ['clone', authUrl, target]);
      if (token) await git(target, ['remote', 'set-url', 'origin', body.cloneUrl]).catch(() => undefined);
    }
    const existing = listSharedRepos(store).find((r) => path.resolve(r.path) === target);
    const repo = existing ?? registerSharedRepo(store, { label: safeName, path: target, remote: body.cloneUrl });
    if (body.sessionId) {
      mustOwn(store, req, 'session', body.sessionId, 'Chat not found.');
      const rootEntry = listGitRoots(store, me(req)).find((r) => path.resolve(r.path) === target);
      const rootId = rootEntry?.id ?? `repo:${repo.label}`;
      const current = getChatWorkspaces(store, body.sessionId);
      if (!current.some((item) => item.kind === 'root' && item.id === rootId)) {
        setChatWorkspaces(store, body.sessionId, [...current, { kind: 'root', id: rootId }]);
      }
      return { repo, ...(await resolveChatWorkspaces(store, body.sessionId, me(req))) };
    }
    return { repo };
  });
  app.post('/api/projects/create', async (req) => {
    if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can create new projects.');
    const body = parse(z.object({
      name: z.string().min(1).max(60),
      description: z.string().max(240).optional(),
      createGithub: z.boolean().optional(),
      isPrivate: z.boolean().optional(),
      sessionId: z.string().optional(),
    }), req.body);
    if (body.sessionId) mustOwn(store, req, 'session', body.sessionId, 'Chat not found.');
    const res = await scaffoldProject({
      store,
      ownerId: me(req),
      name: body.name,
      description: body.description,
      createGithub: Boolean(body.createGithub),
      isPrivate: body.isPrivate !== false,
      token: gitToken() || process.env.GITHUB_TOKEN || null,
      fetchImpl,
      sessionId: body.sessionId ?? null,
    });
    if (body.sessionId) return { ...res, ...(await resolveChatWorkspaces(store, body.sessionId, me(req))) };
    return res;
  });
  app.get('/api/sessions/:id/mention-files', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const q = String((req.query as { q?: string }).q || '').trim().toLowerCase();
    const resolved = await resolveChatWorkspaces(store, id, me(req));
    const items: { kind: 'file' | 'git' | 'repo'; label: string; insert: string; detail: string }[] = [];
    const seen = new Set<string>();
    if (!q || 'git'.includes(q) || 'diff'.includes(q) || 'status'.includes(q)) {
      items.push({ kind: 'git', label: '@git', insert: '@git (inspect git status and diff in the attached repo) ', detail: 'Current git status & diff' });
    }
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);
    for (const root of resolved.roots.slice(0, 4)) {
      const walk = async (dir: string, depth: number) => {
        if (depth > 4 || items.length >= 28) return;
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (items.length >= 28) break;
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) await walk(path.join(dir, entry.name), depth + 1);
          } else {
            const rel = path.relative(root.path, path.join(dir, entry.name));
            const fullLabel = `${root.label}/${rel}`;
            if (q && !fullLabel.toLowerCase().includes(q)) continue;
            if (seen.has(fullLabel)) continue;
            seen.add(fullLabel);
            items.push({ kind: 'file', label: fullLabel, insert: `@${fullLabel} `, detail: root.label });
          }
        }
      };
      await walk(root.path, 0);
    }
    return { items };
  });
  app.get('/api/schedules/presets', async () => ({
    presets: [
      {
        id: 'morning-brief',
        name: '[HEARTBEAT] Morning Brief',
        cron: '0 8 * * *',
        prompt: '[HEARTBEAT] Check any open tasks, upcoming timers, and recent git activity in attached repos. Give a crisp 5-bullet morning briefing.',
        description: 'Daily 8:00 AM summary on the fast model.',
      },
      {
        id: 'server-watchdog',
        name: '[WATCHDOG] Server & GPU Health',
        cron: '*/30 * * * *',
        prompt: '[WATCHDOG] Check disk space, available RAM, and whether local-agent services (llama-server, SearXNG, OCR, Piper) are healthy. Only alert if disk > 85%, MemAvailable < 4 GiB, or a service is down.',
        description: 'Runs every 30 min on the fast model; stays silent (HEARTBEAT_OK) unless an issue is detected.',
      },
      {
        id: 'repo-watchdog',
        name: '[WATCHDOG] Repo & Git Status',
        cron: '0 */2 * * *',
        prompt: '[WATCHDOG] Check git status in attached repos for uncommitted changes left behind or failed checks. Only alert if something needs attention.',
        description: 'Runs every 2 hours on the fast model; only pings when dirty/broken.',
      },
    ],
  }));
  app.delete('/api/sessions/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const permanent = String((req.query as { permanent?: string }).permanent || '') === '1';
    mustOwn(store, req, 'session', id, 'Chat not found.');
    if (engine.sessionBusy(id)) throw http(409, 'A reply is still running in this chat. Press Stop first, then delete it.');
    engine.autonomy.stopForSession(id);
    if (permanent) {
      deleteSessionPermanently(store.db, id, config.dataDir);
    } else {
      store.updateSession(id, { archived: true });
    }
    engine.sweepStaleWaits();
    return { ok: true, permanent };
  });
  app.post('/api/sessions/:id/messages', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const session = store.getSession(id);
    if (!session) throw http(404, 'Chat not found.');
    const body = parse(z.object({
      content: z.string().min(1), agentId: z.string().optional(), modelId: z.string().optional(), imageUrl: z.string().optional(),
      mentions: z.array(z.union([
        z.object({ kind: z.literal('path'), root: z.string().min(1), path: z.string(), start: z.number().int().positive().optional(), end: z.number().int().positive().optional() }),
        z.object({ kind: z.literal('file'), id: z.string().min(1), ocr: z.enum(['auto', 'printed', 'handwriting']).optional() }),
      ])).max(12).optional(),
    }), req.body);
    const modelId = body.modelId ? allowedModel(req, chatModelId(store, body.modelId)) : undefined;
    if (!body.content.trim()) throw http(400, 'Type a message first.');
    const agentId = body.agentId || session.agentId;
    if (!agentId) throw http(400, 'Choose a persona.');
    mustOwn(store, req, 'agent', agentId, 'Persona not found.');
    for (const mention of body.mentions ?? []) {
      if (mention.kind === 'file') mustOwn(store, req, 'file', mention.id, 'File not found.');
      else rootFor(req, mention.root);
    }
    if (engine.sessionBusy(id)) throw http(409, 'A reply is still running in this chat. Wait for it or press Stop, then send again.');
    const offers = vault.capture(null, body.content);
    let context = body.mentions?.length ? expandMentions(store, body.mentions.map((mention) => (mention.kind === 'file' ? { kind: 'file' as const, id: mention.id } : mention)), me(req)) : '';
    // Photos sent with "read text" on: OCR text rides along as context (printed via Tesseract, handwriting via a vision model).
    for (const mention of body.mentions ?? []) {
      if (mention.kind !== 'file' || !mention.ocr || !engine.ocrReader) continue;
      const file = getFile(store, mention.id);
      if (!file || !(/^image\//.test(file.mime) || /\.(jpe?g|png|webp|heic|heif|tiff?|bmp|gif)$/i.test(file.name))) continue;
      try {
        const result = await engine.ocrReader(mention.id, mention.ocr, me(req));
        const how = `${result.engine === 'vision' ? `vision model ${result.model}` : `Tesseract, confidence ${Math.round(result.confidence ?? 0)}`}; direction ${result.direction}`;
        const ocrBody = result.text || '(no text found — OCR-only; call understand_image with file_id ' + mention.id + ' to inspect the visual contents of this image)';
        context += `${context ? '\n\n' : ''}### Text read from ${file.name} (${how})\n${ocrBody}${result.notes.length ? `\n(${result.notes.join(' ')})` : ''}`;
      } catch (error) {
        context += `${context ? '\n\n' : ''}### Text read from ${file.name}\n(OCR failed: ${error instanceof Error ? error.message : 'error'})`;
      }
    }
    const content = context ? `${body.content}${CONTEXT_MARK}${context}` : body.content;
    const run = await engine.startTurn({ sessionId: id, agentId, content: vault.redact(content), imageUrl: body.imageUrl, modelId });
    return { run, offers };
  });
  app.get('/api/sessions/:id/plan', async (req) => { mustOwn(store, req, 'session', (req.params as { id: string }).id, 'Chat not found.'); return { plan: readPlan(store, (req.params as { id: string }).id) }; });
  app.put('/api/sessions/:id/plan', async (req) => {
    mustOwn(store, req, 'session', (req.params as { id: string }).id, 'Chat not found.');
    const body = parse(z.object({ items: z.array(z.string()).max(30) }), req.body);
    return { plan: replacePlan(store, (req.params as { id: string }).id, body.items) };
  });
  app.post('/api/sessions/:id/plan/undo', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'session', id, 'Chat not found.');
    const plan = undoPlan(store, id);
    return { plan };
  });
  app.patch('/api/plan-items/:id', async (req) => {
    const body = parse(z.object({ text: z.string().optional(), status: z.string().optional(), note: z.string().optional() }), req.body);
    const planSession = store.db.prepare('SELECT p.session_id AS s FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ?').get((req.params as { id: string }).id) as { s?: string } | undefined;
    if (!planSession?.s || ownerOf(store, 'session', planSession.s) !== me(req)) throw http(404, 'Plan item not found.');
    if (!updatePlanItem(store, (req.params as { id: string }).id, body)) throw http(404, 'Plan item not found.');
    return { ok: true };
  });
  app.get('/api/sessions/:id/edits', async (req) => { mustOwn(store, req, 'session', (req.params as { id: string }).id, 'Chat not found.'); return { edits: listEdits(store, (req.params as { id: string }).id) }; });
  app.post('/api/edits/:id/revert', async (req) => {
    const batch = store.db.prepare('SELECT session_id AS s FROM edit_batches WHERE id = ?').get((req.params as { id: string }).id) as { s?: string } | undefined;
    if (!batch?.s || ownerOf(store, 'session', batch.s) !== me(req)) throw http(404, 'Edit not found.');
    try { await revertBatch(store, (req.params as { id: string }).id); }
    catch (error) { if (error instanceof RollbackConflict) throw http(409, error.message); throw error; }
    return { ok: true };
  });
  app.post('/api/edits/:id/revert-file', async (req) => {
    const id = (req.params as { id: string }).id;
    const batch = store.db.prepare('SELECT session_id AS s FROM edit_batches WHERE id = ?').get(id) as { s?: string } | undefined;
    if (!batch?.s || ownerOf(store, 'session', batch.s) !== me(req)) throw http(404, 'Edit not found.');
    const body = parse(z.object({ path: z.string().min(1).max(2000) }), req.body);
    try { await revertBatchFile(store, id, body.path); }
    catch (error) { if (error instanceof RollbackConflict) throw http(409, error.message); throw error; }
    return { ok: true };
  });
  app.post('/api/edits/:id/keep', async (req) => {
    const id = (req.params as { id: string }).id;
    const batch = store.db.prepare('SELECT session_id AS s FROM edit_batches WHERE id = ?').get(id) as { s?: string } | undefined;
    if (!batch?.s || ownerOf(store, 'session', batch.s) !== me(req)) throw http(404, 'Edit not found.');
    const body = parse(z.object({ path: z.string().min(1).max(2000).optional() }), req.body);
    keepBatch(store, id, body.path);
    return { ok: true };
  });

  app.get('/api/runs', async (req) => ({ runs: store.listRuns().filter((run) => ownerOf(store, 'session', run.sessionId) === me(req)) }));
  app.get('/api/runs/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'run', id, 'Run not found.');
    const run = store.getRun(id);
    if (!run) throw http(404, 'Run not found.');
    return { run, steps: store.listSteps(id), checkpoints: store.listCheckpoints(id) };
  });
  app.get('/api/runs/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = store.getRun(id);
    if (!run || ownerOf(store, 'run', id) !== me(req)) return reply.code(404).send({ error: 'Run not found.' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const live = engine.getLiveStream(id);
    send({
      type: 'snapshot',
      run: store.getRun(id),
      steps: store.listSteps(id),
      messages: store.listMessages(run.sessionId),
      streaming: live?.text ?? '',
      thinking: live?.thinking ?? '',
      statusDetail: live?.detail ?? '',
      waitInfo: live?.waitInfo ?? null,
    });
    const off = bus.subscribeRun(id, send);
    const beat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(beat); off(); });
  });
  // One chat's live feed: a snapshot on every (re)connect, then that chat's run events, whichever device or timer
  // started the run. Clients keep this open while the chat is on screen, so new messages, steps and status changes
  // arrive within a second and a reconnect always resyncs. ?tokens=1 also streams token/thinking (the phone app).
  app.get('/api/sessions/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSession(id) || ownerOf(store, 'session', id) !== me(req)) return reply.code(404).send({ error: 'Chat not found.' });
    const tokens = (req.query as { tokens?: string }).tokens === '1';
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 50));
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // retry: the browser reconnects after 1s (default is ~3s) when the connection drops.
    reply.raw.write('retry: 1000\n\n');
    const send = (event: unknown) => { try { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } };
    const activeRun = activeRunOf(store, id);
    const live = activeRun ? engine.getLiveStream(activeRun.id) : null;
    const page = store.pageMessages(id, limit);
    send({ type: 'snapshot', sessionId: id, activeRun, live, steps: activeRun ? store.listSteps(activeRun.id) : [], messages: page.messages, hasMore: page.hasMore });
    const filter = sessionEventFilter(store, id, { tokens });
    const off = bus.subscribeAll((event) => { const out = filter(event); if (out) send(out); });
    const beat = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
    req.raw.on('close', () => { clearInterval(beat); off(); });
  });
  app.post('/api/runs/:id/control', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'run', id, 'Run not found.');
    const body = parse(z.object({ action: z.enum(['pause', 'resume', 'stop', 'force', 'retry_from']), checkpointId: z.string().optional() }), req.body);
    if (body.action === 'pause') return { run: engine.pause(id) };
    if (body.action === 'stop') return { run: engine.stop(id) };
    if (body.action === 'force') return engine.forceRun(id);
    if (body.action === 'retry_from') {
      if (!body.checkpointId) throw http(400, 'checkpointId is required.');
      return engine.retryFrom(id, body.checkpointId);
    }
    return { run: await engine.resume(id) };
  });
  app.post('/api/runs/:id/steer', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'run', id, 'Run not found.');
    const body = parse(z.object({ content: z.string().min(1).max(8_000) }), req.body);
    const run = engine.steer(id, body.content.trim());
    return { run, steering: true };
  });

  // Pending approvals of this account, with the chat they belong to and a risk tier, so a phone can list them and jump to the chat.
  app.get('/api/approvals', async (req) => ({ swept: engine.sweepStaleWaits(), approvals: store.listApprovals('pending').filter((approval) => ownerOf(store, 'run', approval.runId) === me(req)).map((approval) => approvalView(store, approval)) }));
  app.get('/api/approvals/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'approval', id, 'Approval not found.');
    const approval = store.getApproval(id);
    if (!approval) throw http(404, 'Approval not found.');
    return { approval: approvalView(store, approval) };
  });
  app.post('/api/approvals/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'approval', id, 'Approval not found.');
    const body = parse(z.object({ decision: z.enum(['approve', 'deny']) }), req.body);
    // A stale button (an old notification, a second device) must not flip a decision that was already made.
    const current = store.getApproval(id);
    if (current && current.status !== 'pending') throw http(409, `Already ${current.status}.`);
    return { approval: engine.decideApproval(id, body.decision === 'approve' ? 'approved' : 'denied') };
  });

  // Members with cloud off stay on local models, even when they pick one by hand.
  const allowedModel = (req: Parameters<typeof accountOf>[0], modelId: string) => {
    const account = accountOf(req);
    if (account.role === 'member' && !account.limits.cloud && !store.getModel(modelId)?.local) throw http(403, 'Cloud models are off for your account. Pick a local model.');
    return modelId;
  };
  app.get('/api/models', async () => {
    const minute = new Date().toISOString().slice(0, 16);
    const day = geminiQuotaDay();
    const quota = FREE_TIER_SNAPSHOT.map((row) => {
      const used = store.quotaUse(row.apiName, day);
      const local = { rpm: used.rpmWindow === minute ? used.rpm : 0, tpm: used.tpmWindow === minute ? used.tpm : 0, rpd: used.rpd };
      // Usage is only what this install sent; the numbers in the snapshot are documented limits.
      return { ...row, rpm: { ...row.rpm, used: local.rpm }, tpm: { ...row.tpm, used: local.tpm }, rpd: { ...row.rpd, used: local.rpd }, availability: quotaAvailability(row, local) };
    });
    const geminiConnected = Boolean(process.env.GEMINI_API_KEY);
    const autoRoles = await autoRoleReport(store, fetchImpl).catch(() => null);
    return { models: store.listModels(), providers: store.listProviders(), resident: lastScan?.resident ?? [], quota, quotaObservedAt: FREE_TIER_OBSERVED_AT, geminiConnected, autoRoles };
  });
  /** What the model pickers may offer this account right now (Auto is always on top in the UI). */
  app.get('/api/models/usable', async (req) => {
    const account = accountOf(req);
    return { ...usableModels(store, { cloudAllowed: account.role !== 'member' || account.limits.cloud }), canManage: account.role !== 'member' };
  });
  app.post('/api/models/scan', async () => {
    lastScan = await scanMachine(fetchImpl, docker, store);
    engine.residentLarge = lastScan.resident;
    return { models: store.listModels(), discovery: lastScan, checklist: checklist(lastScan, store) };
  });
  app.post('/api/models', async (req) => {
    const body = parse(z.object({ providerId: z.string(), name: z.string().min(1) }), req.body);
    const { resolveProfile } = await import('@local-agent/shared');
    const profile = resolveProfile(body.name);
    return {
      model: store.upsertModel({
        id: `custom_${body.name.replace(/[^a-z0-9]+/gi, '_')}`, providerId: body.providerId, name: body.name, apiName: body.name, profileId: profile.id,
        tokenizer: profile.tokenizer, contextWindow: profile.contextWindow, practicalBudget: profile.practicalBudget, strategy: profile.strategy,
        sizeClass: profile.sizeClass, local: false, modalities: profile.modalities, strengths: profile.strengths, typicalQ4GiB: null,
        priceIn: profile.priceIn ?? null, priceOut: profile.priceOut ?? null, notes: profile.notes, parameterSize: null, family: profile.family,
        source: 'custom', embedding: false, freeTier: profile.freeTier ?? null, enabled: true,
      }),
    };
  });
  app.post('/api/providers', async (req) => {
    const body = parse(z.object({
      id: z.string().min(2).max(60).optional(),
      name: z.string().min(1).max(80),
      kind: z.enum(['openai_compat', 'gemini', 'openrouter']).default('openai_compat'),
      baseUrl: z.string().url(),
      apiKeyEnv: z.string().nullable().optional(),
      enabled: z.boolean().default(true),
    }), req.body);
    const cleanId = body.id
      ? (body.id.startsWith('prov_') ? body.id : `prov_${body.id}`)
      : `prov_${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const provider = store.upsertProvider({
      id: cleanId,
      kind: body.kind ?? 'openai_compat',
      name: body.name,
      baseUrl: body.baseUrl.replace(/\/$/, ''),
      apiKeyEnv: body.apiKeyEnv ?? null,
      enabled: body.enabled ?? true,
    });
    lastScan = await scanMachine(fetchImpl, docker, store).catch(() => lastScan);
    bus.publish({ type: 'models_updated' });
    return { provider, models: store.listModels() };
  });
  app.patch('/api/providers/:id', async (req) => {
    const body = parse(z.object({ enabled: z.boolean().optional(), baseUrl: z.string().nullable().optional(), apiKeyEnv: z.string().nullable().optional(), name: z.string().optional() }), req.body);
    const provider = store.updateProvider((req.params as { id: string }).id, body);
    if (!provider) throw http(404, 'Provider not found.');
    lastScan = await scanMachine(fetchImpl, docker, store).catch(() => lastScan);
    bus.publish({ type: 'models_updated' });
    return { provider };
  });
  app.post('/api/settings/searxng/test', async (req) => {
    const body = parse(z.object({ url: z.string().optional() }), req.body ?? {});
    const target = (body.url || '').trim();
    const detected = await findSearxng(fetchImpl, target || undefined);
    if (!detected) return { ok: false, url: target || null, detail: 'SearXNG did not answer JSON search on any candidate URL.' };
    return { ok: true, url: detected, detail: `SearXNG answered at ${detected}` };
  });
  app.get('/api/system/update-status', async () => {
    const backups = listBackups(config.dataDir);
    let commit = '';
    try {
      const head = await new Promise<string>((resolve) => execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd() }, (err, out) => resolve(err ? '' : out.trim())));
      commit = head;
    } catch { /* not a git checkout */ }
    return { version: VERSION, commit: commit || null, dataDir: config.dataDir, backupsCount: backups.length, latestBackup: backups[0] ?? null, inDocker: inDockerContainer() };
  });

  app.get('/api/mcp', async () => ({ servers: mcp.list().map((server) => mcpView(server)), builtin: ['shell', 'files', 'web_search', 'web_fetch', 'docker', 'memory', 'consult_agent', 'plan', 'grep', 'glob', 'apply_patch', 'git'] }));
  /** A server as the Tools page sees it: health, trust and which secrets are set (names only, never values). */
  const mcpView = (server: McpServer) => {
    const needed = [...new Set(Object.values(server.env).flatMap((value) => [...String(value).matchAll(/\{\{secret:([A-Z0-9_]+)\}\}/gi)].map((match) => match[1]!.toUpperCase())))];
    const set = vault.mcpSecretNames(server.id);
    return {
      ...server, env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, /\{\{secret:/i.test(String(value)) ? '(from the vault)' : String(value)])),
      health: mcp.health(server.id), trust: trustOf({ name: server.name, image: server.image, packageName: server.args.find((arg) => !arg.startsWith('-')), source: server.source }),
      secrets: needed.map((name) => ({ name, set: set.includes(name) })),
    };
  };
  app.get('/api/mcp/catalog', async (req) => {
    const query = req.query as { source?: string; q?: string };
    const q = String(query.q || '').trim().toLowerCase();
    if (query.source === 'official') return { source: 'official', entries: await officialCatalog(q, fetchImpl) };
    const entries = (await dockerCatalog(fetchImpl, config.dataDir)).filter((entry) => !q || `${entry.id} ${entry.title} ${entry.description}`.toLowerCase().includes(q));
    return { source: 'docker', total: entries.length, entries: entries.slice(0, 60) };
  });
  app.post('/api/mcp/catalog/vet', async (req) => {
    const body = parse(z.object({ source: z.enum(['docker', 'official']), id: z.string().min(1).max(200) }), req.body);
    const entries = body.source === 'docker' ? await dockerCatalog(fetchImpl, config.dataDir) : await officialCatalog(body.id, fetchImpl);
    const entry = entries.find((row) => row.id === body.id);
    if (!entry) throw http(404, 'Not found in that catalog.');
    if (!entry.installable) throw http(400, entry.note || 'This server cannot be installed here.');
    let report: VettingReport;
    if (entry.image) report = vetCatalogImage(entry);
    else {
      const settings = store.getSettings();
      report = await vetSpec(specFor(entry), fetchImpl, { reputation: true, searxngUrl: settings.searxngUrl || process.env.SEARXNG_URL || '', summarize: localReputationSummarizer(store, fetchImpl) });
      if (entry.trust === 'community' && !report.findings.some((row) => row.code === 'community')) report.findings.push({ severity: 'medium', code: 'community', detail: 'Community server: read its source before trusting it with tokens.' });
    }
    store.saveVetting(report.id, report);
    return { report, trust: entry.trust, secrets: entry.secrets.map((row) => row.env) };
  });
  /** Secrets for one server, typed into a form: stored in the vault for that server only; never returned or shown to a model. */
  app.get('/api/mcp/:id/secrets', async (req) => {
    const server = store.getMcp((req.params as { id: string }).id);
    if (!server) throw http(404, 'MCP server not found.');
    return { secrets: mcpView(server).secrets };
  });
  app.put('/api/mcp/:id/secrets', async (req) => {
    const id = (req.params as { id: string }).id;
    const server = store.getMcp(id);
    if (!server) throw http(404, 'MCP server not found.');
    const body = parse(z.object({ values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(20_000)) }), req.body);
    const allowed = new Set(mcpView(server).secrets.map((row) => row.name));
    for (const [name, value] of Object.entries(body.values)) {
      if (!allowed.has(name)) throw http(400, `${name} is not a secret this server uses.`);
      if (value) vault.put({ name, value, scope: 'mcp', scopeId: id, actor: me(req) });
    }
    if (mcp.health(id).status === 'connected' || server.lastError) void mcp.connect(id).catch(() => undefined);
    return { secrets: mcpView(store.getMcp(id)!).secrets };
  });
  app.patch('/api/mcp/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const server = store.getMcp(id);
    if (!server) throw http(404, 'MCP server not found.');
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    store.upsertMcp({ ...server, enabled: body.enabled });
    if (!body.enabled) await mcp.stop(id);
    return { server: mcpView(store.getMcp(id)!) };
  });
  app.post('/api/mcp/discover', async () => ({ servers: mcp.importFound(config.dataDir), found: importConfigs(config.dataDir).length }));
  app.get('/api/mcp/registry', async (req) => searchRegistry(String((req.query as { q?: string }).q || 'file'), fetchImpl));
  app.post('/api/mcp/vet', async (req) => {
    const body = parse(z.object({
      name: z.string(), command: z.string().optional(), args: z.array(z.string()).optional(), url: z.string().optional(), source: z.string().optional(),
      reputation: z.boolean().optional(),
    }), req.body);
    const settings = store.getSettings();
    const report = await vetSpec({
      name: body.name, transport: body.url ? 'http' : 'stdio', command: body.command, args: body.args, url: body.url, source: body.source || 'ui',
    }, fetchImpl, {
      reputation: body.reputation !== false,
      searxngUrl: settings.searxngUrl || process.env.SEARXNG_URL || '',
      summarize: localReputationSummarizer(store, fetchImpl),
    });
    store.saveVetting(report.id, report);
    return { report };
  });
  app.post('/api/mcp/install', async (req) => {
    const body = parse(z.object({ reportId: z.string(), acknowledgeRisk: z.boolean(), acknowledgeCritical: z.boolean().optional(), acknowledgeCommunity: z.boolean().optional(), grants: z.array(z.string()).optional() }), req.body);
    const report = store.getVetting<import('./mcp.js').VettingReport>(body.reportId);
    if (!report) throw http(404, 'Vetting report not found. Vet the server first.');
    try { return { server: mcpView(mcp.install(report, body)) }; } catch (error) { throw http(400, error instanceof Error ? error.message : 'Install failed.'); }
  });
  app.post('/api/mcp/:id/refresh', async (req) => {
    const id = (req.params as { id: string }).id;
    try { await mcp.connect(id); } catch { /* the view carries the error */ }
    const server = store.getMcp(id);
    if (!server) throw http(404, 'MCP server not found.');
    return { server: mcpView(server) };
  });
  app.delete('/api/mcp/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await mcp.stop(id);
    for (const secret of vault.list().filter((row) => row.scope === 'mcp' && row.scopeId === id && !row.revokedAt)) vault.revoke(secret.id, me(req));
    store.deleteMcp(id);
    return { ok: true };
  });

  app.get('/api/containers', async () => {
    if (!docker.available()) return { available: false, containers: [] };
    const containers = await docker.list();
    return { available: true, containers };
  });
  app.post('/api/containers/sandbox', async (req) => {
    const body = parse(z.object({ agentId: z.string() }), req.body);
    const agent = store.getAgent(body.agentId);
    if (!agent) throw http(404, 'Persona not found.');
    if (!docker.available()) throw http(400, 'Docker is not available.');
    const id = await docker.createSandbox(`la-sbx-${agent.slug}`.slice(0, 40), agent.workspacePath, agent.id);
    return { id };
  });
  app.delete('/api/containers/:id', async (req) => {
    const body = parse(z.object({ confirm: z.literal(true) }), req.body ?? {});
    void body;
    await docker.remove((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get('/api/schedules', async (req) => ({ schedules: store.listSchedules().filter((schedule) => ownerOf(store, 'agent', schedule.agentId) === me(req)) }));
  app.post('/api/schedules', async (req) => {
    const body = parse(z.object({ agentId: z.string(), name: z.string().min(1), cron: z.string(), prompt: z.string().min(1) }), req.body);
    mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    const next = nextCron(body.cron, new Date()).toISOString();
    return { schedule: store.createSchedule({ ...body, nextRunAt: next }) };
  });
  app.patch('/api/schedules/:id', async (req) => {
    mustOwn(store, req, 'schedule', (req.params as { id: string }).id, 'Schedule not found.');
    const body = parse(z.object({ name: z.string().optional(), cron: z.string().optional(), prompt: z.string().optional(), enabled: z.boolean().optional() }), req.body);
    const next = body.cron ? nextCron(body.cron, new Date()).toISOString() : undefined;
    return { schedule: store.updateSchedule((req.params as { id: string }).id, { ...body, nextRunAt: next }) };
  });
  app.delete('/api/schedules/:id', async (req) => {
    mustOwn(store, req, 'schedule', (req.params as { id: string }).id, 'Schedule not found.');
    store.deleteSchedule((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/schedules/:id/run', async (req) => {
    mustOwn(store, req, 'schedule', (req.params as { id: string }).id, 'Schedule not found.');
    const schedule = store.getSchedule((req.params as { id: string }).id);
    if (!schedule) throw http(404, 'Schedule not found.');
    const session = schedule.sessionId ? store.getSession(schedule.sessionId) : store.createSession({ agentId: schedule.agentId, title: schedule.name });
    if (!session) throw http(400, 'Session missing.');
    if (!schedule.sessionId) store.updateSchedule(schedule.id, { sessionId: session.id });
    const run = await engine.startTurn({ sessionId: session.id, agentId: schedule.agentId, content: schedule.prompt, background: true });
    return { run };
  });

  app.get('/api/discovery', async () => ({ scan: lastScan, checklist: checklist(lastScan, store) }));
  app.post('/api/discovery/scan', async () => {
    lastScan = await scanMachine(fetchImpl, docker, store);
    engine.residentLarge = lastScan.resident;
    if (lastScan.searxng) {
      const settings = store.getSettings();
      if (!settings.searxngUrl) store.saveSettings({ ...settings, searxngUrl: lastScan.searxng }, 'Detected SearXNG', { settings: { ...settings, searxngUrl: lastScan.searxng } });
    }
    return { scan: lastScan, checklist: checklist(lastScan, store) };
  });
  // Machine profile: role defaults, runtime advice, the install plan and the last bench, for the setup wizard.
  const ollamaBase = () => (process.env.OLLAMA_HOST || lastScan?.ollama?.url || 'http://127.0.0.1:11434').replace(/\/$/, '').replace(/^(?!https?:)/, 'http://');
  const installedModels = async () => fetchImpl(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((res) => res.json() as Promise<{ models?: { name: string }[] }>).then((data) => (data.models ?? []).map((row) => row.name)).catch(() => [] as string[]);
  const catalogSizes = () => Object.fromEntries(store.listModels().filter((row) => row.typicalQ4GiB).map((row) => [row.apiName, row.typicalQ4GiB as number]));
  const pickProfile = async (id?: string) => {
    const machine = await machineInfo();
    const gtt = readGpu()?.gttBytes;
    const detected = profileFor({ ...machine, gpu: machine.gpu ?? undefined, gttGiB: gtt ? gtt / 2 ** 30 : undefined });
    return { machine, detected, profile: (id ? MACHINE_PROFILES.find((row) => row.id === id) : null) ?? detected };
  };
  const roleChoices = z.record(z.enum(['fast', 'main', 'hebrew', 'coder', 'vision', 'embed', 'image']), z.string().max(120).regex(/^[\w.:/-]*$/)).optional();
  app.get('/api/setup/profile', async (req) => {
    const { machine, detected, profile } = await pickProfile((req.query as { id?: string }).id);
    const { match: _match, ...plain } = profile;
    const settings = store.getSettings();
    return { machine, detected: detected.id, profile: plain, residentGiB: residentGiB(profile), autoMap: autoMapFor(profile), plan: planInstall(profile, {}, await installedModels(), catalogSizes()), applied: settings.modelProfile ?? null, bench: loadBench(config.dataDir), profiles: MACHINE_PROFILES.map((row) => ({ id: row.id, title: row.title })) };
  });
  app.post('/api/setup/profile/plan', async (req) => {
    const body = parse(z.object({ id: z.string().optional(), choices: roleChoices }), req.body);
    const { profile } = await pickProfile(body.id);
    return { plan: planInstall(profile, body.choices, await installedModels(), catalogSizes()) };
  });
  const applyPlan = (plan: InstallPlan) => {
    const settings = store.getSettings();
    const image = plan.rows.find((row) => row.role === 'image')?.model;
    const hebrew = plan.rows.find((row) => row.role === 'hebrew')?.model;
    const next = { ...settings, autoModels: { ...settings.autoModels, ...autoMapForPlan(plan) }, ramBudgetGiB: plan.ramCapGiB, imageGen: { ...settings.imageGen, localModel: image || settings.imageGen.localModel }, modelProfile: { id: plan.profileId, hebrew: hebrew ?? null, at: new Date().toISOString() } };
    store.saveSettings(next, `Applied machine profile ${plan.profileId}`, { settings: next });
    return next;
  };
  app.post('/api/setup/profile/apply', async (req) => {
    const body = parse(z.object({ confirm: z.literal(true), id: z.string().optional(), choices: roleChoices }), req.body);
    const { profile } = await pickProfile(body.id);
    const next = applyPlan(planInstall(profile, body.choices, await installedModels(), catalogSizes()));
    return { applied: profile.id, autoModels: next.autoModels, ramBudgetGiB: next.ramBudgetGiB, imageModel: next.imageGen.localModel };
  });
  // Pull every model the plan needs (one at a time, compact progress), then write the role map. Refuses plans over the RAM cap.
  app.post('/api/setup/profile/install', async (req) => {
    const body = parse(z.object({ confirm: z.literal(true), id: z.string().optional(), choices: roleChoices }), req.body);
    const { profile } = await pickProfile(body.id);
    const plan = planInstall(profile, body.choices, await installedModels(), catalogSizes());
    if (!plan.fits) throw http(400, plan.warnings[0] ?? 'These models do not fit the RAM cap.');
    const job = store.createJob('install-models', plan.pulls.length ? `ollama pull ${plan.pulls.join(' && ollama pull ')}` : 'nothing to pull');
    void (async () => {
      try {
        store.appendJob(job.id, `Profile ${plan.profileId}: ${plan.pulls.length} model(s), ~${plan.downloadGiB} GB to download; ~${plan.peakGiB} GB peak RAM of ${plan.ramCapGiB} GB.\n`);
        for (const [index, name] of plan.pulls.entries()) {
          store.appendJob(job.id, `[${index + 1}/${plan.pulls.length}] ${name}\n`);
          await ollamaPull(fetchImpl, ollamaBase(), name, pullProgress(name, (line) => store.appendJob(job.id, line)));
        }
        applyPlan(plan);
        store.appendJob(job.id, `Role map saved: ${plan.rows.map((row) => `${row.role}=${row.model}`).join(', ')}\n`);
        store.finishJob(job.id, 'done');
      } catch (error) {
        store.appendJob(job.id, `Failed: ${error instanceof Error ? error.message : String(error)}\n`);
        store.finishJob(job.id, 'failed');
      }
    })();
    return { job, plan };
  });
  app.post('/api/setup/actions/:id/preview', async (req) => {
    const model = (req.body as { model?: string } | undefined)?.model;
    return setupPreview((req.params as { id: string }).id, model);
  });
  app.post('/api/setup/actions/:id/run', async (req) => {
    const body = parse(z.object({ confirm: z.literal(true), model: z.string().optional() }), req.body);
    const action = (req.params as { id: string }).id;
    const preview = setupPreview(action, body.model);
    const job = store.createJob(action, preview.command);
    void runSetup(action, body.model, job.id, ctx);
    return { job };
  });
  app.get('/api/jobs/:id', async (req) => {
    const job = store.getJob((req.params as { id: string }).id);
    if (!job) throw http(404, 'Job not found.');
    return { job };
  });

  app.get('/api/resources', async () => {
    const current = snapshotResources(store, config.dataDir);
    const loadedModels = await ollamaLoaded(fetchImpl);
    const flags = [...current.flags];
    for (const loaded of loadedModels) {
      const known = store.listModels().find((model) => model.apiName === loaded.name || model.name === loaded.name);
      if (loaded.contextLength && known && loaded.contextLength + 256 < known.practicalBudget) {
        flags.push({ level: 'warn' as const, text: `${loaded.name} is loaded with ${loaded.contextLength} tokens of context. This app budgets ${known.practicalBudget}.` });
      }
    }
    const workbench = engine.workbench ? await engine.workbench.status() : null;
    const browser = engine.browser ? await engine.browser.status() : null;
    const memUsage = engine.memory ? await engine.memory.usage().catch(() => null) : null;
    const gtt = memUsage?.gtt ?? readGtt();
    const llamaProviders = store.listProviders().filter((provider) => provider.enabled && isLlamaServerProvider(provider));
    const llamaModels = llamaProviders.map((provider) => {
      const m = store.listModels().find((model) => model.providerId === provider.id);
      return m?.name || provider.name;
    });
    const residentModels = [...new Set([...loadedModels.map((m) => m.name), ...llamaModels])];
    return { current: { ...current, loadedModels, flags, gtt, residentModels, workbench, browser } };
  });
  app.get('/api/workbench', async () => ({ workbench: engine.workbench ? await engine.workbench.status() : null }));
  app.get('/api/browser', async () => ({ browser: engine.browser ? await engine.browser.status() : null }));
  app.get('/api/llm/live', async () => {
    const readGpuBusy = (): number | null => {
      try {
        for (const name of fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
          const p = path.join('/sys/class/drm', name, 'device', 'gpu_busy_percent');
          if (fs.existsSync(p)) {
            const v = Number(fs.readFileSync(p, 'utf8').trim());
            if (Number.isFinite(v)) return Math.max(0, Math.min(100, v));
          }
        }
      } catch { /* ignore */ }
      return null;
    };
    const probeSlot = async (baseUrl: string | undefined, label: string) => {
      if (!baseUrl) return null;
      const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      try {
        const res = await fetchImpl(`${root}/slots`, { signal: AbortSignal.timeout(900) });
        if (!res.ok) return null;
        const slots = await res.json() as Array<{
          id?: number; n_ctx?: number; is_processing?: boolean; speculative?: boolean;
          n_prompt_tokens?: number; n_prompt_tokens_processed?: number; n_prompt_tokens_cache?: number;
          next_token?: Array<{ has_next_token?: boolean; n_decoded?: number; n_remain?: number }>;
          params?: { 'speculative.types'?: string };
        }>;
        const slot = slots.find((s) => s.is_processing) ?? slots[0];
        if (!slot) return null;
        const total = Number(slot.n_prompt_tokens ?? 0);
        const processed = Number(slot.n_prompt_tokens_processed ?? 0);
        const cached = Number(slot.n_prompt_tokens_cache ?? 0);
        const nDecoded = Number(slot.next_token?.[0]?.n_decoded ?? 0);
        const isPrefilling = Boolean(slot.is_processing && nDecoded === 0 && total > 0 && processed < total);
        const isGenerating = Boolean(slot.is_processing && !isPrefilling);
        const prefillPct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : null;
        const cacheHitPct = total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : null;
        return {
          server: label,
          isProcessing: Boolean(slot.is_processing),
          isPrefilling,
          isGenerating,
          nDecoded,
          nCtx: Number(slot.n_ctx ?? 0),
          promptTotal: total,
          promptProcessed: processed,
          promptCached: cached,
          prefillPct,
          cacheHitPct,
          speculative: Boolean(slot.speculative),
          speculativeType: slot.params?.['speculative.types'] || null,
        };
      } catch {
        return null;
      }
    };
    const [mainSlot, uncSlot] = await Promise.all([
      probeSlot(process.env.LLAMA_SERVER_URL, 'main'),
      probeSlot(process.env.LLAMA_UNCENSORED_SERVER_URL, 'uncensored'),
    ]);
    const slot = (mainSlot?.isProcessing ? mainSlot : null) ?? (uncSlot?.isProcessing ? uncSlot : null) ?? mainSlot ?? uncSlot;
    const gtt = readGtt();
    const gpuBusyPct = readGpuBusy();
    const cpus = os.cpus().length || 1;
    const cpuPct = Math.min(100, Math.round((os.loadavg()[0] / cpus) * 100));
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    return {
      slot,
      gpu: {
        busyPct: gpuBusyPct,
        gttUsedGiB: gtt ? Math.round((gtt.usedBytes / 1024 ** 3) * 10) / 10 : null,
        gttTotalGiB: gtt ? Math.round((gtt.totalBytes / 1024 ** 3) * 10) / 10 : null,
      },
      cpu: {
        busyPct: cpuPct,
        cores: cpus,
        ramUsedGiB: Math.round(((totalRam - freeRam) / 1024 ** 3) * 10) / 10,
        ramTotalGiB: Math.round((totalRam / 1024 ** 3) * 10) / 10,
      },
    };
  });
  app.get('/api/resources/trends', async (req) => {
    const hours = Number((req.query as { hours?: string }).hours || 24);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return { samples: store.listSamples(since) };
  });
  app.post('/api/resources/prune/preview', async (req) => {
    const body = parse(z.object({ action: z.string(), target: z.string().optional() }), req.body);
    return { preview: previewPrune(store, config.dataDir, body.action, body.target) };
  });
  app.post('/api/resources/prune', async (req) => {
    const body = parse(z.object({ previewId: z.string(), confirm: z.literal(true) }), req.body);
    return { result: await runPrune(store, config.dataDir, body.previewId, docker, fetchImpl) };
  });

  app.post('/api/control/kill', async () => {
    const settings = store.getSettings();
    store.saveSettings({ ...settings, killed: true }, 'Kill switch', { settings: { ...settings, killed: true } });
    engine.stopAll();
    await notifier.push('Kill switch is on. Running turns were stopped.');
    return { killed: true };
  });
  app.post('/api/control/resume', async () => {
    const settings = store.getSettings();
    store.saveSettings({ ...settings, killed: false }, 'Kill switch cleared', { settings: { ...settings, killed: false } });
    return { killed: false };
  });
  // Fresh start (owner only): counts by default; deletes chats, runs and history only with the typed phrase, after a backup.
  app.post('/api/admin/reset', async (req) => {
    const body = parse(z.object({ confirm: z.boolean().optional(), phrase: z.string().optional() }), req.body ?? {});
    if (!body.confirm) return resetChats(store.db, config.dataDir);
    if (body.phrase !== RESET_PHRASE) throw http(400, `Type "${RESET_PHRASE}" to confirm.`);
    if (engine.busyRuns() > 0) throw http(409, 'A reply is still running. Stop it (or wait), then reset.');
    const sessions = (store.db.prepare('SELECT id FROM chat_sessions').all() as { id: string }[]).map((row) => row.id);
    const result = await resetChats(store.db, config.dataDir, { confirm: true });
    engine.forgetChats(sessions);
    store.addLog('warn', `Fresh start: deleted ${result.total} rows across chats, runs and history. Backup: ${result.backup?.id}.`, undefined, 'ops');
    return result;
  });
  app.get('/api/backups', async () => ({ backups: listBackups(config.dataDir) }));
  app.post('/api/backups', async () => {
    ensureDiskRoom(config.dataDir, fs.existsSync(path.join(config.dataDir, 'local-agent.db')) ? fs.statSync(path.join(config.dataDir, 'local-agent.db')).size : 0);
    const backup = await createBackup(config.dataDir);
    const shipped = await shipBackup(backup.file, store.getSettings());
    return { backup, shipped };
  });
  app.post('/api/backups/:id/restore', async (req) => {
    const body = parse(z.object({ confirm: z.literal(true) }), req.body);
    void body;
    stageRestore(config.dataDir, (req.params as { id: string }).id);
    setTimeout(() => process.exit(0), 300);
    return { ok: true, detail: 'Restore is staged. The process is exiting so it can come back on the snapshot. systemd or the supervisor should start it again.' };
  });
  app.get('/api/voice', async () => voiceStatus(fetchImpl));
  app.post('/api/voice/transcribe', async (req, reply) => {
    const raw = req.body as unknown;
    const audio = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.alloc(0);
    try {
      // No hint by default: Whisper detects Hebrew and English itself, and a bilingual user may speak either.
      const hint = String((req.query as { lang?: string }).lang || '');
      const text = await transcribe(fetchImpl, audio, String(req.headers['content-type'] || 'audio/webm'), hint === 'he' || hint === 'en' ? hint : undefined);
      return { text };
    } catch (error) {
      if (error instanceof VoiceError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, hint: error.hint });
      throw error;
    }
  });
  app.post('/api/voice/speak', async (req, reply) => {
    const body = parse(z.object({ text: z.string().min(1).max(2000), lang: z.enum(['he', 'en']).optional(), agentId: z.string().optional(), voice: z.string().max(80).optional() }), req.body);
    try {
      const account = accountOf(req);
      const cloud = account.role === 'owner' || account.limits.cloud !== false;
      const agent = body.agentId ? store.getAgent(body.agentId) : null;
      const agentLang = agent?.language === 'he' || agent?.language === 'en' ? agent.language : undefined;
      const audio = await speak(fetchImpl, body.text, { lang: body.lang ?? agentLang, voice: body.voice || agent?.voiceName || undefined, geminiKey: cloud ? process.env.GEMINI_API_KEY : '' });
      reply.header('content-type', audio.type);
      reply.header('x-tts-engine', audio.engine);
      return reply.send(audio.bytes);
    } catch (error) {
      if (error instanceof VoiceError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, hint: error.hint });
      throw error;
    }
  });
  app.get('/api/push/key', async () => ({ publicKey: notifier.publicKey() }));
  app.post('/api/push/subscribe', async (req) => {
    const body = parse(z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }), req.body);
    notifier.addSubscription(body);
    return { ok: true };
  });
  app.get('/api/logs', async (req) => {
    const query = req.query as { component?: string; level?: string; q?: string };
    return { logs: searchLogs(store, query), components: LOG_COMPONENTS, debugLevel: store.getSettings().debugLevel };
  });
  app.get('/api/debug/runs/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'run', id, 'Run not found.');
    const run = store.getRun(id);
    if (!run) throw http(404, 'Run not found.');
    const approvals = store.listApprovals().filter((item) => item.runId === id);
    return redactValue({
      run, steps: store.listSteps(id), approvals,
      messages: store.listMessages(run.sessionId).filter((message) => message.runId === id || message.role === 'user'),
    });
  });
  app.post('/api/debug/runs/:id/replay', async (req) => {
    mustOwn(store, req, 'run', (req.params as { id: string }).id, 'Run not found.');
    const run = store.getRun((req.params as { id: string }).id);
    if (!run) throw http(404, 'Run not found.');
    const first = store.listMessages(run.sessionId).find((message) => message.role === 'user' && message.runId === run.id)
      ?? store.listMessages(run.sessionId).find((message) => message.role === 'user');
    const rehearsal = store.getModel('model_rehearsal');
    const replay = await engine.startTurn({
      sessionId: run.sessionId, agentId: run.agentId,
      content: `Replay the earlier request and answer from the rehearsal model.\n\n${first?.content || ''}`,
      modelId: rehearsal?.id,
    });
    return { run: replay };
  });
  app.get('/api/memory/budget', async (req) => {
    if (accountOf(req).role === 'member') throw http(403, 'Only the owner can see the RAM budget.');
    const memory = engine.memory;
    if (!memory) return { tracked: false };
    const cfg = budgetConfig(store.getSettings());
    return { tracked: true, budgetBytes: cfg.budgetBytes, usage: await memory.usage(), active: memory.snapshotActive(), queue: memory.snapshotQueue(), summary: (await budgetReport(memory, cfg)).detail };
  });
  app.post('/api/memory/recheck', async () => {
    const memory = engine.memory;
    if (!memory) return { tracked: false };
    await memory.recheck();
    const cfg = budgetConfig(store.getSettings());
    return { tracked: true, usage: await memory.usage(), active: memory.snapshotActive(), queue: memory.snapshotQueue(), summary: (await budgetReport(memory, cfg)).detail };
  });
  registerMonitor(app, {
    store, redact: (text) => vault.redact(text),
    health: async () => {
      const [checks, ocrFound, piperFound] = await Promise.all([healthChecks(store, docker, fetchImpl, config.dataDir, engine.memory), resolveServiceUrl(fetchImpl, 'ocr'), resolveServiceUrl(fetchImpl, 'piper')]);
      const ocrUp = ocrFound?.health;
      const piperUp = piperFound?.health;
      return [...checks,
        { id: 'ocr', ok: Boolean(ocrUp), optional: true, detail: ocrUp ? `OCR service up (${(ocrUp.langs as string[] | undefined)?.join('+') ?? 'tesseract'})` : 'OCR service not running' },
        { id: 'piper', ok: Boolean(piperUp), optional: true, detail: piperUp ? 'Piper voices up' : 'Piper voices not running' }];
    },
    memory: async () => {
      const memory = engine.memory;
      if (!memory) return { tracked: false };
      const cfg = budgetConfig(store.getSettings());
      return { tracked: true, budgetGiB: Math.round((cfg.budgetBytes / 2 ** 30) * 10) / 10, usage: await memory.usage(), active: memory.snapshotActive(), queue: memory.snapshotQueue() };
    },
    ownerOnly: (req) => { if (accountOf(req).role !== 'owner') throw http(403, 'Only the owner can manage monitoring tokens.'); },
  });
  app.get('/api/debug/health', async () => ({ checks: await healthChecks(store, docker, fetchImpl, config.dataDir, engine.memory) }));
  app.post('/api/debug/health/:id', async (req) => {
    const checks = await healthChecks(store, docker, fetchImpl, config.dataDir, engine.memory);
    const check = checks.find((item) => item.id === (req.params as { id: string }).id);
    if (!check) throw http(404, 'No check with that name.');
    return { check };
  });
  // Runs the real tools once, so a broken search or knowledge base shows up before a chat does.
  app.post('/api/debug/tool-test', async (req) => {
    const body = parse(z.object({ tool: z.enum(['web_search', 'kb_search']).optional(), query: z.string().optional() }), req.body);
    const tools = body.tool ? [body.tool] : ['web_search', 'kb_search'] as const;
    const settings = store.getSettings();
    const results = [];
    for (const tool of tools) {
      const query = body.query?.trim() || (tool === 'web_search' ? 'Ollama latest release' : 'test');
      const started = Date.now();
      try {
        const output = tool === 'web_search'
          ? formatSearch(query, await searxngQuery(settings.searxngUrl || process.env.SEARXNG_URL || '', query, fetchImpl, undefined, settings.searchHits))
          : formatCitations(await searchKnowledge(store, query, { k: 3 }));
        results.push({ tool, query, ok: !/^No (results|knowledge-base passages)/.test(output), ms: Date.now() - started, output: output.slice(0, 2000) });
      } catch (error) {
        results.push({ tool, query, ok: false, ms: Date.now() - started, output: '', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  });
  app.get('/api/debug/bundle', async (_req, reply) => {
    const checks = await healthChecks(store, docker, fetchImpl, config.dataDir, engine.memory);
    const runs = store.listRuns(8).map((run) => redactValue({ run, steps: store.listSteps(run.id) }));
    const body = zipStore([
      { name: 'logs.json', data: Buffer.from(JSON.stringify(searchLogs(store, { limit: 400 }), null, 2)) },
      { name: 'config.json', data: Buffer.from(JSON.stringify(redactValue(store.getSettings()), null, 2)) },
      { name: 'health.json', data: Buffer.from(JSON.stringify(checks, null, 2)) },
      { name: 'runs.json', data: Buffer.from(JSON.stringify(runs, null, 2)) },
      { name: 'versions.json', data: Buffer.from(JSON.stringify({ version: VERSION, node: process.version }, null, 2)) },
    ]);
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', 'attachment; filename="local-agent-debug.zip"');
    return reply.send(body);
  });
  app.get('/api/memory', async (req) => {
    const agentId = String((req.query as { agentId?: string }).agentId || '');
    mustOwn(store, req, 'agent', agentId, 'Persona not found.');
    return { notes: store.listNotes(agentId) };
  });
  app.post('/api/memory', async (req) => {
    const body = parse(z.object({ agentId: z.string(), content: z.string().min(1), pinned: z.boolean().optional() }), req.body);
    mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    return { note: store.createNote(body.agentId, body.content, body.pinned) };
  });
  app.delete('/api/memory/:id', async (req) => {
    mustOwn(store, req, 'note', (req.params as { id: string }).id, 'Note not found.');
    store.deleteNote((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get('/api/live', { websocket: true }, (socket, req) => {
    void (async () => {
      if (!(await authenticate(store, req))) {
        socket.close();
        return;
      }
      // Each socket hears only its own account's runs. Machine-wide notes go to the owner.
      const accountId = accountOf(req).id;
      const runOwner = new Map<string, string | null>();
      const off = bus.subscribeAll((event) => {
        // Tokens go out on the run and chat streams; repeating every token of every run here only adds lag.
        if (event.type === 'token' || event.type === 'thinking') return;
        let owner: string | null = OWNER_ID;
        if (event.runId) {
          if (!runOwner.has(event.runId)) runOwner.set(event.runId, ownerOf(store, 'run', event.runId));
          owner = runOwner.get(event.runId) ?? null;
        } else if (event.type === 'title' && (event as { sessionId?: string }).sessionId) {
          owner = ownerOf(store, 'session', String((event as { sessionId?: string }).sessionId));
        }
        if (owner !== accountId) return;
        try { socket.send(JSON.stringify(event)); } catch { /* closed */ }
      });
      // Keep idle connections alive through proxies and NAT (Tailscale, Cloudflare): ping every 20s.
      const beat = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, 20_000);
      socket.on('close', () => { clearInterval(beat); off(); });
    })();
  });

  registerLibrary(app, ctx, ocr);
}

/** Resolves a chat model by id, API name, or name. Unknown or disabled models are a 400 that lists the valid ones. */
function chatModelId(store: Store, wanted: string): string {
  const usable = (providerId: string) => {
    const provider = store.getProvider(providerId);
    if (!provider?.enabled) return false;
    return provider.kind !== 'gemini' || Boolean(process.env[provider.apiKeyEnv || 'GEMINI_API_KEY']);
  };
  const models = store.listModels().filter((model) => model.enabled && !model.embedding && usable(model.providerId));
  const match = models.find((model) => model.id === wanted) ?? models.find((model) => model.apiName === wanted || model.name === wanted);
  if (match) return match.id;
  const valid = models.filter((model) => model.profileId !== 'rehearsal').map((model) => `${model.id} (${model.apiName})`);
  throw http(400, `Unknown or disabled model "${wanted}". Valid models: ${valid.join(', ') || 'none — scan Local models in Setup'}.`);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw http(400, result.error.issues[0]?.message || 'Invalid input.');
  return result.data;
}

async function healthChecks(store: Store, docker: DockerCtl, fetchImpl: typeof fetch, dataDir: string, memory: MemoryBudget | null) {
  const loaded = await ollamaLoaded(fetchImpl);
  let ollamaOk = false;
  try {
    const response = await fetchImpl(`${(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(1500) });
    ollamaOk = response.ok;
  } catch { ollamaOk = false; }
  const snap = snapshotResources(store, dataDir);
  const backups = listBackups(dataDir);
  const mcp = store.listMcp();
  const settings = store.getSettings();
  const searx = await searxngHealth(settings.searxngUrl || process.env.SEARXNG_URL || '', fetchImpl);
  const dbFile = path.join(dataDir, 'local-agent.db');
  const dbBytes = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
  const embedWarning = ollamaOk ? await embedRoleWarning(store, fetchImpl) : null;
  const roleReport = await autoRoleReport(store, fetchImpl);
  return [...doctorChecks({
    ollamaOk, loaded, dockerOk: await docker.ping(), mcpCount: mcp.length, mcpErrors: mcp.filter((item) => item.lastError).length,
    searxngOk: searx.ok, searxngDetail: searx.detail, telegramQueued: telegramQueue(dataDir).length, dbBytes,
    diskFreeBytes: snap.disk.freeBytes, memAvailableGiB: snap.memory.availableGiB,
    geminiOpen: settings.geminiTier === 'paid' ? true : null, geminiState: geminiStateOf(store.getProvider('prov_gemini')) === 'off' ? 'off' : undefined, lastBackupAt: backups[0]?.createdAt ?? null, tailscaleOk: await tailscaleUp(),
  }), { id: 'embed', ok: !embedWarning, detail: embedWarning || (ollamaOk ? 'The embed role is an embedding model.' : 'Ollama is down, so the embed role was not checked.') },
  await imageCheck(store, dataDir, fetchImpl),
  { id: 'ram-budget', ...(memory ? await budgetReport(memory, budgetConfig(settings)) : { ok: true, detail: `RAM budget ${settings.ramBudgetGiB} GB (not tracked in this build).` }) },
  { id: 'roles', ok: roleReport.ok, detail: roleReport.detail, roles: roleReport.roles }];
}

async function imageCheck(store: Store, dataDir: string, fetchImpl: typeof fetch) {
  const cfg = store.getSettings().imageGen;
  if (cfg.mode === 'off') return { id: 'image', ok: true, detail: 'Image generation is off.' };
  const local = await localStatus(dataDir, cfg, fetchImpl);
  if (local.ready) return { id: 'image', ok: true, detail: local.detail };
  const gemini = Boolean(process.env.GEMINI_API_KEY);
  return { id: 'image', ok: cfg.mode !== 'local' && gemini, detail: `${local.detail}${gemini && cfg.mode !== 'local' ? ' Gemini covers image requests meanwhile.' : ''}` };
}

function tailscaleUp(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 800 }, (error, stdout) => resolve(!error && /\d+\.\d+/.test(String(stdout))));
  });
}

function http(statusCode: number, message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function registerLibrary(app: FastifyInstance, ctx: Ctx, ocr: ReturnType<typeof registerOcr>) {
  const { store, engine, vault, config, fetchImpl } = ctx;
  const embed = () => ollamaEmbedder(fetchImpl, store.getSettings().autoModels.embed || 'nomic-embed-text');

  const mine = (req: Parameters<typeof accountOf>[0]) => accountOf(req).id;
  const ownCollection = (req: Parameters<typeof accountOf>[0]) => mustOwn(store, req, 'collection', (req.params as { id: string }).id, 'Collection not found.');
  app.get('/api/kb/collections', async (req) => ({ collections: listCollections(store, mine(req)), usage: kbUsage(store, mine(req)) }));
  app.post('/api/kb/collections', async (req) => {
    const body = parse(z.object({ name: z.string().min(1), agentId: z.string().nullable().optional(), rootPath: z.string().optional() }), req.body);
    if (body.agentId) mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    if (body.rootPath && (accountOf(req).role === 'member' || foreignPath(config.dataDir, mine(req), body.rootPath))) throw http(403, 'Folder collections are for the owner\'s own folders.');
    return { collection: createCollection(store, { ...body, ownerId: mine(req) }) };
  });
  app.post('/api/kb/collections/:id/files', async (req) => {
    ownCollection(req);
    const body = parse(z.object({
      files: z.array(z.object({ name: z.string().min(1), contentBase64: z.string().min(1) })).min(1),
    }), req.body);
    const id = (req.params as { id: string }).id;
    if (!store.db.prepare('SELECT id FROM kb_collections WHERE id = ?').get(id)) throw http(404, 'Collection not found.');
    const results: Array<{ name: string; error?: string } & Partial<Awaited<ReturnType<typeof ingestBuffer>>>> = [];
    for (const file of body.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      try {
        results.push({ name: file.name, ...(await ingestBuffer(store, id, { name: file.name, bytes }, embed(), (data) => ocr.ocrBytesForKb(data, mine(req)))) });
      } catch (error) {
        if (!(error instanceof KbInputError)) throw error;
        results.push({ name: file.name, error: error.message });
      }
    }
    if (results.every((item) => item.error)) {
      const error = http(400, results.map((item) => item.error).join(' ')) as Error & { results?: unknown };
      throw error;
    }
    return { results, usage: kbUsage(store, mine(req)) };
  });
  app.get('/api/kb/collections/:id/files', async (req) => ownCollection(req) ?? ({ files: listDocuments(store, (req.params as { id: string }).id) }));
  app.delete('/api/kb/collections/:id/files/:docId', async (req) => {
    ownCollection(req);
    const params = req.params as { id: string; docId: string };
    if (!deleteDocument(store, params.id, params.docId)) throw http(404, 'File not found in that collection.');
    return { ok: true, usage: kbUsage(store, mine(req)) };
  });
  app.delete('/api/kb/collections/:id', async (req) => {
    ownCollection(req);
    if (!deleteCollection(store, (req.params as { id: string }).id)) throw http(404, 'Collection not found.');
    return { ok: true, usage: kbUsage(store, mine(req)) };
  });
  app.post('/api/kb/collections/:id/folder', async (req) => {
    ownCollection(req);
    const body = parse(z.object({ path: z.string().min(1) }), req.body);
    if (foreignPath(config.dataDir, mine(req), body.path)) throw http(403, 'That folder belongs to another account.');
    return { results: await ingestFolder(store, (req.params as { id: string }).id, body.path, embed()) };
  });
  app.post('/api/kb/collections/:id/reindex', async (req) => {
    ownCollection(req);
    const id = (req.params as { id: string }).id;
    const row = store.db.prepare('SELECT root_path FROM kb_collections WHERE id = ?').get(id) as { root_path: string | null } | undefined;
    if (!row?.root_path) throw http(400, 'This collection has no folder to re-index. Drop the files again.');
    return { results: await ingestFolder(store, id, row.root_path, embed()) };
  });
  app.post('/api/kb/search', async (req) => {
    const body = parse(z.object({ query: z.string().min(1), collectionId: z.string().optional(), agentId: z.string().optional() }), req.body);
    if (body.collectionId) mustOwn(store, req, 'collection', body.collectionId, 'Collection not found.');
    if (body.agentId) mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    return { hits: await searchKnowledge(store, body.query, { collectionId: body.collectionId, agentId: body.agentId, embed: embed(), ownerId: mine(req) }) };
  });

  app.get('/api/skills', async (req) => ({ skills: listSkills(store, (req.query as { agentId?: string }).agentId) }));
  app.post('/api/skills', async (req) => {
    const body = parse(z.object({ skillMd: z.string().min(1), slug: z.string().optional() }), req.body);
    return { skill: await saveSkill(store, config.dataDir, body.skillMd, body.slug) };
  });
  app.get('/api/skills/:slug', async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const skill = listSkills(store).find((item) => item.slug === slug);
    if (!skill) throw http(404, 'Skill not found.');
    return { skill, versions: skillVersions(store, slug), markdown: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n` };
  });
  app.delete('/api/skills/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    if (!(await deleteSkill(store, config.dataDir, slug))) throw http(404, 'Skill not found.');
    store.addLog('info', `Deleted skill ${slug}.`, undefined, 'skills');
    return { ok: true };
  });
  app.post('/api/skills/:slug/restore', async (req) => {
    const { slug } = req.params as { slug: string };
    const body = parse(z.object({ version: z.number().int().positive() }), req.body);
    if (!listSkills(store).some((item) => item.slug === slug)) throw http(404, 'Skill not found.');
    try { return { skill: await restoreSkillVersion(store, config.dataDir, slug, body.version) }; } catch (error) { throw http(404, error instanceof Error ? error.message : String(error)); }
  });
  app.post('/api/skills/:slug/enable', async (req) => {
    const body = parse(z.object({ agentId: z.string(), enabled: z.boolean() }), req.body);
    setSkillEnabled(store, body.agentId, (req.params as { slug: string }).slug, body.enabled);
    return { ok: true };
  });
  app.post('/api/skills/test', async (req) => {
    const body = parse(z.object({ text: z.string().min(1), agentId: z.string().optional() }), req.body);
    const skills = listSkills(store, body.agentId);
    const fits = skills.map((skill) => ({ slug: skill.slug, name: skill.name, score: skillFit(skill.description, body.text), enabled: skill.enabled !== false }));
    fits.sort((a, b) => b.score - a.score);
    return { fits };
  });
  app.post('/api/skills/:slug/test', async (req) => {
    const body = parse(z.object({ text: z.string().min(1), agentId: z.string().optional() }), req.body);
    const skills = listSkills(store, body.agentId);
    const fits = skills.map((skill) => ({ slug: skill.slug, name: skill.name, score: skillFit(skill.description, body.text), enabled: skill.enabled !== false }));
    fits.sort((a, b) => b.score - a.score);
    return { fits };
  });
  app.get('/api/skills/:slug/export', async (req) => exportSkill(store, config.dataDir, (req.params as { slug: string }).slug));
  app.post('/api/skills/import', async (req) => {
    const body = parse(z.object({
      slug: z.string().optional(),
      skillMd: z.string().min(1),
      files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
    }), req.body);
    parseSkillMd(body.skillMd);
    return { skill: await importSkill(store, config.dataDir, body) };
  });

  app.get('/api/triggers', async (req) => ({
    triggers: listTriggers(store).filter((trigger) => ownerOf(store, 'agent', trigger.agentId) === mine(req)).map((trigger) => ({ ...trigger, events: listTriggerEvents(store, trigger.id) })),
  }));
  app.post('/api/triggers', async (req) => {
    const body = parse(z.object({
      name: z.string().min(1),
      kind: z.enum(['webhook', 'github', 'folder', 'imap']),
      agentId: z.string(),
      prompt: z.string().min(1),
      config: z.object({
        debounceMs: z.number().optional(),
        path: z.string().optional(),
        host: z.string().optional(),
        port: z.number().optional(),
        mailbox: z.string().optional(),
        userSecret: z.string().optional(),
        passwordSecret: z.string().optional(),
      }).optional(),
    }), req.body);
    mustOwn(store, req, 'agent', body.agentId, 'Persona not found.');
    if (body.config?.path && foreignPath(config.dataDir, mine(req), body.config.path)) throw http(403, 'That folder belongs to another account.');
    const secret = randomSecret(24);
    const trigger = createTrigger(store, vault, { ...body, kind: body.kind as TriggerKind, secret });
    ctx.bus.publish({ type: 'trigger', message: trigger.id });
    return { trigger, secret, url: hookUrl(trigger.id, trigger.kind) };
  });
  app.post('/api/triggers/:id/test', async (req) => {
    mustOwn(store, req, 'trigger', (req.params as { id: string }).id, 'Trigger not found.');
    const body = parse(z.object({ event: z.unknown().optional() }), req.body);
    const trigger = getTrigger(store, (req.params as { id: string }).id);
    if (!trigger) throw http(404, 'Trigger not found.');
    const event = body.event ?? { test: true, note: 'Fired from the triggers page.' };
    return fireTrigger(store, engine, trigger, event, { test: true, wait: true });
  });
  app.patch('/api/triggers/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    mustOwn(store, req, 'trigger', id, 'Trigger not found.');
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    const trigger = updateTrigger(store, id, { enabled: body.enabled });
    ctx.bus.publish({ type: 'trigger', message: body.enabled ? 'resumed' : 'paused' });
    return { trigger: { id: trigger.id, enabled: trigger.enabled } };
  });
  app.delete('/api/triggers/:id', async (req) => {
    mustOwn(store, req, 'trigger', (req.params as { id: string }).id, 'Trigger not found.');
    store.db.prepare('DELETE FROM triggers WHERE id = ?').run((req.params as { id: string }).id);
    ctx.bus.publish({ type: 'trigger', message: 'deleted' });
    return { ok: true };
  });
  app.post('/api/hooks/github/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const trigger = getTrigger(store, id);
    if (!trigger || trigger.kind !== 'github' || !trigger.enabled) return reply.code(404).send({ error: 'Unknown hook.' });
    const raw = (req as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!githubSignatureOk(triggerSecret(store, vault, id), raw, req.headers['x-hub-signature-256'] as string | undefined)) {
      return reply.code(401).send({ error: 'Bad GitHub signature.' });
    }
    const result = await fireTrigger(store, engine, trigger, req.body ?? {});
    return { ok: true, runId: result.runId };
  });
  app.post('/api/hooks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const trigger = getTrigger(store, id);
    if (!trigger || trigger.kind !== 'webhook' || !trigger.enabled) return reply.code(404).send({ error: 'Unknown hook.' });
    const provided = String(req.headers['x-local-agent-secret'] || '');
    if (!secretEquals(provided, triggerSecret(store, vault, id))) return reply.code(401).send({ error: 'Bad hook secret.' });
    const result = await fireTrigger(store, engine, trigger, req.body ?? {});
    return { ok: true, runId: result.runId };
  });
}

/** SearXNG settings with JSON on and the limiter off. The secret is generated once and kept in the data dir. */
export function searxngConfig(dataDir: string): { yaml: string; secret: string; path: string } {
  const dir = path.join(dataDir, 'searxng');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'settings.yml');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const secret = existing.match(/secret_key:\s*"([a-f0-9]{32,})"/)?.[1] || randomBytes(32).toString('hex');
  const yaml = [
    '# Written by local-agent. JSON must stay on: web_search calls /search?format=json.',
    'use_default_settings: true',
    'server:',
    `  secret_key: "${secret}"`,
    '  limiter: false',
    '  image_proxy: false',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n');
  fs.writeFileSync(file, yaml, { mode: 0o600 });
  return { yaml, secret, path: file };
}

function hookUrl(id: string, kind: TriggerKind) {
  return kind === 'github' ? `/api/hooks/github/${id}` : kind === 'webhook' ? `/api/hooks/${id}` : null;
}

/** Pull one Ollama model, streaming progress text to `onText`. Ollama reports failures (unknown model, disk full) as an {"error"} line inside a 200 stream. */
export async function ollamaPull(fetchImpl: typeof fetch, base: string, name: string, onText: (text: string) => void) {
  const response = await fetchImpl(`${base}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }) });
  if (!response.ok || !response.body) throw new Error(`Ollama pull failed (${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let failure = '';
  const handle = (line: string) => { try { const row = JSON.parse(line) as { error?: string }; if (row.error) failure = row.error; } catch { /* progress text */ } };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const text = decoder.decode(chunk.value, { stream: true });
    onText(text);
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(pending);
  if (failure) throw new Error(`Ollama could not pull ${name}: ${failure}`);
}

/** Compact pull progress: one line per model per 10% instead of Ollama's raw stream. */
export function pullProgress(name: string, emit: (line: string) => void) {
  let last = -1;
  let pending = '';
  return (text: string) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { status?: string; total?: number; completed?: number };
        if (row.total && row.completed !== undefined) {
          const pct = Math.floor((row.completed / row.total) * 10) * 10;
          if (pct > last) { last = pct; emit(`${name}: ${pct}% of ${(row.total / 2 ** 30).toFixed(1)} GB\n`); }
        } else if (row.status && !/^pulling [0-9a-f]{6,}/.test(row.status)) emit(`${name}: ${row.status}\n`);
      } catch { /* partial */ }
    }
  };
}

async function runSetup(action: string, model: string | undefined, jobId: string, ctx: Ctx) {
  const { store, docker, fetchImpl } = ctx;
  try {
    if (action === 'pull-model' || action === 'pull-embed') {
      const name = action === 'pull-embed' ? 'nomic-embed-text' : (model || 'gemma4:e4b');
      const base = lastScan?.ollama?.url || ollamaRoot();
      await ollamaPull(fetchImpl, base, name, (text) => store.appendJob(jobId, text));
    } else if (action === 'bench-runtime') {
      const base = lastScan?.ollama?.url || ollamaRoot();
      const report = await benchRuntime(fetchImpl, base, { model: model || undefined, log: (line) => store.appendJob(jobId, line) });
      saveBench(ctx.config.dataDir, report);
    } else if (action === 'start-searxng') {
      if (!(await docker.ping())) throw new Error(`Docker is not available at ${docker.describe()}.`);
      await preChangeBackup(ctx.config.dataDir, 'pre-searxng');
      const config = searxngConfig(ctx.config.dataDir);
      store.appendJob(jobId, 'pulling docker.io/searxng/searxng:latest\n');
      await docker.pull('docker.io/searxng/searxng:latest').catch(() => store.appendJob(jobId, 'pull failed; using the local image if there is one\n'));
      // The stock settings only allow HTML, so format=json is a 403. Ship our own into a writable volume.
      const id = await docker.startDetached({
        Image: 'docker.io/searxng/searxng:latest',
        name: 'local-agent-searxng',
        replace: true,
        Labels: { 'local-agent.role': 'searxng', 'local-agent.watch': '1' },
        Env: [`SEARXNG_SECRET=${config.secret}`, 'SEARXNG_BASE_URL=http://127.0.0.1:8088/'],
        ExposedPorts: { '8080/tcp': {} },
        HostConfig: {
          PortBindings: { '8080/tcp': [{ HostPort: '8088' }] },
          RestartPolicy: { Name: 'unless-stopped' },
          Dns: ['1.1.1.1', '8.8.8.8'],
          Binds: ['local-agent-searxng-config:/etc/searxng'],
        },
        files: [{ dir: '/etc/searxng', name: 'settings.yml', content: config.yaml, mode: 0o644 }],
      });
      store.appendJob(jobId, `started ${id.slice(0, 12)} with JSON output on\n`);
      const current = store.getSettings();
      const reachable = await findSearxng(fetchImpl) || (inDockerContainer() ? 'http://local-agent-searxng:8080' : 'http://127.0.0.1:8088');
      if (!current.searxngUrl || (inDockerContainer() && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(current.searxngUrl))) {
        store.saveSettings({ ...current, searxngUrl: reachable }, 'SearXNG started', { searxngUrl: reachable });
      }
    } else if (action === 'start-whisper' || action === 'start-kokoro') {
      if (!docker.available()) throw new Error('Docker is not available.');
      const whisper = action === 'start-whisper';
      const id = await docker.startDetached({
        Image: whisper ? 'fedirz/faster-whisper-server:latest-cpu' : 'ghcr.io/remsky/kokoro-fastapi-cpu:latest',
        name: whisper ? 'local-agent-whisper' : 'local-agent-kokoro',
        Labels: { 'local-agent.role': whisper ? 'whisper' : 'kokoro', 'local-agent.watch': '1' },
        ExposedPorts: whisper ? { '8000/tcp': {} } : { '8880/tcp': {} },
        HostConfig: {
          PortBindings: whisper ? { '8000/tcp': [{ HostPort: '8091' }] } : { '8880/tcp': [{ HostPort: '8880' }] },
          RestartPolicy: { Name: 'unless-stopped' },
        },
      });
      store.appendJob(jobId, `started ${id}\n${whisper ? WHISPER_COMMAND : KOKORO_COMMAND}\n`);
    } else if (action === 'pull-sandbox' || action === 'pull-mcp-runtime') {
      const image = action === 'pull-sandbox' ? 'alpine:3.20' : 'node:22-alpine';
      if (!docker.available()) throw new Error('Docker is not available.');
      await docker.pull(image);
      store.appendJob(jobId, `pulled ${image}\n`);
    } else throw new Error('Unknown action.');
    store.finishJob(jobId, 'completed');
  } catch (error) {
    store.appendJob(jobId, `\n${error instanceof Error ? error.message : 'failed'}\n`);
    store.finishJob(jobId, 'failed');
  }
}
