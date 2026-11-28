import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { checkOrRepair, normalizeToolArgs, toolArgumentsSchema } from '../src/contracts.js';
import { Store } from '../src/db.js';
import { ensureFilesTable, shareFileTool } from '../src/files.js';
import { fetchWebImage, mockPng } from '../src/images.js';
import type { ModelProvider } from '../src/providers.js';
import { searxngQuery, type ToolContext } from '../src/tools.js';
import { loadMasterKey, Vault } from '../src/vault.js';
import { VpnManager } from '../src/vpn.js';
import type { DockerCtl } from '../src/docker.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class ScriptedMenuProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  offeredTools: { name: string; parameters?: Record<string, unknown> }[][] = [];
  async *complete(req: { tools?: { name: string; parameters?: Record<string, unknown> }[] }) {
    this.offeredTools.push((req.tools ?? []).map((t) => ({ name: t.name, parameters: t.parameters })));
    const step = this.steps.shift() ?? { text: 'ok' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield { type: 'done' as const, finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop', toolCalls: step.toolCalls, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

async function waitForRun(store: Store, runId: string, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const status = store.getRun(runId)?.status ?? '';
    if (['completed', 'failed', 'stopped'].includes(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

describe('tool hygiene fixes', () => {
  it('hides vpn tool and shell.use_vpn until VPN is configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-hygiene-vpn-'));
    dirs.push(dir);
    const provider = new ScriptedMenuProvider();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'pass', '99'].join('-') } });
    const cookies = { la_session: res.cookies.find((c) => c.name === 'la_session')!.value };
    const agentRes = (await built.app.inject({
      method: 'POST',
      url: '/api/agents',
      cookies,
      payload: { name: 'Assistant', systemPrompt: 'help', toolAllowlist: ['read_file', 'shell'], modelId: 'model_rehearsal' },
    })).json() as { agent: { id: string; ownerId: string } };

    expect(built.vpn.isConfigured()).toBe(false);

    // Run 1: VPN unconfigured -> vpn omitted from catalog/find_tools and shell has no use_vpn param.
    const ses1 = built.store.createSession({ agentId: agentRes.agent.id, ownerId: agentRes.agent.ownerId });
    provider.steps = [
      { toolCalls: [{ id: 'f1', name: 'find_tools', arguments: JSON.stringify({ query: 'vpn proxy fetch url' }) }] },
      { text: 'done' },
    ];
    const run1 = await built.engine.startTurn({ sessionId: ses1.id, agentId: agentRes.agent.id, content: 'hello' });
    await waitForRun(built.store, run1.id);
    const findStep1 = built.store.listSteps(run1.id).find((s) => s.name === 'find_tools');
    expect(String(findStep1?.output ?? '')).not.toContain('- vpn:');
    const shell1 = provider.offeredTools[0]?.find((t) => t.name === 'shell');
    expect((shell1?.parameters?.properties as Record<string, unknown> | undefined)?.use_vpn).toBeUndefined();

    // Configure proxy VPN (using Vault directly avoids external HTTP probe).
    const vault = new Vault(built.store, loadMasterKey(dir));
    const mgr = new VpnManager({ available: () => false } as unknown as DockerCtl, vault);
    expect(mgr.isConfigured()).toBe(false);
    vault.put({ name: 'LA_VPN_PROXY_URL', value: 'http://198.51.100.10:8888', scope: 'vpn', actor: 'owner' });
    vault.put({ name: 'LA_VPN_MODE', value: 'proxy', scope: 'vpn', actor: 'owner' });
    expect(mgr.isConfigured()).toBe(true);
    expect(built.vpn.isConfigured()).toBe(true);

    // Run 2: VPN configured -> find_tools discovers vpn and shell exposes use_vpn.
    const ses2 = built.store.createSession({ agentId: agentRes.agent.id, ownerId: agentRes.agent.ownerId });
    provider.offeredTools = [];
    provider.steps = [
      { toolCalls: [{ id: 'f2', name: 'find_tools', arguments: JSON.stringify({ query: 'vpn proxy' }) }] },
      { text: 'done' },
    ];
    const run2 = await built.engine.startTurn({ sessionId: ses2.id, agentId: agentRes.agent.id, content: 'hello' });
    await waitForRun(built.store, run2.id);
    const findStep2 = built.store.listSteps(run2.id).find((s) => s.name === 'find_tools');
    expect(String(findStep2?.output ?? '')).toContain('Added to your tools');
    expect(String(findStep2?.output ?? '')).toContain('vpn');
    const shell2 = provider.offeredTools[0]?.find((t) => t.name === 'shell');
    expect((shell2?.parameters?.properties as Record<string, unknown> | undefined)?.use_vpn).toBeDefined();

    await built.app.close();
  });

  it('find_tools discovers web_search, browse, and web_fetch in compact Code mode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-hygiene-codemenu-'));
    dirs.push(dir);
    const provider = new ScriptedMenuProvider();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'pass', '98'].join('-') } });
    const cookies = { la_session: res.cookies.find((c) => c.name === 'la_session')!.value };
    const agentRes = (await built.app.inject({
      method: 'POST',
      url: '/api/agents',
      cookies,
      payload: { name: 'Assistant', systemPrompt: 'code', toolAllowlist: ['read_file', 'write_file', 'shell'], modelId: 'model_rehearsal' },
    })).json() as { agent: { id: string; ownerId: string } };

    // Force compact coding prompt + menu even on mock model.
    process.env.LA_COMPACT_CODING = '1';
    try {
      const ses = built.store.createSession({ agentId: agentRes.agent.id, ownerId: agentRes.agent.ownerId });
      built.store.updateSession(ses.id, { mode: 'code' });
      provider.steps = [
        { toolCalls: [{ id: 'fw', name: 'find_tools', arguments: JSON.stringify({ query: 'web_search browse web_fetch' }) }] },
        { text: 'done' },
      ];
      const run = await built.engine.startTurn({ sessionId: ses.id, agentId: agentRes.agent.id, content: 'check repo' });
      await waitForRun(built.store, run.id);
      expect(provider.offeredTools[0]?.map((t) => t.name)).not.toContain('web_search');
      const findStep = built.store.listSteps(run.id).find((s) => s.name === 'find_tools');
      expect(String(findStep?.output ?? '')).toContain('web_search');
      expect(String(findStep?.output ?? '')).toContain('browse');
      expect(String(findStep?.output ?? '')).toContain('web_fetch');
      expect(provider.offeredTools[1]?.map((t) => t.name)).toContain('web_search');
    } finally {
      delete process.env.LA_COMPACT_CODING;
      await built.app.close();
    }
  });

  it('share_file preserves file extension when omitted and strips container workspace prefix', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-hygiene-share-data-'));
    const wsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-hygiene-share-ws-')), 'coder');
    fs.mkdirSync(wsDir, { recursive: true });
    dirs.push(dataDir, path.dirname(wsDir));
    fs.writeFileSync(path.join(wsDir, 'gta-game.html'), '<!doctype html><html><body>hi</body></html>');

    const store = new Store(path.join(dataDir, 'test.db'));
    ensureFilesTable(store);
    const tool = shareFileTool(() => dataDir);
    const ctx = {
      agent: { id: 'agt_1', ownerId: 'owner' } as ToolContext['agent'],
      workspace: wsDir,
      store,
      sessionId: 'ses_1',
    } as unknown as ToolContext;

    const out1 = await tool.execute({ path: 'gta-game.html', name: 'Street Chaos — Open World Game (v1.2)' }, ctx);
    expect(out1).toContain('Street Chaos — Open World Game (v1.2).html');

    const out2 = await tool.execute({ path: '/workspaces/coder/gta-game.html' }, ctx);
    expect(out2).toContain('gta-game.html');
    store.close();
  });

  it('filters broken relative redirect URLs in searxngQuery', async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
      results: [
        { title: 'Broken redirect', url: 'http:///go/v1/abc123', content: 'bad' },
        { title: 'Missing host', url: '/relative/path', content: 'bad2' },
        { title: 'Valid Hit', url: 'https://example.org/docs', content: 'good' },
      ],
      unresponsive_engines: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const res = await searxngQuery('http://searxng.local:8080', 'ssd specs', fakeFetch, undefined, 5);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.url).toBe('https://example.org/docs');
  });

  it('normalizes web_search/web_fetch/browse arg aliases and includes field path in Zod error', async () => {
    expect(normalizeToolArgs('web_search', { pattern: 'Tiel-Coder GGUF', path: 'https://huggingface.co' })).toMatchObject({
      query: 'Tiel-Coder GGUF',
    });
    expect(normalizeToolArgs('web_fetch', { href: 'https://example.org' })).toMatchObject({
      url: 'https://example.org',
    });
    expect(normalizeToolArgs('browse', { link: 'https://example.org' })).toMatchObject({
      url: 'https://example.org',
    });

    const failed = await checkOrRepair(toolArgumentsSchema('web_search'), {}, async () => ({}));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toContain('query:');
    }
  });

  it('raises step caps, respects >24 settings, promotes slide_draft/exit_plan_mode to longTask, and seeds follow-up presentation turns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-hygiene-caps-'));
    dirs.push(dir);
    const provider = new ScriptedMenuProvider();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider });
    const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'pass', '97'].join('-') } });
    const cookies = { la_session: res.cookies.find((c) => c.name === 'la_session')!.value };
    const agentRes = (await built.app.inject({
      method: 'POST',
      url: '/api/agents',
      cookies,
      payload: { name: 'Assistant', systemPrompt: 'help', toolAllowlist: ['read_file', 'shell'], modelId: 'model_rehearsal' },
    })).json() as { agent: { id: string; ownerId: string } };

    // Legacy maxSteps=12 still yields generous floors (>=32 chat, >=40 code/plan, >=60 longTask).
    built.store.saveSettings({ ...built.store.getSettings(), maxSteps: 12 }, 'legacy 12', { maxSteps: 12 });
    expect((built.engine as any).stepCap({}, 'chat')).toBeGreaterThanOrEqual(32);
    expect((built.engine as any).stepCap({}, 'code')).toBeGreaterThanOrEqual(40);
    expect((built.engine as any).stepCap({ stage: 'plan' }, 'chat')).toBeGreaterThanOrEqual(40);
    expect((built.engine as any).stepCap({ longTask: true }, 'chat')).toBeGreaterThanOrEqual(60);

    // Higher maxSteps=50 is NOT clamped to 24.
    built.store.saveSettings({ ...built.store.getSettings(), maxSteps: 50 }, 'higher cap', { maxSteps: 50 });
    expect((built.engine as any).stepCap({}, 'chat')).toBe(50);

    // Calling slide_draft(start) promotes run.cursor.longTask to true, and a follow-up message in a presentation chat seeds make_slides.
    const ses = built.store.createSession({ agentId: agentRes.agent.id, ownerId: agentRes.agent.ownerId, title: 'Presentation Creation' });
    built.store.updateSession(ses.id, { mode: 'code' });
    provider.steps = [
      { toolCalls: [{ id: 'sd1', name: 'slide_draft', arguments: JSON.stringify({ action: 'start', title: 'Test Deck' }) }] },
      { text: 'Draft started.' },
    ];
    const run = await built.engine.startTurn({ sessionId: ses.id, agentId: agentRes.agent.id, content: 'add real clinical data now' });
    await waitForRun(built.store, run.id);
    expect(provider.offeredTools[0]?.map((t) => t.name)).toContain('make_slides');
    expect(built.store.getRun(run.id)?.cursor.longTask).toBe(true);

    await built.app.close();
  });

  it('filters PDFs, videos, IA scans, and tiny icons in fetchWebImage and follows Wikimedia relevance order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-hygiene-img-'));
    dirs.push(dir);
    const store = new Store(path.join(dir, 'test.db'));
    ensureFilesTable(store);

    const pngBytes = mockPng('clean diagram', 64, 64);
    const requestedUrls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const u = String(input);
      requestedUrls.push(u);
      if (u.includes('commons.wikimedia.org/w/api.php')) {
        return new Response(JSON.stringify({
          query: {
            pages: {
              '100': {
                index: 2,
                title: 'File:Old_Paper_(IA_doc123).pdf',
                imageinfo: [{ mime: 'application/pdf', width: 960, height: 1200, url: 'https://upload.wikimedia.org/a.pdf', thumburl: 'https://thumb.wikimedia.org/pdf.jpg' }],
              },
              '200': {
                index: 3,
                title: 'File:Video_clip.ogv',
                imageinfo: [{ mime: 'application/ogg', width: 800, height: 600, url: 'https://upload.wikimedia.org/v.ogv', thumburl: 'https://thumb.wikimedia.org/v.jpg' }],
              },
              '300': {
                index: 4,
                title: 'File:Tiny_icon.png',
                imageinfo: [{ mime: 'image/png', width: 64, height: 64, url: 'https://upload.wikimedia.org/tiny.png' }],
              },
              '99999': {
                index: 1,
                title: 'File:Immunoglobulin_diagram.svg',
                imageinfo: [{ mime: 'image/svg+xml', width: 512, height: 512, url: 'https://upload.wikimedia.org/antibody.svg', thumburl: 'https://thumb.wikimedia.org/1280px-antibody.png' }],
              },
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(u).toBe('https://thumb.wikimedia.org/1280px-antibody.png');
      return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
    };

    const res = await fetchWebImage({ store, dataDir: dir, fetchImpl: fakeFetch }, { query: 'antibody structure', ownerId: 'owner' });
    expect(requestedUrls[0]).toContain('filetype%3Abitmap%7Cdrawing');
    expect(res.sourceUrl).toBe('https://thumb.wikimedia.org/1280px-antibody.png');
    store.close();
  });
});
