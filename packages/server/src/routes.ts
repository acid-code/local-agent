import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FREE_TIER_OBSERVED_AT, FREE_TIER_SNAPSHOT, VERSION, nextCron, quotaAvailability } from '@local-agent/shared';
import { authenticate, hashPassword, noteFailure, rateLimit, setSession, verifyPassword } from './auth.js';
import { TEMPLATES } from './catalog.js';
import { detectCodingClis, listEdits, readPlan, replacePlan, revertBatch, updatePlanItem } from './coding.js';
import { secretNames, writeSecret } from './config.js';
import type { DockerCtl } from './docker.js';
import { checklist, scanMachine, setupPreview } from './discovery.js';
import type { McpRuntime } from './mcp.js';
import { importConfigs, searchRegistry, vetSpec } from './mcp.js';
import type { Notifier } from './notify.js';
import { createBackup, listBackups, shipBackup, stageRestore } from './ops.js';
import { previewPrune, runPrune, snapshotResources } from './resources.js';
import { speak, transcribe, voiceStatus, KOKORO_COMMAND, WHISPER_COMMAND } from './voice.js';
import { listWorkspace, readWorkspaceFile } from './tools.js';
import type { Bus } from './bus.js';
import type { Engine } from './engine.js';
import type { Store } from './db.js';
import type { Vault } from './vault.js';

