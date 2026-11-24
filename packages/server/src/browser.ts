import fs from 'node:fs';
import path from 'node:path';
import { isBlockedUrl } from '@local-agent/shared';
import type { DockerCtl } from './docker.js';
import { GiB, type Lease, type MemoryBudget } from './memory.js';

export const BROWSER_NAME = 'la-browser';
export const BROWSER_MEMORY_BYTES = 2 * GiB;
/** Upfront RAM lease checked before starting la-browser; Docker still enforces BROWSER_MEMORY_BYTES (2 GB) as a hard ceiling. */
export const browserLeaseBytes = () => Math.max(0.25, Number(process.env.LA_BROWSER_LEASE_GIB || 1)) * GiB;
const IMAGE = () => process.env.LA_BROWSER_IMAGE || 'la-browser:latest';
const IDLE_MS = () => Number(process.env.LA_BROWSER_IDLE_MS || 15 * 60_000);
const ADMIT_WAIT_MS = () => Number(process.env.LA_BROWSER_ADMIT_WAIT_MS || 5_000);

export function realBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LA_BROWSER || 'container').toLowerCase() !== 'headless';
}

export interface BrowserAction {
  type?: 'navigate' | 'click' | 'type' | 'fill' | 'hover' | 'scroll' | 'screenshot' | 'extract' | 'press' | 'select' | 'wait' | 'submit' | 'back' | 'reload';
  action?: string;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  y?: number;
  ms?: number;
}

export interface BrowserResult {
  title: string;
  href: string;
  text: string;
  elements: string[];
  log: string[];
  png: Buffer | null;
  loginDetected?: boolean;
}

export interface BrowserStatus {
  enabled: boolean;
  state: 'running' | 'idle' | 'stopped' | 'missing' | 'unavailable';
  image: string;
  memoryBytes: number | null;
  memoryLimitBytes: number;
  lastUsedAt: string | null;
  activePersona: string | null;
  activeRunId: string | null;
  activeTabOpen?: boolean;
  lastUrl?: string | null;
  lastTitle?: string | null;
}

export interface CdpDriver {
  runTab(input: {
    profileDir: string;
    url: string;
    actions: BrowserAction[];
    screenshot: boolean;
    signal?: AbortSignal;
  }): Promise<BrowserResult>;
}

const PASSWORD_SELECTOR = /\b(pass(word|wd|code)?|pwd|pin|secret)\b|type\s*=\s*['"]?password['"]?/i;
const PAYMENT_URL = /\/(checkout|pay(ment)?|billing|cart|order|purchase|buy)\b/i;
const PAYMENT_TEXT = /\b(pay\s*now|buy\s*now|place\s*order|complete\s*(purchase|order|payment)|checkout|submit\s*payment|confirm\s*purchase|purchase)\b/i;

/** True when an action attempts to type/fill a password field. Agents must never type passwords directly. */
export function isPasswordAction(action: BrowserAction): boolean {
  if (action.type !== 'fill' && action.type !== 'type') return false;
  const sel = `${action.selector || ''} ${action.text || ''}`;
  return PASSWORD_SELECTOR.test(sel);
}

/** True when a browse call submits or clicks a purchase/payment/checkout control. */
export function isPaymentAction(url: string, actions: BrowserAction[]): boolean {
  const onPaymentUrl = PAYMENT_URL.test(url) || actions.some((a) => a.type === 'navigate' && PAYMENT_URL.test(a.url || ''));
  return actions.some((a) => {
    if (a.type === 'submit') return onPaymentUrl || PAYMENT_TEXT.test(`${a.selector || ''} ${a.text || ''}`);
    if (a.type === 'click') {
      const target = `${a.selector || ''} ${a.text || ''}`;
      if (PAYMENT_TEXT.test(target)) return true;
      if (onPaymentUrl && /\b(submit|confirm|continue|buy|pay|order)\b/i.test(target)) return true;
    }
    return false;
  });
}

/** Scrub any vault secret values from extracted page text, titles, or logs so secrets never leak to models or logs. */
export function redactVaultValues(text: string, vaultValues: string[]): string {
  let out = text;
  for (const val of vaultValues) {
    if (!val || val.length < 4) continue;
    out = out.split(val).join('[REDACTED_SECRET]');
  }
  return out;
}

/** Per-persona persistent profile directory under data/browser/<persona>. */
export function personaProfileDir(dataDir: string, personaSlug: string): string {
  const safe = personaSlug.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  const root = path.resolve(dataDir, 'browser');
  const full = path.resolve(root, safe);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error('Invalid persona profile path.');
  fs.mkdirSync(full, { recursive: true });
  return full;
}

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

export function isPrivateAddress(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (PRIVATE_IPV4.test(h)) return true;
  return false;
}

function checkAllowedUrl(url: string, allowPrivate = process.env.LA_BROWSER_ALLOW_PRIVATE === '1'): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are allowed.');
  if (allowPrivate) return;
  const blocked = isBlockedUrl(url);
  if (blocked) throw new Error(blocked);
  if (isPrivateAddress(parsed.hostname)) {
    throw new Error(`Private or loopback address is blocked: ${parsed.hostname}`);
  }
}

