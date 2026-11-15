import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { test, expect, send, firstAgent } from '../lib/fixtures';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function axe(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] }));
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('phone layout: one column, chats open from the header, no sideways scroll', async ({ owner, api }) => {
  await owner.setViewportSize({ width: 390, height: 844 });
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await send(owner, 'phone hello');
  await expect(owner.getByText('Echo: phone hello')).toBeVisible();
  expect(await noHorizontalScroll(owner)).toBe(true);
  await expect(owner.locator('.sidebar')).not.toBeInViewport();
  await owner.getByRole('button', { name: /chats/i }).first().click();
  await expect(owner.locator('.sidebar')).toBeInViewport();
  const composer = await owner.getByRole('textbox', { name: /message/i }).boundingBox();
  expect(composer!.width).toBeGreaterThan(300);
});

test('narrow window: sidebar and chat, status panel as an overlay, no sideways scroll', async ({ owner, api }) => {
  await owner.setViewportSize({ width: 900, height: 800 });
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  expect(await noHorizontalScroll(owner)).toBe(true);
  await owner.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(owner.getByRole('complementary', { name: /status/i })).toBeVisible();
  expect(await noHorizontalScroll(owner)).toBe(true);
  await owner.setViewportSize({ width: 1440, height: 900 });
  await expect(owner.locator('.sidebar')).toBeInViewport();
});

for (const route of ['/', '/settings', '/agents', '/library', '/schedules', '/models', '/tools', '/runs']) {
  test(`axe: no serious or critical issues on ${route}`, async ({ owner, api }) => {
    if (route === '/') { const agent = await firstAgent(api); await owner.goto(`/?persona=${agent.id}`); await send(owner, 'axe check'); await expect(owner.getByText('Echo: axe check')).toBeVisible(); }
    else await owner.goto(route);
    await owner.waitForLoadState('networkidle');
    expect(await axe(owner)).toEqual([]);
  });
}
