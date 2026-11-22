import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { Bus } from '../src/bus.js';
import { ComputerControl } from '../src/live-computer.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('live computer panel and proxy auth', () => {
  it('rejects unauthenticated requests to /api/computer/state, /takeover, /giveback, and /shell-tail (401)', async () => {
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

      // Unauthenticated -> 401 (no token, no stream / no state).
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/state' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'POST', url: '/api/computer/takeover' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'POST', url: '/api/computer/giveback' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/shell-tail' })).statusCode).toBe(401);
      expect((await built.app.inject({ method: 'GET', url: '/api/computer/vnc' })).statusCode).toBe(401);

      // Authenticated owner -> 200.
      const okState = await built.app.inject({
        method: 'GET',
        url: '/api/computer/state',
        headers: { cookie: Array.isArray(ownerCookie) ? ownerCookie[0]! : String(ownerCookie) },
      });
      expect(okState.statusCode).toBe(200);
      expect(okState.json().takenOver).toBe(false);

      // Member account -> 403.
      const createMem = await built.app.inject({
        method: 'POST',
        url: '/api/members',
        headers: { cookie: Array.isArray(ownerCookie) ? ownerCookie[0]! : String(ownerCookie) },
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
      const memState = await built.app.inject({
        method: 'GET',
        url: '/api/computer/state',
        headers: { cookie: Array.isArray(memCookie) ? memCookie[0]! : String(memCookie) },
      });
      expect(memState.statusCode).toBe(403);
    } finally {
      await built.app.close();
    }
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
