import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { riskOf } from '@local-agent/shared';
import { MEMBER_DENIED_TOOLS } from '../src/accounts.js';
import {
  BROWSER_MEMORY_BYTES,
  BROWSER_NAME,
  BROWSER_PIDS_LIMIT,
  BROWSER_SHM_BYTES,
  ManagedBrowser,
  isBrowserPolicyError,
  isPasswordAction,
  isPaymentAction,
  personaProfileDir,
  realBrowserEnabled,
  redactVaultValues,
  type CdpDriver,
} from '../src/browser.js';
import type { DockerCtl } from '../src/docker.js';
import { GiB, MemoryBudget, type MemoryProbe } from '../src/memory.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeDocker() {
  const startedSpecs: any[] = [];
  let exists = false;
  let running = false;
  const docker = {
    available: () => true,
    containerState: vi.fn(async () => (exists ? { id: 'br-1', state: running ? 'running' : 'exited' } : null)),
    hasImage: vi.fn(async () => true),
    start: vi.fn(async () => { running = true; }),
    startDetached: vi.fn(async (spec: any) => { startedSpecs.push(spec); exists = true; running = true; return 'br-1'; }),
    stop: vi.fn(async () => { running = false; }),
    remove: vi.fn(async () => { exists = false; running = false; }),
    stats: vi.fn(async () => ({ memoryBytes: 0.8 * GiB, memoryLimitBytes: BROWSER_MEMORY_BYTES, cpuPercent: 5 })),
  } as unknown as DockerCtl;
  return { docker, startedSpecs };
}

function fakeBudget(availableGiB: number) {
  const probe: MemoryProbe = {
    serverRss: () => 0.5 * GiB,
    systemAvailable: () => availableGiB * GiB,
    loaded: async () => [],
    show: async () => null,
    unload: async () => undefined,
  };
  return new MemoryBudget(probe, () => ({ budgetBytes: 16 * GiB, systemReserveBytes: 2 * GiB, parallelSlots: 1 }));
}

