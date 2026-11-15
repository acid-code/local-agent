import fs from 'node:fs';
import path from 'node:path';
import { geminiQuotaDay } from '@local-agent/shared';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { DockerCtl } from './docker.js';
import { searxngHealth } from './tools.js';
import { MemoryBudget, budgetConfig, budgetReport, systemProbe } from './memory.js';
import { doctorChecks, geminiStateOf } from './debug.js';
import { ollamaLoaded } from './ollama.js';
import { snapshotResources } from './resources.js';
import { listBackups } from './ops.js';
import { beginOwnerReset } from './setup-token.js';

const config = loadConfig();
const store = new Store(path.join(config.dataDir, 'local-agent.db'));

if (process.argv.includes('--reset-owner')) {
  store.db.prepare('DELETE FROM owner').run();
  const token = beginOwnerReset(config.dataDir);
  console.log('The owner account was removed.');
  console.log(`New setup token (shown once): ${token.value}`);
  console.log('Open the LAN setup page and create the owner again. The old password no longer works.');
  process.exit(0);
}

if (process.argv.includes('--monitor-token')) {
  const { createMonitorToken } = await import('./monitor.js');
  const label = process.argv[process.argv.indexOf('--monitor-token') + 1] || 'monitor';
  const { id, token } = createMonitorToken(store, label.startsWith('--') ? 'monitor' : label);
  console.log(`Monitoring token ${id} (shown once, store it in ~/.config/local-agent/monitor-token with chmod 600):`);
  console.log(token);
  process.exit(0);
}

const loaded = await ollamaLoaded(fetch);
const searx = await searxngHealth(store.getSettings().searxngUrl || process.env.SEARXNG_URL || '', fetch);
const snap = snapshotResources(store, config.dataDir);
const dbFile = path.join(config.dataDir, 'local-agent.db');
const checks = doctorChecks({
  ollamaOk: loaded.length >= 0 && await ollamaUp(),
  loaded,
  dockerOk: await new DockerCtl().ping(),
  mcpCount: store.listMcp().length,
  mcpErrors: store.listMcp().filter((item) => item.lastError).length,
  searxngOk: searx.ok,
  searxngDetail: searx.detail,
  tailscaleOk: false,
  telegramQueued: 0,
  dbBytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
  diskFreeBytes: snap.disk.freeBytes,
  memAvailableGiB: snap.memory.availableGiB,
  geminiOpen: null,
  geminiState: geminiStateOf(store.getProvider('prov_gemini')) === 'off' ? 'off' : 'unknown',
  lastBackupAt: listBackups(config.dataDir)[0]?.createdAt ?? null,
});
const ramBudget = new MemoryBudget(systemProbe(fetch), () => budgetConfig(store.getSettings()));
checks.push({ id: 'ram-budget', ...(await budgetReport(ramBudget, budgetConfig(store.getSettings()))) });
console.log(`local-agent doctor  quota day ${geminiQuotaDay()} (UTC)`);
for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'warn'} ${check.id}: ${check.detail}`);
console.log('Nothing was uploaded. Debug exports stay on this machine until you download one.');
process.exit(checks.some((check) => !check.ok && ['disk', 'db'].includes(check.id)) ? 1 : 0);

async function ollamaUp() {
  try {
    const response = await fetch(`${(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}
