import { cronMatches } from '@local-agent/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { hashPassword, noteFailure, rateLimit, setSession, verifyPassword, authenticate } from './auth.js';
import { writeSecret } from './config.js';
import { DockerCtl } from './docker.js';
import { scanMachine } from './discovery.js';
import { isLanAddress } from './lan.js';
import type { Store } from './db.js';
import { consumeSetupToken, setupTokenValid } from './setup-token.js';
import { contractWarnings } from './contracts.js';
import { toolCapabilityWarnings } from './ollama.js';
import { embedRoleWarning } from './kb.js';
import type { Settings } from './settings.js';
import type { Vault } from './vault.js';
import fs from 'node:fs';
import { accountDir, createMember, listMembers } from './accounts.js';

const ENV_KEYS = new Set(['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const VAULT_KEYS = new Set([...ENV_KEYS, 'IMAP_USER', 'IMAP_PASSWORD']);

export async function buildSetupApp(options: {
  dataDir: string;
  store: Store;
  vault: Vault;
  cookieSecret: string;
  fetchImpl?: typeof fetch;
  allow?: string[];
  docker?: DockerCtl;
}): Promise<FastifyInstance> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allow = options.allow ?? [];
  const app = Fastify({ bodyLimit: 256 * 1024, logger: false, trustProxy: false });
  await app.register(cookie, { secret: options.cookieSecret });

  app.setErrorHandler((error: unknown, _req, reply) => {
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const message = error instanceof Error ? error.message : 'Invalid input.';
    return reply.code(status || 500).send({ error: status >= 500 ? 'Internal error' : message });
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cache-control', 'no-store');
    const ip = req.socket?.remoteAddress || req.ip || '';
    if (!isLanAddress(ip, allow)) {
      return reply.code(403).send({ error: 'Setup is only available from a private LAN address.' });
    }
  });

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return reply.send(PAGE);
  });

  app.get('/api/setup/state', async (req, reply) => {
    const owner = options.store.getOwner();
    const authed = owner ? (await authenticate(options.store, req)) && (req as { account?: { role?: string } }).account?.role === 'owner' : false;
    if (!owner) return { needsOwner: true, authenticated: false };
    if (!authed) return reply.code(401).send({ needsOwner: false, authenticated: false });
    const models = options.store.listModels();
    const capability = await toolCapabilityWarnings(fetchImpl, models);
    const embedWarning = await embedRoleWarning(options.store, fetchImpl);
    const warnings = [
      ...contractWarnings(models.filter((model) => model.local && model.embedding).map((model) => model.name)),
      ...capability,
      ...(embedWarning ? [embedWarning] : []),
    ];
    const support = { ...options.store.getSettings().toolSupport };
    let changed = false;
    for (const model of models) {
      if (!capability.some((line) => line.startsWith(`${model.name} does not support`))) continue;
      if (support[model.apiName] === false) continue;
      support[model.apiName] = false;
      changed = true;
    }
    if (changed) {
      const current = options.store.getSettings();
      options.store.saveSettings({ ...current, toolSupport: support }, 'Recorded models without tool calls', { toolSupport: support });
    }
    return { needsOwner: false, authenticated: true, warnings, ...publicState(options.store, options.vault) };
  });

  app.post('/api/setup/owner', async (req, reply) => {
    if (options.store.getOwner()) return reply.code(409).send({ error: 'An owner already exists. Sign in.' });
    const body = parse(z.object({
      token: z.string().min(8),
      username: z.string().regex(/^[a-zA-Z0-9._-]{1,32}$/),
      password: z.string().min(8).max(200),
    }), req.body);
    if (!setupTokenValid(options.dataDir, body.token)) return reply.code(401).send({ error: 'That setup token is not valid.' });
    if (body.password === body.token) return reply.code(400).send({ error: 'Use a password that is not the setup token.' });
    try {
      options.store.createOwner(body.username, await hashPassword(body.password));
    } catch (error) {
      if (error instanceof Error && /already exists|UNIQUE/i.test(error.message)) return reply.code(409).send({ error: 'An owner already exists.' });
      throw error;
    }
    consumeSetupToken(options.dataDir);
    await setSession(reply, options.store);
    return { ok: true, username: body.username };
  });

  app.post('/api/setup/login', async (req, reply) => {
    const ip = req.socket?.remoteAddress || req.ip || '';
    if (rateLimit(ip)) return reply.code(429).send({ error: 'Too many attempts. Wait and try again.' });
    const owner = options.store.getOwner();
    if (!owner) return reply.code(400).send({ error: 'Create the owner with the setup token first.' });
    const body = parse(z.object({ username: z.string(), password: z.string() }), req.body);
    if (body.username !== owner.username || !(await verifyPassword(body.password, owner.passwordHash))) {
      noteFailure(ip);
      return reply.code(401).send({ error: 'Wrong username or password.' });
    }
    await setSession(reply, options.store);
    return { ok: true };
  });

  app.post('/api/setup/detect', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    const docker = options.docker ?? new DockerCtl();
    const scan = await scanMachine(fetchImpl, docker, options.store);
    return {
      ollama: scan.ollama?.url ?? null,
      models: (scan.ollama?.models ?? []).map((model) => model.name),
      known: options.store.listModels().filter((model) => model.enabled).map((model) => ({ id: model.id, name: model.name, local: model.local })),
    };
  });

  app.post('/api/setup/secret', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    const body = parse(z.object({ key: z.string(), value: z.string().min(1).max(4000) }), req.body);
    if (!VAULT_KEYS.has(body.key)) return reply.code(400).send({ error: 'That name is not a setup credential.' });
    if (/[\r\n]/.test(body.value)) return reply.code(400).send({ error: 'Credentials cannot contain line breaks.' });
    saveCredential(options, body.key, body.value);
    return { ok: true, key: body.key, set: true };
  });

  app.post('/api/setup/test', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    const body = parse(z.object({
      kind: z.enum(['gemini', 'openrouter', 'telegram']),
      value: z.string().max(4000).optional(),
      chatId: z.string().max(40).optional(),
    }), req.body);
    if (body.kind === 'telegram') {
      if (body.value) saveCredential(options, 'TELEGRAM_BOT_TOKEN', body.value);
      if (body.chatId) saveCredential(options, 'TELEGRAM_CHAT_ID', body.chatId);
      return testTelegram(options.vault, fetchImpl);
    }
    const keyName = body.kind === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY';
    const value = (body.value || options.vault.valueByName(keyName) || process.env[keyName] || '').trim();
    if (!value) return reply.code(400).send({ error: 'Save the key first, or paste it into the test.' });
    if (body.value) {
      options.vault.put({ name: keyName, value, actor: 'setup-lan' });
      writeSecret(options.dataDir, keyName, value);
    }
    return testProvider(body.kind, value, fetchImpl);
  });

  app.patch('/api/setup/defaults', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    const body = parse(z.object({
      goodModelId: z.string().nullable().optional(),
      geminiTier: z.enum(['free', 'paid']).optional(),
      quotaLimits: z.record(z.object({ rpm: z.number().int().optional(), rpd: z.number().int().optional() })).optional(),
      backupCron: z.string().optional(),
      backupTransport: z.enum(['none', 'rsync', 'rclone', 's3']).optional(),
      backupTarget: z.string().max(300).optional(),
      imapHost: z.string().max(200).optional(),
      imapPort: z.number().int().optional(),
      imapMailbox: z.string().max(80).optional(),
      gitName: z.string().max(80).optional(),
      gitEmail: z.string().max(120).optional(),
      gitSshKey: z.string().max(300).optional(),
      autoFast: z.string().max(120).optional(),
      autoMain: z.string().max(120).optional(),
      autoCoder: z.string().max(120).optional(),
      autoThinking: z.string().max(120).optional(),
      autoCloud: z.string().max(120).optional(),
      autoEmbed: z.string().max(120).optional(),
      dailyTokenLimit: z.number().int().nullable().optional(),
      dailySpendLimitUsd: z.number().nullable().optional(),
    }), req.body);
    const problem = validateDefaults(options.store, body);
    if (problem) return reply.code(400).send({ error: problem });
    const { autoFast, autoMain, autoCoder, autoThinking, autoCloud, autoEmbed, ...rest } = body;
    const next = { ...options.store.getSettings(), ...rest };
    if ([autoFast, autoMain, autoCoder, autoThinking, autoCloud, autoEmbed].some((value) => value !== undefined)) {
      const current = next.autoModels;
      next.autoModels = {
        fast: autoFast ?? current.fast,
        main: autoMain ?? current.main,
        coder: autoCoder ?? current.coder,
        thinking: autoThinking ?? current.thinking,
        cloud: autoCloud ?? current.cloud,
        embed: autoEmbed ?? current.embed,
      };
    }
    const saved = options.store.saveSettings(next, 'LAN setup defaults', { settings: next });
    return { settings: publicSettings(saved) };
  });

  app.get('/api/setup/members', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    return { members: listMembers(options.store).map((member) => ({ username: member.username, displayName: member.displayName, disabled: member.disabled, cloud: member.limits.cloud })) };
  });
  app.post('/api/setup/members', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    const body = parse(z.object({ username: z.string().min(1).max(32), displayName: z.string().max(60).optional(), password: z.string().min(8).max(200), cloud: z.string().optional() }), req.body);
    try {
      const member = createMember(options.store, { username: body.username, displayName: body.displayName || undefined, passwordHash: await hashPassword(body.password), limits: { cloud: body.cloud !== 'off' } });
      fs.mkdirSync(accountDir(options.dataDir, member.id), { recursive: true });
      return { ok: true, username: member.username };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not create that account.' });
    }
  });

  app.post('/api/setup/password', async (req, reply) => {
    if (!(await requireOwner(options.store, req, reply))) return;
    const body = parse(z.object({ current: z.string(), next: z.string().min(8).max(200) }), req.body);
    const owner = options.store.getOwner();
    if (!owner || !(await verifyPassword(body.current, owner.passwordHash))) return reply.code(401).send({ error: 'Current password is wrong.' });
    options.store.db.prepare('UPDATE owner SET password_hash = ? WHERE id = 1').run(await hashPassword(body.next));
    return { ok: true };
  });

  return app;
}

