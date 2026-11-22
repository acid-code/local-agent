import fs from 'node:fs';
import path from 'node:path';
import { isBlockedUrl } from '@local-agent/shared';
import type { DockerCtl } from './docker.js';
import { GiB, type Lease, type MemoryBudget } from './memory.js';

export const BROWSER_NAME = 'la-browser';
export const BROWSER_MEMORY_BYTES = 2 * GiB;
const IMAGE = () => process.env.LA_BROWSER_IMAGE || 'la-browser:latest';
const IDLE_MS = () => Number(process.env.LA_BROWSER_IDLE_MS || 15 * 60_000);
const ADMIT_WAIT_MS = () => Number(process.env.LA_BROWSER_ADMIT_WAIT_MS || 5_000);

export function realBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LA_BROWSER || 'container').toLowerCase() !== 'headless';
}

export interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'fill' | 'scroll' | 'screenshot' | 'extract' | 'press' | 'select' | 'wait' | 'submit' | 'back' | 'reload';
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
function dockerCdpDriver(docker: DockerCtl): CdpDriver {
  return {
    async runTab({ profileDir, url, actions, screenshot }) {
      const personaFolder = path.basename(profileDir);
      const payload = Buffer.from(JSON.stringify({ url, actions, screenshot, profile: `/profiles/${personaFolder}` })).toString('base64');
      const script = `
const { chromium } = require('playwright');
(async () => {
  const cfg = JSON.parse(Buffer.from(process.env.LA_BROWSE_REQ, 'base64').toString('utf8'));
  const ctx = await chromium.launchPersistentContext(cfg.profile, {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const log = [];
  try {
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    log.push('navigate ' + cfg.url);
    for (const a of cfg.actions || []) {
      if (a.type === 'navigate' && a.url) { await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 25000 }); log.push('navigate ' + a.url); }
      else if (a.type === 'click' && a.selector) { await page.click(a.selector, { timeout: 10000 }); log.push('click ' + a.selector); }
      else if ((a.type === 'fill' || a.type === 'type') && a.selector) {
        const isPw = await page.locator(a.selector).first().evaluate((el) => (el.type || '').toLowerCase() === 'password').catch(() => false);
        if (isPw) throw new Error('Password field detected: ask the user to take over to sign in.');
        await page.fill(a.selector, String(a.value ?? a.text ?? ''), { timeout: 10000 });
        log.push('type ' + a.selector);
      }
      else if (a.type === 'scroll') { await page.evaluate((dy) => window.scrollBy(0, dy), Number(a.y ?? 500)); log.push('scroll ' + (a.y ?? 500)); }
      else if (a.type === 'press' && a.key) { await page.keyboard.press(a.key); log.push('press ' + a.key); }
      else if (a.type === 'submit' && a.selector) { await page.click(a.selector, { timeout: 10000 }); log.push('submit ' + a.selector); }
      else if (a.type === 'wait') { await page.waitForTimeout(Math.min(5000, Number(a.ms ?? 1000))); log.push('wait'); }
      else if (a.type === 'extract') { log.push('extract'); }
    }
    const title = await page.title().catch(() => '');
    const href = page.url();
    const text = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 12000);
    const loginDetected = await page.locator('input[type="password"]').count().then((n) => n > 0).catch(() => false);
    const png = cfg.screenshot ? (await page.screenshot({ type: 'png' })).toString('base64') : null;
    process.stdout.write(JSON.stringify({ title, href, text, elements: [], log, png, loginDetected }));
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
})().catch((e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
`.trim();
      const res = await docker.exec(
        BROWSER_NAME,
        ['env', `LA_BROWSE_REQ=${payload}`, 'DISPLAY=:99', 'node', '-e', script],
        '/profiles',
        45_000,
      );
      if (res.code !== 0) throw new Error(res.output.trim() || `Browser action failed (exit ${res.code}).`);
      const parsed = JSON.parse(res.output) as { title: string; href: string; text: string; elements: string[]; log: string[]; png: string | null; loginDetected?: boolean };
      return {
        title: parsed.title || '',
        href: parsed.href || url,
        text: parsed.text || '',
        elements: parsed.elements || [],
        log: parsed.log || [],
        png: parsed.png ? Buffer.from(parsed.png, 'base64') : null,
        loginDetected: Boolean(parsed.loginDetected),
      };
    },
  };
}

export class ManagedBrowser {
  private lease: Lease | null = null;
  private starting: Promise<void> | null = null;
  private lastUsed = 0;
  private activeTabs = 0;
  private activePersona: string | null = null;
  private activeRunId: string | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly driver: CdpDriver;

  constructor(
    private readonly docker: DockerCtl,
    private readonly dataDir: string,
    private readonly memory: () => MemoryBudget | null,
    private readonly hostPath: (p: string) => string = (p) => p,
    driver?: CdpDriver,
  ) {
    this.driver = driver ?? dockerCdpDriver(docker);
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
        const usage = await memory.usage();
        const reserve = 2 * GiB;
        if (usage.usedBytes + BROWSER_MEMORY_BYTES > usage.budgetBytes || BROWSER_MEMORY_BYTES > Math.max(0, usage.systemAvailable - reserve)) {
          throw new Error('Browser refused: not enough free memory for its 2 GB lease.');
        }
        this.lease = await memory.admit({ kind: 'background', label: 'browser', bytes: BROWSER_MEMORY_BYTES, maxWaitMs: ADMIT_WAIT_MS() });
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
        network: null,
        HostConfig: {
          Memory: BROWSER_MEMORY_BYTES,
          NanoCpus: 2_000_000_000,
          PidsLimit: 256,
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
    try {
      const raw = await this.driver.runTab({
        profileDir,
        url: input.url,
        actions,
        screenshot: Boolean(input.screenshot) || actions.some((a) => a.type === 'screenshot'),
        signal: input.signal,
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
      this.activeTabs = Math.max(0, this.activeTabs - 1);
      if (this.activeTabs === 0) {
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
    const base = {
      enabled: realBrowserEnabled(),
      image: IMAGE(),
      memoryLimitBytes: BROWSER_MEMORY_BYTES,
      lastUsedAt: this.lastUsed ? new Date(this.lastUsed).toISOString() : null,
      activePersona: this.activePersona,
      activeRunId: this.activeRunId,
    };
    if (!this.docker.available()) return { ...base, state: 'unavailable', memoryBytes: null };
    const state = await this.docker.containerState(BROWSER_NAME).catch(() => null);
    if (!state) return { ...base, state: 'missing', memoryBytes: null };
    if (state.state !== 'running') return { ...base, state: 'stopped', memoryBytes: null };
    const stats = await this.docker.stats?.(BROWSER_NAME).catch(() => null);
    return { ...base, state: this.activeTabs > 0 ? 'running' : 'idle', memoryBytes: stats?.memoryBytes ?? null };
  }
}
