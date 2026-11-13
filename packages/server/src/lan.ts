import os from 'node:os';

/** Interface name prefixes that are not the home LAN. */
const SKIP_INTERFACE = /^(tailscale|docker|br-|veth|cni|flannel|virbr|zt)/i;

export interface NetAddress {
  name: string;
  address: string;
  internal?: boolean;
}

export function normalizeIp(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (mapped.includes('.')) return mapped;
  }
  return value;
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * True for loopback, RFC1918, and IPv4/IPv6 link-local.
 * Tailscale (100.64.0.0/10) and public addresses are false unless listed in allow.
 */
export function isLanAddress(input: string, allow: string[] = []): boolean {
  const ip = normalizeIp(input);
  if (!ip) return false;
  if (allow.some((entry) => matchesEntry(ip, entry))) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.includes('.')) return isPrivateIpv4(ip);
  return isLinkLocalIpv6(ip);
}

export function setupBindAddresses(ifaces: NetAddress[]): string[] {
  const found = new Set<string>(['127.0.0.1']);
  for (const iface of ifaces) {
    if (SKIP_INTERFACE.test(iface.name)) continue;
    const ip = normalizeIp(iface.address);
    if (!ip || ip === '::1') continue;
    if (isLanAddress(ip)) found.add(ip);
  }
  return [...found];
}

export function interfacesFromOs(): NetAddress[] {
  const nets = os.networkInterfaces();
  const out: NetAddress[] = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      const family = String(addr.family);
      if (family !== 'IPv4' && family !== 'IPv6' && family !== '4' && family !== '6') continue;
      out.push({ name, address: addr.address, internal: addr.internal });
    }
  }
  return out;
}

export function preferredLanUrl(addresses: string[], port: number): string {
  const lan = addresses.find((address) => {
    const ip = normalizeIp(address);
    return Boolean(ip && ip.includes('.') && ip !== '127.0.0.1' && isPrivateIpv4(ip));
  });
  return `http://${lan || '127.0.0.1'}:${port}`;
}

function matchesEntry(ip: string, entry: string): boolean {
  const rule = entry.trim().toLowerCase();
  if (!rule) return false;
  if (rule.includes('/')) return inCidr(ip, rule);
  return normalizeIp(rule) === ip;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLinkLocalIpv6(ip: string): boolean {
  if (!ip.includes(':')) return false;
  const halves = ip.split('::');
  if (halves.length > 2) return false;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  if (halves.length === 1 && head.length !== 8) return false;
  const first = Number.parseInt(head[0] || '0', 16);
  if (!Number.isFinite(first)) return false;
  return (first & 0xffc0) === 0xfe80;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!base || !Number.isInteger(bits)) return false;
  if (ip.includes('.') && base.includes('.')) {
    if (bits < 0 || bits > 32) return false;
    const left = ipv4Int(ip);
    const right = ipv4Int(base);
    if (left == null || right == null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return (left & mask) === (right & mask);
  }
  return false;
}

function ipv4Int(ip: string): number | null {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}
