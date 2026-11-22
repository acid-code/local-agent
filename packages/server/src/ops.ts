import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DockerCtl } from './docker.js';
import { readMem } from './discovery.js';
import type { Settings } from './settings.js';

export interface BackupInfo { id: string; file: string; bytes: number; createdAt: string }

export async function createBackup(dataDir: string, prefix = ''): Promise<BackupInfo> {
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = prefix ? `${prefix}-${stamp}` : stamp;
  const file = path.join(dataDir, 'backups', `${id}.tar`);
  const liveDb = path.join(dataDir, 'local-agent.db');
  if (!fs.existsSync(liveDb)) throw new Error('Nothing to back up yet.');

  const staging = fs.mkdtempSync(path.join(dataDir, 'backup-'));
  try {
    const snapshot = path.join(staging, 'local-agent.db');
    const escaped = snapshot.replace(/'/g, "''");
    const db = new DatabaseSync(liveDb);
    try {
      db.exec(`VACUUM main INTO '${escaped}'`);
    } finally {
      db.close();
    }
    for (const name of ['master.key', 'cookie.secret', 'secrets.env']) {
      if (fs.existsSync(path.join(dataDir, name))) fs.copyFileSync(path.join(dataDir, name), path.join(staging, name));
    }
    if (fs.existsSync(path.join(dataDir, 'workspaces'))) {
      fs.cpSync(path.join(dataDir, 'workspaces'), path.join(staging, 'workspaces'), { recursive: true });
    }
    const include = fs.readdirSync(staging);
    await run('tar', ['-C', staging, '-cf', file, ...include]);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const stat = fs.statSync(file);
  return { id, file, bytes: stat.size, createdAt: new Date().toISOString() };
}

/** Best-effort automatic backup before a container change or update. */
export async function preChangeBackup(dataDir: string, reason = 'pre-change'): Promise<BackupInfo | null> {
  if (!fs.existsSync(path.join(dataDir, 'local-agent.db'))) return null;
  try {
    return await createBackup(dataDir, reason.replace(/[^a-z0-9_-]+/gi, '-'));
  } catch {
    return null;
  }
}

/**
 * Refuse to start on an empty data folder when an existing live install is found elsewhere.
 * Prevents accidentally creating a blank database if DATA_DIR or a Docker volume mount is misconfigured.
 */
export async function guardEmptyDataDir(dataDir: string, docker?: DockerCtl): Promise<void> {
  if (process.env.LA_ALLOW_EMPTY_DATA === '1' || process.env.NODE_ENV === 'test') return;
  const targetDb = path.join(dataDir, 'local-agent.db');
  if (fs.existsSync(targetDb)) return;
  const resolvedTarget = path.resolve(dataDir);
  const candidates = new Set<string>([
    '/opt/local-agent/data',
    ...(process.env.LA_EXISTING_DATA_DIRS ? process.env.LA_EXISTING_DATA_DIRS.split(':').filter(Boolean) : []),
  ]);
  for (const dir of candidates) {
    if (path.resolve(dir) === resolvedTarget) continue;
    if (fs.existsSync(path.join(dir, 'local-agent.db'))) {
      throw new Error(
        `Refusing to start on empty data folder (${resolvedTarget}): found an existing local-agent database at ${path.join(dir, 'local-agent.db')}. ` +
        `Point DATA_DIR to ${dir}, or set LA_ALLOW_EMPTY_DATA=1 to intentionally start a fresh empty instance.`,
      );
    }
  }
  if (docker?.available()) {
    const others = await docker.findExistingDataMounts();
    const hostSelf = process.env.LA_HOST_DATA_DIR ? path.resolve(process.env.LA_HOST_DATA_DIR) : resolvedTarget;
    const conflict = others.find((item) => path.resolve(item.source) !== hostSelf);
    if (conflict) {
      throw new Error(
        `Refusing to start on empty data folder (${resolvedTarget}): another local-agent container (${conflict.container}, project ${conflict.project}) already uses data at ${conflict.source}. ` +
        `Reuse that install's data directory, or set LA_ALLOW_EMPTY_DATA=1 to intentionally start a fresh empty instance.`,
      );
    }
  }
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tar')).sort().reverse().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    return { id: name.replace(/\.tar$/, ''), file, bytes: stat.size, createdAt: stat.mtime.toISOString() };
  });
}

export function stageRestore(dataDir: string, id: string) {
  const file = path.join(dataDir, 'backups', `${id}.tar`);
  if (!fs.existsSync(file)) throw new Error('Backup not found.');
  fs.writeFileSync(path.join(dataDir, 'pending-restore.json'), JSON.stringify({ file }));
}

