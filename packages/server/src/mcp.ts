import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreRisk, type Finding } from '@local-agent/shared';
import type { McpServer, Store } from './db.js';
import { mcpContainerSpec, type DockerCtl } from './docker.js';
import { reputationSubject, runReputation, type ReputationCheck } from './reputation.js';
import { nid, now } from './util.js';

export interface ImportedMcp {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  source: string;
}

export interface VettingReport {
  id: string;
  name: string;
  ecosystem: 'npm' | 'pypi' | 'docker' | 'binary' | 'remote' | 'unknown';
  packageName?: string;
  version?: string;
  publisher?: string;
  license?: string;
  repoUrl?: string;
  stars?: number | null;
  downloads?: number | null;
  permissions: string[];
  findings: Finding[];
  score: number;
  level: string;
  llmReview?: string;
  reputation?: ReputationCheck;
  createdAt: string;
  spec: ImportedMcp;
}

const SUSPICIOUS = [/curl[^\n]*\|\s*sh/i, /wget[^\n]*\|\s*sh/i, /base64\s+-d/i, /child_process/, /eval\(/, /\/etc\/passwd/, /nc\s+-e/];

export function mcpConfigFiles(home = os.homedir(), dataDir = '') {
  return [
    { source: 'project', file: path.join(process.cwd(), 'mcp.json') },
    { source: 'local-agent', file: path.join(dataDir, 'mcp.json') },
    { source: 'xdg', file: path.join(home, '.config', 'local-agent', 'mcp.json') },
    { source: 'cursor', file: path.join(home, '.cursor', 'mcp.json') },
    { source: 'vscode', file: path.join(home, '.vscode', 'mcp.json') },
    { source: 'vscode-user', file: path.join(home, '.config', 'Code', 'User', 'mcp.json') },
    { source: 'claude', file: path.join(home, '.config', 'Claude', 'claude_desktop_config.json') },
    { source: 'claude-macos', file: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') },
    { source: 'windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
}

export function parseMcpConfig(text: string, source: string): ImportedMcp[] {
  const json = JSON.parse(text) as { mcpServers?: Record<string, McpEntry>; servers?: Record<string, McpEntry> };
  const table = json.mcpServers || json.servers || {};
  return Object.entries(table).map(([name, entry]) => ({
    name,
    transport: entry.url ? 'http' as const : 'stdio' as const,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    env: entry.env,
    source,
  }));
}

interface McpEntry { command?: string; args?: string[]; url?: string; env?: Record<string, string> }

export function importConfigs(dataDir: string): ImportedMcp[] {
  const found: ImportedMcp[] = [];
  for (const candidate of mcpConfigFiles(os.homedir(), dataDir)) {
    if (!fs.existsSync(candidate.file)) continue;
    try { found.push(...parseMcpConfig(fs.readFileSync(candidate.file, 'utf8'), candidate.source)); } catch { /* skip broken files */ }
  }
  return found;
}

export function guessPackage(spec: ImportedMcp): { ecosystem: VettingReport['ecosystem']; name?: string } {
  const args = spec.args ?? [];
  const command = spec.command ?? '';
  if (spec.url) return { ecosystem: 'remote' };
  const npx = [...(command === 'npx' ? args : []), ...(command.includes('npx') ? args : [])];
  const pkg = npx.find((arg) => !arg.startsWith('-') && arg !== 'npx');
  if (command === 'npx' || command.endsWith('/npx')) return { ecosystem: 'npm', name: pkg };
  if (command === 'uvx' || command === 'pipx') return { ecosystem: 'pypi', name: args.find((arg) => !arg.startsWith('-')) };
  if (command === 'docker') return { ecosystem: 'docker', name: args.at(-1) };
  if (spec.url) return { ecosystem: 'remote' };
  return { ecosystem: command ? 'binary' : 'unknown', name: command || undefined };
}

export interface VetOptions {
  llm?: (prompt: string) => Promise<string>;
  /** Local SearXNG reputation search. On unless set false. */
  reputation?: boolean;
  searxngUrl?: string;
  summarize?: (prompt: string) => Promise<string>;
}

export async function vetSpec(spec: ImportedMcp, fetchImpl: typeof fetch, options?: VetOptions | ((prompt: string) => Promise<string>)): Promise<VettingReport> {
  const opts: VetOptions = typeof options === 'function' ? { llm: options } : options ?? {};
  const llm = opts.llm;
  const guessed = guessPackage(spec);
  const findings: Finding[] = [];
  const permissions = new Set<string>();
  let publisher: string | undefined;
  let license: string | undefined;
  let repoUrl: string | undefined;
  let version: string | undefined;
  let stars: number | null = null;
  let downloads: number | null = null;
  if (guessed.ecosystem === 'npm' && guessed.name) {
    permissions.add('network');
    permissions.add('package-install');
    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(guessed.name)}`, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const doc = await response.json() as { license?: string; description?: string; repository?: { url?: string }; 'dist-tags'?: { latest?: string }; versions?: Record<string, { scripts?: Record<string, string>; _npmUser?: { name?: string }; license?: string }> };
        version = doc['dist-tags']?.latest;
        license = doc.license || (version ? doc.versions?.[version]?.license : undefined);
        publisher = version ? doc.versions?.[version]?._npmUser?.name : undefined;
        repoUrl = doc.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
        const scripts = version ? doc.versions?.[version]?.scripts ?? {} : {};
        for (const [hook, body] of Object.entries(scripts)) {
          if (/preinstall|install|postinstall/.test(hook)) {
            findings.push({ severity: hook === 'postinstall' ? 'high' : 'medium', code: 'install-script', detail: `${hook}: ${body.slice(0, 240)}` });
            if (SUSPICIOUS.some((pattern) => pattern.test(body))) findings.push({ severity: 'critical', code: 'suspicious-script', detail: `${hook} matches a suspicious pattern.` });
          }
        }
        if (!license) findings.push({ severity: 'medium', code: 'license', detail: 'npm record has no license.' });
      } else findings.push({ severity: 'high', code: 'registry', detail: `npm returned ${response.status} for ${guessed.name}.` });
    } catch (error) {
      findings.push({ severity: 'medium', code: 'registry', detail: `npm lookup failed: ${error instanceof Error ? error.message : 'error'}` });
    }
    try {
      const downloadsResponse = await fetchImpl(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(guessed.name)}`, { signal: AbortSignal.timeout(8000) });
      if (downloadsResponse.ok) {
        const body = await downloadsResponse.json() as { downloads?: number };
        downloads = body.downloads ?? null;
        if ((downloads ?? 0) < 1000) findings.push({ severity: 'low', code: 'downloads', detail: 'Fewer than 1,000 downloads in the last month.' });
      }
    } catch { /* optional */ }
    await addOsv(findings, 'npm', guessed.name, version, fetchImpl);
  } else if (guessed.ecosystem === 'pypi' && guessed.name) {
    permissions.add('network');
    permissions.add('package-install');
    try {
      const response = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(guessed.name)}/json`, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const doc = await response.json() as { info?: { version?: string; license?: string; author?: string; project_urls?: Record<string, string> } };
        version = doc.info?.version;
        license = doc.info?.license;
        publisher = doc.info?.author;
        repoUrl = doc.info?.project_urls?.Homepage || doc.info?.project_urls?.Source;
      }
    } catch (error) {
      findings.push({ severity: 'medium', code: 'registry', detail: `PyPI lookup failed: ${error instanceof Error ? error.message : 'error'}` });
    }
    await addOsv(findings, 'PyPI', guessed.name, version, fetchImpl);
  } else if (guessed.ecosystem === 'remote') {
    permissions.add('network');
    findings.push({ severity: 'medium', code: 'remote', detail: 'This server runs off-box. A container does not isolate code we never execute. Tools can still send your data to that URL.' });
  } else if (guessed.ecosystem === 'binary') {
    permissions.add('process');
    findings.push({ severity: 'high', code: 'host-binary', detail: 'A local binary is not a pinned package. It will only run inside a container if you provide an image.' });
  } else {
    findings.push({ severity: 'medium', code: 'unknown', detail: 'Could not tell which package this server installs.' });
  }
  if ((spec.env && Object.keys(spec.env).length) || (spec.args ?? []).some((arg) => arg.startsWith('/') || arg.includes('..'))) {
    permissions.add('filesystem');
    findings.push({ severity: 'medium', code: 'paths', detail: 'Arguments or env look like they expect host paths. No host path is mounted unless you grant it.' });
  }
  if (!publisher && guessed.ecosystem !== 'remote') findings.push({ severity: 'low', code: 'publisher', detail: 'Publisher was not identified.' });
  if (repoUrl && repoUrl.includes('github.com')) {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#]+)/);
    if (match) {
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${match[1]}/${match[2]}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'local-agent' }, signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const repo = await response.json() as { stargazers_count?: number };
          stars = repo.stargazers_count ?? null;
        }
      } catch { stars = null; }
    }
  }
  let llmReview: string | undefined;
  if (llm) {
    try {
      llmReview = await llm(`Review this MCP server for a single-user home box. Two short sentences on risk. Do not invent CVEs.\n${JSON.stringify({ spec, findings, publisher, license })}`);
    } catch {
      findings.push({ severity: 'info', code: 'llm-review', detail: 'Optional model review was skipped.' });
    }
  } else {
    findings.push({ severity: 'info', code: 'llm-review', detail: 'Optional model review was not run.' });
  }
  let reputation: ReputationCheck | undefined;
  if (opts.reputation !== false) {
    const subject = reputationSubject(spec.name, guessed.name, repoUrl);
    const ran = await runReputation({
      subject: subject.subject,
      repo: subject.repo,
      fetchImpl,
      searxngUrl: opts.searxngUrl,
      summarize: opts.summarize,
    });
    reputation = ran.check;
    findings.push(...ran.findings);
  } else {
    reputation = { enabled: false, skipped: true, queries: [], links: [] };
  }
  const risk = scoreRisk(findings);
  return {
    id: nid('vet'), name: spec.name, ecosystem: guessed.ecosystem, packageName: guessed.name, version, publisher, license, repoUrl, stars, downloads,
    permissions: [...permissions], findings, score: risk.score, level: risk.level, llmReview, reputation, createdAt: now(), spec,
  };
}

async function addOsv(findings: Finding[], ecosystem: string, name: string, version: string | undefined, fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl('https://api.osv.dev/v1/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ package: { ecosystem, name }, version }),
    });
    if (!response.ok) return;
    const body = await response.json() as { vulns?: { id: string; summary?: string; database_specific?: { severity?: string } }[] };
    for (const vuln of (body.vulns ?? []).slice(0, 8)) {
      const severity = /CRITICAL/i.test(vuln.database_specific?.severity || '') ? 'critical' : /HIGH/i.test(vuln.database_specific?.severity || '') ? 'high' : 'medium';
      findings.push({ severity, code: 'osv', detail: `${vuln.id}: ${vuln.summary || 'vulnerability'}` });
    }
  } catch { /* OSV is best effort */ }
}

export function curatedRegistry() {
  return [
    { name: 'io.modelcontextprotocol/filesystem', description: 'Official filesystem server. Still vetted, still containerized, and it gets no host mount until you grant a path.', package: '@modelcontextprotocol/server-filesystem', ecosystem: 'npm' },
    { name: 'io.modelcontextprotocol/fetch', description: 'Official fetch server.', package: '@modelcontextprotocol/server-fetch', ecosystem: 'npm' },
    { name: 'io.modelcontextprotocol/memory', description: 'Official memory server.', package: '@modelcontextprotocol/server-memory', ecosystem: 'npm' },
  ];
}

export async function searchRegistry(query: string, fetchImpl: typeof fetch) {
  const curated = curatedRegistry().filter((item) => item.name.includes(query) || item.description.toLowerCase().includes(query.toLowerCase()));
  try {
    const response = await fetchImpl(`https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query)}&version=latest&limit=20`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { source: 'curated-fallback', servers: curated };
    const json = await response.json() as { servers?: { server?: { name?: string; description?: string; repository?: { url?: string }; packages?: { registryType?: string; identifier?: string }[] } }[] };
    const servers = (json.servers ?? []).map((entry) => ({
      name: entry.server?.name,
      description: entry.server?.description,
      repo: entry.server?.repository?.url,
      package: entry.server?.packages?.[0]?.identifier,
      ecosystem: entry.server?.packages?.[0]?.registryType,
    }));
    return { source: 'official', servers: servers.length ? servers : curated };
  } catch {
    return { source: 'curated-fallback', servers: curated };
  }
}

export class McpRuntime {
  private readonly stops = new Map<string, () => Promise<void>>();

  constructor(private readonly store: Store, private readonly docker: DockerCtl) {}

  list() {
    return this.store.listMcp();
  }

  importFound(dataDir: string) {
    const imported = importConfigs(dataDir);
    for (const spec of imported) {
      const id = `mcp_${spec.source}_${spec.name}`.replace(/[^a-z0-9_]+/gi, '_').slice(0, 48);
      if (this.store.getMcp(id)) continue;
      this.store.upsertMcp(serverFrom(id, spec, false));
    }
    return this.store.listMcp();
  }

  install(report: VettingReport, approve: { acknowledgeRisk: boolean; acknowledgeCritical?: boolean; grants?: string[] }) {
    if (!approve.acknowledgeRisk) throw new Error('Installation needs an explicit approval.');
    if (report.level === 'critical' && !approve.acknowledgeCritical) throw new Error('Critical risk needs a second acknowledgement.');
    const grants = approve.grants ?? [];
    if (grants.length && report.level !== 'low') {
      /* grants are stored and shown; they do not skip the risk acknowledgement above */
    }
    const id = nid('mcp');
    const server = serverFrom(id, report.spec, true);
    server.grants = grants;
    server.riskScore = report.score;
    server.riskLevel = report.level;
    server.reportId = report.id;
    server.network = report.permissions.includes('network') || report.ecosystem === 'npm' || report.ecosystem === 'pypi' ? 'bridge' : 'none';
    server.image = report.ecosystem === 'npm' ? 'node:22-alpine' : report.ecosystem === 'pypi' ? 'python:3.12-alpine' : 'alpine:3.20';
    this.store.saveVetting(report.id, report);
    return this.store.upsertMcp(server);
  }

  async connect(id: string) {
    const server = this.store.getMcp(id);
    if (!server) throw new Error('MCP server not found.');
    if (!server.enabled) throw new Error('Enable the server after vetting.');
    if (server.execution !== 'container') throw new Error('Host execution is off. MCP servers run in their own container.');
    if (!this.docker.available()) {
      this.store.upsertMcp({ ...server, lastError: 'Docker is required to start this MCP server.' });
      throw new Error('Docker is required to start this MCP server.');
    }
    const cmd = containerCommand(server);
    const spec = mcpContainerSpec({ id: server.id, image: server.image || 'node:22-alpine', cmd, env: server.env, network: server.network, mounts: server.grants });
    const attached = await this.docker.attach(spec);
    this.stops.set(id, attached.stop);
    try {
      const tools = await listTools(attached.stdin, attached.stdout);
      this.store.upsertMcp({ ...server, tools, lastError: null });
      return this.store.getMcp(id);
    } catch (error) {
      await attached.stop();
      const message = error instanceof Error ? error.message : 'MCP handshake failed.';
      this.store.upsertMcp({ ...server, lastError: message });
      throw new Error(message);
    }
  }

  async stop(id: string) {
    const stop = this.stops.get(id);
    if (stop) await stop();
    this.stops.delete(id);
  }
}

function serverFrom(id: string, spec: ImportedMcp, enabled: boolean): McpServer {
  return {
    id, name: spec.name, transport: spec.transport, command: spec.command ?? null, args: spec.args ?? [], url: spec.url ?? null,
    env: spec.env ?? {}, enabled, source: spec.source, execution: spec.transport === 'http' ? 'remote' : 'container', network: 'none',
    grants: [], image: null, riskScore: null, riskLevel: null, reportId: null, lastError: null, tools: [], createdAt: now(),
  };
}

function containerCommand(server: McpServer): string[] {
  if (server.command === 'npx') return ['npx', '-y', ...(server.args.length ? server.args : [])];
  if (server.command === 'uvx') return ['uvx', ...server.args];
  if (server.command) return [server.command, ...server.args];
  return ['sleep', 'infinity'];
}

export function encodeFrame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

export class FrameParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) break;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

async function listTools(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream) {
  const parser = new FrameParser();
  const pending = new Map<number, (value: unknown) => void>();
  stdout.on('data', (chunk: Buffer) => {
    for (const message of parser.push(chunk)) {
      const rpc = message as { id?: number; result?: unknown };
      if (rpc.id && pending.has(rpc.id)) pending.get(rpc.id)!(rpc.result);
    }
  });
  const call = (id: number, method: string, params: unknown) => new Promise((resolve, reject) => {
    pending.set(id, resolve);
    stdin.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
  });
  await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'local-agent', version: '0.1.0' } });
  stdin.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const listed = await call(2, 'tools/list', {}) as { tools?: unknown[] };
  return listed.tools ?? [];
}

export function spawnChecked(command: string, args: string[]) {
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
