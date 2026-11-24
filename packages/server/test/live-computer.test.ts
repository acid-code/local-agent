import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { ManagedBrowser } from '../src/browser.js';
import { Bus } from '../src/bus.js';
import { Store } from '../src/db.js';
import { DockerCtl } from '../src/docker.js';
import { ComputerControl } from '../src/live-computer.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('live computer panel and proxy auth', () => {
  it('rejects unauthenticated requests, allows SAMEORIGIN novnc viewer, and serves 1h last-screen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-comp-'));
    dirs.push(dir);
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    try {
      // Create owner account so auth is active.
      const setup = await built.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'asaf', password: 'password1234' },
      });
      expect(setup.statusCode).toBe(200);
      const ownerCookie = setup.headers['set-cookie'];
      const ownerHeader = Array.isArray(ownerCookie) ? ownerCookie[0]! : String(ownerCookie);

      // Unauthenticated -> 401 (no token, no stream / no state).
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/state' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/last-screen' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/novnc/viewer.html' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'POST', url: '/api/computer/takeover' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'POST', url: '/api/computer/giveback' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/shell-tail' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/vnc' })).statusCode).toBe(401);

      // Authenticated owner -> 200; viewer.html allows SAMEORIGIN iframe without crossorigin attribute, state stays DENY.
      const okState = await built.app.inject({
        method: 'GET',
        url: '/api/computer/state',
        headers: { cookie: ownerHeader },
      });
      expect(okState.statusCode).toBe(200);
      expect(okState.headers['x-frame-options']).toBe('DENY');
      expect(okState.json().takenOver).toBe(false);
      expect(okState.json().lastScreen).toBeNull();
      expect(okState.json().browseSteps).toEqual([]);

      const viewerRes = await built.app.inject({
        method: 'GET',
        url: '/api/computer/novnc/viewer.html?path=api/computer/vnc&view_only=0',
        headers: { cookie: ownerHeader },
      });
      expect(viewerRes.statusCode).toBe(200);
      expect(viewerRes.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(viewerRes.body).not.toMatch(/crossorigin=/i);
      expect(viewerRes.body).toMatch(/scaleViewport\s*=\s*true/);

      // Last screen: 404 before any screen, 200 within 1h, and expired -> 404 when > 1h old.
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/last-screen', headers: { cookie: ownerHeader } })).statusCode).toBe(404);
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      built.computer.recordScreen({ png: fakePng, url: 'https://example.com', title: 'Example', persona: 'Assistant', runId: 'r1' });
      const shotRes = await built.app.inject({ method: 'GET', url: '/api/computer/last-screen', headers: { cookie: ownerHeader } });
      expect(shotRes.statusCode).toBe(200);
      expect(shotRes.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(shotRes.rawPayload, fakePng)).toBe(0);

      const stateWithShot = (await built.app.inject({ method: 'GET', url: '/api/computer/state', headers: { cookie: ownerHeader } })).json();
      expect(stateWithShot.lastScreen).toMatchObject({ available: true, url: 'https://example.com', title: 'Example' });

      // Simulate > 1 hour elapsed on disk
      const staleAt = new Date(Date.now() - 61 * 60_000).toISOString();
      built.computer.recordScreen({ png: fakePng, url: 'https://stale.example', title: 'Stale', persona: 'Assistant', runId: 'r1', at: staleAt });
      const staleTime = new Date(Date.now() - 61 * 60_000);
      fs.utimesSync(path.join(dir, 'browser', '.last-screen.png'), staleTime, staleTime);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/last-screen', headers: { cookie: ownerHeader } })).statusCode).toBe(404);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/state', headers: { cookie: ownerHeader } })).json().lastScreen).toBeNull();

      // Member account -> 403 across endpoints.
      const createMem = await built.app.inject({
        method: 'POST',
        url: '/api/members',
        headers: { cookie: ownerHeader },
        payload: { username: 'guest', displayName: 'Guest', password: 'guestpassword1' },
      });
      expect(createMem.statusCode).toBe(200);
      const memLogin = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'guest', password: 'guestpassword1' },
      });
      expect(memLogin.statusCode).toBe(200);
      const memCookie = memLogin.headers['set-cookie'];
      const memHeader = Array.isArray(memCookie) ? memCookie[0]! : String(memCookie);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/state', headers: { cookie: memHeader } })).statusCode).toBe(403);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/last-screen', headers: { cookie: memHeader } })).statusCode).toBe(403);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/novnc/viewer.html', headers: { cookie: memHeader } })).statusCode).toBe(403);
    } finally {
      await built.app.close();
    }
  });

  it('records live browse steps, hydrates recent steps from SQLite, and keeps browser state running while active run thinks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-comp-steps-'));
    dirs.push(dir);
    const store = new Store(path.join(dir, 'db.sqlite'));
    const bus = new Bus();
    const control = new ComputerControl(bus, { dataDir: dir, store });

    const stepId = control.recordBrowseStart({ runId: 'run_b1', persona: 'Assistant', url: 'https://example.com', actions: ['scroll 300'] });
    expect(control.browseSteps('run_b1')[0]?.status).toBe('running');
    control.finishBrowseStep(stepId, { status: 'completed', title: 'Example Domain', actions: ['navigate https://example.com', 'scroll 300'] });
    expect(control.browseSteps('run_b1')[0]).toMatchObject({ status: 'completed', title: 'Example Domain' });

    // Cold-start hydration from store run_steps
    const agent = store.createAgent({ name: 'SurfAgent', systemPrompt: 'test', toolAllowlist: [], workspacePath: dir });
    const session = store.createSession({ agentId: agent.id, title: 'Surf' });
    const run = store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'tools', turn: 0 } });
    store.addStep({
      runId: run.id, kind: 'tool', name: 'browse', status: 'completed',
      input: { url: 'https://news.ycombinator.com', actions: [{ action: 'scroll', y: 400 }] },
      output: 'ok', toolCallId: 'c1', turn: 0, tokensIn: 0, tokensOut: 0, latencyMs: 100, costUsd: 0, error: null,
      startedAt: new Date().toISOString(),
    });
    const coldControl = new ComputerControl(bus, { dataDir: dir, store });
    const hydrated = coldControl.browseSteps();
    expect(hydrated.some((s) => s.url === 'https://news.ycombinator.com' && s.persona === 'SurfAgent' && s.actions[0] === 'scroll')).toBe(true);

    // ManagedBrowser stays 'running' across LLM pauses while isRunActive(runId) is true
    let runActive = true;
    const fakeDocker = {
      available: () => true,
      containerState: async () => ({ id: 'c1', state: 'running', status: 'Up' }),
      hasImage: async () => true,
      start: async () => undefined,
      startDetached: async () => undefined,
      stop: async () => undefined,
      stats: async () => ({ memoryBytes: 200_000_000 }),
    } as unknown as DockerCtl;
    const browser = new ManagedBrowser(fakeDocker, dir, () => null, (p) => p, {
      async runTab() {
        return { title: 'HN', href: 'https://news.ycombinator.com', text: 'items', elements: [], log: ['navigate'], png: null };
      },
    }, { isRunActive: () => runActive });

    await browser.browse({ personaSlug: 'assistant', runId: run.id, url: 'https://news.ycombinator.com', screenshot: false });
    const midStatus = await browser.status();
    expect(midStatus.state).toBe('running');
    expect(midStatus.activeTabOpen).toBe(false);
    expect(midStatus.lastUrl).toBe('https://news.ycombinator.com');

    runActive = false;
    const endStatus = await browser.status();
    expect(endStatus.state).toBe('idle');
    store.close();
  });

  it('pauses a run on login detection, supports takeOver/giveBack resume, and records per-run shell tail', async () => {
    const bus = new Bus();
    const control = new ComputerControl(bus);

    expect(control.isTakenOver()).toBe(false);
    let resumed = false;
    const waitPromise = control.pauseForLogin('run_login_1', 'Researcher', 'https://example.com/login').then(() => {
      resumed = true;
    });

    expect(control.state().pausedForLogin?.runId).toBe('run_login_1');
    expect(resumed).toBe(false);

    control.takeOver();
    expect(control.isTakenOver()).toBe(true);
    expect(resumed).toBe(false);

    control.giveBack();
    await waitPromise;
    expect(control.isTakenOver()).toBe(false);
    expect(control.state().pausedForLogin).toBeNull();
    expect(resumed).toBe(true);

    control.recordShell({ runId: 'r1', persona: 'Coder', command: 'npm test', output: 'ok', code: 0 });
    control.recordShell({ runId: 'r2', persona: 'Coder', command: 'ls', output: 'a.ts', code: 0 });
    expect(control.shellTail()).toHaveLength(2);
    expect(control.shellTail('r1')).toHaveLength(1);
    expect(control.shellTail('r1')[0]!.command).toBe('npm test');
  });
});
