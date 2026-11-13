import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProfile } from '@local-agent/shared';
import type { ModelRow, Store } from './db.js';
import { commandOnPath } from './docker.js';
import type { DockerCtl } from './docker.js';

export interface Probe {
  id: string;
  kind: string;
  ok: boolean;
  detail: string;
  url?: string;
}

export interface DiscoveryReport {
  probedAt: string;
  probes: Probe[];
  ollama: { url: string; models: { name: string; parameterSize?: string; size?: number; family?: string }[] } | null;
  resident: string[];
  gpu: { name: string; vramBytes?: number; gttBytes?: number; note: string } | null;
  docker: boolean;
  tailscale: string | null;
  cloudflared: boolean;
  memAvailableGiB: number;
  searxng: string | null;
}

const PORTS = [
  { id: 'ollama', url: 'http://127.0.0.1:11434', kind: 'ollama' },
  { id: 'ollama-host', url: 'http://host.docker.internal:11434', kind: 'ollama' },
  { id: 'llama', url: 'http://127.0.0.1:8080/v1', kind: 'openai' },
  { id: 'lmstudio', url: 'http://127.0.0.1:1234/v1', kind: 'openai' },
  { id: 'vllm', url: 'http://127.0.0.1:8000/v1', kind: 'openai' },
];

export async function scanMachine(fetchImpl: typeof fetch, docker: DockerCtl, store: Store): Promise<DiscoveryReport> {
  const probes: Probe[] = [];
  let ollama: DiscoveryReport['ollama'] = null;
  const resident: string[] = [];
  const host = process.env.OLLAMA_HOST;
  const targets = host ? [{ id: 'ollama-env', url: host.replace(/\/$/, ''), kind: 'ollama' }, ...PORTS] : PORTS;
  for (const target of targets) {
    try {
      if (target.kind === 'ollama') {
        const response = await fetchImpl(`${target.url}/api/tags`, { signal: AbortSignal.timeout(700) });
        if (!response.ok) throw new Error(String(response.status));
        const json = await response.json() as { models?: { name: string; size?: number; details?: { parameter_size?: string; family?: string } }[] };
        const models = parseOllamaTags(json).map((model) => ({ ...model, family: (json.models ?? []).find((item) => item.name === model.name)?.details?.family }));
        probes.push({ id: target.id, kind: 'ollama', ok: true, detail: `${models.length} model${models.length === 1 ? '' : 's'} at ${target.url}`, url: target.url });
        if (!ollama) ollama = { url: target.url, models };
        try {
          const ps = await fetchImpl(`${target.url}/api/ps`, { signal: AbortSignal.timeout(700) });
          if (ps.ok) {
            const body = await ps.json() as { models?: { name?: string }[] };
            for (const model of body.models ?? []) if (model.name) resident.push(model.name);
          }
        } catch { /* ps is optional */ }
      } else {
        const response = await fetchImpl(`${target.url}/models`, { signal: AbortSignal.timeout(700) });
        if (!response.ok) throw new Error(String(response.status));
        const json = await response.json() as { data?: { id?: string }[] };
        const count = json.data?.length ?? 0;
        probes.push({ id: target.id, kind: 'openai', ok: true, detail: `${count} model${count === 1 ? '' : 's'} at ${target.url}`, url: target.url });
        rememberOpenAI(store, target.id, target.url, json);
      }
    } catch {
      probes.push({ id: target.id, kind: target.kind, ok: false, detail: `No answer from ${target.url}`, url: target.url });
    }
  }
  if (ollama) rememberOllama(store, ollama);
  const gpu = readGpu();
  const dockerOk = docker.available();
  probes.push({ id: 'docker', kind: 'docker', ok: dockerOk, detail: dockerOk ? 'Docker socket is present.' : 'Docker socket was not found.' });
  const tailscale = await tailscaleIp();
  const cloudflared = await commandOnPath('cloudflared');
  const searxng = await findSearxng(fetchImpl, process.env.SEARXNG_URL);
  return {
    probedAt: new Date().toISOString(), probes, ollama, resident, gpu, docker: dockerOk, tailscale, cloudflared,
    memAvailableGiB: readMem(), searxng,
  };
}

export function parseOllamaTags(json: { models?: { name: string; size?: number; details?: { parameter_size?: string; family?: string } }[] }) {
  return (json.models ?? []).map((model) => ({ name: model.name, parameterSize: model.details?.parameter_size, size: model.size, family: model.details?.family }));
}

