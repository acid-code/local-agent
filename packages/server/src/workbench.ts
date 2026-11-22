import fs from 'node:fs';
import path from 'node:path';
import type { DockerCtl } from './docker.js';
import { GiB, type Lease, type MemoryBudget } from './memory.js';

/**
 * One long-lived shared shell computer, `la-workbench`: installs and caches persist, network is on, and every persona's
 * shell runs in it with docker exec instead of a throwaway container per command. Workspaces mount at /workspaces.
 * It holds a 6 GB reservation in the shared RAM/GTT budget while it runs, and stops after it sits idle.
 * LA_SHELL=ephemeral keeps the old per-command containers.
 */
export const WORKBENCH_NAME = 'la-workbench';
export const WORKBENCH_MEMORY_BYTES = 6 * GiB;
const IMAGE = () => process.env.LA_WORKBENCH_IMAGE || 'node:22-bookworm';
const IDLE_MS = () => Number(process.env.LA_WORKBENCH_IDLE_MS || 30 * 60_000);

export function workbenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LA_SHELL || 'workbench').toLowerCase() !== 'ephemeral';
}

/** Python projects get their own .venv (created once, activated every command); Node uses the project's node_modules. */
export function wrapCommand(command: string): string {
  const venv = 'if [ -f pyproject.toml ] || [ -f requirements.txt ]; then [ -d .venv ] || python3 -m venv .venv >/dev/null 2>&1; [ -f .venv/bin/activate ] && . .venv/bin/activate; fi';
  return `${venv}; export PATH="$PWD/node_modules/.bin:$PATH"; ${command}`;
}

export interface WorkbenchStatus {
  enabled: boolean;
  state: 'running' | 'stopped' | 'missing' | 'unavailable';
  image: string;
  memoryBytes: number | null;
  memoryLimitBytes: number;
  cpuPercent: number | null;
  lastUsedAt: string | null;
}

export class Workbench {
  private lease: Lease | null = null;
  private starting: Promise<void> | null = null;
  private lastUsed = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly docker: DockerCtl, private readonly workspacesDir: string, private readonly memory: () => MemoryBudget | null, private readonly hostPath: (p: string) => string = (p) => p) {}

  /** Container path for a host cwd, or null when the folder is outside data/workspaces (then the old path runs it). */
  containerPath(cwd: string): string | null {
    const root = path.resolve(this.workspacesDir);
    const full = path.resolve(cwd);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
    return path.posix.join('/workspaces', path.relative(root, full).split(path.sep).join('/'));
  }

  async run(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<{ output: string; code: number } | null> {
    const inside = this.containerPath(cwd);
    if (!inside) return null;
    await this.ensure();
    this.lastUsed = Date.now();
    try {
      return await this.docker.exec(WORKBENCH_NAME, ['bash', '-lc', wrapCommand(command)], inside, timeoutMs);
    } finally {
      this.lastUsed = Date.now();
    }
  }

  /** Start the container if needed, after the memory budget admits its 6 GB (it queues behind model loads like any job). */
  async ensure(): Promise<void> {
    if (this.starting) return this.starting;
    const state = await this.docker.containerState(WORKBENCH_NAME).catch(() => null);
    if (state?.state === 'running' && this.lease) return;
    this.starting = (async () => {
      const memory = this.memory();
      if (!this.lease && memory) this.lease = await memory.admit({ kind: 'background', label: 'workbench', bytes: WORKBENCH_MEMORY_BYTES, maxWaitMs: 2 * 60_000 });
      if (state?.state === 'running') return;
      if (state) { await this.docker.start(state.id); return; }
      if (!(await this.docker.hasImage(IMAGE()))) await this.docker.pull(IMAGE());
      fs.mkdirSync(this.workspacesDir, { recursive: true });
      await this.docker.startDetached({
        name: WORKBENCH_NAME,
        Image: IMAGE(),
        Cmd: ['sleep', 'infinity'],
        Labels: { 'com.local-agent.role': 'sandbox', 'local-agent.role': 'workbench' },
        Env: ['PIP_CACHE_DIR=/cache/pip', 'npm_config_cache=/cache/npm', 'UV_CACHE_DIR=/cache/uv', 'PYTHONDONTWRITEBYTECODE=1'],
        network: null,
        HostConfig: {
          Memory: WORKBENCH_MEMORY_BYTES,
          NanoCpus: 4_000_000_000,
          PidsLimit: 200,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
          SecurityOpt: ['no-new-privileges:true'],
          Binds: [`${this.hostPath(this.workspacesDir)}:/workspaces`, 'la-workbench-cache:/cache'],
          RestartPolicy: { Name: 'no' },
        },
      });
    })();
    try { await this.starting; } catch (error) { this.lease?.release(); this.lease = null; throw error; } finally { this.starting = null; }
    this.watchIdle();
  }

  private watchIdle() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => { if (Date.now() - this.lastUsed > IDLE_MS()) void this.stop(); }, 60_000);
    this.idleTimer.unref?.();
  }

  async stop() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    await this.docker.stop(WORKBENCH_NAME).catch(() => undefined);
    this.lease?.release();
    this.lease = null;
  }

  async status(): Promise<WorkbenchStatus> {
    const base = { enabled: workbenchEnabled(), image: IMAGE(), memoryLimitBytes: WORKBENCH_MEMORY_BYTES, lastUsedAt: this.lastUsed ? new Date(this.lastUsed).toISOString() : null };
    if (!this.docker.available()) return { ...base, state: 'unavailable', memoryBytes: null, cpuPercent: null };
    const state = await this.docker.containerState(WORKBENCH_NAME).catch(() => null);
    if (!state) return { ...base, state: 'missing', memoryBytes: null, cpuPercent: null };
    if (state.state !== 'running') return { ...base, state: 'stopped', memoryBytes: null, cpuPercent: null };
    const stats = await this.docker.stats(WORKBENCH_NAME);
    return { ...base, state: 'running', memoryBytes: stats?.memoryBytes ?? null, cpuPercent: stats?.cpuPercent ?? null };
  }
}
