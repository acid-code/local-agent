import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { needsApproval, riskOf } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('risk tiers', () => {
  it('classifies tool calls', () => {
    expect(riskOf('read_file', { path: 'a' }, null).tier).toBe('safe');
    expect(riskOf('write_file', { path: 'a' }, 'Write a').tier).toBe('low');
    expect(riskOf('shell', { command: 'ls -la' }, null).tier).toBe('low');
    expect(riskOf('shell', { command: 'rm build/old.txt' }, 'x').tier).toBe('medium');
    expect(riskOf('shell', { command: 'git push origin main' }, 'x').tier).toBe('high');
    expect(riskOf('shell', { command: 'sudo apt install jq' }, 'x').tier).toBe('high');
    expect(riskOf('docker_run', { image: 'alpine' }, 'Create a container').tier).toBe('medium');
    expect(riskOf('docker_rm', { id: 'x' }, 'Remove').tier).toBe('high');
    expect(riskOf('gmail__send_email', {}, null).tier).toBe('high');
    expect(riskOf('github__list_issues', {}, null).tier).toBe('safe');
    expect(riskOf('propose_skill', {}, 'Save skill').tier).toBe('high');
  });
  it('asks per mode, and high always asks', () => {
    expect(needsApproval('low', 'Write a', 'cautious')).toBe(true);
    expect(needsApproval('low', 'Write a', 'balanced')).toBe(false);
    expect(needsApproval('medium', 'x', 'balanced')).toBe(true);
    expect(needsApproval('medium', 'x', 'autonomous')).toBe(false);
    expect(needsApproval('high', null, 'autonomous')).toBe(true);
    expect(needsApproval('safe', null, 'cautious')).toBe(false);
  });
});

class ScriptProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  async *complete(_req: { messages: ChatMessage[] }) {
    const step = this.steps.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

describe('engine applies tiers', () => {
  it('auto-runs a workspace write in balanced mode and asks with the tier in autonomous mode for high risk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-tier-')); dirs.push(dir);
    const provider = new ScriptProvider();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
    const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '11'].join('-') } });
    const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
    const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 't', toolAllowlist: ['write_file', 'docker_rm'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string; workspacePath: string };
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const done = async (id: string) => { for (let i = 0; i < 200 && !['completed', 'failed', 'awaiting_approval'].includes(built.store.getRun(id)?.status ?? ''); i++) await new Promise((r) => setTimeout(r, 20)); return built.store.getRun(id)!.status; };

    provider.steps = [{ toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'hi' }) }] }, { text: 'Wrote a.txt.' }];
    const first = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'write a.txt' });
    expect(await done(first.id)).toBe('completed');
    expect(fs.readFileSync(path.join(agent.workspacePath, 'a.txt'), 'utf8')).toBe('hi');

    const auto = { ...built.store.getSettings(), approvalMode: 'autonomous' as const };
    built.store.saveSettings(auto, 'test', { settings: auto });
    provider.steps = [{ toolCalls: [{ id: 'd1', name: 'docker_rm', arguments: JSON.stringify({ id: 'abc' }) }] }, { text: 'ok' }];
    const second = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'remove it' });
    expect(await done(second.id)).toBe('awaiting_approval');
    expect(built.store.listApprovals('pending').find((row) => row.runId === second.id)?.reason).toMatch(/^\[high risk\] Remove container abc/);
    await built.app.close();
  });
});
