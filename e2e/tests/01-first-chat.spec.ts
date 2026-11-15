import { test, expect, OWNER, watch, send, ALLOWED } from '../lib/fixtures';

test('fresh install: create the owner, then the first chat gets a reply', async ({ browser, server, consoleErrors }) => {
  const context = await browser.newContext({ baseURL: server.url });
  const page = await context.newPage();
  watch(page, consoleErrors);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create owner' })).toBeVisible();
  await page.fill('input[autocomplete="username"]', OWNER.username);
  await page.fill('input[type="password"]', OWNER.password);
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  // The first reply discovers the local model on its own.
  await page.goto('/');
  await send(page, 'hello from a fresh install');
  await expect(page.locator('.msg.from-agent, article.msg').filter({ hasText: 'Echo: hello from a fresh install' }).first()).toBeVisible({ timeout: 30_000 });
  // No ghost "working" after the reply.
  await expect(page.locator('.typing')).toHaveCount(0);
  expect(consoleErrors.filter((line) => !ALLOWED.some((p) => p.test(line)))).toEqual([]);
  await context.close();
});
