import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = path.resolve(process.argv[2] || 'data');
const requested = process.argv[3];
fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = requested || path.join(dataDir, 'backups', `pre-update-${stamp}.tar`);
const liveDb = path.join(dataDir, 'local-agent.db');
if (!fs.existsSync(liveDb)) throw new Error(`Database missing: ${liveDb}`);

const staging = fs.mkdtempSync(path.join(dataDir, 'backup-'));
try {
  const snapshot = path.join(staging, 'local-agent.db');
  const db = new DatabaseSync(liveDb);
  try {
    db.exec(`VACUUM main INTO '${snapshot.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  for (const name of ['master.key', 'cookie.secret', 'secrets.env']) {
    const source = path.join(dataDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staging, name));
  }
  const workspaces = path.join(dataDir, 'workspaces');
  if (fs.existsSync(workspaces)) {
    fs.cpSync(workspaces, path.join(staging, 'workspaces'), { recursive: true });
  }
  const items = fs.readdirSync(staging);
  execFileSync('tar', ['-C', staging, '-cf', backup, ...items]);
  console.log(backup);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
