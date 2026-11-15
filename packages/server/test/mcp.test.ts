import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { McpClient, mcpToolName } from '../src/mcp-client.js';
import { trustOf, type VettingReport } from '../src/mcp.js';
import { cacheNpm, cacheStatus, dockerCatalog, specFor, vetCatalogImage } from '../src/mcp-catalog.js';
import { RECOMMENDED_CONNECTORS, recommendedSpec } from '../src/connectors.js';
import { ScriptedProvider, type ModelProvider } from '../src/providers.js';
import type { DockerCtl } from '../src/docker.js';
import type { Agent } from '@local-agent/shared';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'echo-mcp.mjs');
const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn().catch(() => undefined); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-mcp-')); dirs.push(dir); return dir; }
const pw = (tag: string) => ['fixture', 'only', tag].join('-');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await wait(25); }
}

/** A Docker stand-in that really runs the stdio server as a child process, with the container's env. */
function processDocker() {
  const state = { attaches: 0, lastEnv: {} as Record<string, string> };
  const docker = {
    available: () => true, ping: async () => true, hasImage: async () => true, pull: async () => undefined,
    attach: async (spec: { Env?: string[] }) => {
      state.attaches += 1;
      const env = Object.fromEntries((spec.Env ?? []).map((row) => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
      state.lastEnv = env;
      const child = spawn(process.execPath, [FIXTURE], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, stop: async () => { child.kill(); } };
    },
  } as unknown as DockerCtl;
  return { docker, state };
}

function echoReport(trustName = 'echo', source = 'docker:echo', image = 'mcp/echo@sha256:abc'): VettingReport {
  return {
    id: `vet_${Math.random().toString(36).slice(2)}`, name: trustName, ecosystem: 'docker', packageName: image, permissions: ['network'], findings: [], score: 0, level: 'low', createdAt: new Date().toISOString(),
    spec: { name: trustName, transport: 'stdio', args: [], env: { ECHO_TOKEN: '{{secret:ECHO_TOKEN}}' }, source, image },
  } as VettingReport;
}

async function setup() {
  const dir = tmp();
  const provider: { current: ModelProvider } = { current: new ScriptedProvider([]) };
  const { docker, state } = processDocker();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, docker, providerOverride: () => provider.current });
  cleanups.push(() => built.app.close());
  return { ...built, dir, provider, state };
}

describe('MCP client (real stdio process)', () => {
  it('initializes, pages through tools, skips log lines, and maps tool errors', async () => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanups.push(async () => child.kill());
    const client = new McpClient(child.stdin, child.stdout, child.stderr);
    await client.initialize();
    expect(client.serverInfo.name).toBe('echo');
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'write_note', 'env', 'crash']);
    expect(await client.callTool('echo', { text: 'hi' })).toEqual({ text: 'echo: hi', isError: false });
    expect((await client.callTool('nope', {})).isError).toBe(true);
    client.close('done');
  });

  it('names agent tools safely and within 64 characters', () => {
    expect(mcpToolName('GitHub (official)', 'create_pull_request')).toMatch(/^mcp_[a-z0-9_]+$/i);
    expect(mcpToolName('x'.repeat(80), 'y'.repeat(80)).length).toBeLessThanOrEqual(64);
  });
});

