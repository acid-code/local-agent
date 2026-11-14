import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from './db.js';
import { OWNER_ID, getAccount, type Account } from './accounts.js';

const scrypt = promisify(scryptCb);
const loginFailures = new Map<string, { count: number; at: number }>();

/** The signed-in account, or null. API tokens belong to the owner. A disabled member is signed out. */
export async function authAccount(store: Store, req: FastifyRequest): Promise<Account | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    const hash = createHash('sha256').update(token).digest('hex');
    const id = store.findToken(hash);
    if (!id) return null;
    store.touchToken(id);
    return getAccount(store, OWNER_ID);
  }
  const raw = req.cookies?.la_session;
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const session = store.getAuthSession(unsigned.value);
  if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
  return getAccount(store, session.accountId);
}

export async function authenticate(store: Store, req: FastifyRequest) {
  const account = await authAccount(store, req);
  if (account) (req as { account?: Account }).account = account;
  return Boolean(account);
}

export function rateLimit(ip: string) {
  const row = loginFailures.get(ip);
  if (!row || Date.now() - row.at > 15 * 60_000) return false;
  return row.count >= 8;
}

export function noteFailure(ip: string) {
  const row = loginFailures.get(ip);
  if (!row || Date.now() - row.at > 15 * 60_000) loginFailures.set(ip, { count: 1, at: Date.now() });
  else row.count += 1;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [, , , , salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const key = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export async function setSession(reply: FastifyReply, store: Store, accountId = OWNER_ID) {
  const id = randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  store.createAuthSession(id, expires, accountId);
  reply.setCookie('la_session', id, { httpOnly: true, sameSite: 'lax', path: '/', signed: true, maxAge: 30 * 86400 });
}