export function parseOpenAIModels(json: { data?: { id?: string }[] }) {
  return (json.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id));
}

function rememberOllama(store: Store, ollama: NonNullable<DiscoveryReport['ollama']>) {
  const provider = store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: `${ollama.url}/v1`, enabled: true });
  for (const model of ollama.models) {
    const profile = resolveProfile(model.name, { parameterSize: model.parameterSize, family: model.family });
    store.upsertModel({
      id: `ollama_${model.name.replace(/[^a-z0-9]+/gi, '_')}`, providerId: provider.id, name: model.name, apiName: model.name,
      profileId: profile.id, tokenizer: profile.tokenizer, contextWindow: profile.contextWindow, practicalBudget: profile.practicalBudget,
      strategy: profile.strategy, sizeClass: profile.sizeClass, local: true, modalities: profile.modalities, strengths: profile.strengths,
      typicalQ4GiB: profile.typicalQ4GiB ?? (model.size ? model.size / 1024 ** 3 : null), priceIn: 0, priceOut: 0, notes: profile.notes,
      parameterSize: model.parameterSize ?? null, family: model.family ?? profile.family, source: 'discovered', embedding: false, freeTier: null, enabled: true,
    });
  }
}

function rememberOpenAI(store: Store, id: string, base: string, json: { data?: { id?: string }[] }) {
  const provider = store.upsertProvider({ id: `prov_${id}`, kind: 'openai_compat', name: id, baseUrl: base, enabled: true });
  for (const name of parseOpenAIModels(json)) {
    const profile = resolveProfile(name);
    store.upsertModel({
      id: `${id}_${name.replace(/[^a-z0-9]+/gi, '_')}`, providerId: provider.id, name, apiName: name, profileId: profile.id,
      tokenizer: profile.tokenizer, contextWindow: profile.contextWindow, practicalBudget: profile.practicalBudget, strategy: profile.strategy,
      sizeClass: profile.sizeClass, local: true, modalities: profile.modalities, strengths: profile.strengths, typicalQ4GiB: profile.typicalQ4GiB ?? null,
      priceIn: 0, priceOut: 0, notes: profile.notes, parameterSize: null, family: profile.family, source: 'discovered', embedding: false, freeTier: null, enabled: true,
    });
  }
}

export function readGpu() {
  const cards = fs.existsSync('/sys/class/drm') ? fs.readdirSync('/sys/class/drm').filter((name) => /^card\d+$/.test(name)) : [];
  for (const card of cards) {
    const base = `/sys/class/drm/${card}/device`;
    const vram = readNum(path.join(base, 'mem_info_vram_total'));
    const gtt = readNum(path.join(base, 'mem_info_gtt_total'));
    if (vram || gtt) {
      return { name: `DRM ${card}`, vramBytes: vram || undefined, gttBytes: gtt || undefined, note: 'AMD/Intel sysfs memory. GTT is the iGPU share of system RAM.' };
    }
  }
  if (fs.existsSync('/dev/dri')) return { name: 'DRM render node', note: '/dev/dri is present. Vendor counters were not readable (common inside a container without the device mounted).' };
  return null;
}

export function readMem() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/MemAvailable:\s+(\d+)/);
    if (match) return Number(match[1]) / 1024 / 1024;
  } catch { /* ignore */ }
  return os.totalmem() / 1024 ** 3;
}

function readNum(file: string) {
  try { return Number(fs.readFileSync(file, 'utf8').trim()); } catch { return 0; }
}

async function tailscaleIp() {
  if (!(await commandOnPath('tailscale'))) return null;
  return new Promise<string | null>((resolve) => {
    const child = spawn('tailscale', ['ip', '-4']);
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] || null : null));
    child.on('error', () => resolve(null));
  });
}

async function findSearxng(fetchImpl: typeof fetch, configured?: string) {
  const urls = [configured, 'http://127.0.0.1:8088', 'http://host.docker.internal:8088'].filter((url): url is string => Boolean(url));
  for (const url of urls) {
    try {
      const response = await fetchImpl(`${url.replace(/\/$/, '')}/search?q=ping&format=json`, { signal: AbortSignal.timeout(700) });
      if (response.ok) return url.replace(/\/$/, '');
    } catch { /* next */ }
  }
  return null;
}

