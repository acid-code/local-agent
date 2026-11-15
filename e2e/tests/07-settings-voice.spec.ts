import { test, expect, firstAgent } from '../lib/fixtures';

test('settings: appearance choices apply live and survive a reload', async ({ owner }) => {
  await owner.goto('/settings');
  const density = owner.getByRole('group', { name: 'Density' });
  await density.getByRole('button', { name: 'Roomy' }).click();
  await expect(density.getByRole('button', { name: 'Roomy' })).toHaveAttribute('aria-pressed', 'true');
  await owner.reload();
  await expect(owner.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Roomy' })).toHaveAttribute('aria-pressed', 'true');
});

test('voice fallback: with no local Whisper the panel says browser dictation and transcribe explains why', async ({ owner, api }) => {
  const voice = await (await api.get('/api/voice')).json();
  expect(voice.whisper).toBe(false);
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await expect(owner.getByText(/Hold the mic to talk · browser dictation/)).toBeVisible();
  const res = await api.post('/api/voice/transcribe', { headers: { 'content-type': 'audio/webm' }, data: Buffer.from('not really audio') });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(600);
  const body = await res.json();
  expect(body.error).not.toMatch(/Internal error/);
  expect(String(body.error).length).toBeGreaterThan(10);
});