export function applyPendingRestore(dataDir: string) {
  const flag = path.join(dataDir, 'pending-restore.json');
  if (!fs.existsSync(flag)) return false;
  const { file } = JSON.parse(fs.readFileSync(flag, 'utf8')) as { file: string };
  applyBackupArchive(dataDir, file);
  fs.rmSync(flag, { force: true });
  return true;
}

export function applyBackupArchive(dataDir: string, archive: string) {
  if (!fs.existsSync(archive)) throw new Error('Backup archive is missing.');
  const staging = fs.mkdtempSync(path.join(dataDir, 'restore-'));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    runSync('tar', ['-C', staging, '-xf', archive]);
    fs.rmSync(path.join(dataDir, 'local-agent.db-wal'), { force: true });
    fs.rmSync(path.join(dataDir, 'local-agent.db-shm'), { force: true });
    for (const name of ['local-agent.db', 'local-agent.db-wal', 'local-agent.db-shm', 'master.key', 'secrets.env']) {
      const source = path.join(staging, name);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(dataDir, name));
    }
    const workspace = path.join(staging, 'workspaces');
    if (fs.existsSync(workspace)) {
      fs.cpSync(workspace, path.join(dataDir, 'workspaces'), { recursive: true });
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function shipBackup(file: string, settings: Pick<Settings, 'backupTransport' | 'backupTarget'>): Promise<{ shipped: boolean; detail: string }> {
  if (settings.backupTransport === 'none' || !settings.backupTarget) return { shipped: false, detail: 'No off-box target configured.' };
  if (settings.backupTransport === 'rsync') {
    await run('rsync', ['-a', file, settings.backupTarget]);
    return { shipped: true, detail: `rsync to ${settings.backupTarget}` };
  }
  if (settings.backupTransport === 'rclone' || settings.backupTransport === 's3') {
    if (!(await commandExists('rclone'))) return { shipped: false, detail: 'rclone is not installed. The local snapshot is still here.' };
    const target = settings.backupTransport === 's3'
      ? `${process.env.BACKUP_S3_BUCKET || settings.backupTarget}`
      : settings.backupTarget;
    const args = ['copy', file, target];
    if (settings.backupTransport === 's3' && process.env.BACKUP_S3_ENDPOINT) {
      args.push('--s3-endpoint', process.env.BACKUP_S3_ENDPOINT, '--s3-provider', 'Other');
    }
    await run('rclone', args);
    return { shipped: true, detail: `rclone copy to ${target}` };
  }
  return { shipped: false, detail: 'Unknown backup transport.' };
}

export async function backupIfDue(dataDir: string, settings: Settings) {
  const stateFile = path.join(dataDir, 'backup-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { nextAt?: string } : {};
  if (state.nextAt && Date.parse(state.nextAt) > Date.now()) return null;
  const backup = await createBackup(dataDir);
  const shipped = await shipBackup(backup.file, settings).catch((error: Error) => ({ shipped: false, detail: error.message }));
  const { nextCron } = await import('@local-agent/shared');
  const nextAt = nextCron(settings.backupCron || '0 3 * * *', new Date()).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({ nextAt, lastId: backup.id, shipped }));
  return { backup, shipped };
}

export interface WatchReport { at: string; ollama: boolean; restarted: string[]; notes: string[] }

export async function watchOnce(docker: DockerCtl, fetchImpl: typeof fetch): Promise<WatchReport> {
  const notes: string[] = [];
  const restarted: string[] = [];
  let ollama = false;
  const base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(700) });
    ollama = response.ok;
  } catch {
    notes.push('Ollama did not answer. The watchdog does not restart a model server it did not install.');
  }
  if (docker.available()) {
    const containers = await docker.list().catch(() => []);
    for (const container of containers) {
      const watched = container.labels['local-agent.watch'] === '1' || container.labels['local-agent.role'] === 'mcp' || container.labels['local-agent.role'] === 'sandbox';
      if (!watched || container.state === 'running') continue;
      try {
        await docker.start(container.id);
        restarted.push(container.name || container.id);
      } catch (error) {
        notes.push(`Could not restart ${container.name}: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
  }
  const mem = readMem();
  if (mem < 6) notes.push(`Low RAM: ${mem.toFixed(1)} GiB available.`);
  return { at: new Date().toISOString(), ollama, restarted, notes };
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let err = '';
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `${command} exited ${code}`))));
  });
}

function runSync(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
}

async function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