describe('agents call installed MCP tools', () => {
  it('a persona allowed "mcp:<server>" calls the tool in a real turn; others cannot', async () => {
    const { store, engine, provider, dir, mcp } = await setup();
    const server = mcp.install(echoReport('Echo'), { acknowledgeRisk: true });
    await mcp.connect(server.id);
    expect(mcp.health(server.id).status).toBe('connected');
    const name = mcpToolName('Echo', 'echo');
    const allowed = store.createAgent({ name: 'Uses echo', systemPrompt: 'x', toolAllowlist: ['mcp:Echo'], workspacePath: dir });
    const blocked = store.createAgent({ name: 'No echo', systemPrompt: 'x', toolAllowlist: [], workspacePath: dir });
    const yes = store.createSession({ agentId: allowed.id, title: 'yes' });
    const no = store.createSession({ agentId: blocked.id, title: 'no' });
    provider.current = new ScriptedProvider([{ toolCalls: [{ id: 'c1', name, arguments: '{"text":"from agent"}' }] }, { text: 'Done.' }]);
    await engine.startTurn({ sessionId: yes.id, agentId: allowed.id, content: 'echo', wait: true });
    expect(store.listMessages(yes.id).some((m) => m.content.includes('echo: from agent'))).toBe(true);
    provider.current = new ScriptedProvider([{ toolCalls: [{ id: 'c2', name, arguments: '{"text":"x"}' }] }, { text: 'Done.' }]);
    await engine.startTurn({ sessionId: no.id, agentId: blocked.id, content: 'echo', wait: true });
    expect(store.listMessages(no.id).some((m) => m.content.includes('echo: x'))).toBe(false);
  });

  it('read-only tools run directly; others need approval', async () => {
    const { mcp } = await setup();
    const server = mcp.install(echoReport('Echo'), { acknowledgeRisk: true });
    await mcp.connect(server.id);
    const tools = Object.fromEntries(mcp.agentTools().map((row) => [row.tool.name, row.tool]));
    expect(tools[mcpToolName('Echo', 'echo')]!.approval({})).toBeNull();
    expect(tools[mcpToolName('Echo', 'write_note')]!.approval({ text: 'a' })).toMatch(/Echo → write_note/);
  });

  it('member personas never get MCP tools, even with mcp:*', async () => {
    const { store, engine, mcp, dir } = await setup();
    const server = mcp.install(echoReport('Echo'), { acknowledgeRisk: true });
    await mcp.connect(server.id);
    const owner = store.createAgent({ name: 'Owner star', systemPrompt: 'x', toolAllowlist: ['mcp:*'], workspacePath: dir });
    const member = store.createAgent({ name: 'Member star', systemPrompt: 'x', toolAllowlist: ['mcp:*'], workspacePath: dir, ownerId: 'acct_member_x' });
    const names = (agent: Agent) => (engine as unknown as { tools: (a: Agent) => { name: string }[] }).tools(agent).map((tool) => tool.name);
    expect(names(owner)).toContain(mcpToolName('Echo', 'echo'));
    expect(names(member).some((name) => name.startsWith('mcp_'))).toBe(false);
  });

  it('a gallery persona gets a recommended connector\'s tools by template', async () => {
    const { store, engine, mcp, dir } = await setup();
    const server = mcp.install(echoReport('GitHub', 'recommended:github', 'ghcr.io/github/github-mcp-server@sha256:1'), { acknowledgeRisk: true });
    await mcp.connect(server.id);
    const coder = store.createAgent({ name: 'Coder t', systemPrompt: 'x', toolAllowlist: [], workspacePath: dir });
    const templated = { ...coder, templateId: 'coder' } as Agent;
    const plain = (engine as unknown as { tools: (a: Agent) => { name: string }[] }).tools(coder).map((tool) => tool.name);
    const viaTemplate = (engine as unknown as { tools: (a: Agent) => { name: string }[] }).tools(templated).map((tool) => tool.name);
    expect(plain.some((name) => name.startsWith('mcp_github_'))).toBe(false);
    // The Coder template lists the GitHub connector.
    expect(viaTemplate.some((name) => name.startsWith('mcp_github_'))).toBe(true);
  });
});

describe('health and auto-reconnect', () => {
  it('reconnects after the server dies, and a tool call starts a stopped server', async () => {
    const { mcp, state } = await setup();
    mcp.reconnectDelays = [50, 50];
    const server = mcp.install(echoReport('Echo'), { acknowledgeRisk: true });
    expect(mcp.health(server.id).status).toBe('idle');
    await mcp.connect(server.id);
    await mcp.call(server.id, 'crash', {}).catch(() => undefined);
    await until(() => mcp.health(server.id).status === 'down' || mcp.health(server.id).status === 'starting' || state.attaches >= 2);
    await until(() => mcp.health(server.id).status === 'connected' && state.attaches >= 2);
    expect((await mcp.call(server.id, 'echo', { text: 'back' })).text).toBe('echo: back');
    await mcp.stop(server.id);
    expect(mcp.health(server.id).status).not.toBe('connected');
    expect((await mcp.call(server.id, 'echo', { text: 'lazy' })).text).toBe('echo: lazy');
    expect(state.attaches).toBe(3);
  });

  it('dedupes concurrent connects', async () => {
    const { mcp, state } = await setup();
    const server = mcp.install(echoReport('Echo'), { acknowledgeRisk: true });
    await Promise.all([mcp.connect(server.id), mcp.connect(server.id), mcp.connect(server.id)]);
    expect(state.attaches).toBe(1);
  });
});

