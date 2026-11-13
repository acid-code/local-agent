import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  repoRoot: string;
  webDist: string;
  cookieSecret: string;
  instanceId: string;
}

export function repoRootFrom(cwd = process.cwd()): string {
  if (cwd.endsWith(`${path.sep}packages${path.sep}server`)) return path.resolve(cwd, '../..');
  return cwd;
}

const loadedSecrets = new Map<string, string>();

function readSecretFile(dataDir: string): Map<string, string> {
  const file = path.join(dataDir, 'secrets.env');
  const found = new Map<string, string>();
  if (!fs.existsSync(file)) return found;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    found.set(key, trimmed.slice(eq + 1));
  }
  return found;
}

export function captureLoadedSecrets(dataDir: string) {
  loadedSecrets.clear();
  for (const [key, value] of readSecretFile(dataDir)) loadedSecrets.set(key, value);
}

export function noteSecretLoaded(key: string, value: string) {
  loadedSecrets.set(key, value);
}

export function secretDrift(dataDir: string): string[] {
  const file = readSecretFile(dataDir);
  const keys = new Set([...loadedSecrets.keys(), ...file.keys()]);
  return [...keys].filter((key) => (loadedSecrets.get(key) ?? '') !== (file.get(key) ?? '')).sort();
}

export function loadSecrets(dataDir: string) {
  const file = path.join(dataDir, 'secrets.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

export function writeSecret(dataDir: string, key: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Secret names look like GEMINI_API_KEY.');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'secrets.env');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# local-agent secrets. Do not commit.\n';
  const lines = current.split('\n').filter((line) => !line.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  const next = `${lines.filter((line, index) => line || index === 0).join('\n').replace(/\n*$/, '\n')}`;
  fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
  process.env[key] = value;
  noteSecretLoaded(key, value);
}

export function secretNames(dataDir: string): { key: string; set: boolean }[] {
  const known = ['GEMINI_API_KEY', 'OPENROUTER_API_KEY'];
  const file = path.join(dataDir, 'secrets.env');
  const found = new Set(known);
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const key = line.split('=')[0]?.trim();
      if (key && /^[A-Z][A-Z0-9_]*$/.test(key)) found.add(key);
    }
  }
  return [...found].map((key) => ({ key, set: Boolean(process.env[key]) }));
}

export function loadConfig(partial?: { dataDir?: string; port?: number }): AppConfig {
  const repoRoot = repoRootFrom();
  const dataDir = path.resolve(partial?.dataDir || process.env.DATA_DIR || (process.cwd().endsWith(`${path.sep}packages${path.sep}server`) ? path.join(repoRoot, 'data') : path.join(process.cwd(), 'data')));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
  loadSecrets(dataDir);
  captureLoadedSecrets(dataDir);
  const secretFile = path.join(dataDir, 'cookie.secret');
  let cookieSecret = process.env.LA_COOKIE_SECRET || '';
  if (!cookieSecret) {
    if (fs.existsSync(secretFile)) cookieSecret = fs.readFileSync(secretFile, 'utf8').trim();
    else {
      cookieSecret = randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, cookieSecret, { mode: 0o600 });
    }
  }
  return {
    host: process.env.LA_HOST || '0.0.0.0',
    port: partial?.port || Number(process.env.LA_PORT || process.env.PORT || 8787),
    dataDir,
    repoRoot,
    webDist: path.join(repoRoot, 'packages', 'web', 'dist'),
    cookieSecret,
    instanceId: randomBytes(8).toString('hex'),
  };
}
