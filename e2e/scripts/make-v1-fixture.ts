/**
 * Builds e2e/fixtures/v1-data from a checkout of the previous release (main before this PR), so the upgrade test opens
 * a real old data folder. Usage: node --experimental-strip-types e2e/scripts/make-v1-fixture.ts /path/to/old/checkout
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeOllama } from '../lib/fake-ollama.ts';
import { startServer } from '../lib/server.ts';

const root = process.argv[2]!;
const out = path.resolve(import.meta.dirname, '..', 'fixtures', 'v1-data');
const ollama = await new FakeOllama().start();
const server = await startServer({ ollamaUrl: ollama.url, root });
const cookie: string[] = [];
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(server.url + url, { method, headers: { 'content-type': 'application/json', cookie: cookie.join('; ') }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  for (const line of res.headers.getSetCookie()) cookie.push(line.split(';')[0]!);
  if (res.status >= 300) throw new Error(`${method} ${url} ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
};
await call('POST', '/api/setup', { username: 'owner', password: ['e2e', 'owner', 'pass', '42'].join('-') });
await call('POST', '/api/models/scan');
const agent = (await call('GET', '/api/agents')).agents[0] ?? (await call('POST', '/api/agents', { name: 'Oldie', systemPrompt: 'Be brief.', toolAllowlist: ['read_file'] })).agent;
const session = (await call('POST', '/api/sessions', { agentId: agent.id, title: 'Old chat from v1' })).session;
await call('POST', `/api/sessions/${session.id}/messages`, { content: 'hello from the old version' });
for (let i = 0; i < 50; i += 1) {
  const runs = (await call('GET', '/api/runs')).runs;
  if (runs[0]?.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
await call('POST', '/api/memory', { content: 'Asaf likes short answers' }).catch(() => undefined);
await server.stop();
await ollama.stop();
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// Only the database: secrets, keys and caches are machine-specific and are re-created on start.
// VACUUM INTO folds the WAL into one self-contained file.
new DatabaseSync(path.join(server.dataDir, 'local-agent.db')).exec(`VACUUM INTO '${path.join(out, 'local-agent.db')}'`);
console.log('wrote', out, fs.readdirSync(server.dataDir).join(', '));
