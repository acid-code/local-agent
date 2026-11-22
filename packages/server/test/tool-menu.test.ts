import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { compactSchema, findToolsTool, rankTools } from '../src/toolsearch.js';
import type { Tool } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const fake = (name: string, description: string, properties: Record<string, unknown> = {}): Tool => ({
  name, description, parameters: { type: 'object', properties, required: Object.keys(properties).slice(0, 1) },
  mutates: () => false, approval: () => null, execute: async () => 'ok',
});

describe('tool search', () => {
  const catalog = [
    fake('mcp_gmail_send', 'Send an email message', { to: { type: 'string', description: 'Recipient' }, body: { type: 'string' } }),
    fake('make_slides', 'Build a pptx presentation deck'),
    fake('manage_timer', 'Set a reminder or a recurring timer'),
    fake('vercel', 'Deploy projects and manage domains'),
  ];
  const servers = new Map([['mcp_gmail_send', 'gmail']]);

  it('ranks by intent, synonyms and Hebrew included', () => {
    expect(rankTools(catalog, 'send an email to Dana', servers)[0]!.tool.name).toBe('mcp_gmail_send');
    expect(rankTools(catalog, 'תזכיר לי מחר', servers).length).toBe(0);
    expect(rankTools(catalog, 'תזכורת למחר', servers)[0]!.tool.name).toBe('manage_timer');
    expect(rankTools(catalog, 'make a presentation', servers)[0]!.tool.name).toBe('make_slides');
    expect(rankTools(catalog, 'vercel', servers)[0]!.tool.name).toBe('vercel');
  });

  it('find_tools adds matches once and shows compact arguments', async () => {
    const added: string[] = [];
    const tool = findToolsTool({ discoverable: catalog, servers, offered: () => new Set(added), add: (names) => added.push(...names) });
    expect(tool.description).toContain('connectors: gmail (1)');
    const out = await tool.execute({ query: 'email' }, {} as never);
    expect(added).toEqual(['mcp_gmail_send']);
    expect(out).toContain('to: string (Recipient)');
    expect(out).toContain('body?: string');
    const again = await tool.execute({ query: 'email' }, {} as never);
    expect(added).toEqual(['mcp_gmail_send']);
    expect(again).toMatch(/already on your list/i);
    expect(await tool.execute({ query: 'quantum teleport' }, {} as never)).toMatch(/No tool matches/);
    expect(compactSchema(catalog[1]!)).toContain('args: none');
  });
});

class Recorder implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  tools: string[][] = [];
  async *complete(req: { tools?: { name: string }[] }) {
    this.tools.push((req.tools ?? []).map((tool) => tool.name));
    const step = this.steps.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-menu-')); dirs.push(dir);
  const provider = new Recorder();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '12'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  return { ...built, provider, agent, session };
}
async function waitFor(check: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
}

describe('lean tool menu', () => {
  it('starts small, find_tools appends found tools at the end, and the list never shrinks', async () => {
    const built = await setup();
    built.provider.steps = [
      { toolCalls: [{ id: 'f1', name: 'find_tools', arguments: JSON.stringify({ query: 'presentation slides' }) }] },
      { text: 'Found the slides tool.' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'hello there' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    const [first, second] = built.provider.tools;
    expect(first).toContain('find_tools');
    expect(first).toContain('read_file');
    expect(first).not.toContain('make_slides');
    const all = (built.engine as unknown as { tools: (...args: unknown[]) => { name: string }[] }).tools(built.store.getAgent(built.agent.id), undefined, undefined, undefined, false, undefined, true);
    expect(first!.length).toBeLessThan(all.length);
    // Append-only: the previous list is an exact prefix.
    expect(second!.slice(0, first!.length)).toEqual(first);
    expect(second!.slice(first!.length)).toContain('make_slides');
    expect(built.store.getRun(row.id)!.cursor.extraTools).toContain('make_slides');
    await built.app.close();
  });

  it('seeds obvious tools from the request so the first step already has them', async () => {
    const built = await setup();
    built.provider.steps = [{ text: 'ok' }];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'make me a slides presentation about bees' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    expect(built.provider.tools[0]).toContain('make_slides');
    await built.app.close();
  });

  it('a permitted tool called before it was found still runs and joins the menu', async () => {
    const built = await setup();
    built.provider.steps = [
      { toolCalls: [{ id: 't1', name: 'time_now', arguments: '{}' }] },
      { toolCalls: [{ id: 's1', name: 'search_chats', arguments: JSON.stringify({ query: 'bees' }) }] },
      { text: 'done' },
    ];
    const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'hello' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
    const step = built.store.listSteps(row.id).find((item) => item.name === 'search_chats');
    expect(step?.kind).toBe('tool');
    expect(built.provider.tools[2]).toContain('search_chats');
    await built.app.close();
  });

  it('LA_TOOL_MENU=full offers everything, as before', async () => {
    process.env.LA_TOOL_MENU = 'full';
    try {
      const built = await setup();
      built.provider.steps = [{ text: 'ok' }];
      const row = await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'hello' });
      await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(row.id)?.status ?? ''));
      expect(built.provider.tools[0]).toContain('make_slides');
      expect(built.provider.tools[0]).not.toContain('find_tools');
      await built.app.close();
    } finally { delete process.env.LA_TOOL_MENU; }
  });
});
