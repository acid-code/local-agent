import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  /** What local-agent uses it for. Only managed containers are ever listed. */
  role: ManagedRole;
}

/** Every container local-agent starts carries these, so the app only ever shows or touches its own. */
export const MANAGED_LABEL = 'com.local-agent.managed';
export const ROLE_LABEL = 'com.local-agent.role';
export type ManagedRole = 'search' | 'mcp' | 'tool' | 'sandbox' | 'image' | 'app';
const ROLES = new Set<ManagedRole>(['search', 'mcp', 'tool', 'sandbox', 'image', 'app']);
/** Labels older versions used (local-agent.role=...). */
const LEGACY_ROLE: Record<string, ManagedRole> = { searxng: 'search', mcp: 'mcp', sandbox: 'sandbox', shell: 'tool', 'agent-run': 'tool', whisper: 'tool', kokoro: 'tool', 'image-build': 'image' };
/** docker compose project names of this app (the repo folder name by default). */
const COMPOSE_PROJECTS = () => new Set(['local-agent', ...(process.env.LA_COMPOSE_PROJECT ? [process.env.LA_COMPOSE_PROJECT] : [])]);

export function withManagedLabels(labels: Record<string, string> = {}): Record<string, string> {
  const legacy = labels['local-agent.role'] ?? labels['local-agent'];
  const given = labels[ROLE_LABEL] as ManagedRole | undefined;
  const role = given && ROLES.has(given) ? given : (legacy && LEGACY_ROLE[legacy]) || 'tool';
  return { ...labels, [MANAGED_LABEL]: 'true', [ROLE_LABEL]: role };
}

/** The role of a container local-agent owns, or null for anything else on the machine. */
export function managedRole(container: { name: string; labels: Record<string, string> }): ManagedRole | null {
  const labels = container.labels ?? {};
  if (labels[MANAGED_LABEL] === 'true') {
    const role = labels[ROLE_LABEL] as ManagedRole;
    return ROLES.has(role) ? role : 'tool';
  }
  const legacy = labels['local-agent.role'] ?? labels['local-agent'];
  if (legacy) return LEGACY_ROLE[legacy] ?? 'tool';
  const project = labels['com.docker.compose.project'];
  if (project && COMPOSE_PROJECTS().has(project)) {
    const service = labels['com.docker.compose.service'] || '';
    return /searx/.test(service) ? 'search' : /whisper|kokoro|voice/.test(service) ? 'tool' : 'app';
  }
  const name = (container.name || '').replace(/^\//, '');
  if (name === 'local-agent-searxng') return 'search';
  if (name === 'local-agent-whisper' || name === 'local-agent-kokoro') return 'tool';
  if (name.startsWith('la-mcp-')) return 'mcp';
  if (name.startsWith('la-sbx-')) return 'sandbox';
  return null;
}

export interface RunSpec {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  WorkingDir?: string;
  Labels?: Record<string, string>;
  HostConfig?: Docker.HostConfig;
  name?: string;
  OpenStdin?: boolean;
  StdinOnce?: boolean;
}

/** Where the Docker API lives: DOCKER_HOST (tcp:// or unix://) wins over the default socket. */
export function dockerTarget(env: NodeJS.ProcessEnv = process.env, socketPath?: string): { socketPath: string } | { host: string; port: number; protocol: 'http' | 'https' } {
  const raw = (env.DOCKER_HOST || '').trim();
  if (raw.startsWith('unix://')) return { socketPath: raw.slice('unix://'.length) };
  const tcp = raw.match(/^(?:tcp|http|https):\/\/\[?([^\]/:]+)\]?(?::(\d+))?/i);
  if (tcp) {
    const tls = /^https:/i.test(raw) || Boolean(env.DOCKER_TLS_VERIFY && env.DOCKER_TLS_VERIFY !== '0');
    return { host: tcp[1]!, port: Number(tcp[2] || (tls ? 2376 : 2375)), protocol: tls ? 'https' : 'http' };
  }
  return { socketPath: socketPath || env.DOCKER_SOCKET || '/var/run/docker.sock' };
}

export class DockerCtl {
  private client: Docker | null = null;
  private readonly target: ReturnType<typeof dockerTarget>;

