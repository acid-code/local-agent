import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HASH = 'setup-token.sha256';
const PLAIN = 'setup.token';
const USED = 'setup-token.used';

export function ensureSetupToken(dataDir: string): { reveal: boolean; value: string | null } {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(path.join(dataDir, USED))) return { reveal: false, value: null };
  const plainPath = path.join(dataDir, PLAIN);
  if (fs.existsSync(plainPath)) {
    const value = fs.readFileSync(plainPath, 'utf8').trim();
    fs.writeFileSync(path.join(dataDir, HASH), sha(value), { mode: 0o600 });
    fs.rmSync(plainPath, { force: true });
    return { reveal: true, value };
  }
  if (fs.existsSync(path.join(dataDir, HASH))) return { reveal: false, value: null };
  const value = randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, HASH), sha(value), { mode: 0o600 });
  return { reveal: true, value };
}

export function setupTokenValid(dataDir: string, token: string): boolean {
  if (!token || fs.existsSync(path.join(dataDir, USED))) return false;
  const file = path.join(dataDir, HASH);
  if (!fs.existsSync(file)) return false;
  const expected = Buffer.from(fs.readFileSync(file, 'utf8').trim());
  const actual = Buffer.from(sha(token.trim()));
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function consumeSetupToken(dataDir: string) {
  fs.writeFileSync(path.join(dataDir, USED), new Date().toISOString(), { mode: 0o600 });
  fs.rmSync(path.join(dataDir, HASH), { force: true });
  fs.rmSync(path.join(dataDir, PLAIN), { force: true });
}

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
