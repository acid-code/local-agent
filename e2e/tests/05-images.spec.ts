import { test, expect, send, firstAgent } from '../lib/fixtures';

// The mock runner draws a placeholder through the same pipeline (RAM gate, file save, preview) as Stable Diffusion.
test.use({ serverEnv: { LA_IMAGE_MOCK: '1' } });

test('images: /image makes a picture on this machine and shows it in the chat', async ({ owner, api }) => {
  const status = await (await api.get('/api/images/status')).json();
  expect(JSON.stringify(status)).toMatch(/mock/i);
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await send(owner, '/image a red fox in the snow');
  await expect(owner.locator('.image-card img').first()).toBeVisible({ timeout: 30_000 });
  await expect(owner.getByText(/Image · mock runner/).first()).toBeVisible();
  const files = (await (await api.get('/api/files')).json()).files as { name: string; mime?: string }[];
  expect(files.some((file) => file.name.startsWith('a-red-fox'))).toBe(true);
});