describe('managed real browser (la-browser)', () => {
  it('executes CDP actions, isolates per-persona profiles across container restart, holds 2 GB lease, and exposes no host ports', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-'));
    dirs.push(dataDir);
    const { docker, startedSpecs } = fakeDocker();
    const budget = fakeBudget(12);

    const calls: { profileDir: string; url: string; actions: any[]; screenshot: boolean }[] = [];
    const driver: CdpDriver = {
      async runTab(input) {
        calls.push(input);
        // Simulate browser writing a cookie file into the persona's profile dir.
        fs.writeFileSync(path.join(input.profileDir, 'Cookies'), `cookie-for-${path.basename(input.profileDir)}`);
        return {
          title: 'Example Page',
          href: input.url,
          text: 'Hello world secret-token-9999',
          elements: [],
          log: ['navigate ' + input.url, 'click #go', 'type #q', 'scroll 400', 'extract'],
          png: input.screenshot ? Buffer.from('PNGDATA') : null,
        };
      },
    };

    const browser = new ManagedBrowser(docker, dataDir, () => budget, (p) => p, driver);
    const res = await browser.browse({
      personaSlug: 'researcher',
      url: 'https://example.com',
      actions: [
        { type: 'click', selector: '#go' },
        { type: 'type', selector: '#q', text: 'local agent' },
        { type: 'scroll', y: 400 },
        { type: 'screenshot' },
        { type: 'extract' },
      ],
      vaultValues: ['secret-token-9999'],
    });

    expect(res.title).toBe('Example Page');
    expect(res.text).toContain('[REDACTED_SECRET]');
    expect(res.text).not.toContain('secret-token-9999');
    expect(res.png?.toString()).toBe('PNGDATA');
    expect(browser.hasLease()).toBe(true);
    expect(startedSpecs).toHaveLength(1);
    expect(startedSpecs[0].name).toBe(BROWSER_NAME);
    expect(startedSpecs[0].HostConfig.Memory).toBe(BROWSER_MEMORY_BYTES);
    expect(startedSpecs[0].HostConfig.PidsLimit).toBe(BROWSER_PIDS_LIMIT);
    expect(startedSpecs[0].HostConfig.ShmSize).toBe(BROWSER_SHM_BYTES);
    expect(startedSpecs[0].HostConfig.Init).toBe(true);
    expect(startedSpecs[0].HostConfig.PortBindings).toBeUndefined();
    expect(startedSpecs[0].HostConfig.NetworkMode).not.toBe('host');

    // Stop container (simulates idle stop) and verify lease released + profile persisted on disk.
    await browser.stop();
    expect(browser.hasLease()).toBe(false);
    const researcherProfile = personaProfileDir(dataDir, 'researcher');
    expect(fs.readFileSync(path.join(researcherProfile, 'Cookies'), 'utf8')).toBe('cookie-for-researcher');

    // Restart with a second persona: separate profile dir, never shared!
    await browser.browse({ personaSlug: 'coder', url: 'https://example.org' });
    const coderProfile = personaProfileDir(dataDir, 'coder');
    expect(coderProfile).not.toBe(researcherProfile);
    expect(fs.readFileSync(path.join(coderProfile, 'Cookies'), 'utf8')).toBe('cookie-for-coder');
    expect(fs.readFileSync(path.join(researcherProfile, 'Cookies'), 'utf8')).toBe('cookie-for-researcher');
    await browser.stop();
  });

  it('refuses to start when memory is short for the 2 GB lease', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-oom-'));
    dirs.push(dataDir);
    const { docker, startedSpecs } = fakeDocker();
    const budget = fakeBudget(2.5); // 2.5 GiB - 2 GiB reserve = 0.5 GiB < 1 GiB lease
    const browser = new ManagedBrowser(docker, dataDir, () => budget);
    await expect(browser.browse({ personaSlug: 'researcher', url: 'https://example.com' })).rejects.toThrow(/not enough free memory/i);
    expect(startedSpecs).toHaveLength(0);
    expect(browser.hasLease()).toBe(false);
  });

  it('blocks private/loopback IP URLs', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-priv-'));
    dirs.push(dataDir);
    const { docker } = fakeDocker();
    const browser = new ManagedBrowser(docker, dataDir, () => null);
    await expect(browser.browse({ personaSlug: 'researcher', url: 'http://127.0.0.1:8787/api/health' })).rejects.toThrow(/private|local|loopback|blocked/i);
    await expect(browser.browse({ personaSlug: 'researcher', url: 'http://192.168.1.10/' })).rejects.toThrow(/private|local|loopback|blocked/i);
    await expect(browser.browse({ personaSlug: 'researcher', url: 'https://example.com', actions: [{ type: 'navigate', url: 'http://10.0.0.1/' }] })).rejects.toThrow(/private|local|loopback|blocked/i);
  });

  it('refuses password typing and gates payment/checkout submits as high risk', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-sec-'));
    dirs.push(dataDir);
    const { docker } = fakeDocker();
    const browser = new ManagedBrowser(docker, dataDir, () => null);

    expect(isPasswordAction({ type: 'type', selector: 'input[type="password"]', text: 'hunter2' })).toBe(true);
    await expect(browser.browse({
      personaSlug: 'researcher',
      url: 'https://example.com/login',
      actions: [{ type: 'fill', selector: '#password', value: 'hunter2' }],
    })).rejects.toThrow(/never types passwords/i);

    expect(isPaymentAction('https://shop.example.com/checkout', [{ type: 'submit', selector: '#pay' }])).toBe(true);
    expect(isPaymentAction('https://shop.example.com/item', [{ type: 'click', text: 'Buy now' }])).toBe(true);
    const tier = riskOf('browse', { url: 'https://shop.example.com/checkout', actions: [{ type: 'click', text: 'Place order' }] }, null);
    expect(tier.tier).toBe('high');
  });

  it('respects LA_BROWSER=headless rollback, denies members, and redacts vault values', () => {
    expect(realBrowserEnabled({ LA_BROWSER: 'headless' })).toBe(false);
    expect(realBrowserEnabled({ LA_BROWSER: 'container' })).toBe(true);
    expect(MEMBER_DENIED_TOOLS.has('browse')).toBe(true);
    expect(redactVaultValues('token=ghp_1234567890 ok', ['ghp_1234567890'])).toBe('token=[REDACTED_SECRET] ok');
  });

  it('recreates an existing container whose HostConfig has old PidsLimit/ShmSize/Init, and reuses when upgraded', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-drift-'));
    dirs.push(dataDir);
    let inspectConfig = { PidsLimit: 200, Init: false, ShmSize: 67_108_864 };
    const startedSpecs: any[] = [];
    const startMock = vi.fn(async () => undefined);
    let state = 'exited';
    const docker = {
      available: () => true,
      containerState: vi.fn(async () => ({ id: 'br-old', state, status: 'Exited' })),
      inspect: vi.fn(async () => ({ HostConfig: inspectConfig })),
      hasImage: vi.fn(async () => true),
      start: startMock,
      startDetached: vi.fn(async (spec: any) => {
        startedSpecs.push(spec);
        inspectConfig = {
          PidsLimit: spec.HostConfig.PidsLimit,
          Init: spec.HostConfig.Init,
          ShmSize: spec.HostConfig.ShmSize,
        };
        state = 'running';
        return 'br-new';
      }),
      stop: vi.fn(async () => { state = 'exited'; }),
      stats: vi.fn(async () => ({ memoryBytes: 0.4 * GiB, memoryLimitBytes: BROWSER_MEMORY_BYTES, cpuPercent: 1 })),
    } as unknown as DockerCtl;

    const browser = new ManagedBrowser(docker, dataDir, () => null);
    await browser.ensure();
    expect(startedSpecs).toHaveLength(1);
    expect(startedSpecs[0].replace).toBe(true);
    expect(startedSpecs[0].HostConfig.PidsLimit).toBe(BROWSER_PIDS_LIMIT);
    expect(startedSpecs[0].HostConfig.ShmSize).toBe(BROWSER_SHM_BYTES);
    expect(startedSpecs[0].HostConfig.Init).toBe(true);
    expect(startMock).not.toHaveBeenCalled();

    // After idle stop, container matches upgraded limits, so ensure() calls start() instead of recreating.
    await browser.stop();
    await browser.ensure();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startedSpecs).toHaveLength(1);
  });

  it('serializes concurrent browse calls FIFO via tabQueue', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-queue-'));
    dirs.push(dataDir);
    const { docker } = fakeDocker();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const driver: CdpDriver = {
      async runTab(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${input.url}`);
        await new Promise((r) => setTimeout(r, input.url.includes('first') ? 40 : 10));
        order.push(`end:${input.url}`);
        active -= 1;
        return { title: input.url, href: input.url, text: 'ok', elements: [], log: ['navigate'], png: null };
      },
    };

    const browser = new ManagedBrowser(docker, dataDir, () => null, (p) => p, driver);
    const [r1, r2] = await Promise.all([
      browser.browse({ personaSlug: 'assistant', url: 'https://example.com/first' }),
      browser.browse({ personaSlug: 'assistant', url: 'https://example.com/second' }),
    ]);

    expect(r1.href).toBe('https://example.com/first');
    expect(r2.href).toBe('https://example.com/second');
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      'start:https://example.com/first',
      'end:https://example.com/first',
      'start:https://example.com/second',
      'end:https://example.com/second',
    ]);
  });

  it('recycles la-browser once and retries on EAGAIN / Resource temporarily unavailable errors', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-eagain-'));
    dirs.push(dataDir);
    const { docker, startedSpecs } = fakeDocker();
    let attempts = 0;
    const driver: CdpDriver = {
      async runTab(input) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('browserType.launch: fork: Resource temporarily unavailable (11)');
        }
        return { title: 'Recovered', href: input.url, text: 'ok', elements: [], log: ['navigate'], png: null };
      },
    };

    const browser = new ManagedBrowser(docker, dataDir, () => null, (p) => p, driver);
    const res = await browser.browse({ personaSlug: 'assistant', url: 'https://example.com' });
    expect(res.title).toBe('Recovered');
    expect(attempts).toBe(2);
    expect((docker as any).stop).toHaveBeenCalledTimes(1);
    expect((docker as any).remove).toHaveBeenCalledTimes(1);
    expect(startedSpecs).toHaveLength(2);
  });

  it('classifies policy errors without false-positives on Chromium launch flags', () => {
    const playwrightCrash = new Error(
      'browserType.launch: Target page, context or browser has been closed\n' +
      'Browser logs:\n' +
      '<launching> /ms-playwright/chromium-1169/chrome-linux/chrome --password-store=basic --disable-popup-blocking --no-sandbox\n' +
      '[pid=1373][err] fork: Resource temporarily unavailable (11)',
    );
    expect(isBrowserPolicyError(playwrightCrash)).toBe(false);
    expect(isBrowserPolicyError(new Error('Refused: the agent never types passwords.'))).toBe(true);
    expect(isBrowserPolicyError(new Error('Password field detected: ask the user to take over to sign in.'))).toBe(true);
    expect(isBrowserPolicyError(new Error('Private or loopback address is blocked: 127.0.0.1'))).toBe(true);
  });

  it('runs dockerCdpDriver with timeout wrapper, crash-reporter disabled, file JSON IPC, and temp cleanup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-br-ipc-'));
    dirs.push(dataDir);
    const { docker } = fakeDocker();
    let capturedCmd: string[] = [];
    let hostResPath = '';
    (docker as any).exec = vi.fn(async (_name: string, cmd: string[]) => {
      capturedCmd = cmd;
      const envArg = cmd.find((part) => part.startsWith('LA_BROWSE_REQ='))!;
      const reqPayload = JSON.parse(Buffer.from(envArg.slice('LA_BROWSE_REQ='.length), 'base64').toString('utf8'));
      const resName = path.basename(reqPayload.resPath);
      hostResPath = path.resolve(dataDir, 'browser', resName);
      fs.writeFileSync(hostResPath, JSON.stringify({
        title: 'IPC Domain',
        href: 'https://example.com/',
        text: 'hello ' + 'x'.repeat(70_000),
        elements: [],
        log: ['navigate https://example.com'],
        loginDetected: false,
      }), 'utf8');
      return { output: 'noisy stderr warning that would corrupt stdout JSON', code: 0 };
    });

    const browser = new ManagedBrowser(docker, dataDir, () => null);
    const res = await browser.browse({ personaSlug: 'assistant', url: 'https://example.com', screenshot: false });

    expect(res.title).toBe('IPC Domain');
    expect(res.text.length).toBe(70_006);
    expect(capturedCmd.slice(2, 8)).toEqual(['DISPLAY=:99', 'timeout', '-k', '5', '42', 'node']);
    const scriptArg = capturedCmd[capturedCmd.length - 1];
    expect(scriptArg).toContain('--disable-crash-reporter');
    expect(scriptArg).toContain('--disable-breakpad');
    expect(hostResPath).not.toBe('');
    expect(fs.existsSync(hostResPath)).toBe(false);
  });
});
