import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { browseTool } from '../src/connectors.js';
import type { ModelProvider } from '../src/providers.js';
import { recoveryHint } from '../src/recovery.js';
import { shouldSteerToBrowse, toolsFor } from '../src/tools.js';
import { rankTools } from '../src/toolsearch.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

class ScriptProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[]; onCall?: () => void }[] = [];
  seen: { system: string; tools: string[] }[] = [];
  async *complete(req: { messages: { role: string; content: unknown }[]; tools?: { name: string }[] }) {
    const system = String(req.messages.find((m) => m.role === 'system')?.content ?? '');
    this.seen.push({ system, tools: (req.tools ?? []).map((t) => t.name) });
    const step = this.steps.shift() ?? { text: 'ok' };
    step.onCall?.();
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 8, outputTokens: 6 } };
  }
}

async function waitFor(check: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('timed out');
}

describe('browse / surf tool steering', () => {
  it('offers browse on Turn 0 in a default lean menu and includes steering rules in system prompt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-browse-turn0-')); dirs.push(dir);
    const provider = new ScriptProvider();
    provider.steps = [{ text: 'Ready to surf.' }];
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '13'].join('-') } });
    const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
    const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });

    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello there' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(run.id)?.status ?? ''));

    expect(provider.seen[0]!.tools).toEqual(expect.arrayContaining(['web_search', 'browse', 'web_fetch']));
    expect(provider.seen[0]!.system).toMatch(/prefer browse \(live browser\) instead of web_fetch/i);
    await built.app.close();
  });

  it('ranks browse for surf, store shopping, and Hebrew browsing queries', () => {
    const catalog = [browseTool(), ...toolsFor(['web_search', 'web_fetch', 'read_file'])];
    for (const q of ['use the surf tool', 'shop on aliexpress', 'לגלוש באתר']) {
      const ranked = rankTools(catalog, q);
      expect(ranked.length, q).toBeGreaterThan(0);
      expect(ranked[0]!.tool.name, q).toBe('browse');
    }
  });

  it('steers web_fetch results toward browse on stores, JS/bot shells, empty pages, and thin pages, but not static docs', async () => {
    const longDoc = `<html><body><main>${'Documentation paragraph explaining PCIe 4.0 M.2 NVMe lane bifurcation and thermal pad installation steps in thorough detail. '.repeat(4)}</main></body></html>`;
    const thinHtml = '<html><body><div>Loading store...</div></body></html>';
    const jsGateHtml = '<html><body><div>Please enable JavaScript and verify you are human to continue.</div></body></html>';
    const emptyHtml = '<html><body><script>window.__APP__=1;</script></body></html>';

    expect(shouldSteerToBrowse('https://docs.example.org/guide', longDoc.replace(/<[^>]+>/g, ''))).toBeNull();
    expect(shouldSteerToBrowse('https://www.aliexpress.com/w/wholesale-ssd-1tb.html', 'Netac SSD 1TB '.repeat(30))).toMatch(/browse\(\{ url: "https:\/\/www\.aliexpress\.com\/w\/wholesale-ssd-1tb\.html" \}\)/);
    expect(shouldSteerToBrowse('https://static.example.org/app', '(empty page)')).toMatch(/empty page shell/);
    expect(shouldSteerToBrowse('https://static.example.org/shop', 'Just a moment... Verify you are human')).toMatch(/JavaScript or bot-protection challenge/);
    expect(shouldSteerToBrowse('https://static.example.org/thin', 'Tiny shell')).toMatch(/very little text/);

    const webFetch = toolsFor(['web_fetch'])[0]!;
    const mkCtx = (html: string) => ({
      fetchImpl: (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
      signal: undefined,
    }) as never;

    const aliOut = await webFetch.execute({ url: 'https://www.aliexpress.com/w/wholesale-ssd-1tb.html' }, mkCtx(longDoc));
    expect(aliOut).toContain('Use browse({ url: "https://www.aliexpress.com/w/wholesale-ssd-1tb.html" })');

    const emptyOut = await webFetch.execute({ url: 'https://example.org/spa' }, mkCtx(emptyHtml));
    expect(emptyOut).toContain('Use browse({ url: "https://example.org/spa" })');

    const jsOut = await webFetch.execute({ url: 'https://example.org/wall' }, mkCtx(jsGateHtml));
    expect(jsOut).toContain('Use browse({ url: "https://example.org/wall" })');

    const thinOut = await webFetch.execute({ url: 'https://example.org/thin' }, mkCtx(thinHtml));
    expect(thinOut).toContain('Use browse({ url: "https://example.org/thin" })');

    const docOut = await webFetch.execute({ url: 'https://docs.example.org/guide' }, mkCtx(longDoc));
    expect(docOut).not.toContain('Use browse(');
  });

  it('recoveryHint recommends browse on web_fetch HTTP blocks and timeouts while keeping retry guidance', () => {
    const blocked = recoveryHint('web_fetch', 'Fetch returned 403.');
    expect(blocked).toMatch(/browse tool/i);

    const timedOut = recoveryHint('web_fetch', 'fetch failed: ETIMEDOUT');
    expect(timedOut).toMatch(/retry once/i);
    expect(timedOut).toMatch(/browse tool/i);
  });

  it('seeds matching discoverable tools when mid-run steering arrives', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-steer-seed-')); dirs.push(dir);
    const provider = new ScriptProvider();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '14'].join('-') } });
    const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
    const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies, payload: { name: 'Ada', systemPrompt: 'test', toolAllowlist: ['read_file'], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });

    provider.steps = [
      {
        toolCalls: [{ id: 't1', name: 'time_now', arguments: '{}' }],
        onCall: () => {
          const active = built.store.listRuns(1)[0];
          if (active) built.engine.steer(active.id, 'make a slides presentation');
        },
      },
      { text: 'Prepared with make_slides.' },
    ];

    const run = await built.engine.startTurn({ sessionId: session.id, agentId: agent.id, content: 'hello there' });
    await waitFor(() => ['completed', 'failed'].includes(built.store.getRun(run.id)?.status ?? ''));

    expect(provider.seen[0]!.tools).not.toContain('make_slides');
    expect(provider.seen[1]!.tools).toContain('make_slides');
    expect(built.store.getRun(run.id)!.cursor.extraTools).toContain('make_slides');
    await built.app.close();
  });
});