type Ctx = {
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

  app.get('/api/auth/me', async (req) => {
    const owner = store.getOwner();
    const header = req.headers.authorization;
    const cookieOk = Boolean(req.cookies?.la_session);
    let authenticated = false;
    if (header?.startsWith('Bearer ') || cookieOk) authenticated = await authenticate(store, req);
    return { needsSetup: !owner, authenticated, username: authenticated ? owner?.username : undefined, version: VERSION };
  });

  app.post('/api/setup', async (req, reply) => {
    if (store.getOwner()) return reply.code(409).send({ error: 'An owner already exists.' });
    const body = parse(z.object({ username: z.string().regex(/^[a-zA-Z0-9._-]{1,32}$/), password: z.string().min(8).max(200) }), req.body);
    store.createOwner(body.username, await hashPassword(body.password));
    await setSession(reply, store);
    store.addLog('info', `Owner ${body.username} created.`);
    return { username: body.username };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip || 'local';
    if (rateLimit(ip)) return reply.code(429).send({ error: 'Too many attempts. Wait a few minutes.' });
    const owner = store.getOwner();
    if (!owner) return reply.code(409).send({ error: 'Create the owner account first.' });
    const body = parse(z.object({ username: z.string(), password: z.string() }), req.body);
    if (body.username !== owner.username || !(await verifyPassword(body.password, owner.passwordHash))) {
      noteFailure(ip);
      return reply.code(401).send({ error: 'Wrong username or password.' });
    }
    await setSession(reply, store);
    return { username: owner.username };
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
      sandbox: z.enum(['docker-or-host', 'docker-only', 'host']).optional(),
      maxSteps: z.number().int().min(1).max(40).optional(),
      outputReserveTokens: z.number().int().min(128).max(32000).optional(),
      summaryTriggerTokens: z.number().int().min(200).max(20000).optional(),
      searxngUrl: z.string().optional(),
      approvalForDestructive: z.boolean().optional(),
      mcpAllowHost: z.boolean().optional(),
      geminiTier: z.enum(['free', 'paid']).optional(),
      codeApproval: z.enum(['sandbox-auto', 'always']).optional(),
      killed: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      dailyTokenLimit: z.number().nullable().optional(),
      dailySpendLimitUsd: z.number().nullable().optional(),
      quotaLimits: z.record(z.object({ rpm: z.number().optional(), rpd: z.number().optional() })).optional(),
      backupCron: z.string().optional(),
      backupTransport: z.enum(['none', 'rsync', 'rclone', 's3']).optional(),
      backupTarget: z.string().optional(),
      agentLimits: z.record(z.object({ maxTokensPerDay: z.number().optional(), maxSpendUsd: z.number().optional(), maxRunMs: z.number().optional(), readOnly: z.boolean().optional() })).optional(),
    }), req.body);
    const next = { ...store.getSettings(), ...body };
    const saved = store.saveSettings(next, 'Settings updated', { settings: next, agents: store.listAgents() });
    return { settings: saved };
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

  app.get('/api/vault', async () => ({ secrets: vault.list(), requests: vault.listRequests('pending'), audit: vault.auditLog() }));
  app.post('/api/vault', async (req) => {
    const body = parse(z.object({ name: z.string(), value: z.string().min(1), scope: z.string().optional(), scopeId: z.string().nullable().optional() }), req.body);
    return { secret: vault.put({ name: body.name, value: body.value, scope: body.scope, scopeId: body.scopeId, actor: 'owner' }) };
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
    engine.provideSecret((req.params as { id: string }).id, body.deny ? null : body.value || null);
    return { ok: true };
  });

  app.get('/api/agents', async () => ({ agents: store.listAgents(), templates: TEMPLATES }));
  app.post('/api/agents', async (req) => {
    const body = parse(z.object({
      name: z.string().min(1).max(80),
      description: z.string().optional(),
      systemPrompt: z.string().min(1),
      modelId: z.string().nullable().optional(),
      routing: z.enum(['auto', 'pinned']).optional(),
      strategy: z.enum(['rolling', 'hierarchical', 'pinned', 'retrieval']).nullable().optional(),
      toolAllowlist: z.array(z.string()),
      memoryEnabled: z.boolean().optional(),
      template: z.string().optional(),
    }), req.body);
    const template = TEMPLATES.find((item) => item.id === body.template);
    const name = body.name || template?.name || 'Agent';
    const workspace = path.join(config.dataDir, 'workspaces', name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'agent');
    fs.mkdirSync(workspace, { recursive: true });
    return {
      agent: store.createAgent({
        name, description: body.description ?? template?.description, systemPrompt: body.systemPrompt || template?.systemPrompt || 'You are a local agent.',
        modelId: body.modelId, routing: body.routing, strategy: body.strategy, toolAllowlist: body.toolAllowlist.length ? body.toolAllowlist : template?.tools || [],
        memoryEnabled: body.memoryEnabled, workspacePath: workspace,
      }),
    };
  });
  app.patch('/api/agents/:id', async (req) => {
    const body = parse(z.object({
      name: z.string().optional(), description: z.string().optional(), systemPrompt: z.string().optional(),
      modelId: z.string().nullable().optional(), routing: z.enum(['auto', 'pinned']).optional(),
      strategy: z.enum(['rolling', 'hierarchical', 'pinned', 'retrieval']).nullable().optional(),
      toolAllowlist: z.array(z.string()).optional(), memoryEnabled: z.boolean().optional(),
    }), req.body);
    const agent = store.updateAgent((req.params as { id: string }).id, body);
    if (!agent) throw http(404, 'Persona not found.');
    return { agent };
  });
  app.delete('/api/agents/:id', async (req) => {
    store.deleteAgent((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/agents/:id/files', async (req) => {
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    return { workspace: agent.workspacePath, entries: await listWorkspace(agent.workspacePath) };
  });
  app.get('/api/agents/:id/file', async (req) => {
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    const relative = String((req.query as { path?: string }).path || '');
    return { path: relative, content: await readWorkspaceFile(agent.workspacePath, relative) };
  });

  app.get('/api/rooms', async () => ({ rooms: store.listRooms() }));
  app.post('/api/rooms', async (req) => {
    const body = parse(z.object({ name: z.string().min(1), agentIds: z.array(z.string()).min(1) }), req.body);
    return { room: store.createRoom(body.name, body.agentIds) };
  });

  app.get('/api/sessions', async () => ({ sessions: store.listSessions() }));
  app.post('/api/sessions', async (req) => {
    const body = parse(z.object({ agentId: z.string().optional(), roomId: z.string().optional(), title: z.string().optional(), mode: z.enum(['chat', 'code']).optional() }), req.body);
    const session = store.createSession(body);
    if (body.mode) store.updateSession(session.id, { mode: body.mode });
    return { session: store.getSession(session.id) };
  });
  app.get('/api/sessions/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const session = store.getSession(id);
    if (!session) throw http(404, 'Chat not found.');
    return { session, messages: store.listMessages(id), summaries: store.listSummaries(id), plan: readPlan(store, id), edits: listEdits(store, id), archived: store.listArchived(id) };
  });
  app.patch('/api/sessions/:id', async (req) => {
    const body = parse(z.object({ title: z.string().optional(), mode: z.enum(['chat', 'code']).optional() }), req.body);
    return { session: store.updateSession((req.params as { id: string }).id, body) };
  });
  app.post('/api/sessions/:id/messages', async (req) => {
    const id = (req.params as { id: string }).id;
    const session = store.getSession(id);
    if (!session) throw http(404, 'Chat not found.');
    const body = parse(z.object({ content: z.string().min(1), agentId: z.string().optional(), modelId: z.string().optional(), imageUrl: z.string().optional() }), req.body);
    const offers = vault.capture(null, body.content);
    const agentId = body.agentId || session.agentId;
    if (!agentId) throw http(400, 'Choose a persona.');
    const run = await engine.startTurn({ sessionId: id, agentId, content: vault.redact(body.content), imageUrl: body.imageUrl, modelId: body.modelId });
    return { run, offers };
  });
  app.get('/api/sessions/:id/plan', async (req) => ({ plan: readPlan(store, (req.params as { id: string }).id) }));
  app.put('/api/sessions/:id/plan', async (req) => {
    const body = parse(z.object({ items: z.array(z.string()).max(30) }), req.body);
    return { plan: replacePlan(store, (req.params as { id: string }).id, body.items) };
  });
  app.patch('/api/plan-items/:id', async (req) => {
    const body = parse(z.object({ text: z.string().optional(), status: z.string().optional(), note: z.string().optional() }), req.body);
    if (!updatePlanItem(store, (req.params as { id: string }).id, body)) throw http(404, 'Plan item not found.');
    return { ok: true };
  });
  app.get('/api/sessions/:id/edits', async (req) => ({ edits: listEdits(store, (req.params as { id: string }).id) }));
  app.post('/api/edits/:id/revert', async (req) => {
    await revertBatch(store, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.get('/api/runs', async () => ({ runs: store.listRuns() }));
  app.get('/api/runs/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const run = store.getRun(id);
    if (!run) throw http(404, 'Run not found.');
    return { run, steps: store.listSteps(id), checkpoints: store.listCheckpoints(id) };
  });
  app.get('/api/runs/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'snapshot', run: store.getRun(id), steps: store.listSteps(id), messages: store.listMessages(run.sessionId) });
    const off = bus.subscribeRun(id, send);
    const beat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(beat); off(); });
  });
  app.post('/api/runs/:id/control', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = parse(z.object({ action: z.enum(['pause', 'resume', 'stop', 'retry_from']), checkpointId: z.string().optional() }), req.body);
    if (body.action === 'pause') return { run: engine.pause(id) };
    if (body.action === 'stop') return { run: engine.stop(id) };
    if (body.action === 'retry_from') {
      if (!body.checkpointId) throw http(400, 'checkpointId is required.');
      return engine.retryFrom(id, body.checkpointId);
    }
    return { run: await engine.resume(id) };
  });

  app.get('/api/approvals', async () => ({ approvals: store.listApprovals('pending') }));
  app.post('/api/approvals/:id', async (req) => {
    const body = parse(z.object({ decision: z.enum(['approve', 'deny']) }), req.body);
    return { approval: engine.decideApproval((req.params as { id: string }).id, body.decision === 'approve' ? 'approved' : 'denied') };
  });

  app.get('/api/models', async () => {
    const minute = new Date().toISOString().slice(0, 16);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    const quota = FREE_TIER_SNAPSHOT.map((row) => {
      const used = store.quotaUse(row.apiName, day);
      return { ...row, availability: quotaAvailability(row, { rpm: used.rpmWindow === minute ? used.rpm : 0, tpm: used.tpmWindow === minute ? used.tpm : 0, rpd: used.rpd }) };
    });
    return { models: store.listModels(), providers: store.listProviders(), resident: lastScan?.resident ?? [], quota, quotaObservedAt: FREE_TIER_OBSERVED_AT };
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
  app.patch('/api/providers/:id', async (req) => {
    const body = parse(z.object({ enabled: z.boolean().optional(), baseUrl: z.string().nullable().optional(), apiKeyEnv: z.string().nullable().optional(), name: z.string().optional() }), req.body);
    const provider = store.updateProvider((req.params as { id: string }).id, body);
    if (!provider) throw http(404, 'Provider not found.');
    return { provider };
  });

  app.get('/api/mcp', async () => ({ servers: mcp.list(), builtin: ['shell', 'files', 'web_search', 'web_fetch', 'docker', 'memory', 'consult_agent', 'plan', 'grep', 'glob', 'apply_patch', 'git'] }));
  app.post('/api/mcp/discover', async () => ({ servers: mcp.importFound(config.dataDir), found: importConfigs(config.dataDir).length }));
  app.get('/api/mcp/registry', async (req) => searchRegistry(String((req.query as { q?: string }).q || 'file'), fetchImpl));
  app.post('/api/mcp/vet', async (req) => {
    const body = parse(z.object({
      name: z.string(), command: z.string().optional(), args: z.array(z.string()).optional(), url: z.string().optional(), source: z.string().optional(),
    }), req.body);
    const report = await vetSpec({ name: body.name, transport: body.url ? 'http' : 'stdio', command: body.command, args: body.args, url: body.url, source: body.source || 'ui' }, fetchImpl);
    store.saveVetting(report.id, report);
    return { report };
  });
  app.post('/api/mcp/install', async (req) => {
    const body = parse(z.object({ reportId: z.string(), acknowledgeRisk: z.boolean(), acknowledgeCritical: z.boolean().optional(), grants: z.array(z.string()).optional() }), req.body);
    const report = store.getVetting<import('./mcp.js').VettingReport>(body.reportId);
    if (!report) throw http(404, 'Vetting report not found. Vet the server first.');
    return { server: mcp.install(report, body) };
  });
  app.post('/api/mcp/:id/refresh', async (req) => ({ server: await mcp.connect((req.params as { id: string }).id) }));
  app.delete('/api/mcp/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await mcp.stop(id);
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

  app.get('/api/schedules', async () => ({ schedules: store.listSchedules() }));
  app.post('/api/schedules', async (req) => {
    const body = parse(z.object({ agentId: z.string(), name: z.string().min(1), cron: z.string(), prompt: z.string().min(1) }), req.body);
    const next = nextCron(body.cron, new Date()).toISOString();
    return { schedule: store.createSchedule({ ...body, nextRunAt: next }) };
  });
  app.patch('/api/schedules/:id', async (req) => {
    const body = parse(z.object({ name: z.string().optional(), cron: z.string().optional(), prompt: z.string().optional(), enabled: z.boolean().optional() }), req.body);
    const next = body.cron ? nextCron(body.cron, new Date()).toISOString() : undefined;
    return { schedule: store.updateSchedule((req.params as { id: string }).id, { ...body, nextRunAt: next }) };
  });
  app.delete('/api/schedules/:id', async (req) => {
    store.deleteSchedule((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/schedules/:id/run', async (req) => {
    const schedule = store.getSchedule((req.params as { id: string }).id);
    if (!schedule) throw http(404, 'Schedule not found.');
    const session = schedule.sessionId ? store.getSession(schedule.sessionId) : store.createSession({ agentId: schedule.agentId, title: schedule.name });
    if (!session) throw http(400, 'Session missing.');
    if (!schedule.sessionId) store.updateSchedule(schedule.id, { sessionId: session.id });
    const run = await engine.startTurn({ sessionId: session.id, agentId: schedule.agentId, content: schedule.prompt });
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

  app.get('/api/resources', async () => ({ current: snapshotResources(store, config.dataDir) }));
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
  app.get('/api/backups', async () => ({ backups: listBackups(config.dataDir) }));
  app.post('/api/backups', async () => {
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
  app.post('/api/voice/transcribe', async (req) => {
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as ArrayBuffer);
    const text = await transcribe(fetchImpl, audio, String(req.headers['content-type'] || 'audio/webm'));
    return { text };
  });
  app.post('/api/voice/speak', async (req, reply) => {
    const body = parse(z.object({ text: z.string().min(1).max(2000) }), req.body);
    const audio = await speak(fetchImpl, body.text);
    reply.header('content-type', audio.type);
    return reply.send(audio.bytes);
  });
  app.get('/api/push/key', async () => ({ publicKey: notifier.publicKey() }));
  app.post('/api/push/subscribe', async (req) => {
    const body = parse(z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }), req.body);
    notifier.addSubscription(body);
    return { ok: true };
  });
  app.get('/api/logs', async () => ({ logs: store.listLogs() }));
  app.get('/api/memory', async (req) => ({ notes: store.listNotes(String((req.query as { agentId?: string }).agentId || '')) }));
  app.post('/api/memory', async (req) => {
    const body = parse(z.object({ agentId: z.string(), content: z.string().min(1), pinned: z.boolean().optional() }), req.body);
    return { note: store.createNote(body.agentId, body.content, body.pinned) };
  });
  app.delete('/api/memory/:id', async (req) => {
    store.deleteNote((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get('/api/live', { websocket: true }, (socket, req) => {
    void (async () => {
      if (!(await authenticate(store, req))) {
        socket.close();
        return;
      }
      const off = bus.subscribeAll((event) => {
        try { socket.send(JSON.stringify(event)); } catch { /* closed */ }
      });
      socket.on('close', () => off());
    })();
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw http(400, result.error.issues[0]?.message || 'Invalid input.');
  return result.data;
}

function http(statusCode: number, message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

async function runSetup(action: string, model: string | undefined, jobId: string, ctx: Ctx) {
  const { store, docker, fetchImpl } = ctx;
  try {
    if (action === 'pull-model') {
      const name = model || 'gemma4:e4b';
      const base = (process.env.OLLAMA_HOST || lastScan?.ollama?.url || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const response = await fetchImpl(`${base}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }) });
      if (!response.ok || !response.body) throw new Error(`Ollama pull failed (${response.status}).`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        store.appendJob(jobId, decoder.decode(chunk.value));
      }
    } else if (action === 'start-searxng') {
      if (!docker.available()) throw new Error('Docker is not available.');
      const id = await docker.startDetached({
        Image: 'docker.io/searxng/searxng:latest',
        name: 'local-agent-searxng',
        Labels: { 'local-agent.role': 'searxng' },
        ExposedPorts: { '8080/tcp': {} },
        HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '8088' }] }, RestartPolicy: { Name: 'unless-stopped' } },
      });
      store.appendJob(jobId, `started ${id}\n`);
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