/** Default CDP driver executing inside `la-browser` against 127.0.0.1:9222 (no host ports exposed). */
function dockerCdpDriver(docker: DockerCtl, dataDir: string): CdpDriver {
  return {
    async runTab({ profileDir, url, actions, screenshot }) {
      const personaFolder = path.basename(profileDir);
      const shotFile = screenshot ? `.shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png` : null;
      const payload = Buffer.from(JSON.stringify({ url, actions, shotPath: shotFile ? `/profiles/${shotFile}` : null, profile: `/profiles/${personaFolder}` })).toString('base64');
      const script = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const cfg = JSON.parse(Buffer.from(process.env.LA_BROWSE_REQ, 'base64').toString('utf8'));
  // Clean stale Chromium Singleton* locks left behind after a container recreate or crash.
  try {
    const lockPath = path.join(cfg.profile, 'SingletonLock');
    const target = fs.readlinkSync(lockPath);
    const sep = target.lastIndexOf('-');
    const lockHost = sep > 0 ? target.slice(0, sep) : '';
    const lockPid = sep > 0 ? Number(target.slice(sep + 1)) : 0;
    let alive = false;
    if (lockHost === os.hostname() && lockPid > 0) {
      try { process.kill(lockPid, 0); alive = true; } catch {}
    }
    if (!alive) {
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.unlinkSync(path.join(cfg.profile, name)); } catch {}
      }
    }
  } catch {}
  const browserArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run'];
  let browser = null;
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(cfg.profile, {
      headless: false,
      args: browserArgs,
      viewport: { width: 1280, height: 800 },
    });
  } catch {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(cfg.profile, name)); } catch {}
    }
    try {
      ctx = await chromium.launchPersistentContext(cfg.profile, {
        headless: false,
        args: browserArgs,
        viewport: { width: 1280, height: 800 },
      });
    } catch {
      browser = await chromium.launch({ headless: false, args: browserArgs });
      ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    }
  }
  const page = await ctx.newPage();
  const log = [];
  const liveTmp = '/profiles/.last-screen.tmp.png';
  const liveDest = '/profiles/.last-screen.png';
  const snapLive = async () => {
    try {
      await page.screenshot({ path: liveTmp, type: 'png' });
      fs.renameSync(liveTmp, liveDest);
    } catch {}
  };
  try {
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    log.push('navigate ' + cfg.url);
    await snapLive();
    for (const a of cfg.actions || []) {
      const kind = String((a && (a.type || a.action)) || '').toLowerCase();
      if (kind === 'navigate' && a.url) { await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 25000 }); log.push('navigate ' + a.url); }
      else if (kind === 'reload') { await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }); log.push('reload'); }
      else if (kind === 'back') { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}); log.push('back'); }
      else if (kind === 'click' && a.selector) { await page.click(a.selector, { timeout: 10000 }); log.push('click ' + a.selector); }
      else if (kind === 'hover' && (a.selector || a.text)) {
        const target = a.selector || 'text=' + a.text;
        await page.locator(target).first().hover({ timeout: 10000 });
        log.push('hover ' + target);
      }
      else if ((kind === 'fill' || kind === 'type') && a.selector) {
        const isPw = await page.locator(a.selector).first().evaluate((el) => (el.type || '').toLowerCase() === 'password').catch(() => false);
        if (isPw) throw new Error('Password field detected: ask the user to take over to sign in.');
        await page.fill(a.selector, String(a.value ?? a.text ?? ''), { timeout: 10000 });
        log.push('type ' + a.selector);
      }
      else if (kind === 'select' && a.selector) { await page.selectOption(a.selector, String(a.value ?? a.text ?? ''), { timeout: 10000 }); log.push('select ' + a.selector); }
      else if (kind === 'scroll') { await page.evaluate((dy) => window.scrollBy(0, dy), Number(a.y ?? 500)); log.push('scroll ' + (a.y ?? 500)); }
      else if (kind === 'press' && a.key) { await page.keyboard.press(a.key); log.push('press ' + a.key); }
      else if (kind === 'submit' && a.selector) { await page.click(a.selector, { timeout: 10000 }); log.push('submit ' + a.selector); }
      else if (kind === 'wait') { await page.waitForTimeout(Math.min(5000, Number(a.ms ?? 1000))); log.push('wait'); }
      else if (kind === 'extract') { log.push('extract'); }
      await snapLive();
    }
    const title = await page.title().catch(() => '');
    const href = page.url();
    const text = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 10000);
    const loginDetected = await page.locator('input[type="password"]').count().then((n) => n > 0).catch(() => false);
    if (cfg.shotPath) await page.screenshot({ path: cfg.shotPath, type: 'png' }).catch(() => {});
    await snapLive();
    process.stdout.write(JSON.stringify({ title, href, text, elements: [], log, loginDetected }));
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
})().catch((e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
`.trim();
      const res = await docker.exec(
        BROWSER_NAME,
        ['env', `LA_BROWSE_REQ=${payload}`, 'DISPLAY=:99', 'node', '-e', script],
        '/profiles',
        45_000,
      );
      let png: Buffer | null = null;
      if (shotFile) {
        const hostShot = path.resolve(dataDir, 'browser', shotFile);
        try { png = fs.readFileSync(hostShot); } catch { png = null; }
        try { fs.unlinkSync(hostShot); } catch { /* ignore */ }
      }
      if (res.code !== 0) throw new Error(res.output.trim() || `Browser action failed (exit ${res.code}).`);
      const parsed = JSON.parse(res.output) as { title: string; href: string; text: string; elements: string[]; log: string[]; loginDetected?: boolean };
      return {
        title: parsed.title || '',
        href: parsed.href || url,
        text: parsed.text || '',
        elements: parsed.elements || [],
        log: parsed.log || [],
        png,
        loginDetected: Boolean(parsed.loginDetected),
      };
    },
  };
}

export interface ManagedBrowserOpts {
  isRunActive?: (runId: string) => boolean;
  onFrame?: (info: { url: string; title: string; persona: string; runId: string | null; at: string }) => void;
}

export class ManagedBrowser {
  private lease: Lease | null = null;
  private starting: Promise<void> | null = null;
  private lastUsed = 0;
  private activeTabs = 0;
  private activePersona: string | null = null;
  private activeRunId: string | null = null;
  private lastPersona: string | null = null;
  private lastRunId: string | null = null;
  private lastUrl: string | null = null;
  private lastTitle: string | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly driver: CdpDriver;

  constructor(
    private readonly docker: DockerCtl,
    private readonly dataDir: string,
    private readonly memory: () => MemoryBudget | null,
    private readonly hostPath: (p: string) => string = (p) => p,
    driver?: CdpDriver,
    private readonly opts?: ManagedBrowserOpts,
  ) {
    this.driver = driver ?? dockerCdpDriver(docker, dataDir);
  }

  hasLease(): boolean {
    return this.lease !== null;
  }

  async ensure(): Promise<void> {
    if (this.starting) return this.starting;
    const state = await this.docker.containerState(BROWSER_NAME).catch(() => null);
    if (state?.state === 'running' && this.lease) return;
    this.starting = (async () => {
      const memory = this.memory();
      if (!this.lease && memory) {
        const leaseBytes = browserLeaseBytes();
        const usage = await memory.usage();
        const reserve = 2 * GiB;
        if (usage.usedBytes + leaseBytes > usage.budgetBytes || leaseBytes > Math.max(0, usage.systemAvailable - reserve)) {
          throw new Error(`Browser refused: not enough free memory for its ${(leaseBytes / GiB).toFixed(1)} GB lease.`);
        }
        this.lease = await memory.admit({ kind: 'background', label: 'browser', bytes: leaseBytes, maxWaitMs: ADMIT_WAIT_MS() });
      }
      if (state?.state === 'running') return;
      if (state) { await this.docker.start(state.id); return; }
      if (!(await this.docker.hasImage(IMAGE()))) {
        throw new Error(`Browser image ${IMAGE()} is not built yet. Build deploy/browser/Dockerfile first, or set LA_BROWSER=headless.`);
      }
      const profilesRoot = path.resolve(this.dataDir, 'browser');
      fs.mkdirSync(profilesRoot, { recursive: true });
      await this.docker.startDetached({
        name: BROWSER_NAME,
        Image: IMAGE(),
        Labels: { 'com.local-agent.role': 'browser', 'local-agent.role': 'browser' },
        Env: ['DISPLAY=:99', 'CDP_PORT=9222', 'VNC_PORT=5900', 'NOVNC_PORT=6080'],
        network: process.env.LA_COMPOSE_PROJECT ? `${process.env.LA_COMPOSE_PROJECT}_default` : null,
        HostConfig: {
          Memory: BROWSER_MEMORY_BYTES,
          NanoCpus: 1_500_000_000,
          PidsLimit: 200,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Binds: [`${this.hostPath(profilesRoot)}:/profiles`],
          RestartPolicy: { Name: 'no' },
        },
      });
    })();
    try { await this.starting; } catch (error) { this.lease?.release(); this.lease = null; throw error; } finally { this.starting = null; }
    this.watchIdle();
  }

  async browse(input: {
    personaSlug: string;
    runId?: string;
    url: string;
    actions?: BrowserAction[];
    screenshot?: boolean;
    signal?: AbortSignal;
    vaultValues?: string[];
    allowPrivate?: boolean;
  }): Promise<BrowserResult> {
    const actions = input.actions ?? [];
    checkAllowedUrl(input.url, input.allowPrivate);
    for (const action of actions) {
      if (action.type === 'navigate' && action.url) checkAllowedUrl(action.url, input.allowPrivate);
      if (isPasswordAction(action)) {
        throw new Error('Refused: the agent never types passwords. Ask the owner to take over to sign in, or use request_secret.');
      }
    }

    const profileDir = personaProfileDir(this.dataDir, input.personaSlug);
    await this.ensure();
    this.lastUsed = Date.now();
    this.activeTabs += 1;
    this.activePersona = input.personaSlug;
    this.activeRunId = input.runId ?? null;
    this.lastPersona = input.personaSlug;
    if (input.runId) this.lastRunId = input.runId;
    this.lastUrl = input.url;
    const liveShotPath = path.resolve(this.dataDir, 'browser', '.last-screen.png');
    let lastMtime = (() => { try { return fs.statSync(liveShotPath).mtimeMs; } catch { return 0; } })();
    const frameWatch = this.opts?.onFrame
      ? setInterval(() => {
          try {
            const mt = fs.statSync(liveShotPath).mtimeMs;
            if (mt > lastMtime) {
              lastMtime = mt;
              this.lastUsed = Date.now();
              this.opts?.onFrame?.({
                url: this.lastUrl || input.url,
                title: this.lastTitle || '',
                persona: input.personaSlug,
                runId: input.runId ?? null,
                at: new Date().toISOString(),
              });
            }
          } catch { /* no frame yet */ }
        }, 250)
      : null;
    frameWatch?.unref?.();
    try {
      const raw = await this.driver.runTab({
        profileDir,
        url: input.url,
        actions,
        screenshot: Boolean(input.screenshot) || actions.some((a) => (a.type || a.action) === 'screenshot'),
        signal: input.signal,
      });
      this.lastUrl = raw.href || input.url;
      this.lastTitle = raw.title || '';
      this.opts?.onFrame?.({
        url: this.lastUrl,
        title: this.lastTitle,
        persona: input.personaSlug,
        runId: input.runId ?? null,
        at: new Date().toISOString(),
      });
      const secrets = input.vaultValues ?? [];
      return {
        ...raw,
        title: redactVaultValues(raw.title, secrets),
        href: redactVaultValues(raw.href, secrets),
        text: redactVaultValues(raw.text, secrets),
        log: raw.log.map((entry) => redactVaultValues(entry, secrets)),
      };
    } finally {
      if (frameWatch) clearInterval(frameWatch);
      this.activeTabs = Math.max(0, this.activeTabs - 1);
      const runStillActive = Boolean(this.lastRunId && this.opts?.isRunActive?.(this.lastRunId));
      if (this.activeTabs === 0 && !runStillActive) {
        this.activePersona = null;
        this.activeRunId = null;
      }
      this.lastUsed = Date.now();
    }
  }

  private watchIdle() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (this.activeTabs === 0 && Date.now() - this.lastUsed > IDLE_MS()) void this.stop();
    }, 60_000);
    this.idleTimer.unref?.();
  }

  async stop() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    await this.docker.stop(BROWSER_NAME).catch(() => undefined);
    this.lease?.release();
    this.lease = null;
    this.activePersona = null;
    this.activeRunId = null;
  }

  async status(): Promise<BrowserStatus> {
    const runStillActive = Boolean(this.lastRunId && this.opts?.isRunActive?.(this.lastRunId));
    const inFlight = this.activeTabs > 0;
    const isRunning = inFlight || runStillActive;
    const base = {
      enabled: realBrowserEnabled(),
      image: IMAGE(),
      memoryLimitBytes: BROWSER_MEMORY_BYTES,
      lastUsedAt: this.lastUsed ? new Date(this.lastUsed).toISOString() : null,
      activePersona: isRunning ? (this.activePersona || this.lastPersona) : null,
      activeRunId: isRunning ? (this.activeRunId || this.lastRunId) : null,
      activeTabOpen: inFlight,
      lastUrl: this.lastUrl,
      lastTitle: this.lastTitle,
    };
    if (!this.docker.available()) return { ...base, state: 'unavailable', memoryBytes: null, activeTabOpen: false };
    const state = await this.docker.containerState(BROWSER_NAME).catch(() => null);
    if (!state) return { ...base, state: 'missing', memoryBytes: null, activeTabOpen: false };
    if (state.state !== 'running') return { ...base, state: 'stopped', memoryBytes: null, activeTabOpen: false, activePersona: null, activeRunId: null };
    const stats = await this.docker.stats?.(BROWSER_NAME).catch(() => null);
    return { ...base, state: isRunning ? 'running' : 'idle', memoryBytes: stats?.memoryBytes ?? null };
  }
}