export function checklist(report: DiscoveryReport | null, store: Store) {
  const agents = store.listAgents().length;
  const settings = store.getSettings();
  const items = [
    { id: 'owner', title: 'Owner account', ok: Boolean(store.getOwner()), detail: store.getOwner() ? `Signed in as ${store.getOwner()!.username}.` : 'Create the owner before anything else.', optional: false },
    { id: 'ollama', title: 'Local model server', ok: Boolean(report?.ollama) || report?.probes.some((probe) => probe.kind === 'openai' && probe.ok) === true, detail: report?.ollama ? report.ollama.url : 'No Ollama or OpenAI-compatible server answered.', optional: false },
    { id: 'model', title: 'A real model', ok: store.listModels().some((model) => model.source === 'discovered'), detail: 'Discovery writes models it can call. Rehearsal remains available either way.', optional: false },
    { id: 'docker', title: 'Docker', ok: Boolean(report?.docker), detail: report?.docker ? 'Socket is mounted. Sandboxes and MCP servers can run in containers.' : 'Without Docker, shell falls back to a workspace jail and MCP stays disabled.', optional: false },
    { id: 'personas', title: 'Two personas', ok: agents >= 2, detail: agents >= 2 ? `${agents} personas.` : 'Create a house operator and a researcher.', optional: false },
    { id: 'gpu', title: 'GPU / GTT', ok: Boolean(report?.gpu), detail: report?.gpu?.note ?? 'No render node was visible.', optional: true },
    { id: 'searxng', title: 'SearXNG', ok: Boolean(report?.searxng || settings.searxngUrl), detail: report?.searxng || settings.searxngUrl || 'Optional. One click starts a container on port 8088.', optional: true },
    { id: 'tailscale', title: 'Tailscale', ok: Boolean(report?.tailscale), detail: report?.tailscale ? `Reach the UI at http://${report.tailscale}:${process.env.LA_PORT || 8787}` : 'Preferred remote path. Install Tailscale on the box and on your phone.', optional: true },
    { id: 'quota', title: 'Gemini free tier', ok: true, detail: 'Flash Lite is the roomy default (500 requests/day). Hydrogen is the free reasoning model. Argon and Carbon are closed on this key.', optional: true },
    { id: 'embed', title: 'Local embeddings', ok: Boolean(report?.ollama?.models.some((model) => model.name.split(':')[0] === 'nomic-embed-text')), detail: report?.ollama?.models.some((model) => model.name.split(':')[0] === 'nomic-embed-text') ? 'nomic-embed-text is available for the knowledge base.' : 'Optional. Pull nomic-embed-text so collections use Ollama embeddings. Until then, search still runs on a local hash.', optional: true },
  ];
  return items;
}

export function setupPreview(action: string, model?: string) {
  if (action === 'pull-embed') {
    return { command: 'ollama pull nomic-embed-text', detail: 'Local embedding model for the knowledge base. Nothing runs until you confirm.' };
  }
  if (action === 'pull-model') {
    const name = model || 'gemma4:e4b';
    if (!/^[a-zA-Z0-9_.:/-]+$/.test(name)) throw new Error('Model name looks wrong.');
    return { command: `ollama pull ${name}`, detail: `POST /api/pull {"name":"${name}"} on the detected Ollama. Same result as the CLI command.` };
  }
  if (action === 'start-searxng') {
    return { command: 'docker run -d --name local-agent-searxng --restart unless-stopped -p 8088:8080 docker.io/searxng/searxng:latest', detail: 'Starts SearXNG bound to port 8088. Nothing runs until you confirm.' };
  }
  if (action === 'pull-sandbox') {
    return { command: 'docker pull alpine:3.20', detail: 'Image used for shell sandboxes and per-agent containers.' };
  }
  if (action === 'pull-mcp-runtime') {
    return { command: 'docker pull node:22-alpine', detail: 'Runtime image for npm MCP servers. They do not install on the host.' };
  }
  if (action === 'start-whisper') {
    return { command: 'docker run -d --name local-agent-whisper --restart unless-stopped -p 8091:8000 fedirz/faster-whisper-server:latest-cpu', detail: 'Optional faster-whisper container for push-to-talk. Nothing runs until you confirm.' };
  }
  if (action === 'start-kokoro') {
    return { command: 'docker run -d --name local-agent-kokoro --restart unless-stopped -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest', detail: 'Optional Kokoro TTS container. Nothing runs until you confirm.' };
  }
  throw new Error('Unknown setup action.');
}

export type ModelSource = ModelRow;
