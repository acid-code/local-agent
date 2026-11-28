import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { inDockerContainer, type DockerCtl } from './docker.js';
import type { Vault } from './vault.js';
import { WORKBENCH_NAME } from './workbench.js';

export const VPN_CONTAINER = 'la-vpn';
export const VPN_IMAGE = 'qmcgaw/gluetun:v3';
export const VPN_NETWORK = 'la-vpn-net';
export const VPN_HTTP_PORT = 8888;

const VPN_SCOPE = 'vpn';
const KEY_MODE = 'LA_VPN_MODE';
const KEY_WG_CONF = 'LA_VPN_WG_CONF';
const KEY_PROXY_URL = 'LA_VPN_PROXY_URL';

export type VpnMode = 'wireguard' | 'proxy';

export interface ParsedWireGuardConf {
  privateKey: string;
  addresses: string;
  dns: string | null;
  mtu: number | null;
  publicKey: string;
  presharedKey: string | null;
  endpointIp: string;
  endpointPort: number;
}

export interface VpnStatus {
  configured: boolean;
  mode: VpnMode | null;
  running: boolean;
  proxyReady: boolean;
  ip: string | null;
  country: string | null;
  org: string | null;
  error: string | null;
}

function splitEndpoint(raw: string): { host: string; port: number } {
  const value = raw.trim();
  let host = '';
  let portStr = '';
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) throw new Error('Invalid WireGuard Peer Endpoint.');
    host = value.slice(1, close).trim();
    const rest = value.slice(close + 1).trim();
    if (!rest.startsWith(':')) throw new Error('WireGuard Peer Endpoint must include :port.');
    portStr = rest.slice(1).trim();
  } else {
    const colon = value.lastIndexOf(':');
    if (colon <= 0) throw new Error('WireGuard Peer Endpoint must include host:port.');
    host = value.slice(0, colon).trim();
    portStr = value.slice(colon + 1).trim();
  }
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WireGuard Peer Endpoint has an invalid host or port.');
  }
  return { host, port };
}

/** Parse and validate a standard WireGuard `.conf` ([Interface] + [Peer]). */
export function parseWireGuardConf(raw: string): ParsedWireGuardConf {
  if (!raw || !raw.trim()) throw new Error('WireGuard configuration is empty.');
  let section: 'interface' | 'peer' | null = null;
  const iface = new Map<string, string>();
  const peer = new Map<string, string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const noComment = rawLine.replace(/[;#].*$/, '').trim();
    if (!noComment) continue;
    const secMatch = /^\[([A-Za-z0-9_]+)\]$/.exec(noComment);
    if (secMatch) {
      const name = secMatch[1]!.toLowerCase();
      section = name === 'interface' ? 'interface' : name === 'peer' ? 'peer' : null;
      continue;
    }
    const eq = noComment.indexOf('=');
    if (eq <= 0 || !section) continue;
    const k = noComment.slice(0, eq).trim().toLowerCase();
    const v = noComment.slice(eq + 1).trim();
    if (section === 'interface') iface.set(k, v);
    else if (section === 'peer') peer.set(k, v);
  }

  const privateKey = (iface.get('privatekey') ?? '').trim();
  const addresses = (iface.get('address') ?? '').split(',').map((s) => s.trim()).filter(Boolean).join(',');
  const dnsRaw = (iface.get('dns') ?? '').trim() || null;
  const mtuRaw = (iface.get('mtu') ?? '').trim();
  const mtuNum = mtuRaw ? Number(mtuRaw) : null;
  const mtu = mtuNum !== null && Number.isInteger(mtuNum) && mtuNum > 0 ? mtuNum : null;
  const publicKey = (peer.get('publickey') ?? '').trim();
  const presharedKey = (peer.get('presharedkey') ?? '').trim() || null;
  const endpointRaw = (peer.get('endpoint') ?? '').trim();

  if (!privateKey) throw new Error('WireGuard config missing [Interface] PrivateKey.');
  if (!addresses) throw new Error('WireGuard config missing [Interface] Address.');
  if (!publicKey) throw new Error('WireGuard config missing [Peer] PublicKey.');
  if (!endpointRaw) throw new Error('WireGuard config missing [Peer] Endpoint.');

  const { host, port } = splitEndpoint(endpointRaw);
  return {
    privateKey,
    addresses,
    dns: dnsRaw,
    mtu,
    publicKey,
    presharedKey,
    endpointIp: host,
    endpointPort: port,
  };
}

/** Prefer IPv4 interface CIDRs for Gluetun so dual-stack configs (like WARP) work on IPv4-only Docker bridges. */
export function wireGuardIpv4Addresses(addresses: string): string {
  const parts = addresses.split(',').map((s) => s.trim()).filter(Boolean);
  const v4 = parts.filter((cidr) => net.isIP(cidr.split('/')[0] ?? '') === 4);
  return v4.length ? v4.join(',') : parts.join(',');
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Reject loopback, link-local, RFC1918, ULA, and internal service hostnames (SSRF defense). */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const clean = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!clean) return true;
  if (
    clean === 'localhost'
    || clean === 'host.docker.internal'
    || clean === 'searxng'
    || clean === 'local-agent'
    || clean === 'local-agent-searxng'
    || clean === 'la-vpn'
    || clean === 'la-workbench'
    || clean.endsWith('.local')
    || clean.endsWith('.localhost')
    || clean.endsWith('.internal')
    || clean.endsWith('.home.arpa')
  ) {
    return true;
  }
  const ipVer = net.isIP(clean);
  if (ipVer === 4) return isPrivateIpv4(clean);
  if (ipVer === 6) {
    if (clean === '::' || clean === '::1' || clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
      return true;
    }
    const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
    if (v4Mapped) return isPrivateIpv4(v4Mapped[1]!);
  }
  return false;
}

