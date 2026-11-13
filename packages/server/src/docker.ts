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

export class DockerCtl {
  private client: Docker | null = null;

  constructor(private readonly socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock') {}

  available() {
    return fs.existsSync(this.socketPath);
  }

  private api() {
    if (!this.available()) throw new Error('Docker socket is not available.');
    if (!this.client) this.client = new Docker({ socketPath: this.socketPath });
    return this.client;
  }

  async list(): Promise<ContainerSummary[]> {
    const rows = await this.api().listContainers({ all: true });
    return rows.map((row) => ({
      id: row.Id,
      name: (row.Names?.[0] || '').replace(/^\//, ''),
      image: row.Image,
      state: row.State,
      status: row.Status,
      labels: row.Labels ?? {},
    }));
  }

  async inspect(id: string) {
    return this.api().getContainer(id).inspect();
  }

  async logs(id: string) {
    const buffer = await this.api().getContainer(id).logs({ stdout: true, stderr: true, tail: 200 });
    return demux(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  }

  async start(id: string) {
    await this.api().getContainer(id).start();
  }

  async remove(id: string) {
    await this.api().getContainer(id).remove({ force: true });
  }

  async removeImage(id: string) {
    await this.api().getImage(id).remove();
  }

  async startDetached(spec: RunSpec & { ExposedPorts?: Record<string, object> }) {
    const container = await this.api().createContainer({
      Image: spec.Image,
      Cmd: spec.Cmd,
      name: spec.name,
      Labels: spec.Labels,
      Env: spec.Env,
      ExposedPorts: spec.ExposedPorts,
      HostConfig: spec.HostConfig,
    });
    await container.start();
    return container.id;
  }

  async pull(image: string) {
    const stream = await this.api().pull(image);
    await new Promise<void>((resolve, reject) => {
      this.api().modem.followProgress(stream, (error: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  async runCollect(spec: RunSpec, timeoutMs = 30_000): Promise<{ output: string; code: number }> {
    const container = await this.api().createContainer({
      Image: spec.Image,
      Cmd: spec.Cmd,
      Env: spec.Env,
      WorkingDir: spec.WorkingDir,
      Labels: spec.Labels,
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
      Labels: { 'local-agent.role': 'sandbox', 'local-agent.agent': agentId },
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
      Labels: spec.Labels,
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
    Labels: { 'local-agent.role': 'mcp', 'local-agent.mcp': input.id },
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
