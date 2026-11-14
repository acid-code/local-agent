import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FREE_TIER_OBSERVED_AT, FREE_TIER_SNAPSHOT, VERSION, geminiQuotaDay, nextCron, quotaAvailability } from '@local-agent/shared';
import { authenticate, hashPassword, noteFailure, rateLimit, setSession, verifyPassword } from './auth.js';
import { TEMPLATES } from './catalog.js';
import { detectCodingClis, listEdits, readPlan, replacePlan, revertBatch, updatePlanItem } from './coding.js';
import { secretDrift, secretNames, writeSecret } from './config.js';
import type { DockerCtl } from './docker.js';
import { checklist, scanMachine, setupPreview } from './discovery.js';
import type { McpRuntime } from './mcp.js';
import { importConfigs, searchRegistry, vetSpec } from './mcp.js';
import { localReputationSummarizer } from './reputation.js';
import type { Notifier } from './notify.js';
import { createBackup, listBackups, shipBackup, stageRestore } from './ops.js';
import { telegramQueue } from './notify.js';
import { ollamaLoaded } from './ollama.js';
import { doctorChecks, geminiStateOf, missingRoleModels, redactValue, searchLogs, zipStore, LOG_COMPONENTS, type LogComponent } from './debug.js';
import { previewPrune, runPrune, snapshotResources } from './resources.js';
import { speak, transcribe, voiceStatus, KOKORO_COMMAND, WHISPER_COMMAND } from './voice.js';
import { formatSearch, listWorkspace, readWorkspaceFile, searxngHealth, searxngQuery } from './tools.js';
import {
  KbInputError, createCollection, deleteCollection, deleteDocument, embedRoleWarning, listDocuments, formatCitations, ingestBuffer, ingestFolder, kbUsage, listCollections, ollamaEmbedder, searchKnowledge,
} from './kb.js';
import {
  exportSkill, importSkill, listSkills, parseSkillMd, saveSkill, setSkillEnabled, skillFit, skillVersions,
} from './skills.js';
import {
  createTrigger, fireTrigger, getTrigger, githubSignatureOk, listTriggerEvents, listTriggers, secretEquals, triggerSecret,
  type TriggerKind,
} from './triggers.js';
import { secret as randomSecret } from './util.js';
import { createWorkshop, getWorkshop, listWorkshops } from './workshops.js';
import { ACCENT_DEFAULT, FACES, accentOk, avatarPath, saveAvatar } from './avatars.js';
import type { Bus } from './bus.js';
import type { Engine } from './engine.js';
import { git } from './repos.js';
import { isInside } from '@local-agent/shared';
import { CONTEXT_MARK, expandMentions } from './mentions.js';
import { cloneInto, gitRoot, gitStatus, listDir, listGitRoots, openPullRequest, pushBranch, readExcerpt, validBranch } from './gitops.js';
import { MAX_FILE_BYTES, deleteFile, filePath, getFile, getMessageRow, listFiles, mimeFor, saveFile, searchMessages } from './files.js';
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
    return { needsSetup: !owner, authenticated, username: authenticated ? owner?.username : undefined, version: VERSION, restartKeys: authenticated ? secretDrift(config.dataDir) : [] };
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
      searchHits: z.number().int().min(1).max(20).optional(),
      approvalForDestructive: z.boolean().optional(),
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

  app.get('/api/agents', async () => ({ agents: store.listAgents(), templates: TEMPLATES, faces: FACES }));
  app.post('/api/agents/reorder', async (req) => {
    const body = parse(z.object({ ids: z.array(z.string()).min(1) }), req.body);
    store.reorderAgents(body.ids);
    return { agents: store.listAgents() };
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
    }), req.body);
    if (body.accent && !accentOk(body.accent)) throw http(400, 'Accent colors look like #e4b56a.');
    if (body.avatarKind === 'builtin' && body.avatarRef && !FACES.some((face) => face.id === body.avatarRef)) throw http(400, 'That face is not in the built-in set.');
    const agent = store.updateAgent((req.params as { id: string }).id, body);
    if (!agent) throw http(404, 'Persona not found.');
    return { agent };
  });
  app.get('/api/agents/:id', async (req) => {
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent) throw http(404, 'Persona not found.');
    return { agent };
  });
  app.post('/api/agents/:id/read', async (req) => {
    store.markAgentRead((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/agents/:id/avatar', async (req) => {
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
    const agent = store.getAgent((req.params as { id: string }).id);
    if (!agent || agent.avatarKind !== 'upload') throw http(404, 'No uploaded face.');
    const file = avatarPath(config.dataDir, agent.avatarRef);
    if (!file) throw http(404, 'No uploaded face.');
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
    reply.type(type);
    return reply.send(fs.readFileSync(file));
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

  // Files: uploads and agent outputs.
  app.post('/api/files', { bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4) + 4096 }, async (req) => {
    const body = parse(z.object({ name: z.string().min(1).max(200), contentBase64: z.string().min(1), sessionId: z.string().optional() }), req.body);
    if (body.sessionId && !store.getSession(body.sessionId)) throw http(404, 'Chat not found.');
    try {
      return { file: saveFile(store, config.dataDir, { name: body.name, bytes: Buffer.from(body.contentBase64, 'base64'), sessionId: body.sessionId ?? null, source: 'upload' }) };
    } catch (error) {
      throw http(400, error instanceof Error ? error.message : 'Could not save the file.');
    }
  });
  app.get('/api/files', async (req) => {
    const query = parse(z.object({ sessionId: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().int().optional() }), req.query);
    return { files: listFiles(store, { sessionId: query.sessionId, query: query.q, limit: query.limit }) };
  });
  app.get('/api/files/:id', async (req) => {
    const file = getFile(store, (req.params as { id: string }).id);
    if (!file) throw http(404, 'File not found.');
    return { file };
  });
  app.get('/api/files/:id/raw', async (req, reply) => {
    const id = (req.params as { id: string }).id;
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
    if (!deleteFile(store, config.dataDir, (req.params as { id: string }).id)) throw http(404, 'File not found.');
    return { ok: true };
  });
  app.get('/api/messages/:id', async (req) => {
    const message = getMessageRow(store, (req.params as { id: string }).id);
    if (!message) throw http(404, 'Message not found.');
    return { message };
  });
  app.get('/api/context/search', async (req) => {
    const query = parse(z.object({ q: z.string().min(1), sessionId: z.string().optional(), scope: z.enum(['session', 'all']).optional() }), req.query);
    return { messages: searchMessages(store, { sessionId: query.sessionId, query: query.q, scope: query.scope ?? 'all', limit: 20 }), files: listFiles(store, { query: query.q, limit: 20 }) };
  });
  // Git and the workspace browser: agent workspaces and shared repos / workshop projects.
  const gitToken = () => vault.valueByName('GITHUB_TOKEN') || null;
  const ident = () => { const s = store.getSettings(); return { name: s.gitName, email: s.gitEmail, sshKey: s.gitSshKey || undefined, token: gitToken() }; };
  const rootOf = (id: string) => { try { return gitRoot(store, id); } catch { throw http(404, 'Unknown folder.'); } };
  app.get('/api/git/roots', async () => ({ roots: listGitRoots(store).map((root) => ({ ...root, remote: root.remote ? root.remote.replace(/(https?:\/\/)[^@/\s]+@/i, '$1***@') : null })), github: Boolean(gitToken()) }));
  app.get('/api/git/:root/status', async (req) => ({ status: await gitStatus(rootOf((req.params as { root: string }).root).path) }));
  app.get('/api/git/:root/diff', async (req) => {
    const root = rootOf((req.params as { root: string }).root);
    const file = String((req.query as { path?: string }).path || '');
    if (file && (file.startsWith('-') || !isInside(root.path, path.resolve(root.path, file)))) throw http(400, 'Bad path.');
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
    const root = rootOf((req.params as { root: string }).root);
    try { return { entries: listDir(root.path, String((req.query as { path?: string }).path || '.')) }; } catch (error) { throw http(400, error instanceof Error ? error.message : 'Bad path.'); }
  });
  app.get('/api/git/:root/raw', async (req, reply) => {
    const root = rootOf((req.params as { root: string }).root);
    const q = req.query as { path?: string; download?: string };
    const full = path.resolve(root.path, String(q.path || ''));
    if (!isInside(root.path, full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw http(404, 'File not found.');
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
    const root = rootOf((req.params as { root: string }).root);
    const q = req.query as { path?: string; start?: string; end?: string };
    try { return { file: readExcerpt(root.path, String(q.path || ''), { start: Number(q.start) || undefined, end: Number(q.end) || undefined }) }; } catch (error) { throw http(400, error instanceof Error ? error.message : 'Bad path.'); }
  });
  app.post('/api/git/clone', async (req) => {
    const body = parse(z.object({ url: z.string().min(1), label: z.string().optional(), workshopId: z.string().optional() }), req.body);
    try { return await cloneInto(store, config.dataDir, body); } catch (error) { throw http(400, error instanceof Error ? error.message : 'Clone failed.'); }
  });
  app.post('/api/git/:root/action', async (req) => {
    const root = rootOf((req.params as { root: string }).root);
    const body = parse(z.object({
      action: z.enum(['init', 'fetch', 'pull', 'commit', 'branch', 'checkout', 'push', 'open_pr', 'remote']),
      message: z.string().optional(), name: z.string().optional(), url: z.string().optional(), title: z.string().optional(), body: z.string().optional(), base: z.string().optional(),
      paths: z.array(z.string()).optional(), confirmMain: z.boolean().optional(),
    }), req.body);
    const cwd = root.path;
    const strip = (raw: string) => raw.replace(/^exit \d+\n/, '');
    const fail = (raw: string, what: string) => { if (!/^exit 0\n/.test(raw)) throw http(400, `${what} failed.\n${strip(raw).slice(0, 1200)}`); return strip(raw); };
    if (body.action === 'init') return { output: fail(await git(cwd, ['init', '-b', 'main']), 'git init') };
    if (body.action === 'fetch') return { output: fail(await git(cwd, ['fetch', '--prune'], ident()), 'Fetch') };
    if (body.action === 'pull') {
      const out = await git(cwd, ['pull', '--ff-only'], ident());
      if (!/^exit 0\n/.test(out)) throw http(409, /diverg|fast-forward|CONFLICT/i.test(out) ? 'Pull stopped: the histories diverged. Nothing was merged.' : `Pull failed.\n${strip(out).slice(0, 1200)}`);
      return { output: strip(out) };
    }
    if (body.action === 'commit') {
      const message = (body.message || '').trim();
      if (!message) throw http(400, 'Write a commit message.');
      const paths = (body.paths || []).filter((p) => p && !p.startsWith('-') && isInside(cwd, path.resolve(cwd, p)));
      fail(await git(cwd, ['add', '-A', '--', ...(paths.length ? paths : ['.'])]), 'Staging');
      const out = await git(cwd, ['commit', '-m', message], ident());
      if (/nothing to commit/i.test(out)) throw http(400, 'Nothing to commit.');
      return { output: fail(out, 'Commit') };
    }
    if (body.action === 'branch' || body.action === 'checkout') {
      const name = (body.name || '').trim();
      if (!validBranch(name)) throw http(400, 'Branch names look like feature/login-fix.');
      return { output: fail(await git(cwd, body.action === 'branch' ? ['checkout', '-b', name] : ['checkout', name]), body.action === 'branch' ? 'New branch' : 'Checkout') };
    }
    if (body.action === 'remote') {
      const url = (body.url || '').trim();
      if (!url || /[\s;&|`$]/.test(url)) throw http(400, 'Give a remote URL.');
      const has = await git(cwd, ['remote', 'get-url', 'origin']);
      return { output: fail(await git(cwd, /^exit 0\n/.test(has) ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]), 'Setting origin') };
    }
    if (body.action === 'push') {
      try {
        const pushed = await pushBranch(cwd, ident(), { allowMain: body.confirmMain === true });
        if (!pushed.ok) throw http(409, pushed.output.slice(0, 1500));
        return { output: pushed.output, branch: pushed.branch };
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode) throw error;
        throw http(400, error instanceof Error ? error.message : 'Push failed.');
      }
    }
    try {
      const pr = await openPullRequest(cwd, gitToken(), fetchImpl, { title: (body.title || '').trim() || 'Changes from local-agent', body: body.body, base: body.base });
      return { pr };
    } catch (error) {
      throw http(400, error instanceof Error ? error.message : 'Could not open the PR.');
    }
  });
  app.get('/api/workshops', async () => ({ workshops: listWorkshops(store) }));
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
    const coder = store.listAgents().find((agent) => agent.toolAllowlist.includes('git')) ?? store.listAgents()[0];
    const agentId = body.agentId || coder?.id;
    if (!agentId) throw http(400, 'Create a persona first. The coder is the one that should own a workshop.');
    const session = store.createSession({ agentId, title: workshop.name });
    store.updateSession(session.id, { mode: 'code', workshopId: workshop.id });
    return { workshop, session: store.getSession(session.id) };
  });
  app.get('/api/sessions', async (req) => {
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), cursor: z.string().optional() }), req.query);
    return store.pageSessions({ limit: query.limit ?? 100, cursor: query.cursor || null });
  });
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
    const workshop = session.workshopId ? getWorkshop(store, session.workshopId) : null;
    return { session, messages: store.listMessages(id), summaries: store.listSummaries(id), plan: readPlan(store, id), edits: listEdits(store, id), archived: store.listArchived(id), workshop };
  });
  app.patch('/api/sessions/:id', async (req) => {
    const body = parse(z.object({ title: z.string().optional(), mode: z.enum(['chat', 'code']).optional(), modelPin: z.string().nullable().optional() }), req.body);
    if (!store.getSession((req.params as { id: string }).id)) throw http(404, 'Chat not found.');
    if (body.modelPin) body.modelPin = chatModelId(store, body.modelPin);
    return { session: store.updateSession((req.params as { id: string }).id, body) };
  });
  app.delete('/api/sessions/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!store.getSession(id)) throw http(404, 'Chat not found.');
    if (engine.sessionBusy(id)) throw http(409, 'A reply is still running in this chat. Press Stop first, then delete it.');
    store.updateSession(id, { archived: true });
    return { ok: true };
  });
  app.post('/api/sessions/:id/messages', async (req) => {
    const id = (req.params as { id: string }).id;
    const session = store.getSession(id);
    if (!session) throw http(404, 'Chat not found.');
    const body = parse(z.object({
      content: z.string().min(1), agentId: z.string().optional(), modelId: z.string().optional(), imageUrl: z.string().optional(),
      mentions: z.array(z.union([
        z.object({ kind: z.literal('path'), root: z.string().min(1), path: z.string(), start: z.number().int().positive().optional(), end: z.number().int().positive().optional() }),
        z.object({ kind: z.literal('file'), id: z.string().min(1) }),
      ])).max(12).optional(),
    }), req.body);
    const modelId = body.modelId ? chatModelId(store, body.modelId) : undefined;
    if (!body.content.trim()) throw http(400, 'Type a message first.');
    const agentId = body.agentId || session.agentId;
    if (!agentId) throw http(400, 'Choose a persona.');
    if (engine.sessionBusy(id)) throw http(409, 'A reply is still running in this chat. Wait for it or press Stop, then send again.');
    const offers = vault.capture(null, body.content);
    const context = body.mentions?.length ? expandMentions(store, body.mentions) : '';
    const content = context ? `${body.content}${CONTEXT_MARK}${context}` : body.content;
    const run = await engine.startTurn({ sessionId: id, agentId, content: vault.redact(content), imageUrl: body.imageUrl, modelId });
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
    const day = geminiQuotaDay();
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
    return { current: { ...current, loadedModels, flags } };
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
  app.get('/api/logs', async (req) => {
    const query = req.query as { component?: string; level?: string; q?: string };
    return { logs: searchLogs(store, query), components: LOG_COMPONENTS, debugLevel: store.getSettings().debugLevel };
  });
  app.get('/api/debug/runs/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const run = store.getRun(id);
    if (!run) throw http(404, 'Run not found.');
    const approvals = store.listApprovals().filter((item) => item.runId === id);
    return redactValue({
      run, steps: store.listSteps(id), approvals,
      messages: store.listMessages(run.sessionId).filter((message) => message.runId === id || message.role === 'user'),
    });
  });
  app.post('/api/debug/runs/:id/replay', async (req) => {
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
  app.get('/api/debug/health', async () => ({ checks: await healthChecks(store, docker, fetchImpl, config.dataDir) }));
  app.post('/api/debug/health/:id', async (req) => {
    const checks = await healthChecks(store, docker, fetchImpl, config.dataDir);
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
    const checks = await healthChecks(store, docker, fetchImpl, config.dataDir);
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

  registerLibrary(app, ctx);
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

async function healthChecks(store: Store, docker: DockerCtl, fetchImpl: typeof fetch, dataDir: string) {
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
  let installed: string[] | null = null;
  if (ollamaOk) {
    try {
      const tags = await fetchImpl(`${(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (tags.ok) installed = ((await tags.json()) as { models?: { name: string }[] }).models?.map((model) => model.name) ?? [];
    } catch { installed = null; }
  }
  const missingRoles = installed ? missingRoleModels(settings.autoModels as unknown as Record<string, string>, installed) : [];
  return [...doctorChecks({
    ollamaOk, loaded, dockerOk: await docker.ping(), mcpCount: mcp.length, mcpErrors: mcp.filter((item) => item.lastError).length,
    searxngOk: searx.ok, searxngDetail: searx.detail, telegramQueued: telegramQueue(dataDir).length, dbBytes,
    diskFreeBytes: snap.disk.freeBytes, memAvailableGiB: snap.memory.availableGiB,
    geminiOpen: settings.geminiTier === 'paid' ? true : null, geminiState: geminiStateOf(store.getProvider('prov_gemini')) === 'off' ? 'off' : undefined, lastBackupAt: backups[0]?.createdAt ?? null, tailscaleOk: await tailscaleUp(),
  }), { id: 'embed', ok: !embedWarning, detail: embedWarning || (ollamaOk ? 'The embed role is an embedding model.' : 'Ollama is down, so the embed role was not checked.') },
  { id: 'roles', ok: missingRoles.length === 0, detail: installed === null ? 'Ollama is down, so the Auto roles were not checked.' : missingRoles.length ? `Auto roles point at models Ollama does not have: ${missingRoles.join(', ')}. Pull them or change Defaults in Setup.` : 'Every Auto role points at an installed model.' }];
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

function registerLibrary(app: FastifyInstance, ctx: Ctx) {
  const { store, engine, vault, config, fetchImpl } = ctx;
  const embed = () => ollamaEmbedder(fetchImpl, store.getSettings().autoModels.embed || 'nomic-embed-text');

  app.get('/api/kb/collections', async () => ({ collections: listCollections(store), usage: kbUsage(store) }));
  app.post('/api/kb/collections', async (req) => {
    const body = parse(z.object({ name: z.string().min(1), agentId: z.string().nullable().optional(), rootPath: z.string().optional() }), req.body);
    return { collection: createCollection(store, body) };
  });
  app.post('/api/kb/collections/:id/files', async (req) => {
    const body = parse(z.object({
      files: z.array(z.object({ name: z.string().min(1), contentBase64: z.string().min(1) })).min(1),
    }), req.body);
    const id = (req.params as { id: string }).id;
    if (!store.db.prepare('SELECT id FROM kb_collections WHERE id = ?').get(id)) throw http(404, 'Collection not found.');
    const results: Array<{ name: string; error?: string } & Partial<Awaited<ReturnType<typeof ingestBuffer>>>> = [];
    for (const file of body.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      try {
        results.push({ name: file.name, ...(await ingestBuffer(store, id, { name: file.name, bytes }, embed())) });
      } catch (error) {
        if (!(error instanceof KbInputError)) throw error;
        results.push({ name: file.name, error: error.message });
      }
    }
    if (results.every((item) => item.error)) {
      const error = http(400, results.map((item) => item.error).join(' ')) as Error & { results?: unknown };
      throw error;
    }
    return { results, usage: kbUsage(store) };
  });
  app.get('/api/kb/collections/:id/files', async (req) => ({ files: listDocuments(store, (req.params as { id: string }).id) }));
  app.delete('/api/kb/collections/:id/files/:docId', async (req) => {
    const params = req.params as { id: string; docId: string };
    if (!deleteDocument(store, params.id, params.docId)) throw http(404, 'File not found in that collection.');
    return { ok: true, usage: kbUsage(store) };
  });
  app.delete('/api/kb/collections/:id', async (req) => {
    if (!deleteCollection(store, (req.params as { id: string }).id)) throw http(404, 'Collection not found.');
    return { ok: true, usage: kbUsage(store) };
  });
  app.post('/api/kb/collections/:id/folder', async (req) => {
    const body = parse(z.object({ path: z.string().min(1) }), req.body);
    return { results: await ingestFolder(store, (req.params as { id: string }).id, body.path, embed()) };
  });
  app.post('/api/kb/collections/:id/reindex', async (req) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.prepare('SELECT root_path FROM kb_collections WHERE id = ?').get(id) as { root_path: string | null } | undefined;
    if (!row?.root_path) throw http(400, 'This collection has no folder to re-index. Drop the files again.');
    return { results: await ingestFolder(store, id, row.root_path, embed()) };
  });
  app.post('/api/kb/search', async (req) => {
    const body = parse(z.object({ query: z.string().min(1), collectionId: z.string().optional(), agentId: z.string().optional() }), req.body);
    return { hits: await searchKnowledge(store, body.query, { collectionId: body.collectionId, agentId: body.agentId, embed: embed() }) };
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

  app.get('/api/triggers', async () => ({
    triggers: listTriggers(store).map((trigger) => ({ ...trigger, events: listTriggerEvents(store, trigger.id) })),
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
    const secret = randomSecret(24);
    const trigger = createTrigger(store, vault, { ...body, kind: body.kind as TriggerKind, secret });
    ctx.bus.publish({ type: 'trigger', message: trigger.id });
    return { trigger, secret, url: hookUrl(trigger.id, trigger.kind) };
  });
  app.post('/api/triggers/:id/test', async (req) => {
    const body = parse(z.object({ event: z.unknown().optional() }), req.body);
    const trigger = getTrigger(store, (req.params as { id: string }).id);
    if (!trigger) throw http(404, 'Trigger not found.');
    const event = body.event ?? { test: true, note: 'Fired from the triggers page.' };
    return fireTrigger(store, engine, trigger, event, { test: true, wait: true });
  });
  app.delete('/api/triggers/:id', async (req) => {
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

async function runSetup(action: string, model: string | undefined, jobId: string, ctx: Ctx) {
  const { store, docker, fetchImpl } = ctx;
  try {
    if (action === 'pull-model' || action === 'pull-embed') {
      const name = action === 'pull-embed' ? 'nomic-embed-text' : (model || 'gemma4:e4b');
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
      if (!(await docker.ping())) throw new Error(`Docker is not available at ${docker.describe()}.`);
      const config = searxngConfig(ctx.config.dataDir);
      store.appendJob(jobId, 'pulling docker.io/searxng/searxng:latest\n');
      await docker.pull('docker.io/searxng/searxng:latest').catch(() => store.appendJob(jobId, 'pull failed; using the local image if there is one\n'));
      // The stock settings only allow HTML, so format=json is a 403. Ship our own into a writable volume.
      const id = await docker.startDetached({
        Image: 'docker.io/searxng/searxng:latest',
        name: 'local-agent-searxng',
        replace: true,
        Labels: { 'local-agent.role': 'searxng' },
        Env: [`SEARXNG_SECRET=${config.secret}`, 'SEARXNG_BASE_URL=http://127.0.0.1:8088/'],
        ExposedPorts: { '8080/tcp': {} },
        HostConfig: {
          PortBindings: { '8080/tcp': [{ HostPort: '8088' }] },
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: ['local-agent-searxng-config:/etc/searxng'],
        },
        files: [{ dir: '/etc/searxng', name: 'settings.yml', content: config.yaml, mode: 0o644 }],
      });
      store.appendJob(jobId, `started ${id.slice(0, 12)} with JSON output on\n`);
      const current = store.getSettings();
      if (!current.searxngUrl) store.saveSettings({ ...current, searxngUrl: 'http://127.0.0.1:8088' }, 'SearXNG started', { searxngUrl: 'http://127.0.0.1:8088' });
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
