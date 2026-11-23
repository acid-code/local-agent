import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { riskOf } from '@local-agent/shared';
import { GiB, MemoryBudget, type MemoryProbe } from '../src/memory.js';
import {
  WORKBENCH_CACHE_VOLUMES,
  WORKBENCH_MEMORY_BYTES,
  WORKBENCH_NAME,
  Workbench,
  workbenchEnabled,
  wrapCommand,
} from '../src/workbench.js';
import type { DockerCtl } from '../src/docker.js';

function fakeDocker() {
  const execCalls: { name: string; cmd: string[]; cwd: string; timeoutMs: number }[] = [];
  const startedSpecs: any[] = [];
  let running = false;
  let exists = false;
  const docker = {
    available: () => true,
    containerState: vi.fn(async () => (exists ? { id: 'wb-1', state: running ? 'running' : 'exited' } : null)),
    hasImage: vi.fn(async () => true),
    pull: vi.fn(async () => undefined),
    start: vi.fn(async () => { running = true; }),
    startDetached: vi.fn(async (spec: any) => { startedSpecs.push(spec); exists = true; running = true; return 'wb-1'; }),
    stop: vi.fn(async () => { running = false; }),
    exec: vi.fn(async (name: string, cmd: string[], cwd: string, timeoutMs = 60_000) => {
      execCalls.push({ name, cmd, cwd, timeoutMs });
      if (cmd[2]?.includes('printf "node=')) {
        return { output: 'node=v22.13.0\npython=Python 3.12.7\nuv=uv 0.5.11\n', code: 0 };
      }
      return { output: `ran in ${cwd}`, code: 0 };
    }),
    stats: vi.fn(async () => ({ memoryBytes: 1.5 * GiB, memoryLimitBytes: WORKBENCH_MEMORY_BYTES, cpuPercent: 12.5 })),
  } as unknown as DockerCtl;
  return { docker, execCalls, startedSpecs, isRunning: () => running };
}

function fakeBudget(opts: { availableGiB: number; budgetGiB?: number; gttUsedGiB?: number; gttTotalGiB?: number; externalResident?: number }) {
  const loaded: { name: string; sizeBytes: number }[] = [];
  const probe: MemoryProbe = {
    serverRss: () => 0.5 * GiB,
    systemAvailable: () => opts.availableGiB * GiB,
    loaded: async () => [...loaded],
    show: async () => null,
    unload: async (name) => {
      const idx = loaded.findIndex((m) => m.name === name);
      if (idx >= 0) loaded.splice(idx, 1);
    },
    gtt: opts.gttTotalGiB ? () => ({ usedBytes: (opts.gttUsedGiB ?? 0) * GiB, totalBytes: opts.gttTotalGiB! * GiB }) : undefined,
    externalResident: () => opts.externalResident ?? 0,
  };
  const cfg = () => ({ budgetBytes: (opts.budgetGiB ?? 32) * GiB, systemReserveBytes: 2 * GiB, parallelSlots: 1 });
  return { budget: new MemoryBudget(probe, cfg), loaded };
}

