import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DockerCtl } from './docker.js';
import { readMem } from './discovery.js';
import type { Settings } from './settings.js';

export interface BackupInfo { id: string; file: string; bytes: number; createdAt: string }

export async function createBackup(dataDir: string): Promise<BackupInfo> {
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dataDir, 'backups', `${id}.tar`);
  const include = ['local-agent.db', 'local-agent.db-wal', 'local-agent.db-shm', 'master.key', 'secrets.env', 'workspaces'].filter((name) => fs.existsSync(path.join(dataDir, name)));
  if (!include.length) throw new Error('Nothing to back up yet.');
  await run('tar', ['-C', dataDir, '-cf', file, ...include]);
  const stat = fs.statSync(file);
  return { id, file, bytes: stat.size, createdAt: new Date().toISOString() };
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