function publicState(store: Store, vault: Vault) {
  const settings = store.getSettings();
  return {
    username: store.getOwner()?.username ?? null,
    models: store.listModels().filter((model) => model.enabled).map((model) => ({ id: model.id, name: model.name, local: model.local })),
    secrets: [...VAULT_KEYS].map((key) => ({ key, set: Boolean(vault.active(key) || process.env[key]) })),
    settings: publicSettings(settings),
  };
}

function publicSettings(settings: Settings) {
  return {
    goodModelId: settings.goodModelId,
    geminiTier: settings.geminiTier,
    quotaLimits: settings.quotaLimits,
    backupCron: settings.backupCron,
    backupTransport: settings.backupTransport,
    backupTarget: settings.backupTarget,
    imapHost: settings.imapHost,
    imapPort: settings.imapPort,
    imapMailbox: settings.imapMailbox,
    gitName: settings.gitName,
    gitEmail: settings.gitEmail,
    gitSshKey: settings.gitSshKey,
    autoModels: settings.autoModels,
    dailyTokenLimit: settings.dailyTokenLimit,
    dailySpendLimitUsd: settings.dailySpendLimitUsd,
  };
}

function validateDefaults(store: Store, body: {
  goodModelId?: string | null;
  quotaLimits?: Record<string, { rpm?: number; rpd?: number }>;
  backupCron?: string;
  backupTransport?: Settings['backupTransport'];
  backupTarget?: string;
  imapHost?: string;
  imapPort?: number;
  imapMailbox?: string;
  gitName?: string;
  gitEmail?: string;
  gitSshKey?: string;
  autoFast?: string;
  autoMain?: string;
  autoCoder?: string;
  autoThinking?: string;
  autoCloud?: string;
  autoEmbed?: string;
  dailyTokenLimit?: number | null;
  dailySpendLimitUsd?: number | null;
}): string | null {
  if (body.goodModelId) {
    const known = store.listModels().some((model) => model.id === body.goodModelId);
    if (!known) return 'Pick a model this machine already knows.';
  }
  if (body.quotaLimits) {
    for (const [name, limit] of Object.entries(body.quotaLimits)) {
      if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(name)) return 'Quota names use letters, numbers, dots, and dashes.';
      if (limit.rpm != null && (limit.rpm < 1 || limit.rpm > 100_000)) return 'RPM must be between 1 and 100000.';
      if (limit.rpd != null && (limit.rpd < 1 || limit.rpd > 1_000_000)) return 'RPD must be between 1 and 1000000.';
    }
  }
  if (body.backupCron) {
    try { cronMatches(body.backupCron, new Date()); } catch (error) {
      return error instanceof Error ? error.message : 'Cron is not valid.';
    }
  }
  const transport = body.backupTransport;
  const target = body.backupTarget ?? '';
  if (transport && transport !== 'none' && !target.trim()) return 'A backup target is required for that transport.';
  if (/[\r\n]/.test(target)) return 'The backup target cannot contain a line break.';
  if (body.imapHost && !/^[a-zA-Z0-9.-]+$/.test(body.imapHost)) return 'IMAP host should be a hostname.';
  if (body.imapPort != null && (body.imapPort < 1 || body.imapPort > 65535)) return 'IMAP port is out of range.';
  if (body.imapMailbox && !/^[A-Za-z0-9._-]+$/.test(body.imapMailbox)) return 'Mailbox names use letters, numbers, dots, and dashes.';
  for (const name of [body.autoFast, body.autoMain, body.autoCoder, body.autoThinking, body.autoCloud, body.autoEmbed]) {
    if (name && /[\r\n]/.test(name)) return 'A model name cannot contain a line break.';
  }
  if (body.gitEmail && !/^[^\s@]+@[^\s@]+$/.test(body.gitEmail)) return 'Git email should look like a mailbox.';
  if (body.gitSshKey && (!body.gitSshKey.startsWith('/') || /[\r\n]/.test(body.gitSshKey))) return 'The SSH key has to be an absolute path on this machine.';
  if (body.dailyTokenLimit != null && body.dailyTokenLimit < 1) return 'Daily token limit must be empty or at least 1.';
  if (body.dailySpendLimitUsd != null && body.dailySpendLimitUsd < 0) return 'Daily spend limit cannot be negative.';
  return null;
}

