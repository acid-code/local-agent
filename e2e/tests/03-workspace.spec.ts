import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, send, personaWithChat } from '../lib/fixtures';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-e2e-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.test'); git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\nAlways write tests first.\n');
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'la-e2e-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('remote', 'add', 'origin', remote);
  return { dir, remote };
}

test('workspace: rules apply, an edit needs approval, rollback restores it, and a push waits for approval', async ({ owner, api }) => {
  const { dir, remote } = repo();
  const label = `demo${Date.now() % 100000}`;
  const added = await api.post('/api/workspaces/folder', { data: { path: dir, label } });
  expect(added.status(), await added.text()).toBeLessThan(300);
  const { agentId, sessionId } = await personaWithChat(api, 'Builder', ['read_file', 'write_file', 'git', 'list_dir']);
  const workspaceId = `prj:${label}`;
  expect((await api.put(`/api/sessions/${sessionId}/workspaces`, { data: { items: [{ kind: 'root', id: workspaceId }] } })).status()).toBeLessThan(300);
  // The repo's AGENTS.md shows up as a rule for this chat.
  const rules = await (await api.get(`/api/sessions/${sessionId}/rules`)).json();
  expect(JSON.stringify(rules)).toContain('AGENTS.md');

  await owner.goto(`/?persona=${agentId}`);
  await send(owner, `[[tool:write_file {"path":"${label}/hello.txt","content":"changed by the agent\\n"}]]`);
  const card = owner.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(card).toContainText('hello.txt');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByText(/Done: Wrote/)).toBeVisible();
  expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('changed by the agent\n');

  // One-click rollback of that reply's edits.
  const run = ((await (await api.get('/api/runs')).json()).runs as { id: string; sessionId: string }[]).find((row) => row.sessionId === sessionId)!;
  const rolled = await api.post(`/api/runs/${run.id}/rollback`, { data: {} });
  expect(rolled.status(), await rolled.text()).toBeLessThan(300);
  expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('original\n');

  // A push is never silent: it waits for an OK that names the branch.
  await send(owner, `[[tool:git {"action":"push","project":"${label}"}]]`);
  const push = owner.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(push).toContainText(/main/i);
  await push.getByRole('button', { name: 'Deny' }).click();
  await expect(push).toHaveCount(0);
  const refs = execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' });
  expect(refs.trim()).toBe('');
});
