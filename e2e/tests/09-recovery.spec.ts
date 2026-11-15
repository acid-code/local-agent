import { test, expect, send, firstAgent, waitForRun } from '../lib/fixtures';

test('Ollama down: the reply fails with a clear card, and Try again works once Ollama is back', async ({ owner, api, ollama }) => {
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  const port = ollama.port;
  await ollama.stop();
  await send(owner, 'are you there?');
  const card = owner.locator('.error-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).not.toContainText('Internal error');
  await ollama.start(port);
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(owner.getByText('Echo: are you there?')).toBeVisible({ timeout: 30_000 });
});

test('restart mid-run: no ghost "running" after the process dies', async ({ owner, api, server, ollama }) => {
  await api.patch('/api/settings', { data: { autoResume: false } });
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  ollama.slowWords = 40;
  await send(owner, '[[slow]] long one');
  await expect(owner.getByText(/word1 /).first()).toBeVisible({ timeout: 10_000 });
  await server.kill();
  await server.restart();
  const sessionId = ((await (await api.get('/api/sessions')).json()).sessions as { id: string }[])[0]!.id;
  const run = await waitForRun(api, sessionId, ['interrupted', 'failed', 'completed', 'stopped']);
  expect(run.status).toBe('interrupted');
  await owner.reload();
  await expect(owner.locator('.typing')).toHaveCount(0);
  await expect(owner.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
  // The chat works again right away.
  await send(owner, 'back again');
  await expect(owner.getByText('Echo: back again')).toBeVisible({ timeout: 20_000 });
});