function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed.');
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error(`Refusing to route private or internal host "${url.hostname}" through the VPN tool.`);
  }
  return url;
}

export interface ProxyFetchResult {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
}

function stripHtmlSummary(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildProxyAuthHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`;
}

function connectHttpTunnel(proxy: URL, target: URL, timeoutMs: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
    const proxyAuth = buildProxyAuthHeader(proxy);
    const headers: Record<string, string> = {
      Host: `${target.hostname}:${targetPort}`,
    };
    if (proxyAuth) headers['Proxy-Authorization'] = proxyAuth;

    const req = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`Proxy CONNECT timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy(new Error('Aborted.'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    req.on('connect', (res, socket) => {
      cleanup();
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT returned HTTP ${res.statusCode}.`));
        return;
      }
      resolve(socket);
    });

    req.on('error', (err) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.end();
  });
}

function upgradeTlsSocket(rawSocket: net.Socket, servername: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({ socket: rawSocket, servername });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      tlsSock.destroy();
      reject(new Error('TLS handshake over VPN proxy timed out.'));
    }, timeoutMs);
    tlsSock.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tlsSock);
    });
    tlsSock.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function singleProxyFetch(
  proxy: URL,
  target: URL,
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<{ status: number; location: string | null; contentType: string; body: string }> {
  return new Promise(async (resolve, reject) => {
    let tunnelSock: net.Socket | tls.TLSSocket | null = null;
    try {
      const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
      const proxyAuth = buildProxyAuthHeader(proxy);
      const isHttps = target.protocol === 'https:';

      let req: http.ClientRequest;
      if (isHttps) {
        const raw = await connectHttpTunnel(proxy, target, opts.timeoutMs, opts.signal);
        const tlsSock = await upgradeTlsSocket(raw, target.hostname, opts.timeoutMs);
        tunnelSock = tlsSock;
        // Do not pass agent: false — Node's http.request ignores createConnection when agent is false.
        req = http.request({
          createConnection: () => tlsSock,
          hostname: target.hostname,
          port: Number(target.port || 443),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            Host: target.host,
            'User-Agent': 'local-agent/1.0',
            Accept: 'text/html,application/json,text/plain,*/*',
            'Accept-Encoding': 'identity',
            Connection: 'close',
          },
        });
      } else {
        const headers: Record<string, string> = {
          Host: target.host,
          'User-Agent': 'local-agent/1.0',
          Accept: 'text/html,application/json,text/plain,*/*',
          'Accept-Encoding': 'identity',
          Connection: 'close',
        };
        if (proxyAuth) headers['Proxy-Authorization'] = proxyAuth;
        req = http.request({
          host: proxy.hostname,
          port: proxyPort,
          path: target.toString(),
          method: 'GET',
          headers,
        });
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy(new Error(`VPN request timed out after ${opts.timeoutMs}ms.`));
      }, opts.timeoutMs);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy(new Error('Aborted.'));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };

      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          const remaining = opts.maxBytes - totalBytes;
          if (remaining <= 0) {
            res.destroy();
            return;
          }
          const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(slice);
          totalBytes += slice.length;
          if (totalBytes >= opts.maxBytes) res.destroy();
        });
        const finish = () => {
          cleanup();
          if (settled) return;
          settled = true;
          const locHeader = res.headers.location;
          const location = Array.isArray(locHeader) ? (locHeader[0] ?? null) : (locHeader ?? null);
          const ctHeader = res.headers['content-type'];
          const contentType = Array.isArray(ctHeader) ? (ctHeader[0] ?? '') : (ctHeader ?? '');
          resolve({
            status: res.statusCode ?? 0,
            location,
            contentType,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        };
        res.once('end', finish);
        res.once('close', finish);
        res.once('error', (err) => {
          cleanup();
          if (settled) return;
          settled = true;
          reject(err);
        });
      });

      req.on('error', (err) => {
        cleanup();
        tunnelSock?.destroy();
        if (settled) return;
        settled = true;
        reject(err);
      });

      req.end();
    } catch (err) {
      tunnelSock?.destroy();
      reject(err);
    }
  });
}

/** Fetch a public URL over an HTTP proxy using built-in Node http/tls (no shell or external proxy deps). */
export async function fetchViaHttpProxy(
  proxyUrl: string,
  targetUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<ProxyFetchResult> {
  const proxy = new URL(proxyUrl);
  let current = assertPublicHttpUrl(targetUrl);
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const maxBytes = opts?.maxBytes ?? 128 * 1024;

  for (let hop = 0; hop <= 3; hop += 1) {
    const res = await singleProxyFetch(proxy, current, { timeoutMs, maxBytes, signal: opts?.signal });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location && hop < 3) {
      current = assertPublicHttpUrl(new URL(res.location, current).toString());
      continue;
    }
    return {
      status: res.status,
      contentType: res.contentType,
      body: res.body,
      finalUrl: current.toString(),
    };
  }
  throw new Error('Too many redirects via VPN proxy.');
}

function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export class VpnManager {
  constructor(private readonly docker: DockerCtl, private readonly vault: Vault) {}

  private storedMode(): VpnMode | null {
    const mode = this.vault.readScoped(KEY_MODE, VPN_SCOPE);
    return mode === 'wireguard' || mode === 'proxy' ? mode : null;
  }

  /** Fast synchronous check used when building tool menus so unconfigured VPN isn't advertised. */
  isConfigured(): boolean {
    return this.storedMode() !== null;
  }

  async saveWireGuard(conf: string, actor: string): Promise<VpnStatus> {
    parseWireGuardConf(conf);
    this.vault.put({ name: KEY_WG_CONF, value: conf.trim(), scope: VPN_SCOPE, actor });
    this.vault.put({ name: KEY_MODE, value: 'wireguard', scope: VPN_SCOPE, actor });
    await this.start();
    return this.status(true);
  }

  async connectSaved(): Promise<VpnStatus> {
    const mode = this.storedMode();
    if (mode === 'wireguard') {
      await this.start();
      return this.status(true);
    }
    if (mode === 'proxy') return this.status(true);
    throw new Error('No VPN configuration is saved yet.');
  }

  async saveProxy(proxyUrl: string, actor: string): Promise<VpnStatus> {
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl.trim());
    } catch {
      throw new Error('Invalid proxy URL (expected http://host:port).');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Proxy URL must use http:// or https://.');
    }
    const cleanHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (inDockerContainer() && (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1')) {
      throw new Error('Inside Docker, use host.docker.internal or a reachable LAN/remote proxy IP instead of localhost.');
    }
    await this.stop().catch(() => undefined);
    this.vault.put({ name: KEY_PROXY_URL, value: parsed.toString(), scope: VPN_SCOPE, actor });
    this.vault.put({ name: KEY_MODE, value: 'proxy', scope: VPN_SCOPE, actor });
    return this.status(true);
  }

  async start(): Promise<void> {
    if (!this.docker.available()) throw new Error('Docker is not available to start the isolated VPN container.');
    const conf = this.vault.readScoped(KEY_WG_CONF, VPN_SCOPE);
    if (!conf) throw new Error('No WireGuard config saved.');
    const parsed = parseWireGuardConf(conf);

    let endpointIp = parsed.endpointIp;
    if (net.isIP(endpointIp) === 0) {
      const resolved = await dns.lookup(endpointIp, { family: 4 });
      endpointIp = resolved.address;
    }

    const netOk = await this.docker.ensureNetwork(VPN_NETWORK);
    if (!netOk) throw new Error(`Could not create Docker network ${VPN_NETWORK}.`);

    if (!(await this.docker.hasImage(VPN_IMAGE))) {
      await this.docker.pull(VPN_IMAGE);
    }

    const env = [
      'VPN_SERVICE_PROVIDER=custom',
      'VPN_TYPE=wireguard',
      `WIREGUARD_PRIVATE_KEY=${parsed.privateKey}`,
      `WIREGUARD_ADDRESSES=${wireGuardIpv4Addresses(parsed.addresses)}`,
      `WIREGUARD_PUBLIC_KEY=${parsed.publicKey}`,
      `WIREGUARD_ENDPOINT_IP=${endpointIp}`,
      `WIREGUARD_ENDPOINT_PORT=${parsed.endpointPort}`,
      'HTTPPROXY=on',
      `HTTPPROXY_LISTENING_ADDRESS=:${VPN_HTTP_PORT}`,
      'SHADOWSOCKS=off',
      'FIREWALL_OUTBOUND_SUBNETS=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8',
      'TZ=UTC',
    ];
    if (parsed.mtu) env.push(`WIREGUARD_MTU=${parsed.mtu}`);
    if (parsed.presharedKey) env.push(`WIREGUARD_PRESHARED_KEY=${parsed.presharedKey}`);

    await this.docker.startDetached({
      name: VPN_CONTAINER,
      Image: VPN_IMAGE,
      Labels: { 'com.local-agent.role': 'tool', 'local-agent.role': 'vpn' },
      Env: env,
      network: VPN_NETWORK,
      replace: true,
      HostConfig: {
        CapAdd: ['NET_ADMIN'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });

    if (inDockerContainer()) {
      await this.docker.connectToNetwork(os.hostname(), VPN_NETWORK);
    }
    const wbState = await this.docker.containerState(WORKBENCH_NAME).catch(() => null);
    if (wbState?.state === 'running') {
      await this.docker.connectToNetwork(WORKBENCH_NAME, VPN_NETWORK);
    }

    // Give Gluetun a short moment to bring up WireGuard and the :8888 HTTP proxy.
    for (let i = 0; i < 10; i += 1) {
      if (await probeTcp(VPN_CONTAINER, VPN_HTTP_PORT, 500)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async stop(): Promise<void> {
    if (!this.docker.available()) return;
    await this.docker.stop(VPN_CONTAINER).catch(() => undefined);
    const state = await this.docker.containerState(VPN_CONTAINER).catch(() => null);
    if (state) {
      await this.docker.remove(VPN_CONTAINER).catch(() => undefined);
    }
  }

  async clear(actor: string): Promise<void> {
    await this.stop().catch(() => undefined);
    this.vault.clearScoped(KEY_MODE, VPN_SCOPE, actor);
    this.vault.clearScoped(KEY_WG_CONF, VPN_SCOPE, actor);
    this.vault.clearScoped(KEY_PROXY_URL, VPN_SCOPE, actor);
  }

  async proxyUrlFor(target: 'server' | 'workbench'): Promise<string | null> {
    const mode = this.storedMode();
    if (mode === 'proxy') {
      return this.vault.readScoped(KEY_PROXY_URL, VPN_SCOPE);
    }
    if (mode === 'wireguard') {
      if (!this.docker.available()) return null;
      const state = await this.docker.containerState(VPN_CONTAINER).catch(() => null);
      if (!state || state.state !== 'running') return null;
      if (target === 'server' && inDockerContainer()) {
        await this.docker.connectToNetwork(os.hostname(), VPN_NETWORK);
      } else if (target === 'workbench') {
        await this.docker.connectToNetwork(WORKBENCH_NAME, VPN_NETWORK);
      }
      return `http://${VPN_CONTAINER}:${VPN_HTTP_PORT}`;
    }
    return null;
  }

  async status(checkIp = false): Promise<VpnStatus> {
    const mode = this.storedMode();
    if (!mode) {
      return { configured: false, mode: null, running: false, proxyReady: false, ip: null, country: null, org: null, error: null };
    }
    if (mode === 'proxy') {
      const proxyUrl = this.vault.readScoped(KEY_PROXY_URL, VPN_SCOPE);
      if (!proxyUrl) {
        return { configured: false, mode: null, running: false, proxyReady: false, ip: null, country: null, org: null, error: null };
      }
      if (!checkIp) {
        return { configured: true, mode, running: true, proxyReady: true, ip: null, country: null, org: null, error: null };
      }
      try {
        const res = await fetchViaHttpProxy(proxyUrl, 'https://ipinfo.io/json', { timeoutMs: 8000, maxBytes: 16 * 1024 });
        const info = JSON.parse(res.body) as { ip?: string; country?: string; org?: string };
        return {
          configured: true,
          mode,
          running: true,
          proxyReady: true,
          ip: info.ip ?? null,
          country: info.country ?? null,
          org: info.org ?? null,
          error: null,
        };
      } catch (err) {
        return {
          configured: true,
          mode,
          running: true,
          proxyReady: false,
          ip: null,
          country: null,
          org: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const state = this.docker.available() ? await this.docker.containerState(VPN_CONTAINER).catch(() => null) : null;
    const running = state?.state === 'running';
    if (!running) {
      return {
        configured: true,
        mode,
        running: false,
        proxyReady: false,
        ip: null,
        country: null,
        org: null,
        error: state ? `Container state: ${state.state}` : null,
      };
    }

    const proxyUrl = await this.proxyUrlFor('server');
    if (!proxyUrl) {
      return { configured: true, mode, running: true, proxyReady: false, ip: null, country: null, org: null, error: null };
    }
    const reachable = await probeTcp(VPN_CONTAINER, VPN_HTTP_PORT, 1500);
    if (!reachable) {
      return {
        configured: true,
        mode,
        running: true,
        proxyReady: false,
        ip: null,
        country: null,
        org: null,
        error: 'VPN proxy is still starting up (or tunnel handshake failed).',
      };
    }
    if (!checkIp) {
      return { configured: true, mode, running: true, proxyReady: true, ip: null, country: null, org: null, error: null };
    }
    try {
      const res = await fetchViaHttpProxy(proxyUrl, 'https://ipinfo.io/json', { timeoutMs: 10_000, maxBytes: 16 * 1024 });
      const info = JSON.parse(res.body) as { ip?: string; country?: string; org?: string };
      return {
        configured: true,
        mode,
        running: true,
        proxyReady: true,
        ip: info.ip ?? null,
        country: info.country ?? null,
        org: info.org ?? null,
        error: null,
      };
    } catch (err) {
      return {
        configured: true,
        mode,
        running: true,
        proxyReady: true,
        ip: null,
        country: null,
        org: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async fetch(url: string, signal?: AbortSignal): Promise<string> {
    const proxyUrl = await this.proxyUrlFor('server');
    if (!proxyUrl) {
      throw new Error('VPN is not connected. Configure a WireGuard config or HTTP proxy in Settings → VPN first.');
    }
    const res = await fetchViaHttpProxy(proxyUrl, url, { timeoutMs: 20_000, maxBytes: 128 * 1024, signal });
    const clean = /html/i.test(res.contentType) ? stripHtmlSummary(res.body) : res.body;
    return `HTTP ${res.status} (${res.finalUrl})\n\n${clean.slice(0, 16_000)}`;
  }
}
