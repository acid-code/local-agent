import { test, expect, send, personaWithChat } from '../lib/fixtures';

test('agent timers: the agent creates a timer and it fires in the same chat', async ({ owner, api }) => {
  const { agentId, sessionId } = await personaWithChat(api, 'Timekeeper', ['manage_timer']);
  await owner.goto(`/?persona=${agentId}`);
  await send(owner, '[[tool:manage_timer {"action":"create","name":"Daily ping","cron":"0 9 * * *","prompt":"timer ping"}]]');
  const ask = owner.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(ask).toContainText('Daily ping');
  await ask.getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByText(/^Done:/).first()).toBeVisible();
  const schedules = (await (await api.get('/api/schedules')).json()).schedules as { id: string; name: string; sessionId?: string | null }[];
  const timer = schedules.find((row) => row.name === 'Daily ping');
  expect(timer, JSON.stringify(schedules)).toBeTruthy();
  await expect(owner.locator('.state-panel, [aria-label$="status"]').getByText('Daily ping').first()).toBeVisible();
  // Fire it now: the reply lands in the chat that made it, not a new one.
  expect((await api.post(`/api/schedules/${timer!.id}/run`, { data: {} })).status()).toBeLessThan(300);
  await expect(owner.getByText('Echo: timer ping')).toBeVisible({ timeout: 20_000 });
  const sessions = (await (await api.get('/api/sessions')).json()).sessions as { id: string; agentId: string }[];
  expect(sessions.filter((row) => row.agentId === agentId).map((row) => row.id)).toEqual([sessionId]);
});