describe('shared workbench', () => {
  it('runs commands via docker exec in /workspaces/<project> with named cache volumes and 6 GB lease', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-wb-'));
    const projectDir = path.join(tmp, 'coder', 'app');
    fs.mkdirSync(projectDir, { recursive: true });
    const { docker, execCalls, startedSpecs } = fakeDocker();
    const { budget } = fakeBudget({ availableGiB: 20, budgetGiB: 32 });
    const wb = new Workbench(docker, tmp, () => budget);

    const res = await wb.run('npm test', projectDir, 123_000);
    expect(res).toEqual({ output: 'ran in /workspaces/coder/app', code: 0 });
    expect(wb.hasLease()).toBe(true);
    expect(startedSpecs).toHaveLength(1);
    expect(startedSpecs[0].name).toBe(WORKBENCH_NAME);
    expect(startedSpecs[0].HostConfig.Memory).toBe(WORKBENCH_MEMORY_BYTES);
    for (const vol of WORKBENCH_CACHE_VOLUMES) {
      expect(startedSpecs[0].HostConfig.Binds).toContain(vol);
    }
    const userExec = execCalls.find((c) => c.cmd[2]?.includes('npm test'));
    expect(userExec?.cwd).toBe('/workspaces/coder/app');
    expect(userExec?.timeoutMs).toBe(123_000);

    const st = await wb.status();
    expect(st.state).toBe('idle');
    expect(st.cpuPercent).toBe(12.5);
    expect(st.tools).toEqual({ node: '22.13.0', python: '3.12.7', uv: '0.5.11' });

    await wb.stop();
    expect(wb.hasLease()).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null for paths outside data/workspaces so caller falls back to ephemeral', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-wb-out-'));
    const { docker } = fakeDocker();
    const wb = new Workbench(docker, tmp, () => null);
    expect(wb.containerPath('/etc')).toBeNull();
    expect(await wb.run('ls', '/etc')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to start when memory is short and releases nothing leaked', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-wb-oom-'));
    const { docker, startedSpecs } = fakeDocker();
    const { budget } = fakeBudget({ availableGiB: 2.5, budgetGiB: 32 }); // 2.5 GiB available - 2 GiB reserve = 0.5 GiB < 1 GiB lease
    const wb = new Workbench(docker, tmp, () => budget);
    await expect(wb.run('echo hi', tmp)).rejects.toThrow(/not enough free memory/i);
    expect(startedSpecs).toHaveLength(0);
    expect(wb.hasLease()).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('wrapCommand auto-creates .venv with uv python 3.12 when pyproject.toml or requirements.txt exists', () => {
    const wrapped = wrapCommand('pytest');
    expect(wrapped).toContain('pyproject.toml');
    expect(wrapped).toContain('requirements.txt');
    expect(wrapped).toContain('uv venv --python 3.12 .venv');
    expect(wrapped).toContain('.venv/bin/activate');
    expect(wrapped).toContain('pytest');
  });

  it('respects LA_SHELL=ephemeral rollback switch', () => {
    expect(workbenchEnabled({ LA_SHELL: 'ephemeral' })).toBe(false);
    expect(workbenchEnabled({ LA_SHELL: 'EPHEMERAL' })).toBe(false);
    expect(workbenchEnabled({ LA_SHELL: 'workbench' })).toBe(true);
    expect(workbenchEnabled({})).toBe(true);
  });

  it('gates apt install as high risk with "affects all personas" text and does not flag JS => arrows as redirects', () => {
    const r1 = riskOf('shell', { command: 'apt install -y jq' }, null);
    expect(r1.tier).toBe('high');
    expect(r1.why).toContain('affects all personas');
    const r2 = riskOf('shell', { command: 'apt-get install ripgrep' }, null);
    expect(r2.tier).toBe('high');
    expect(r2.why).toContain('affects all personas');
    const r3 = riskOf('shell', { command: "node -e \"https.get('https://example.com', res => console.log(res.statusCode))\"" }, null);
    expect(r3.tier).toBe('low');
  });

  it('runs sandboxed projects under workspaces/projects in workbench and refuses host paths outside workspaces', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'la-wb-ws-'));
    const repoDir = path.join(ws, 'projects', 'fb-marketplace-scraper');
    fs.mkdirSync(repoDir, { recursive: true });
    const { docker, execCalls, startedSpecs } = fakeDocker();
    const wb = new Workbench(docker, ws, () => null);

    expect(await wb.run('ls', '/home/acid/projects/secret')).toBeNull();
    const res = await wb.run('npm ping', repoDir);
    expect(res).toEqual({ output: 'ran in /workspaces/projects/fb-marketplace-scraper', code: 0 });
    expect(startedSpecs[0].HostConfig.Binds).toEqual([
      `${ws}:/workspaces`,
      'la-workbench-npm:/cache/npm',
      'la-workbench-pip:/cache/pip',
      'la-workbench-uv:/cache/uv',
      'la-workbench-tools:/opt/workbench',
    ]);
    expect(execCalls.find((c) => c.cmd[2]?.includes('npm ping'))?.cwd).toBe('/workspaces/projects/fb-marketplace-scraper');

    await wb.stop();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('queues chat before background (FIFO within priority) and enforces max 2 resident models', async () => {
    const { budget } = fakeBudget({ availableGiB: 20, budgetGiB: 16, externalResident: 1 });
    // 1 external resident (llama-server) + 1 Ollama model = 2 resident models (at cap).
    const first = await budget.admit({ kind: 'chat', label: 'first', model: 'm1', bytes: 10 * GiB });

    const order: string[] = [];
    const bgPromise = budget.admit({ kind: 'background', label: 'bg', model: 'm2', bytes: 10 * GiB }).then((l) => { order.push('bg'); return l; });
    const chatPromise = budget.admit({ kind: 'chat', label: 'chat', model: 'm3', bytes: 10 * GiB }).then((l) => { order.push('chat'); return l; });

    // Neither m2 nor m3 can start while m1 holds memory (and cap is 2).
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]);

    // Release first: chat must run before background!
    first.release();
    const chatLease = await chatPromise;
    expect(order).toEqual(['chat']);

    chatLease.release();
    const bgLease = await bgPromise;
    expect(order).toEqual(['chat', 'bg']);
    bgLease.release();
  });
});