describe('secrets go through a form only', () => {
  it('stores per-server secrets, injects them only into that container, never returns them, and redacts tool output', async () => {
    const { app, mcp, engine, vault, state, store, dir, provider } = await setup();
    const owner = { la_session: (await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } })).cookies.find((c) => c.name === 'la_session')!.value };
    const server = mcp.install(echoReport('Echo'), { acknowledgeRisk: true });
    const token = 'tok-' + 'f'.repeat(24);
    expect((await app.inject({ method: 'PUT', url: `/api/mcp/${server.id}/secrets`, cookies: owner, payload: { values: { NOT_USED: 'x' } } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: `/api/mcp/${server.id}/secrets`, cookies: owner, payload: { values: { ECHO_TOKEN: token } } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(token);
    expect(put.json().secrets).toEqual([{ name: 'ECHO_TOKEN', set: true }]);
    const list = await app.inject({ method: 'GET', url: '/api/mcp', cookies: owner });
    expect(list.body).not.toContain(token);
    expect(list.json().servers[0].env.ECHO_TOKEN).toBe('(from the vault)');
    await mcp.connect(server.id);
    expect(state.lastEnv.ECHO_TOKEN).toBe(token);
    // Not in any agent's shell env.
    const agent = store.createAgent({ name: 'Envy', systemPrompt: 'x', toolAllowlist: ['mcp:Echo'], workspacePath: dir });
    expect(Object.values(vault.envFor(agent.id, 'test'))).not.toContain(token);
    // A tool that prints it is redacted before the model sees it.
    const session = store.createSession({ agentId: agent.id, title: 's' });
    const tool = mcpToolName('Echo', 'env');
    provider.current = new ScriptedProvider([{ toolCalls: [{ id: 'e1', name: tool, arguments: '{}' }] }, { text: 'ok' }]);
    await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'env', wait: true });
    const all = store.listMessages(session.id).map((m) => m.content).join('\n');
    expect(all).toContain('token set ([redacted])');
    expect(all).not.toContain(token);
  });
});

