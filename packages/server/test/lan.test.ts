import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isLanAddress, setupBindAddresses } from '../src/lan.js';
import { buildSetupApp } from '../src/setup-site.js';
import { consumeSetupToken, ensureSetupToken, setupTokenValid } from '../src/setup-token.js';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-lan-'));
  dirs.push(dir);
  return dir;
}

describe('LAN address guard', () => {
  const allowed = [
    '127.0.0.1',
    '::1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.12.1',
    '::ffff:192.168.1.9',
    'fe80::1',
    'fe80::1%eth0',
  ];
  const refused = [
    '8.8.8.8',
    '1.1.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '100.128.0.1',
    '172.15.5.5',
    '172.32.0.1',
    '::ffff:100.64.0.2',
    '2001:db8::1',
    '',
  ];

  it('allows RFC1918, link-local, and loopback, and refuses Tailscale and public addresses', () => {
    for (const ip of allowed) expect(isLanAddress(ip), ip).toBe(true);
    for (const ip of refused) expect(isLanAddress(ip), ip).toBe(false);
  });

  it('accepts an extra address only when the allowlist names it', () => {
    expect(isLanAddress('8.8.8.8', ['8.8.8.8'])).toBe(true);
    expect(isLanAddress('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(isLanAddress('203.0.113.9', [])).toBe(false);
    expect(isLanAddress('100.64.0.8', ['192.168.1.0/24'])).toBe(false);
  });

  it('binds loopback and LAN interfaces, not Tailscale or docker', () => {
    const bound = setupBindAddresses([
      { name: 'lo', address: '127.0.0.1', internal: true },
      { name: 'eth0', address: '192.168.1.20' },
      { name: 'eth0', address: '172.16.5.5' },
      { name: 'eth0', address: '8.8.8.8' },
      { name: 'tailscale0', address: '100.64.0.5' },
      { name: 'docker0', address: '172.17.0.1' },
    ]);
    expect(bound).toContain('127.0.0.1');
    expect(bound).toContain('192.168.1.20');
    expect(bound).toContain('172.16.5.5');
    expect(bound).not.toContain('100.64.0.5');
    expect(bound).not.toContain('172.17.0.1');
    expect(bound).not.toContain('8.8.8.8');
  });

  it('refuses the setup site from Tailscale or a public address, including a spoofed forwarded header', async () => {
    const dir = tmp();
    const { app, store, vault, config } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await buildSetupApp({ dataDir: dir, store, vault, cookieSecret: config.cookieSecret, allow: [] });
    const tailscale = await setup.inject({ method: 'GET', url: '/api/setup/state', remoteAddress: '100.64.8.8' });
    expect(tailscale.statusCode).toBe(403);
    const spoofed = await setup.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '8.8.8.8',
      headers: { 'x-forwarded-for': '192.168.1.20' },
    });
    expect(spoofed.statusCode).toBe(403);
    const lan = await setup.inject({ method: 'GET', url: '/api/setup/state', remoteAddress: '192.168.1.20' });
    expect(lan.statusCode).toBe(200);
    expect(lan.json().needsOwner).toBe(true);

    const issued = ensureSetupToken(dir);
    expect(issued.value).toBeTruthy();
    const denied = await setup.inject({
      method: 'POST',
      url: '/api/setup/owner',
      remoteAddress: '100.100.1.1',
      payload: { token: issued.value, username: 'owner', password: 'a-real-password' },
    });
    expect(denied.statusCode).toBe(403);
    expect(store.getOwner()).toBeNull();

    const created = await setup.inject({
      method: 'POST',
      url: '/api/setup/owner',
      remoteAddress: '10.0.0.8',
      payload: { token: issued.value, username: 'owner', password: 'a-real-password' },
    });
    expect(created.statusCode).toBe(200);
    expect(setupTokenValid(dir, issued.value!)).toBe(false);
    const replay = await setup.inject({
      method: 'POST',
      url: '/api/setup/owner',
      remoteAddress: '10.0.0.8',
      payload: { token: issued.value, username: 'other', password: 'a-real-password' },
    });
    expect(replay.statusCode).toBe(409);

    const cookie = created.cookies.find((item) => item.name === 'la_session')?.value;
    const saved = await setup.inject({
      method: 'POST',
      url: '/api/setup/secret',
      remoteAddress: '10.0.0.8',
      cookies: { la_session: cookie! },
      payload: { key: 'GEMINI_API_KEY', value: 'local-test-key' },
    });
    expect(saved.statusCode).toBe(200);
    const state = await setup.inject({
      method: 'GET',
      url: '/api/setup/state',
      remoteAddress: '10.0.0.8',
      cookies: { la_session: cookie! },
    });
    expect(state.statusCode).toBe(200);
    expect(JSON.stringify(state.json())).not.toContain('local-test-key');
    expect(state.json().secrets.find((item: { key: string }) => item.key === 'GEMINI_API_KEY').set).toBe(true);

    const calls: string[] = [];
    const fetching = (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const testing = await buildSetupApp({ dataDir: dir, store, vault, cookieSecret: config.cookieSecret, fetchImpl: fetching });
    const probed = await testing.inject({
      method: 'POST',
      url: '/api/setup/test',
      remoteAddress: '192.168.0.4',
      cookies: { la_session: cookie! },
      payload: { kind: 'gemini' },
    });
    expect(probed.statusCode).toBe(200);
    expect(probed.json().ok).toBe(true);
    expect(calls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(calls[0]).not.toContain('local-test-key');
    await testing.close();
    await setup.close();
    await app.close();
  });

  it('consumes a token only once', () => {
    const dir = tmp();
    const first = ensureSetupToken(dir);
    const second = ensureSetupToken(dir);
    expect(second.reveal).toBe(false);
    expect(setupTokenValid(dir, first.value!)).toBe(true);
    expect(setupTokenValid(dir, 'not-the-token')).toBe(false);
    consumeSetupToken(dir);
    expect(setupTokenValid(dir, first.value!)).toBe(false);
  });
});
