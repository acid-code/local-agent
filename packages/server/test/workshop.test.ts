import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideRoute } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { CODING_TOOLS } from '../src/coding.js';
import { locatePath, projectPath, workshopBrief } from '../src/workshops.js';
import type { ToolContext } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-shop-'));
  dirs.push(dir);
  return dir;
}

describe('workshops', () => {
  it('keeps a path inside the named project and refuses one that escapes', () => {
    const root = tmp();
    const server = path.join(root, 'server');
    const apk = path.join(root, 'apk');
    fs.mkdirSync(server);
    fs.mkdirSync(apk);
    const roots = [{ label: 'server', path: server }, { label: 'apk', path: apk }];
    const hit = locatePath({ workspace: root, roots, target: 'server/src/index.ts' });
    expect(hit?.full).toBe(path.join(server, 'src', 'index.ts'));
    expect(hit?.write).toBe(true);
    expect(locatePath({ workspace: root, roots, target: 'server/../../etc/passwd' })).toBeNull();
    expect(projectPath(roots, 'apk', root)).toBe(apk);
    expect(() => projectPath(roots, undefined, root)).toThrow(/server, apk/);
  });

  it('routes a workshop turn to a local model that can code', () => {
    const chat = { id: 'model_chat', name: 'Small chat', apiName: 'chat', providerKind: 'openai_compat' as const, local: true, resident: false, enabled: true, sizeClass: 'small' as const, modalities: ['text'] as ('text')[], strengths: ['chat'] as ('chat')[], contextWindow: 8192, practicalBudget: 4096, profileId: 'chat' };
    const coder = { ...chat, id: 'model_coder', name: 'Local coder', apiName: 'coder', strengths: ['code', 'chat'] as ('code' | 'chat')[], profileId: 'coder' };
    const decision = decideRoute({ text: 'look at both projects', agentRouting: 'auto', sessionModelId: chat.id, preferCode: true, models: [chat, coder], memAvailableGiB: 40 });
    expect(decision.modelId).toBe(coder.id);
    expect(decision.kind).toBe('code');
    expect(decision.switched).toBe(true);
    expect(decision.reason).toMatch(/changes a project|implement/);
    const hard = decideRoute({ text: 'Prove this architecture tradeoff formally, step by step', agentRouting: 'auto', sessionModelId: coder.id, preferCode: true, models: [coder], memAvailableGiB: 40 });
    expect(hard.kind).toBe('hard-reasoning');
  });

  it('opens a workshop over two checkouts and runs git in the one you name', async () => {
    const dir = tmp();
    const server = path.join(dir, 'server');
    const apk = path.join(dir, 'apk');
    fs.mkdirSync(server);
    fs.mkdirSync(apk);
    fs.writeFileSync(path.join(server, 'README.md'), 'server\n');
    fs.writeFileSync(path.join(apk, 'README.md'), 'apk\n');
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '01'].join('-') } });
    const cookie = setup.cookies.find((item) => item.name === 'la_session')!.value;
    store.createAgent({ name: 'Coder', systemPrompt: 'code', toolAllowlist: ['git', 'read_file'], workspacePath: dir, modelId: 'model_rehearsal' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/workshops',
      cookies: { la_session: cookie },
      payload: { name: 'Server and app', projects: [{ label: 'server', path: server }, { label: 'apk', path: apk }] },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.session.mode).toBe('code');
    expect(workshopBrief(store, body.workshop.id)).toMatch(/server/);
    expect(workshopBrief(store, body.workshop.id)).toMatch(/apk/);
    const gitTool = CODING_TOOLS.find((tool) => tool.name === 'git')!;
    expect(gitTool.approval({ action: 'pull', project: 'apk' }, {} as ToolContext)).toMatch(/Pull apk/);
    expect(gitTool.approval({ action: 'push' }, {} as ToolContext)).toMatch(/[Pp]ush/);
    const ctx = { workspace: dir, roots: body.workshop.projects, store, agent: store.listAgents()[0] } as ToolContext;
    await expect(gitTool.execute({ action: 'commit', message: 'x' }, ctx)).rejects.toThrow(/Name the project/);
    fs.mkdirSync(path.join(server, '.git'));
    const status = await gitTool.execute({ action: 'status', project: 'server' }, ctx);
    expect(status).toMatch(/exit/);
    await app.close();
  });
});
