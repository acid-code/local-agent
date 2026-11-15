import { test, expect } from '../lib/fixtures';

test('models: refresh picks up a new model, a pull downloads one, a bad pull fails clearly', async ({ owner, api, ollama }) => {
  ollama.models.push('gemma3:1b');
  await owner.goto('/models');
  await owner.getByRole('button', { name: 'Refresh models' }).click();
  await expect(owner.getByText('gemma3:1b').first()).toBeVisible();

  await owner.getByText('Pull another model').click();
  const name = owner.getByLabel('Ollama model name').first();
  await name.fill('llama3.2:1b');
  await owner.getByRole('button', { name: 'Pull model' }).first().click();
  await expect.poll(async () => ((await (await api.get('/api/models')).json()).models as { name: string }[]).map((m) => m.name), { timeout: 20_000 }).toContain('llama3.2:1b');

  await name.fill('no-such-model:7b');
  await owner.getByRole('button', { name: 'Pull model' }).first().click();
  await expect(owner.getByText(/file does not exist/i).first()).toBeVisible({ timeout: 20_000 });
  expect(((await (await api.get('/api/models')).json()).models as { name: string }[]).map((m) => m.name)).not.toContain('no-such-model:7b');
});