async function testProvider(kind: 'gemini' | 'openrouter', value: string, fetchImpl: typeof fetch) {
  try {
    const response = kind === 'gemini'
      ? await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': value }, signal: AbortSignal.timeout(12_000) })
      : await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { ok: false, detail: safeDetail(`${kind === 'gemini' ? 'Gemini' : 'OpenRouter'} returned ${response.status}.`, value) };
    return { ok: true, detail: kind === 'gemini' ? 'Gemini accepted the key.' : 'OpenRouter accepted the key.' };
  } catch {
    return { ok: false, detail: 'The provider could not be reached. The key stayed on this machine.' };
  }
}

function saveCredential(options: { dataDir: string; store: Store; vault: Vault }, key: string, value: string) {
  options.vault.put({ name: key, value, actor: 'setup-lan' });
  if (ENV_KEYS.has(key)) writeSecret(options.dataDir, key, value);
  if (key === 'GEMINI_API_KEY') options.store.updateProvider('prov_gemini', { enabled: true });
  if (key === 'OPENROUTER_API_KEY') options.store.updateProvider('prov_openrouter', { enabled: true });
}

async function testTelegram(vault: Vault, fetchImpl: typeof fetch) {
  const token = (vault.valueByName('TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (vault.valueByName('TELEGRAM_CHAT_ID') || process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chat) return { ok: false, detail: 'Save the bot token and the chat id first.' };
  if (!/^-?\d+$/.test(chat)) return { ok: false, detail: 'The chat id should be a number.' };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: 'local-agent setup can reach this chat.' }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { ok: false, detail: safeDetail(`Telegram returned ${response.status}.`, token) };
    return { ok: true, detail: 'Telegram accepted the message.' };
  } catch {
    return { ok: false, detail: 'Telegram could not be reached. The token stayed on this machine.' };
  }
}

