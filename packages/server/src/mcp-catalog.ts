/**
 * Where MCP servers come from: the official MCP registry and Docker's MCP catalog (pinned image digests),
 * each entry labelled with a trust level. Installing still goes through a vetting report and an approval.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scoreRisk, type Finding } from '@local-agent/shared';
import type { DockerCtl } from './docker.js';
import { npmCacheDir, trustOf, type ImportedMcp, type Trust, type VettingReport } from './mcp.js';
import { nid, now } from './util.js';

export interface CatalogEntry {
  source: 'docker' | 'official';
  id: string;
  title: string;
  description: string;
  trust: Trust;
  image?: string;
  packageName?: string;
  version?: string;
  repo?: string;
  secrets: { env: string; description?: string }[];
  env: { name: string; value: string }[];
  installable: boolean;
  note?: string;
}

const DOCKER_CATALOG_URL = 'https://desktop.docker.com/mcp/catalog/v2/catalog.json';
const DAY = 24 * 3600_000;

type DockerRaw = { title?: string; description?: string; image?: string; type?: string; upstream?: string; source?: string; secrets?: { name?: string; env?: string; description?: string }[]; env?: { name: string; value: string }[]; remote?: { url?: string } };

/** Docker's catalog, cached for a day so browsing works offline after the first look. */
export async function dockerCatalog(fetchImpl: typeof fetch, dataDir: string): Promise<CatalogEntry[]> {
  const file = path.join(dataDir, 'cache', 'docker-mcp-catalog.json');
  let raw: { registry?: Record<string, DockerRaw> } | null = null;
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < DAY) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* not cached yet */ }
  if (!raw) {
    try {
      const response = await fetchImpl(DOCKER_CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const text = await response.text();
        raw = JSON.parse(text);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
    } catch { /* offline */ }
    if (!raw) { try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = { registry: {} }; } }
  }
  return Object.entries(raw?.registry ?? {}).map(([id, entry]) => ({
    source: 'docker' as const, id, title: entry.title || id, description: (entry.description || '').slice(0, 400),
    trust: trustOf({ image: entry.image, name: id }), image: entry.image, repo: entry.upstream || entry.source,
    secrets: (entry.secrets ?? []).filter((row) => row.env).map((row) => ({ env: String(row.env), description: row.description })),
    env: (entry.env ?? []).filter((row) => row?.name),
    installable: Boolean(entry.image) && (entry.type ?? 'server') === 'server',
    note: entry.image ? undefined : 'Remote-only server; not supported here yet.',
  }));
}