  constructor(socketPath?: string, env: NodeJS.ProcessEnv = process.env) {
    this.target = socketPath ? { socketPath } : dockerTarget(env);
  }

  /** Where this talks to Docker, for messages. */
  describe() {
    return 'socketPath' in this.target ? this.target.socketPath : `${this.target.protocol}://${this.target.host}:${this.target.port}`;
  }

  available() {
    if ('host' in this.target) return true;
    return fs.existsSync(this.target.socketPath);
  }

  /** True when the Docker API answers. */
  async ping(): Promise<boolean> {
    if (!this.available()) return false;
    try {
      await Promise.race([this.api().ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      return true;
    } catch {
      return false;
    }
  }

  private api() {
    if (!this.available()) throw new Error(`Docker is not available at ${this.describe()}.`);
    if (!this.client) this.client = new Docker(this.target);
    return this.client;
  }

  /** Containers local-agent owns. Other containers on the machine are never listed. */
  async list(): Promise<ContainerSummary[]> {
    const rows = await this.api().listContainers({ all: true });
    const out: ContainerSummary[] = [];
    for (const row of rows) {
      const name = (row.Names?.[0] || '').replace(/^\//, '');
      const labels = row.Labels ?? {};
      const role = managedRole({ name, labels });
      if (role) out.push({ id: row.Id, name, image: row.Image, state: row.State, status: row.Status, labels, role });
    }
    return out;
  }

  /** Refuse to act on a container local-agent does not own. Accepts an id, id prefix, or name. */
  async assertManaged(id: string): Promise<ContainerSummary> {
    const key = String(id || '').replace(/^\//, '');
    const match = key ? (await this.list()).find((row) => row.id === key || (key.length >= 6 && row.id.startsWith(key)) || row.name === key) : undefined;
    if (!match) throw Object.assign(new Error('That container is not managed by local-agent, so it cannot be changed here.'), { statusCode: 403 });
    return match;
  }

  async inspect(id: string) {
    const row = await this.assertManaged(id);
    return this.api().getContainer(row.id).inspect();
  }

  async logs(id: string) {
    await this.assertManaged(id);
    const buffer = await this.api().getContainer(id).logs({ stdout: true, stderr: true, tail: 200 });
    return demux(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  }

  async start(id: string) {
    const row = await this.assertManaged(id);
    await this.api().getContainer(row.id).start();
  }

  async remove(id: string) {
    const row = await this.assertManaged(id);
    if (row.role === 'app') throw Object.assign(new Error('That is local-agent itself. Stop it with docker compose instead.'), { statusCode: 403 });
    await this.api().getContainer(row.id).remove({ force: true });
  }

  async removeImage(id: string) {
    await this.api().getImage(id).remove();
  }

  async startDetached(spec: RunSpec & { ExposedPorts?: Record<string, object>; files?: { dir: string; name: string; content: string | Buffer; mode?: number }[]; replace?: boolean }) {
    if (spec.replace && spec.name) {
      try {
        await this.api().getContainer(spec.name).remove({ force: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
    const container = await this.api().createContainer({
      Image: spec.Image,
      Cmd: spec.Cmd,
      name: spec.name,
      Labels: withManagedLabels(spec.Labels),
      Env: spec.Env,
      ExposedPorts: spec.ExposedPorts,
      HostConfig: spec.HostConfig,
    });
    for (const file of spec.files ?? []) {
      await container.putArchive(tarFile(file.name, Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content), file.mode), { path: file.dir });
    }
    await container.start();
    return container.id;
  }

  async pull(image: string) {
    const stream = await this.api().pull(image);
    await new Promise<void>((resolve, reject) => {
      this.api().modem.followProgress(stream, (error: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  /** Run a container to completion and copy one file out of it (used to build a native binary without a local compiler). */
  async runAndCopyOut(spec: RunSpec, filePath: string, timeoutMs = 30 * 60_000): Promise<{ code: number; output: string; file: Buffer | null }> {
    await this.pull(spec.Image).catch(() => undefined);
    const container = await this.api().createContainer({ Image: spec.Image, Cmd: spec.Cmd, Env: spec.Env, Labels: withManagedLabels(spec.Labels), name: spec.name });
    try {
      await container.start();
      const result = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Container timed out.')), timeoutMs)),
      ]);
      const raw = await container.logs({ stdout: true, stderr: true, tail: 40 });
      const output = demux(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).slice(-4000);
      if ((result.StatusCode ?? 1) !== 0) return { code: result.StatusCode ?? 1, output, file: null };
      const stream = await container.getArchive({ path: filePath });
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      return { code: 0, output, file: untarFirst(Buffer.concat(chunks)) };
    } finally {
      try { await container.remove({ force: true }); } catch { /* already removed */ }
    }
  }

  async runCollect(spec: RunSpec, timeoutMs = 30_000): Promise<{ output: string; code: number }> {
    const container = await this.api().createContainer({
      Image: spec.Image,
      Cmd: spec.Cmd,
      Env: spec.Env,
      WorkingDir: spec.WorkingDir,
      Labels: withManagedLabels(spec.Labels),
      HostConfig: spec.HostConfig,
      name: spec.name,
      AttachStdout: true,
      AttachStderr: true,
    });
    try {
      await container.start();
      const result = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Container timed out.')), timeoutMs)),
      ]);
      const raw = await container.logs({ stdout: true, stderr: true });
      return { output: demux(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).slice(0, 64_000), code: result.StatusCode ?? 1 };
    } finally {
      try { await container.remove({ force: true }); } catch { /* already removed */ }
    }
  }

  async createSandbox(name: string, workspace: string, agentId: string) {
    const container = await this.api().createContainer({
      Image: 'alpine:3.20',
      Cmd: ['sleep', 'infinity'],
      name,
      WorkingDir: '/work',
      Labels: withManagedLabels({ 'local-agent.role': 'sandbox', 'local-agent.agent': agentId }),
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        NetworkMode: 'none',
        Binds: [`${workspace}:/work`],
        PidsLimit: 64,
      },
    });
    await container.start();
    return container.id;
  }

  async attach(spec: RunSpec): Promise<{ stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; stop: () => Promise<void> }> {
    const container = await this.api().createContainer({
      Image: spec.Image,
      Cmd: spec.Cmd,
      Env: spec.Env,
      WorkingDir: spec.WorkingDir,
      Labels: withManagedLabels(spec.Labels),
      HostConfig: spec.HostConfig,
      name: spec.name,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
    await container.start();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.api().modem.demuxStream(stream, stdout, stderr);
    return {
      stdin: stream,
      stdout,
      stderr,
      stop: async () => {
        try { await container.kill(); } catch { /* exited */ }
        try { await container.remove({ force: true }); } catch { /* gone */ }
      },
    };
  }

  async images() {
    const rows = await this.api().listImages();
    return rows.map((row) => ({ id: row.Id, tags: row.RepoTags ?? [], size: row.Size }));
  }

  cliAvailable() {
    return commandExists('docker');
  }
}

export function commandExists(command: string) {
  return spawn('sh', ['-lc', `command -v ${command}`]).exitCode != null
    ? false
    : true;
}

export function commandOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export function demux(buffer: Buffer): string {
  if (buffer.length < 8) return buffer.toString('utf8');
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    if (stream !== 1 && stream !== 2) return buffer.toString('utf8');
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    parts.push(buffer.subarray(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return parts.join('');
}

export function mcpContainerSpec(input: {
  id: string;
  image: string;
  cmd: string[];
  env: Record<string, string>;
  network: string;
  mounts: string[];
  memoryMb?: number;
}): RunSpec {
  return {
    Image: input.image,
    Cmd: input.cmd,
    Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    name: `la-mcp-${input.id.slice(0, 18)}`,
    Labels: withManagedLabels({ 'local-agent.role': 'mcp', 'local-agent.mcp': input.id }),
    OpenStdin: true,
    HostConfig: {
      Memory: (input.memoryMb ?? 512) * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: false,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      NetworkMode: input.network || 'none',
      Binds: input.mounts,
    },
  };
}

/** A one-file ustar archive, enough for Docker putArchive. */
export function tarFile(name: string, content: Buffer, mode = 0o644): Buffer {
  const header = Buffer.alloc(512, 0);
  const put = (value: string, offset: number, length: number) => header.write(value.slice(0, length), offset, length, 'utf8');
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(content.length, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  header.fill(' ', 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024, 0)]);
}

/** The first regular file in a tar archive. */
export function untarFirst(tar: Buffer): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === '0' || type === '\0') return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}
