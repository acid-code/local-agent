import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { DockerCtl } from './docker.js';
import { interfacesFromOs, parseAllowlist, preferredLanUrl, setupBindAddresses } from './lan.js';
import { applyPendingRestore, guardEmptyDataDir } from './ops.js';
import { buildSetupApp } from './setup-site.js';
import { ensureSetupToken } from './setup-token.js';
import { loadMasterKey, Vault } from './vault.js';
import { Store } from './db.js';
import path from 'node:path';

const config = loadConfig();
if (applyPendingRestore(config.dataDir)) console.log('Restored the pending backup.');
await guardEmptyDataDir(config.dataDir, new DockerCtl());

const setupOnly = process.env.LA_SETUP_ONLY === '1';
const disableSetup = process.env.LA_DISABLE_SETUP === '1';

if (!setupOnly) {
  const { app } = await buildApp({ dataDir: config.dataDir, port: config.port });
  await app.listen({ host: config.host, port: config.port });
  console.log(`local-agent listening on http://${config.host}:${config.port}`);
}

if (!disableSetup) {
  const port = Number(process.env.LA_SETUP_PORT || 8788);
  const addresses = setupBindAddresses(interfacesFromOs());
  const issued = ensureSetupToken(config.dataDir);
  if (issued.reveal && issued.value) console.log(`Setup token (one time, LAN only): ${issued.value}`);
  const store = new Store(path.join(config.dataDir, 'local-agent.db'));
  const vault = new Vault(store, loadMasterKey(config.dataDir));
  const bound: string[] = [];
  for (const host of addresses) {
    const setup = await buildSetupApp({
      dataDir: config.dataDir,
      store,
      vault,
      cookieSecret: config.cookieSecret,
      allow: parseAllowlist(process.env.LA_SETUP_ALLOW),
    });
    try {
      await setup.listen({ host, port });
      bound.push(host);
    } catch (error) {
      await setup.close();
      const message = error instanceof Error ? error.message : 'bind failed';
      console.log(`Setup listener skipped ${host}: ${message}`);
    }
  }
  if (bound.length) console.log(`Setup (LAN only): ${preferredLanUrl(bound, port)}`);
  else console.log('Setup listener did not bind. No LAN address accepted the port.');
}