/** The official MCP registry (registry.modelcontextprotocol.io): npm and OCI packages are installable. */
export async function officialCatalog(query: string, fetchImpl: typeof fetch): Promise<CatalogEntry[]> {
  try {
    const response = await fetchImpl(`https://registry.modelcontextprotocol.io/v0.1/servers?${query ? `search=${encodeURIComponent(query)}&` : ''}version=latest&limit=60`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [];
    const json = await response.json() as { servers?: { server?: { name?: string; title?: string; description?: string; version?: string; repository?: { url?: string }; packages?: { registryType?: string; identifier?: string; version?: string; environmentVariables?: { name?: string; description?: string; isSecret?: boolean }[] }[] } }[] };
    const entries = (json.servers ?? []).map((row) => {
      const server = row.server ?? {};
      const pkg = server.packages?.find((item) => item.registryType === 'npm' || item.registryType === 'oci');
      const image = pkg?.registryType === 'oci' ? `${pkg.identifier}${pkg.version && !String(pkg.identifier).includes(':') ? `:${pkg.version}` : ''}` : undefined;
      return {
        source: 'official' as const, id: String(server.name), title: server.title || String(server.name).split('/').pop() || 'server', description: (server.description || '').slice(0, 400),
        trust: trustOf({ name: server.name, image, packageName: pkg?.registryType === 'npm' ? pkg.identifier : undefined }),
        image, packageName: pkg?.registryType === 'npm' ? pkg.identifier : undefined, version: pkg?.version || server.version, repo: server.repository?.url,
        secrets: (pkg?.environmentVariables ?? []).filter((item) => item.isSecret && item.name).map((item) => ({ env: String(item.name), description: item.description })),
        env: [], installable: Boolean(pkg), note: pkg ? undefined : 'Remote-only server; not supported here yet.',
      };
    });
    // Installable (npm or OCI) first; remote-only ones stay listed but greyed out.
    return [...entries.filter((row) => row.installable), ...entries.filter((row) => !row.installable)];
  } catch { return []; }
}

export function specFor(entry: CatalogEntry): ImportedMcp {
  const env: Record<string, string> = {};
  for (const secret of entry.secrets) env[secret.env] = `{{secret:${secret.env}}}`;
  for (const row of entry.env) env[row.name] = /\{\{[a-z0-9_.-]+\}\}/i.test(row.value) ? '' : row.value;
  if (entry.image) return { name: entry.title, transport: 'stdio', args: [], env, source: `${entry.source}:${entry.id}`, image: entry.image };
  return { name: entry.title, transport: 'stdio', command: 'npx', args: ['-y', `${entry.packageName}${entry.version ? `@${entry.version}` : ''}`], env, source: `${entry.source}:${entry.id}` };
}

/** A vetting report for a catalog image: trust, secrets, network and pinning, scored like package reports. */
export function vetCatalogImage(entry: CatalogEntry): VettingReport {
  const findings: Finding[] = [];
  if (entry.trust === 'community') findings.push({ severity: 'medium', code: 'community', detail: 'Published by someone other than the MCP project, the vendor or Docker. Read its source before trusting it with tokens.' });
  if (entry.image && !entry.image.includes('@sha256:')) findings.push({ severity: 'low', code: 'unpinned', detail: 'The image is not pinned to a digest; updates can change what runs.' });
  if (entry.secrets.length) findings.push({ severity: 'low', code: 'secrets', detail: `Needs ${entry.secrets.map((row) => row.env).join(', ')} (typed into a form, kept in the vault, given only to this container).` });
  const risk = scoreRisk(findings);
  return {
    id: nid('vet'), name: entry.title, ecosystem: 'docker', packageName: entry.image, publisher: entry.trust === 'docker' ? 'Docker (mcp/ namespace)' : entry.trust === 'official' ? 'Official' : undefined,
    repoUrl: entry.repo, permissions: ['network', ...(entry.secrets.length ? ['secrets'] : [])], findings, score: risk.score, level: risk.level, createdAt: now(), spec: specFor(entry),
  };
}

// ── Pre-download: pinned images and npm packages, so connectors start offline and never change under you ──

export interface CacheItem { id: string; kind: 'image' | 'npm'; ref: string; status: 'missing' | 'downloading' | 'ready' | 'failed'; detail?: string }

export async function cacheStatus(items: { id: string; image?: string; npm?: string }[], docker: DockerCtl, cacheDir: string): Promise<CacheItem[]> {
  return Promise.all(items.map(async (item) => {
    if (item.image) {
      const ready = docker.available() && docker.hasImage ? await docker.hasImage(item.image).catch(() => false) : false;
      return { id: item.id, kind: 'image' as const, ref: item.image, status: ready ? 'ready' as const : 'missing' as const };
    }
    const dir = npmCacheDir(cacheDir, item.npm!);
    return { id: item.id, kind: 'npm' as const, ref: item.npm!, status: fs.existsSync(path.join(dir, 'node_modules')) ? 'ready' as const : 'missing' as const };
  }));
}

/** `npm install --ignore-scripts` of one pinned package into its own cache folder (mounted read-only into the container). */
export function cacheNpm(spec: string, cacheDir: string, run = runNpm): Promise<void> {
  const dir = npmCacheDir(cacheDir, spec);
  fs.mkdirSync(dir, { recursive: true });
  return run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--prefix', dir, spec]);
}

function runNpm(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err = (err + String(chunk)).slice(-800); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').at(-1) || `npm exited ${code}`))));
  });
}
