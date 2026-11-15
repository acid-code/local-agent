import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, send, firstAgent, OWNER } from '../lib/fixtures';
import { FakeOllama } from '../lib/fake-ollama';
import { startServer } from '../lib/server';

test.describe('disk full', () => {
  // Pretend the disk has less free space than the reserve: every write that needs room is refused up front.
  test.use({ serverEnv: { LA_DISK_RESERVE_BYTES: String(10 ** 16) } });
  test('uploads and backups get a clear 507, and chat keeps working', async ({ owner, api }) => {
    const upload = await api.post('/api/files', { data: { name: 'big.txt', contentBase64: Buffer.from('hello').toString('base64') } });
    expect(upload.status()).toBe(507);
    expect((await upload.json()).error).toMatch(/disk|space/i);
    const backup = await api.post('/api/backups', { data: {} });
    expect(backup.status()).toBe(507);
    expect((await backup.json()).error).toMatch(/disk|space/i);
    const agent = await firstAgent(api);
    await owner.goto(`/?persona=${agent.id}`);
    await owner.getByRole('button', { name: 'Add files, folders or uploads (@)' }).click();
    await owner.locator('.mention-picker input[type=file]').setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(owner.getByText(/disk|space/i).first()).toBeVisible();
    await owner.keyboard.press('Escape');
    await send(owner, 'still here?');
    await expect(owner.getByText('Echo: still here?')).toBeVisible();
  });
});

test('backup round-trip: restore brings back the snapshot and drops later chats', async ({ owner, api, server }) => {
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await send(owner, 'before the backup');
  await expect(owner.getByText('Echo: before the backup')).toBeVisible();
  const made = await api.post('/api/backups', { data: {} });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const backupId = (await made.json()).backup.id as string;
  await send(owner, 'after the backup');
  await expect(owner.getByText('Echo: after the backup')).toBeVisible();
  expect((await api.post(`/api/backups/${backupId}/restore`, { data: { confirm: true } })).status()).toBeLessThan(300);
  // The process exits to swap the data in; a supervisor would start it again.
  await expect.poll(async () => { try { await fetch(`${server.url}/api/auth/me`); return 'up'; } catch { return 'down'; } }, { timeout: 15_000 }).toBe('down');
  await server.restart();
  await owner.reload();
  await expect(owner.locator('article.msg').getByText('Echo: before the backup')).toBeVisible();
  await expect(owner.locator('article.msg').getByText('after the backup')).toHaveCount(0);
});

test('upgrade: a data folder from the previous release opens with its chats, and new features work', async ({ browser }) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-e2e-v1-'));
  fs.copyFileSync(path.resolve(import.meta.dirname, '..', 'fixtures', 'v1-data', 'local-agent.db'), path.join(dataDir, 'local-agent.db'));
  const ollama = await new FakeOllama().start();
  const server = await startServer({ ollamaUrl: ollama.url, dataDir });
  try {
    const context = await browser.newContext({ baseURL: server.url });
    const page = await context.newPage();
    await page.goto('/');
    await page.fill('input[autocomplete="username"]', OWNER.username);
    await page.fill('input[type="password"]', OWNER.password);
    await page.click('button[type="submit"]');
    await expect(page.locator('.sidebar')).toBeVisible();
    const sessions = (await (await context.request.get('/api/sessions')).json()).sessions as { id: string; title: string; agentId: string }[];
    const old = sessions.find((row) => row.title === 'Old chat from v1');
    expect(old, JSON.stringify(sessions)).toBeTruthy();
    const messages = (await (await context.request.get(`/api/sessions/${old!.id}?limit=50`)).json()).messages as { content: string }[];
    expect(messages.map((row) => row.content)).toContain('hello from the old version');
    await page.goto(`/?persona=${old!.agentId}`);
    await expect(page.locator('article.msg').getByText('hello from the old version', { exact: true })).toBeVisible();
    await send(page, 'hi after the upgrade');
    await expect(page.getByText('Echo: hi after the upgrade')).toBeVisible();
    // Features added since then answer on the old data too.
    for (const url of ['/api/mcp', '/api/connectors', '/api/schedules', '/api/workspaces']) expect((await context.request.get(url)).status(), url).toBe(200);
    await context.close();
  } finally {
    await server.stop();
    await ollama.stop();
  }
});
