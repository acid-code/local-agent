import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { loadMasterKey, Vault } from '../src/vault.js';
import { fetchViaHttpProxy, isPrivateOrLocalHost, parseWireGuardConf } from '../src/vpn.js';

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VPN config, SSRF guard, proxy fetch, and vault isolation', () => {
  it('parses valid WireGuard configs with and without PresharedKey', () => {
    const withPsk = parseWireGuardConf(`
      # ProtonVPN / WireGuard config
      [Interface]
      PrivateKey = cHJpdmF0ZWtleWV4YW1wbGUxMjM0NTY3ODkwMTIzNDU2=
      Address = 10.2.0.2/32, fd00::2/128
      DNS = 10.2.0.1

      [Peer]
      PublicKey = cHVibGlja2V5ZXhhbXBsZTEyMzQ1Njc4OTAxMjM0NTY3ODk=
      PresharedKey = cHNrZXhhbXBsZTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=
      Endpoint = 185.159.158.10:51820
      AllowedIPs = 0.0.0.0/0
    `);
    expect(withPsk).toEqual({
      privateKey: 'cHJpdmF0ZWtleWV4YW1wbGUxMjM0NTY3ODkwMTIzNDU2=',
      addresses: '10.2.0.2/32,fd00::2/128',
      dns: '10.2.0.1',
      publicKey: 'cHVibGlja2V5ZXhhbXBsZTEyMzQ1Njc4OTAxMjM0NTY3ODk=',
      presharedKey: 'cHNrZXhhbXBsZTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=',
      endpointIp: '185.159.158.10',
      endpointPort: 51820,
    });

    const withoutPsk = parseWireGuardConf(`
      [Interface]
      PrivateKey = abc=
      Address = 10.64.0.2/32

      [Peer]
      PublicKey = xyz=
      Endpoint = [2001:db8::1]:51820
    `);
    expect(withoutPsk.presharedKey).toBeNull();
    expect(withoutPsk.endpointIp).toBe('2001:db8::1');
    expect(withoutPsk.endpointPort).toBe(51820);
  });

  it('rejects incomplete or invalid WireGuard configs', () => {
    expect(() => parseWireGuardConf('')).toThrow(/empty/i);
    expect(() => parseWireGuardConf('[Interface]\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=a\nEndpoint=1.1.1.1:51820')).toThrow(/PrivateKey/);
    expect(() => parseWireGuardConf('[Interface]\nPrivateKey=a\nAddress=10.0.0.2/32\n[Peer]\nEndpoint=1.1.1.1:51820')).toThrow(/PublicKey/);
    expect(() => parseWireGuardConf('[Interface]\nPrivateKey=a\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=b\nEndpoint=1.1.1.1:99999')).toThrow(/invalid/i);
  });

  it('blocks loopback, private, and internal Docker/LAN hosts for SSRF protection', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.50',
      '169.254.169.254',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'host.docker.internal',
      'searxng',
      'local-agent',
      'la-vpn',
      'printer.local',
      'service.internal',
    ]) {
      expect(isPrivateOrLocalHost(host), host).toBe(true);
    }

    for (const host of ['example.com', 'ipinfo.io', '1.1.1.1', '8.8.8.8', '172.32.0.1', '203.0.113.10']) {
      expect(isPrivateOrLocalHost(host), host).toBe(false);
    }
  });

  it('routes public URLs through HTTP proxy and rejects private URLs', async () => {
    let seenUrl = '';
    let seenProxyAuth = '';
    const proxyServer = http.createServer((req, res) => {
      seenUrl = req.url || '';
      seenProxyAuth = String(req.headers['proxy-authorization'] || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ip: '198.51.100.77', country: 'CH' }));
    });
    servers.push(proxyServer);
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const addr = proxyServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP port');

    const proxyUrl = `http://vpnuser:vpnpass@127.0.0.1:${addr.port}`;
    const result = await fetchViaHttpProxy(proxyUrl, 'http://example.com/status');
    expect(seenUrl).toBe('http://example.com/status');
    expect(seenProxyAuth).toBe(`Basic ${Buffer.from('vpnuser:vpnpass').toString('base64')}`);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ ip: '198.51.100.77', country: 'CH' });

    await expect(fetchViaHttpProxy(proxyUrl, 'http://127.0.0.1:8787/api/health')).rejects.toThrow(/private or internal/i);
    await expect(fetchViaHttpProxy(proxyUrl, 'http://host.docker.internal:8080/v1/models')).rejects.toThrow(/private or internal/i);
  });

  it('isolates scope=vpn secrets in Vault from envFor()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-vpn-vault-'));
    dirs.push(dir);
    const store = new Store(path.join(dir, 'test.db'));
    const vault = new Vault(store, loadMasterKey(dir));

    vault.put({ name: 'GLOBAL_TOKEN', value: 'global_secret_val', scope: 'global', actor: 'owner' });
    vault.put({ name: 'LA_VPN_WG_CONF', value: 'wg_private_key_secret', scope: 'vpn', actor: 'owner' });

    expect(vault.readScoped('LA_VPN_WG_CONF', 'vpn')).toBe('wg_private_key_secret');
    const agentEnv = vault.envFor('agt_test', 'run:1');
    expect(agentEnv.GLOBAL_TOKEN).toBe('global_secret_val');
    expect(agentEnv.LA_VPN_WG_CONF).toBeUndefined();

    vault.clearScoped('LA_VPN_WG_CONF', 'vpn', 'owner');
    expect(vault.readScoped('LA_VPN_WG_CONF', 'vpn')).toBeNull();
    store.close();
  });
});