describe('trust and approval for community servers', () => {
  it('labels publishers', () => {
    expect(trustOf({ image: 'ghcr.io/github/github-mcp-server@sha256:1' })).toBe('official');
    expect(trustOf({ name: 'io.modelcontextprotocol/filesystem' })).toBe('official');
    expect(trustOf({ packageName: '@modelcontextprotocol/server-memory' })).toBe('official');
    expect(trustOf({ image: 'mcp/notion@sha256:1' })).toBe('docker');
    expect(trustOf({ image: 'yashtekwani/gmail-mcp@sha256:1' })).toBe('community');
    expect(trustOf({ packageName: 'linear-mcp-server' })).toBe('community');
  });

  it('a community server needs an explicit acknowledgement (API returns 400 without it)', async () => {
    const { app, store } = await setup();
    const owner = { la_session: (await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } })).cookies.find((c) => c.name === 'la_session')!.value };
    const report = echoReport('stranger', 'docker:stranger', 'someone/stranger-mcp@sha256:1');
    store.saveVetting(report.id, report);
    const no = await app.inject({ method: 'POST', url: '/api/mcp/install', cookies: owner, payload: { reportId: report.id, acknowledgeRisk: true } });
    expect(no.statusCode).toBe(400);
    expect(no.json().error).toMatch(/community/);
    const yes = await app.inject({ method: 'POST', url: '/api/mcp/install', cookies: owner, payload: { reportId: report.id, acknowledgeRisk: true, acknowledgeCommunity: true } });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().server.trust).toBe('community');
  });

  it('members get 403 on every MCP admin route', async () => {
    const { app } = await setup();
    const owner = { la_session: (await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } })).cookies.find((c) => c.name === 'la_session')!.value };
    await app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
    const member = { la_session: (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } })).cookies.find((c) => c.name === 'la_session')!.value };
    for (const [method, url] of [['GET', '/api/mcp'], ['GET', '/api/mcp/catalog?source=docker'], ['POST', '/api/mcp/catalog/vet'], ['PUT', '/api/mcp/x/secrets'], ['GET', '/api/mcp/x/secrets'], ['PATCH', '/api/mcp/x'], ['POST', '/api/connectors/cache'], ['GET', '/api/connectors/cache'], ['POST', '/api/connectors/github/connect']] as const) {
      expect((await app.inject({ method, url, cookies: member, payload: method === 'GET' ? undefined : {} })).statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('catalogs, pinning and the download cache', () => {
  const catalog = { registry: {
    time: { title: 'Time', description: 'Time zones', image: 'mcp/time@sha256:9c46', type: 'server' },
    gmailx: { title: 'Gmail X', description: 'Mail', image: 'someone/gmail@sha256:1', type: 'server', secrets: [{ name: 'gmail.password', env: 'EMAIL_PASSWORD' }], env: [{ name: 'IMAP_HOST', value: 'imap.gmail.com' }] },
    remote: { title: 'Remote', description: 'Remote only', type: 'remote', remote: { url: 'https://x' } },
  } };

  it('reads the Docker catalog once, caches it, and works offline from the cache', async () => {
    const dir = tmp();
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify(catalog)); }) as typeof fetch;
    const first = await dockerCatalog(fetchImpl, dir);
    expect(first.map((row) => [row.id, row.trust, row.installable])).toEqual([['time', 'docker', true], ['gmailx', 'community', true], ['remote', 'community', false]]);
    const offline = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect((await dockerCatalog(offline, dir)).length).toBe(3);
    expect(calls).toBe(1);
  });

  it('turns an entry into a vetted, secret-free install spec', async () => {
    const dir = tmp();
    const [, gmail] = await dockerCatalog((async () => new Response(JSON.stringify(catalog))) as typeof fetch, dir);
    const report = vetCatalogImage(gmail!);
    expect(report.findings.map((row) => row.code)).toEqual(expect.arrayContaining(['community', 'secrets']));
    expect(report.spec.env).toEqual({ EMAIL_PASSWORD: '{{secret:EMAIL_PASSWORD}}', IMAP_HOST: 'imap.gmail.com' });
    expect(specFor(gmail!).image).toBe('someone/gmail@sha256:1');
  });

  it('every recommended connector is pinned and asks for secrets by placeholder only', () => {
    for (const item of RECOMMENDED_CONNECTORS) {
      expect(Boolean(item.image?.includes('@sha256:')) || /@\d+\.\d+\.\d+$/.test(item.npm ?? ''), item.id).toBe(true);
      const spec = recommendedSpec(item);
      for (const name of item.secrets) expect(spec.env[name]).toBe(`{{secret:${name}}}`);
    }
  });

  it('reports cache status and installs a pinned npm package with scripts off', async () => {
    const dir = tmp();
    const docker = { available: () => true, hasImage: async (image: string) => image.startsWith('mcp/') } as unknown as DockerCtl;
    const status = await cacheStatus([{ id: 'a', image: 'mcp/a@sha256:1' }, { id: 'b', image: 'x/b@sha256:2' }, { id: 'c', npm: 'pkg@1.0.0' }], docker, dir);
    expect(status.map((row) => row.status)).toEqual(['ready', 'missing', 'missing']);
    const seen: string[][] = [];
    await cacheNpm('pkg@1.0.0', dir, async (args) => { seen.push(args); fs.mkdirSync(path.join(args[args.indexOf('--prefix') + 1]!, 'node_modules'), { recursive: true }); });
    expect(seen[0]).toEqual(expect.arrayContaining(['install', '--ignore-scripts', 'pkg@1.0.0']));
    expect((await cacheStatus([{ id: 'c', npm: 'pkg@1.0.0' }], docker, dir))[0]!.status).toBe('ready');
  });

  it('the connect button vets the pinned spec', async () => {
    const { app } = await setup();
    const owner = { la_session: (await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } })).cookies.find((c) => c.name === 'la_session')!.value };
    const res = await app.inject({ method: 'POST', url: '/api/connectors/notion/connect', cookies: owner });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.spec.image).toMatch(/^mcp\/notion@sha256:/);
    expect(res.json().trust).toBe('docker');
    expect(res.json().secrets).toEqual(['INTERNAL_INTEGRATION_TOKEN']);
    const cache = await app.inject({ method: 'GET', url: '/api/connectors/cache', cookies: owner });
    expect(cache.json().items.length).toBe(RECOMMENDED_CONNECTORS.length);
  });
});