function safeDetail(detail: string, secret: string) {
  if (secret.length < 4) return detail;
  return detail.split(secret).join('[redacted]');
}

async function requireOwner(store: Store, req: FastifyRequest, reply: FastifyReply) {
  if (!store.getOwner()) {
    reply.code(401).send({ error: 'Create the owner first.' });
    return false;
  }
  if (!(await authenticate(store, req))) {
    reply.code(401).send({ error: 'Sign in required.' });
    return false;
  }
  // A member's sign-in never opens the setup site.
  if ((req as { account?: { role?: string } }).account?.role !== 'owner') {
    reply.code(403).send({ error: 'Only the owner can use setup.' });
    return false;
  }
  return true;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const error = new Error(result.error.issues[0]?.message || 'Invalid input.') as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return result.data;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>local-agent setup</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: "Segoe UI", sans-serif; background: #090a0c; color: #f4f0e6; }
    main { max-width: 40rem; margin: 0 auto; padding: 2rem 1.2rem 4rem; }
    h1 { font-weight: 560; letter-spacing: -0.03em; }
    p { color: #b7b1a6; line-height: 1.5; }
    label { display: block; margin: 0.8rem 0 0.3rem; color: #b7b1a6; }
    input, select, textarea { width: 100%; box-sizing: border-box; background: #111318; color: inherit; border: 1px solid rgba(243,236,223,.16); border-radius: 12px; padding: 0.7rem; }
    button { margin: 0.4rem 0.4rem 0.4rem 0; background: #e4b56a; color: #1a140c; border: 0; border-radius: 999px; padding: 0.7rem 1rem; font-weight: 650; }
    button.ghost { background: transparent; color: #f4f0e6; border: 1px solid rgba(243,236,223,.2); }
    .card { border: 1px solid rgba(243,236,223,.1); border-radius: 16px; padding: 1rem; margin: 1rem 0; }
    .warn { color: #f3d7a6; }
    .ok { color: #c8e6c4; }
    .steps { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 1rem 0; }
    .steps span { border: 1px solid rgba(243,236,223,.16); border-radius: 999px; padding: 0.2rem 0.6rem; color: #b7b1a6; }
    .steps span.on { color: #1a140c; background: #e4b56a; border-color: #e4b56a; }
  </style>
</head>
<body>
  <main>
    <h1>local-agent setup</h1>
    <p>This page is for the LAN. It does not answer on Tailscale or a public address. Keys stay on this machine, in the encrypted vault and local config. They are not shown to a model.</p>
    <div id="app">Loading…</div>
  </main>
  <script>
    const app = document.querySelector('#app');
    const steps = ['Account', 'Models', 'Cloud keys', 'Notifications', 'Backups', 'Defaults'];
    let step = 0;
    function field(label, name, type, value) {
      return '<label>' + label + '</label><input name="' + name + '" type="' + (type || 'text') + '" value="' + (value || '') + '" />';
    }
    function nav() {
      return '<div class="steps">' + steps.map((name, index) => '<span class="' + (index === step ? 'on' : '') + '">' + name + '</span>').join('') + '</div>';
    }
    async function api(path, opts) {
      const res = await fetch(path, { credentials: 'same-origin', headers: opts && opts.body ? { 'content-type': 'application/json' } : {}, ...opts });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }
    function show(html) { app.innerHTML = nav() + html; }
    async function boot() {
      try {
        const state = await api('/api/setup/state');
        if (state.needsOwner) return account();
        if (!state.authenticated) return login();
        return defaults(state);
      } catch (error) {
        app.textContent = error.message;
      }
    }
    function account() {
      step = 0;
      show('<form class="card" id="f"><h2>Owner account</h2><p>Paste the one-time token from the installer, then choose the password you will use afterwards.</p>'
        + field('Setup token', 'token', 'password') + field('Username', 'username') + field('Password', 'password', 'password')
        + '<button>Create owner</button></form>');
      document.querySelector('#f').onsubmit = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        try { await api('/api/setup/owner', { method: 'POST', body: JSON.stringify(data) }); step = 1; await models(); }
        catch (error) { event.target.insertAdjacentHTML('beforeend', '<p class="warn">' + error.message + '</p>'); }
      };
    }
    function login() {
      step = 0;
      show('<form class="card" id="f"><h2>Sign in</h2>' + field('Username', 'username') + field('Password', 'password', 'password') + '<button>Sign in</button></form>');
      document.querySelector('#f').onsubmit = async (event) => {
        event.preventDefault();
        try { await api('/api/setup/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await boot(); }
        catch (error) { event.target.insertAdjacentHTML('beforeend', '<p class="warn">' + error.message + '</p>'); }
      };
    }
    async function models() {
      step = 1;
      show('<div class="card"><h2>Local models</h2><p>Scan this machine for Ollama. Nothing is pulled until you use the main setup checklist.</p><button id="scan">Scan</button><pre id="out"></pre><button id="next" class="ghost">Cloud keys</button></div>');
      document.querySelector('#scan').onclick = async () => {
        const data = await api('/api/setup/detect', { method: 'POST', body: '{}' });
        document.querySelector('#out').textContent = data.ollama ? (data.ollama + '\\n' + (data.models.join('\\n') || '(no models yet)')) : 'No Ollama answered on this machine.';
      };
      document.querySelector('#next').onclick = () => keys();
    }
    function keys() {
      step = 2;
      show('<form class="card" id="f"><h2>Cloud keys</h2><p>Optional. Leave them blank to stay on local models. A test calls only that provider.</p>'
        + field('Gemini API key', 'GEMINI_API_KEY', 'password') + '<button type="button" data-kind="gemini">Test Gemini</button>'
        + field('OpenRouter API key', 'OPENROUTER_API_KEY', 'password') + '<button type="button" data-kind="openrouter">Test OpenRouter</button>'
        + '<p id="msg"></p><button class="ghost" type="button" id="next">Notifications</button></form>');
      document.querySelectorAll('[data-kind]').forEach((button) => button.onclick = () => testKey(button.dataset.kind));
      document.querySelector('#next').onclick = () => notes();
    }
    async function testKey(kind) {
      const input = document.querySelector('[name="' + (kind === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY') + '"]');
      const msg = document.querySelector('#msg');
      try {
        if (input.value) await api('/api/setup/secret', { method: 'POST', body: JSON.stringify({ key: input.name, value: input.value }) });
        const result = await api('/api/setup/test', { method: 'POST', body: JSON.stringify({ kind, value: input.value || undefined }) });
        msg.textContent = result.detail;
        msg.className = result.ok ? 'ok' : 'warn';
        input.value = '';
      } catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
    }
    function notes() {
      step = 3;
      show('<form class="card" id="f"><h2>Notifications</h2><p>Telegram is optional. The test sends one short message and does not store the chat on any other machine.</p>'
        + field('Bot token', 'TELEGRAM_BOT_TOKEN', 'password') + field('Chat id', 'TELEGRAM_CHAT_ID')
        + '<button type="button" id="test">Send test message</button><p id="msg"></p>'
        + field('IMAP host', 'imapHost', 'text', '') + field('IMAP port', 'imapPort', 'number', '993') + field('Mailbox', 'imapMailbox', 'text', 'INBOX')
        + field('IMAP user', 'IMAP_USER') + field('IMAP password', 'IMAP_PASSWORD', 'password')
        + '<button type="button" id="saveimap">Save IMAP</button><button class="ghost" type="button" id="next">Backups</button></form>');
      document.querySelector('#test').onclick = async () => {
        const token = document.querySelector('[name=TELEGRAM_BOT_TOKEN]').value;
        const chatId = document.querySelector('[name=TELEGRAM_CHAT_ID]').value;
        const msg = document.querySelector('#msg');
        try {
          if (token) await api('/api/setup/secret', { method: 'POST', body: JSON.stringify({ key: 'TELEGRAM_BOT_TOKEN', value: token }) });
          if (chatId) await api('/api/setup/secret', { method: 'POST', body: JSON.stringify({ key: 'TELEGRAM_CHAT_ID', value: chatId }) });
          const result = await api('/api/setup/test', { method: 'POST', body: JSON.stringify({ kind: 'telegram', value: token || undefined, chatId: chatId || undefined }) });
          msg.textContent = result.detail; msg.className = result.ok ? 'ok' : 'warn';
        } catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
      };
      document.querySelector('#saveimap').onclick = async () => {
        const msg = document.querySelector('#msg');
        try {
          const user = document.querySelector('[name=IMAP_USER]').value;
          const password = document.querySelector('[name=IMAP_PASSWORD]').value;
          if (user) await api('/api/setup/secret', { method: 'POST', body: JSON.stringify({ key: 'IMAP_USER', value: user }) });
          if (password) await api('/api/setup/secret', { method: 'POST', body: JSON.stringify({ key: 'IMAP_PASSWORD', value: password }) });
          await api('/api/setup/defaults', { method: 'PATCH', body: JSON.stringify({
            imapHost: document.querySelector('[name=imapHost]').value,
            imapPort: Number(document.querySelector('[name=imapPort]').value || 993),
            imapMailbox: document.querySelector('[name=imapMailbox]').value || 'INBOX',
          }) });
          msg.textContent = 'IMAP settings saved on this machine.'; msg.className = 'ok';
        } catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
      };
      document.querySelector('#next').onclick = () => backups();
    }
    function backups() {
      step = 4;
      show('<form class="card" id="f"><h2>Backups</h2><p>The target is stored here. This page does not upload anything.</p>'
        + '<label>Transport</label><select name="backupTransport"><option value="none">none</option><option value="rsync">rsync</option><option value="rclone">rclone</option><option value="s3">s3</option></select>'
        + field('Target', 'backupTarget') + field('Cron', 'backupCron', 'text', '0 3 * * *')
        + '<button>Save backups</button><p id="msg"></p><button class="ghost" type="button" id="next">Defaults</button></form>');
      document.querySelector('#f').onsubmit = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        const msg = document.querySelector('#msg');
        try { await api('/api/setup/defaults', { method: 'PATCH', body: JSON.stringify(data) }); msg.textContent = 'Saved.'; msg.className = 'ok'; }
        catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
      };
      document.querySelector('#next').onclick = () => boot();
    }
    function defaults(state) {
      step = 5;
      const s = state.settings || {};
      const options = (state.models || []).map((model) => '<option value="' + model.id + '"' + (model.id === s.goodModelId ? ' selected' : '') + '>' + model.name + '</option>').join('');
      const flags = (state.secrets || []).map((item) => item.key + ': ' + (item.set ? 'saved' : 'empty')).join(' · ');
      const warnings = (state.warnings || []).map((line) => '<p class="warn">' + line + '</p>').join('');
      show(warnings + '<form class="card" id="f"><h2>Defaults</h2><p>' + flags + '</p>'
        + '<label>Default model</label><select name="goodModelId"><option value="">Automatic</option>' + options + '</select>'
        + '<label>Gemini tier</label><select name="geminiTier"><option' + (s.geminiTier !== 'paid' ? ' selected' : '') + '>free</option><option' + (s.geminiTier === 'paid' ? ' selected' : '') + '>paid</option></select>'
        + field('Backup cron', 'backupCron', 'text', s.backupCron || '0 3 * * *')
        + '<label>Backup transport</label><select name="backupTransport"><option>none</option><option>rsync</option><option>rclone</option><option>s3</option></select>'
        + field('Backup target', 'backupTarget', 'text', s.backupTarget || '')
        + field('Daily token cap', 'dailyTokenLimit', 'number', s.dailyTokenLimit || '')
        + '<h3>Git</h3><p class="muted">Commits use this name and email. The SSH key is a path on the mini PC, not the key itself.</p>'
        + field('Git name', 'gitName', 'text', s.gitName || 'local-agent')
        + field('Git email', 'gitEmail', 'text', s.gitEmail || 'agent@local')
        + field('SSH key path', 'gitSshKey', 'text', s.gitSshKey || '')
        + '<h3>Auto</h3><p class="muted">Empty main uses Gemma 4 26B-A4B if it is installed, otherwise Qwen3.6 35B-A3B. Empty thinking uses main with reasoning on. Empty cloud uses Gemini when the free quota is open, and falls back to main.</p>'
        + field('Fast', 'autoFast', 'text', (s.autoModels && s.autoModels.fast) || 'qwen3:4b')
        + field('Main', 'autoMain', 'text', (s.autoModels && s.autoModels.main) || '')
        + field('Coder', 'autoCoder', 'text', (s.autoModels && s.autoModels.coder) || 'qwen3-coder:30b')
        + field('Thinking', 'autoThinking', 'text', (s.autoModels && s.autoModels.thinking) || '')
        + field('Smart / cloud', 'autoCloud', 'text', (s.autoModels && s.autoModels.cloud) || '')
        + field('Embed', 'autoEmbed', 'text', (s.autoModels && s.autoModels.embed) || 'nomic-embed-text')
        + '<button>Save defaults</button><p id="msg"></p></form>'
        + '<form class="card" id="people"><h2>People</h2><p class="muted">Add a second person. They get their own chats, personas, memory, files and theme, and never see yours. You keep setup, keys and models.</p><ul id="plist"></ul>'
        + field('Username', 'username') + field('Display name', 'displayName') + field('Password (8+ characters)', 'password', 'password')
        + '<label>Cloud models (Gemini)</label><select name="cloud"><option value="on">On, shared quota</option><option value="off">Off, local models only</option></select>'
        + '<button>Add person</button><p id="pmsg"></p></form>'
        + '<form class="card" id="pw"><h2>Owner password</h2>' + field('Current', 'current', 'password') + field('New', 'next', 'password') + '<button>Change password</button><p id="pwmsg"></p></form>'
        + '<p><button class="ghost" id="wiz" type="button">Run the wizard again</button></p>');
      const transport = document.querySelector('[name=backupTransport]');
      [...transport.options].forEach((option) => { if (option.value === (s.backupTransport || 'none')) option.selected = true; });
      document.querySelector('#f').onsubmit = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        if (!data.goodModelId) data.goodModelId = null;
        if (!data.dailyTokenLimit) data.dailyTokenLimit = null; else data.dailyTokenLimit = Number(data.dailyTokenLimit);
        const msg = document.querySelector('#msg');
        try { await api('/api/setup/defaults', { method: 'PATCH', body: JSON.stringify(data) }); msg.textContent = 'Saved on this machine.'; msg.className = 'ok'; }
        catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
      };
      document.querySelector('#pw').onsubmit = async (event) => {
        event.preventDefault();
        const msg = document.querySelector('#pwmsg');
        try { await api('/api/setup/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); msg.textContent = 'Password updated.'; msg.className = 'ok'; }
        catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
      };
      document.querySelector('#wiz').onclick = () => models();
      const listPeople = async () => {
        const data = await api('/api/setup/members').catch(() => ({ members: [] }));
        const list = document.querySelector('#plist');
        list.textContent = '';
        for (const person of data.members) {
          const item = document.createElement('li');
          item.textContent = person.displayName + ' (' + person.username + ')' + (person.disabled ? ' · disabled' : '') + (person.cloud ? '' : ' · local only');
          list.appendChild(item);
        }
      };
      void listPeople();
      document.querySelector('#people').onsubmit = async (event) => {
        event.preventDefault();
        const msg = document.querySelector('#pmsg');
        try { await api('/api/setup/members', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); msg.textContent = 'Added. They sign in with that username and password.'; msg.className = 'ok'; event.target.reset(); await listPeople(); }
        catch (error) { msg.textContent = error.message; msg.className = 'warn'; }
      };
    }
    boot();
  </script>
</body>
</html>`;
