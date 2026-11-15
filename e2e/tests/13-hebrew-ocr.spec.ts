import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { test, expect, firstAgent, signIn, MEMBER, watch, ALLOWED } from '../lib/fixtures';

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
async function axe(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] }));
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('a Hebrew member gets a right-to-left, translated app and can switch language in Settings', async ({ browser, server, api }, info) => {
  expect((await api.post('/api/members', { data: { username: MEMBER.username, displayName: 'נועה', password: MEMBER.password } })).status()).toBeLessThan(300);
  // Browser language he-IL: auto-detected on the sign-in page already.
  const context = await browser.newContext({ baseURL: server.url, locale: 'he-IL', viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  watch(page, errors);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await signIn(context, MEMBER, page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('complementary', { name: 'תפריט ראשי' })).toContainText('סוכן מקומי');
  await expect(page.getByRole('textbox', { name: 'הודעה' })).toBeVisible();
  // The sidebar sits on the right in RTL.
  const side = await page.locator('.sidebar').boundingBox();
  expect(side!.x + side!.width).toBeGreaterThan(1280 - 40);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('hebrew-wide.png') });
  expect(await axe(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('hebrew-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 820 });

  await page.goto('/settings#language');
  const group = page.getByRole('radiogroup', { name: 'שפת הממשק' });
  await expect(group).toBeVisible();
  await expect(group.getByRole('radio', { name: 'עברית' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath('hebrew-settings.png') });
  // Pin English: the page reloads left-to-right, and the choice is saved on the account.
  await group.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('radiogroup', { name: 'Interface language' })).toBeVisible();
  const saved = await page.evaluate(async () => (await (await fetch('/api/me/language')).json()).language);
  expect(saved).toMatchObject({ choice: 'en', saved: true });
  // Back to Hebrew; a fresh browser (English locale) follows the account's saved choice after sign-in.
  await page.getByRole('radiogroup', { name: 'Interface language' }).getByRole('radio', { name: 'עברית' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const other = await browser.newContext({ baseURL: server.url, locale: 'en-US' });
  const second = await signIn(other, MEMBER);
  await expect(second.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(second.getByRole('complementary', { name: 'תפריט ראשי' })).toBeVisible();
  await other.close();
  await context.close();
  expect(errors.filter((line) => !ALLOWED.some((pattern) => pattern.test(line)))).toEqual([]);
});

test('a photo sent with "read text" carries its OCR text into the chat (fake OCR service)', async ({ owner, api, server }, info) => {
  const calls: string[] = [];
  const fake = http.createServer((req, res) => {
    calls.push(req.url || '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/health') return res.end(JSON.stringify({ ok: true, langs: ['eng', 'heb'] }));
      res.end(JSON.stringify({ text: 'מבצע היום: 2 ב-10 ₪\nSale today only', confidence: 91, words: 7, lowWords: 0, ms: 4 }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  await server.restart({ OCR_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` });
  try {
    const agent = await firstAgent(api);
    await owner.goto(`/?persona=${agent.id}`);
    await owner.getByRole('button', { name: 'Add files, folders or uploads (@)' }).click();
    await owner.locator('.mention-picker input[type=file]').setInputFiles([{ name: 'sign.png', mimeType: 'image/png', buffer: PNG }]);
    const chip = owner.getByRole('combobox', { name: 'Read text in photos' });
    await expect(chip).toBeVisible();
    await chip.selectOption('printed');
    const box = owner.getByRole('textbox', { name: 'Message' });
    await box.fill('what does the sign say?');
    await box.press('Enter');
    await expect(owner.getByText(/^Echo: what does the sign say\?/).first()).toBeVisible();
    const note = owner.locator('.attached-note').first();
    await expect(note).toContainText('Sale today only');
    await expect(note).toContainText('מבצע היום');
    expect(calls.some((url) => url.startsWith('/ocr'))).toBe(true);
    await owner.screenshot({ path: info.outputPath('ocr-chat.png') });
    // "Copy text" in the file viewer reads it too.
    const files = (await (await api.get('/api/files')).json()).files as { id: string; name: string }[];
    const read = await (await api.post('/api/ocr', { data: { fileId: files.find((file) => file.name === 'sign.png')!.id, mode: 'auto' } })).json();
    expect(read.result).toMatchObject({ engine: 'tesseract', direction: 'mixed' });
  } finally {
    fake.close();
  }
});
