import { test, expect, send, firstAgent } from '../lib/fixtures';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('uploads: a text file and an image attach to a message and preview in place', async ({ owner, api }) => {
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await owner.getByRole('button', { name: 'Add files, folders or uploads (@)' }).click();
  await owner.locator('.mention-picker input[type=file]').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('line one\nthe secret word is pineapple\n') },
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(owner.getByText('notes.txt').first()).toBeVisible();
  await send(owner, 'what is in these?');
  await expect(owner.getByText(/^Echo: what is in these\?/).first()).toBeVisible();
  const card = owner.locator('.file-card', { hasText: 'notes.txt' }).first();
  await expect(card).toBeVisible();
  await card.locator('.file-card-main').click();
  const preview = owner.getByRole('dialog', { name: 'Preview notes.txt' });
  await expect(preview).toContainText('pineapple');
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await expect(owner.locator('.image-card img[alt="dot.png"], .file-card img').first()).toBeVisible();
  // Files are listed for the owner and served back byte for byte.
  const files = (await (await api.get('/api/files')).json()).files as { id: string; name: string }[];
  const png = files.find((file) => file.name === 'dot.png')!;
  expect(Buffer.from(await (await api.get(`/api/files/${png.id}/raw`)).body()).equals(PNG)).toBe(true);
});
