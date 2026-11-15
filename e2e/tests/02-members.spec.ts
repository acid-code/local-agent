import { test, expect, MEMBER, signIn, send, firstAgent, watch } from '../lib/fixtures';

test('member isolation: own chats only, admin pages hidden, admin APIs 403, other people\'s ids 404', async ({ browser, server, api, owner, consoleErrors }) => {
  // The owner has a private chat.
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await send(owner, 'owner secret plans');
  await expect(owner.getByText('Echo: owner secret plans')).toBeVisible();
  const ownerSession = ((await (await api.get('/api/sessions')).json()).sessions as { id: string }[])[0]!.id;
  expect((await api.post('/api/members', { data: { username: MEMBER.username, displayName: 'Noa', password: MEMBER.password } })).status()).toBeLessThan(300);

  const context = await browser.newContext({ baseURL: server.url });
  const member = await signIn(context, MEMBER);
  watch(member, consoleErrors);
  await expect(member.getByText('owner secret plans')).toHaveCount(0);
  // Admin pages are not routed for members.
  await member.goto('/tools');
  await expect(member).toHaveURL(/\/$/);
  await member.locator('.side-foot [aria-label="All apps and pages"]').click();
  await expect(member.locator('.apps-pop')).not.toContainText('Tools');
  await expect(member.locator('.apps-pop')).not.toContainText('Models');
  await member.keyboard.press('Escape');

  const req = context.request;
  for (const [method, url] of [['GET', '/api/mcp'], ['POST', '/api/models/scan'], ['GET', '/api/backups'], ['POST', '/api/backups'], ['GET', '/api/members'], ['GET', '/api/vault'], ['PATCH', '/api/settings'], ['GET', '/api/logs'], ['POST', '/api/workspaces/folder'], ['GET', '/api/connectors/cache']] as const) {
    const res = await req.fetch(url, { method, data: method === 'GET' ? undefined : {} });
    expect(res.status(), `${method} ${url}`).toBe(403);
  }
  expect((await req.get(`/api/sessions/${ownerSession}`)).status()).toBe(404);
  expect((await req.get(`/api/sessions/${ownerSession}/messages`)).status()).toBe(404);
  expect((await req.post(`/api/sessions/${ownerSession}/messages`, { data: { content: 'hi' } })).status()).toBe(404);
  expect(((await (await req.get('/api/sessions')).json()).sessions as { id: string }[]).map((row) => row.id)).not.toContain(ownerSession);

  // The member can still chat with a persona of their own.
  const mine = ((await (await req.get('/api/agents')).json()).agents as { id: string }[])[0];
  expect(mine).toBeTruthy();
  await member.goto(`/?persona=${mine!.id}`);
  await send(member, 'member hello');
  await expect(member.getByText('Echo: member hello')).toBeVisible();
  await expect(owner.getByText('member hello')).toHaveCount(0);
  await context.close();
});
