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
/** Upfront RAM lease checked before starting la-workbench; Docker still enforces WORKBENCH_MEMORY_BYTES (6 GB) as a hard ceiling. */
export const workbenchLeaseBytes = () => Math.max(0.25, Number(process.env.LA_WORKBENCH_LEASE_GIB || 1)) * GiB;
export const WORKBENCH_CACHE_VOLUMES = [
  'la-workbench-npm:/cache/npm',
  'la-workbench-pip:/cache/pip',
  'la-workbench-uv:/cache/uv',
  'la-workbench-tools:/opt/workbench',
] as const;

const IMAGE = () => process.env.LA_WORKBENCH_IMAGE || 'node:22-bookworm';
const IDLE_MS = () => Number(process.env.LA_WORKBENCH_IDLE_MS || 30 * 60_000);
const ADMIT_WAIT_MS = () => Number(process.env.LA_WORKBENCH_ADMIT_WAIT_MS || 5_000);

export function workbenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LA_SHELL || 'workbench').toLowerCase() !== 'ephemeral';
}

/** Python projects get their own .venv (via uv with python 3.12 when available, else python3 -m venv); Node uses node_modules. */
export function wrapCommand(command: string): string {
  const pathSetup = 'export PATH="$PWD/node_modules/.bin:/opt/workbench/bin:$PATH"';
  const venv = [
    'if [ -f pyproject.toml ] || [ -f requirements.txt ]; then',
    '  if [ ! -d .venv ]; then',
    '    if command -v uv >/dev/null 2>&1; then',
    '      uv venv --python 3.12 .venv >/dev/null 2>&1 || uv venv .venv >/dev/null 2>&1 || python3 -m venv .venv >/dev/null 2>&1;',
    '    else',
    '      python3 -m venv .venv >/dev/null 2>&1;',
    '    fi;',
    '  fi;',
    '  [ -f .venv/bin/activate ] && . .venv/bin/activate;',
    'fi',
  ].join(' ');
  return `${pathSetup}; ${venv}; ${command}`;
}

export interface WorkbenchTools {
  node: string | null;
  python: string | null;
  uv: string | null;
}

export interface WorkbenchStatus {
  enabled: boolean;
  state: 'running' | 'idle' | 'stopped' | 'missing' | 'unavailable';
  image: string;
  memoryBytes: number | null;
  memoryLimitBytes: number;
  cpuPercent: number | null;
  lastUsedAt: string | null;
  tools: WorkbenchTools;
}

const cleanVer = (raw: string): string | null => {
  const line = raw.trim().split(/\r?\n/)[0]?.trim();
  if (!line || /not found|no such file/i.test(line)) return null;
  return line.replace(/^(node|python3?|uv)\s+/i, '').replace(/^v/i, '').trim() || null;
};

export class Workbench {
  private lease: Lease | null = null;
  private starting: Promise<void> | null = null;
  private lastUsed = 0;
  private activeCommands = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private cachedTools: WorkbenchTools = { node: null, python: null, uv: null };
  private toolsProbed = false;

  constructor(
    private readonly docker: DockerCtl,
    private readonly workspacesDir: string,
    private readonly memory: () => MemoryBudget | null,
    private readonly hostPath: (p: string) => string = (p) => p,
  ) {}

  /** Container path for a host cwd inside workspacesDir, or null when outside (never mounts host paths outside workspaces). */
  containerPath(cwd: string): string | null {
    const full = path.resolve(cwd);
    const root = path.resolve(this.workspacesDir);
    if (full === root || full.startsWith(`${root}${path.sep}`)) {
      return path.posix.join('/workspaces', path.relative(root, full).split(path.sep).join('/'));
    }
    return null;
  }

  async run(command: string, cwd: string, timeoutMs = 5 * 60_000): Promise<{ output: string; code: number } | null> {
    const inside = this.containerPath(cwd);
    if (!inside) return null;
    await this.ensure();
    this.lastUsed = Date.now();
    this.activeCommands += 1;
    try {
      return await this.docker.exec(WORKBENCH_NAME, ['bash', '-lc', wrapCommand(command)], inside, timeoutMs);
    } finally {
      this.activeCommands = Math.max(0, this.activeCommands - 1);
      this.lastUsed = Date.now();
    }
  }

