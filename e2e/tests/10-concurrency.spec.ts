import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { test, expect, send, firstAgent, personaWithChat } from '../lib/fixtures';

test('two tabs on one chat: the second tab follows the running reply and cannot double-send', async ({ owner, api }) => {
  const agent = await firstAgent(api);
  await owner.goto(`/?persona=${agent.id}`);
  await send(owner, '[[slow]] alpha beta gamma delta epsilon zeta');
  const second = await owner.context().newPage();
  await second.goto(`/?persona=${agent.id}`);
  await expect(second.getByText('[[slow]] alpha beta gamma delta epsilon zeta').first()).toBeVisible();
  // Sending from the second tab while the first reply runs is refused, and the text stays in the box.
  await send(second, 'me too');
  await expect(second.getByText(/still running/i).first()).toBeVisible();
  await expect(second.getByRole('textbox', { name: /message/i })).toHaveValue('me too');
  // Both tabs end with the finished reply and no spinner.
  for (const page of [owner, second]) {
    await expect(page.getByText(/Slow done\./).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.typing')).toHaveCount(0);
  }
  await second.close();
});

test('rapid persona switching lands on the last one clicked, with no duplicate chats', async ({ owner, api }) => {
  const names = ['Ada', 'Bo', 'Cy', 'Di'];
  const made = [] as { agentId: string }[];
  for (const name of names) made.push(await personaWithChat(api, name, []));
  await owner.goto('/');
  const list = owner.getByRole('list', { name: 'Personas' });
  for (let round = 0; round < 3; round += 1) {
    for (const name of names) await list.getByRole('button', { name: new RegExp(`^\\S*\\s*${name}\\b`) }).first().click({ delay: 0 });
  }
  await expect(owner.locator('.persona-name')).toContainText('Di');
  await send(owner, 'who is this?');
  await expect(owner.getByText('Echo: who is this?')).toBeVisible();
  const sessions = (await (await api.get('/api/sessions')).json()).sessions as { id: string; agentId: string }[];
  for (const { agentId } of made) expect(sessions.filter((row) => row.agentId === agentId).length).toBe(1);
  const last = made[3]!.agentId;
  const lastSession = sessions.find((row) => row.agentId === last)!;
  const messages = (await (await api.get(`/api/sessions/${lastSession.id}`)).json()).messages as { content: string }[];
  expect(messages.map((row) => row.content)).toContain('who is this?');
});

test('paging: a 400-message chat opens on the newest page and loads older ones on demand', async ({ owner, api, server }) => {
  const { agentId, sessionId } = await personaWithChat(api, 'Talker', []);
  const db = new DatabaseSync(path.join(server.dataDir, 'local-agent.db'), { timeout: 10_000 });
  db.exec('BEGIN IMMEDIATE');
  const insert = db.prepare(`INSERT INTO messages (id, session_id, seq, role, content, tool_call_id, tool_name, tool_calls, agent_id, run_id, image_url, routing_note, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)`);
  const start = Date.now() - 400 * 60_000;
  for (let i = 1; i <= 400; i += 1) insert.run(`msg_seed_${i}`, sessionId, i, i % 2 ? 'user' : 'assistant', `seeded message number ${i}`, i % 2 ? null : agentId, new Date(start + i * 60_000).toISOString());
  db.exec('COMMIT');
  db.close();
  const first = await (await api.get(`/api/sessions/${sessionId}?limit=150`)).json();
  expect(first.messages.length).toBe(150);
  expect(first.hasMore).toBe(true);
  await owner.goto(`/?persona=${agentId}`);
  await expect(owner.locator('article.msg').getByText('seeded message number 400', { exact: true })).toBeVisible();
  await expect(owner.locator('article.msg').getByText('seeded message number 1', { exact: true })).toHaveCount(0);
  const rendered = await owner.locator('article.msg').count();
  expect(rendered).toBeLessThanOrEqual(160);
  for (let i = 0; i < 4 && await owner.locator('article.msg').getByText('seeded message number 1', { exact: true }).count() === 0; i += 1) {
    await owner.getByRole('button', { name: 'Load earlier messages' }).click();
    await expect(owner.getByRole('button', { name: 'Loading…' })).toHaveCount(0);
  }
  await expect(owner.locator('article.msg').getByText('seeded message number 1', { exact: true })).toBeAttached();
  await expect(owner.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});
