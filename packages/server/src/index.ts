import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { applyPendingRestore } from './ops.js';

const config = loadConfig();
if (applyPendingRestore(config.dataDir)) console.log('Restored the pending backup.');
const { app } = await buildApp({ dataDir: config.dataDir, port: config.port });
await app.listen({ host: config.host, port: config.port });
console.log(`local-agent listening on http://${config.host}:${config.port}`);