  /** Start the container if needed, after the memory budget admits its 6 GB. Refuses immediately when memory doesn't fit. */
  async ensure(): Promise<void> {
    if (this.starting) return this.starting;
    const state = await this.docker.containerState(WORKBENCH_NAME).catch(() => null);
    if (state?.state === 'running' && this.lease) return;
    this.starting = (async () => {
      const memory = this.memory();
      if (!this.lease && memory) {
        const leaseBytes = workbenchLeaseBytes();
        const req = { kind: 'background' as const, label: 'workbench', bytes: leaseBytes, maxWaitMs: ADMIT_WAIT_MS() };
        if (!(await memory.fitsNow(req))) {
          throw new Error(`Workbench refused: not enough free memory for its ${(leaseBytes / GiB).toFixed(1)} GB lease.`);
        }
        this.lease = await memory.admit(req);
      }
      if (state?.state === 'running') {
        void this.probeTools();
        return;
      }
      if (state) {
        await this.docker.start(state.id);
        void this.probeTools();
        return;
      }
      if (!(await this.docker.hasImage(IMAGE()))) await this.docker.pull(IMAGE());
      fs.mkdirSync(this.workspacesDir, { recursive: true });
      const binds = [`${this.hostPath(this.workspacesDir)}:/workspaces`, ...WORKBENCH_CACHE_VOLUMES];
      await this.docker.startDetached({
        name: WORKBENCH_NAME,
        Image: IMAGE(),
        Cmd: ['sleep', 'infinity'],
        Labels: { 'com.local-agent.role': 'sandbox', 'local-agent.role': 'workbench' },
        Env: [
          'PIP_CACHE_DIR=/cache/pip',
          'npm_config_cache=/cache/npm',
          'UV_CACHE_DIR=/cache/uv',
          'UV_PYTHON_INSTALL_DIR=/opt/workbench/python',
          'PYTHONDONTWRITEBYTECODE=1',
          'PATH=/opt/workbench/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ],
        network: null,
        HostConfig: {
          Memory: WORKBENCH_MEMORY_BYTES,
          NanoCpus: 4_000_000_000,
          PidsLimit: 200,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
          SecurityOpt: ['no-new-privileges:true'],
          Binds: binds,
          RestartPolicy: { Name: 'no' },
        },
      });
      if (process.env.LA_WORKBENCH_BOOTSTRAP !== '0' && !process.env.VITEST) {
        void this.bootstrapTools().then(() => this.probeTools());
      } else {
        void this.probeTools();
      }
    })();
    try { await this.starting; } catch (error) { this.lease?.release(); this.lease = null; throw error; } finally { this.starting = null; }
    this.watchIdle();
  }

  /** Best-effort install of uv + python 3.12 into the persistent /opt/workbench volume when running stock node:22-bookworm. */
  private async bootstrapTools(): Promise<void> {
    const script = [
      'export PATH="/opt/workbench/bin:$PATH"',
      'export UV_PYTHON_INSTALL_DIR=/opt/workbench/python',
      'if ! command -v uv >/dev/null 2>&1; then',
      '  mkdir -p /opt/workbench/bin && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/opt/workbench/bin sh >/dev/null 2>&1 || true',
      'fi',
      'if command -v uv >/dev/null 2>&1 && ! command -v python3.12 >/dev/null 2>&1; then',
      '  uv python install 3.12 >/dev/null 2>&1 && ln -sf "$(uv python find 3.12)" /opt/workbench/bin/python3.12 || true',
      'fi',
    ].join('; ');
    await this.docker.exec(WORKBENCH_NAME, ['bash', '-lc', script], '/workspaces', 120_000).catch(() => undefined);
  }

  async probeTools(): Promise<WorkbenchTools> {
    try {
      const cmd = 'export PATH="/opt/workbench/bin:$PATH"; printf "node=%s\\npython=%s\\nuv=%s\\n" "$(node -v 2>/dev/null || true)" "$(python3.12 --version 2>/dev/null || python3 --version 2>/dev/null || true)" "$(uv --version 2>/dev/null || true)"';
      const res = await this.docker.exec(WORKBENCH_NAME, ['bash', '-lc', cmd], '/workspaces', 10_000);
      const map = new Map<string, string>();
      for (const line of res.output.split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx > 0) map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      }
      this.cachedTools = {
        node: cleanVer(map.get('node') || ''),
        python: cleanVer(map.get('python') || ''),
        uv: cleanVer(map.get('uv') || ''),
      };
      this.toolsProbed = true;
    } catch {
      // Keep cached values when exec fails
    }
    return this.cachedTools;
  }

  private watchIdle() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (this.activeCommands === 0 && Date.now() - this.lastUsed > IDLE_MS()) void this.stop();
    }, 60_000);
    this.idleTimer.unref?.();
  }

  hasLease(): boolean {
    return this.lease !== null;
  }

  async stop() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    await this.docker.stop(WORKBENCH_NAME).catch(() => undefined);
    this.lease?.release();
    this.lease = null;
    this.toolsProbed = false;
  }

  async status(): Promise<WorkbenchStatus> {
    const base = {
      enabled: workbenchEnabled(),
      image: IMAGE(),
      memoryLimitBytes: WORKBENCH_MEMORY_BYTES,
      lastUsedAt: this.lastUsed ? new Date(this.lastUsed).toISOString() : null,
      tools: this.cachedTools,
    };
    if (!this.docker.available()) return { ...base, state: 'unavailable', memoryBytes: null, cpuPercent: null };
    const state = await this.docker.containerState(WORKBENCH_NAME).catch(() => null);
    if (!state) return { ...base, state: 'missing', memoryBytes: null, cpuPercent: null };
    if (state.state !== 'running') return { ...base, state: 'stopped', memoryBytes: null, cpuPercent: null };
    const [stats, tools] = await Promise.all([
      this.docker.stats(WORKBENCH_NAME),
      this.toolsProbed ? Promise.resolve(this.cachedTools) : this.probeTools(),
    ]);
    const wbState = this.activeCommands > 0 ? 'running' : 'idle';
    return { ...base, state: wbState, memoryBytes: stats?.memoryBytes ?? null, cpuPercent: stats?.cpuPercent ?? null, tools };
  }
}
