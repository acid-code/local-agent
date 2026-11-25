import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { CODING_TOOLS } from '../src/coding.js';
import { runPostEditDiagnostics } from '../src/diagnostics.js';
import { FENCED_EDIT_HINT, extractFencedEdits } from '../src/fenced-edits.js';
import type { CompletionRequest, ModelProvider } from '../src/providers.js';
import { COMPACT_CODING_TOOLS } from '../src/toolsearch.js';
import { toolsFor, type ToolContext } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class CaptureProvider implements ModelProvider {
  steps: { text?: string; toolCalls?: ToolCall[] }[] = [];
  requests: { system: string; toolNames: string[]; messages: ChatMessage[] }[] = [];

  async *complete(req: CompletionRequest) {
    const system = String(req.messages.find((m) => m.role === 'system')?.content ?? '');
    this.requests.push({
      system,
      toolNames: (req.tools ?? []).map((t) => t.name),
      messages: req.messages,
    });
    const step = this.steps.shift() ?? { text: 'Done.' };
    if (step.text) yield { type: 'token' as const, text: step.text };
    yield {
      type: 'done' as const,
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
      toolCalls: step.toolCalls,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

async function setupCoder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-harness-'));
  dirs.push(dir);
  const provider = new CaptureProvider();
  const built = await buildApp({
    dataDir: dir,
    startScheduler: false,
    serveWeb: false,
    providerOverride: () => provider as unknown as ModelProvider,
  });
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'owner', password: ['h', 'owner', 'pass'].join('-') },
  });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({
    method: 'POST',
    url: '/api/agents',
    cookies,
    payload: { name: 'Coder', systemPrompt: 'Work cleanly.', toolAllowlist: [], modelId: 'model_rehearsal' },
  })).json().agent as { id: string; ownerId: string; workspacePath: string };
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  built.store.updateSession(session.id, { mode: 'code' });
  return { ...built, provider, agent, session: built.store.getSession(session.id)!, cookies };
}

describe('Aider-style fenced edits', () => {
  it('extracts file:path blocks with :append and :overwrite flags and nested fences', () => {
    const raw = [
      'Creating the module now.',
      '```file:src/hello.ts',
      'export const greet = () => "hi";',
      '```',
      'Appending tail chunk:',
      '```file:src/hello.ts:append',
      'export const bye = () => "bye";',
      '```',
      'Writing docs with nested code example:',
      '````file:README.md:overwrite',
      '# Docs',
      '```ts',
      'greet();',
      '```',
      '````',
      'Done.',
    ].join('\n');

    const parsed = extractFencedEdits(raw);
    expect(parsed.calls).toHaveLength(3);
    expect(parsed.calls[0]!.name).toBe('write_file');
    expect(JSON.parse(parsed.calls[0]!.arguments)).toEqual({
      path: 'src/hello.ts',
      content: 'export const greet = () => "hi";\n',
    });
    expect(JSON.parse(parsed.calls[1]!.arguments)).toEqual({
      path: 'src/hello.ts',
      content: 'export const bye = () => "bye";\n',
      append: true,
    });
    expect(JSON.parse(parsed.calls[2]!.arguments)).toEqual({
      path: 'README.md',
      content: '# Docs\n```ts\ngreet();\n```\n',
      overwrite: true,
    });
    expect(parsed.text).toBe('Creating the module now.\nAppending tail chunk:\nWriting docs with nested code example:\nDone.');
  });

  it('extracts edit:path blocks with single, multi-hunk, and deletion SEARCH/REPLACE blocks', () => {
    const single = extractFencedEdits([
      '```edit:src/a.ts',
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n'));
    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.name).toBe('apply_patch');
    expect(JSON.parse(single.calls[0]!.arguments)).toEqual({
      path: 'src/a.ts',
      search: 'const a = 1;',
      replace: 'const a = 2;',
    });

    const multi = extractFencedEdits([
      '```edit:src/b.ts',
      '<<<<<<< SEARCH',
      'const x = 1;',
      '=======',
      'const x = 10;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'removeMe();',
      '=======',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n'));
    expect(multi.calls).toHaveLength(1);
    expect(multi.calls[0]!.name).toBe('apply_patch');
    expect(JSON.parse(multi.calls[0]!.arguments)).toEqual({
      edits: [
        { path: 'src/b.ts', search: 'const x = 1;', replace: 'const x = 10;' },
        { path: 'src/b.ts', search: 'removeMe();', replace: '' },
      ],
    });
  });

  it('ignores normal code fences and unclosed truncated file fences', () => {
    const normal = extractFencedEdits('Example:\n```ts\nconst n = 1;\n```');
    expect(normal.calls).toHaveLength(0);

    const truncated = extractFencedEdits('Writing file:\n```file:src/cut.ts\nexport const x = 1;');
    expect(truncated.calls).toHaveLength(0);
    expect(truncated.text).toContain('```file:src/cut.ts');
  });

  it('executes fenced edit: blocks end-to-end in Engine and surfaces post-edit diagnostics', async () => {
    const built = await setupCoder();
    try {
      const target = path.join(built.agent.workspacePath, 'calc.js');
      fs.writeFileSync(target, 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n', 'utf8');

      built.provider.steps = [
        {
          text: [
            'Updating calc.js:',
            '```edit:calc.js',
            '<<<<<<< SEARCH',
            '  return a + b;',
            '=======',
            '  return a + ;',
            '>>>>>>> REPLACE',
            '```',
          ].join('\n'),
        },
        {
          text: [
            'Fixing the syntax error from diagnostics:',
            '```edit:calc.js',
            '<<<<<<< SEARCH',
            '  return a + ;',
            '=======',
            '  return a + b + 1;',
            '>>>>>>> REPLACE',
            '```',
          ].join('\n'),
        },
        { text: 'Updated calc.js cleanly.' },
      ];

      const run = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Update add in calc.js',
        wait: true,
      });
      expect(run.status).toBe('completed');
      const toolMsgs = built.store.listMessages(built.session.id).filter((m) => m.role === 'tool' && m.runId === run.id);
      expect(toolMsgs[0]!.content).toContain('[Diagnostics]');
      expect(toolMsgs[0]!.content).toMatch(/SyntaxError|Unexpected token/);
      expect(toolMsgs[1]!.content).not.toContain('[Diagnostics]');
      expect(fs.readFileSync(target, 'utf8')).toContain('return a + b + 1;');
    } finally {
      await built.app.close();
    }
  });
});

describe('OpenCode automatic post-edit diagnostics', () => {
  it('returns empty on clean files, reports errors on invalid JSON/JS, and respects disabled flags', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-diag-'));
    dirs.push(dir);
    const okJson = path.join(dir, 'ok.json');
    const badJson = path.join(dir, 'bad.json');
    const okJs = path.join(dir, 'ok.js');
    const badJs = path.join(dir, 'bad.js');

    fs.writeFileSync(okJson, '{"ok":true}\n', 'utf8');
    fs.writeFileSync(badJson, '{"ok":\n', 'utf8');
    fs.writeFileSync(okJs, 'const x = 1;\n', 'utf8');
    fs.writeFileSync(badJs, 'const x = ;\n', 'utf8');

    expect(await runPostEditDiagnostics([okJson, okJs], { workspace: dir })).toBe('');

    const jsonDiag = await runPostEditDiagnostics([badJson], { workspace: dir });
    expect(jsonDiag).toContain('[Diagnostics]');
    expect(jsonDiag).toContain('JSON syntax error');

    const jsDiag = await runPostEditDiagnostics([badJs], { workspace: dir });
    expect(jsDiag).toContain('[Diagnostics]');
    expect(jsDiag).toMatch(/SyntaxError|Unexpected token/);

    expect(await runPostEditDiagnostics([badJson, badJs], { workspace: dir, enabled: false })).toBe('');

    // Wire-up check via write_file tool directly
    const writeTool = toolsFor(['write_file'])[0]!;
    const createTool = toolsFor(['create_file'])[0]!;
    const patchTool = CODING_TOOLS.find((t) => t.name === 'apply_patch')!;
    const ctx = { workspace: dir, autoDiagnostics: true } as unknown as ToolContext;
    const out = await writeTool.execute({ path: 'broken.json', content: '{ bad' }, ctx);
    expect(out).toContain('[Diagnostics]');

    // Partial append skips diagnostics until complete
    const appended = await createTool.execute({ path: 'broken.json', content: '}', append: true }, ctx);
    expect(appended).not.toContain('[Diagnostics]');
    expect(patchTool.name).toBe('apply_patch');
  });
});

describe('Pi/Cline compact coding prompt mode', () => {
  it('keeps COMPACT_CODING_TOOLS lean and cuts local coding prompt/menu bloat unless turned off', async () => {
    expect(COMPACT_CODING_TOOLS.length).toBeLessThanOrEqual(16);
    expect(COMPACT_CODING_TOOLS).toContain('share_file');

    const built = await setupCoder();
    try {
      built.provider.steps = [{ text: 'Ready.' }];
      const runCompact = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Inspect the repository',
        wait: true,
      });
      expect(runCompact.status).toBe('completed');
      const compactReq = built.provider.requests[0]!;
      expect(compactReq.toolNames).toEqual(expect.arrayContaining(['read_file', 'write_file', 'apply_patch', 'shell', 'git', 'find_tools']));
      expect(compactReq.toolNames).not.toContain('make_slides');
      expect(compactReq.toolNames).not.toContain('fetch_image');
      expect(compactReq.toolNames).not.toContain('vercel');
      expect(compactReq.system).toContain(FENCED_EDIT_HINT);
      expect(compactReq.system).not.toContain('make_slides (real designed .pptx decks');
      expect(compactReq.system).not.toContain('Web lookup rule:');

      // Non-coding tool stays reachable via find_tools
      built.provider.requests = [];
      built.provider.steps = [
        { toolCalls: [{ id: 'ft1', name: 'find_tools', arguments: JSON.stringify({ query: 'presentation slides' }) }] },
        { text: 'Slides tool unlocked.' },
      ];
      await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Check slides support',
        wait: true,
      });
      expect(built.provider.requests[1]!.toolNames).toContain('make_slides');

      // Disabling compactCodingPrompt restores full menu & capability prompt
      built.provider.requests = [];
      built.provider.steps = [{ text: 'Full mode.' }];
      const cur = built.store.getSettings();
      built.store.saveSettings({ ...cur, compactCodingPrompt: false }, 'disable compact coding', cur);
      await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Inspect again',
        wait: true,
      });
      const fullReq = built.provider.requests[0]!;
      expect(fullReq.toolNames).toContain('web_search');
      expect(fullReq.system).toContain('make_slides (real designed .pptx decks');
      expect(fullReq.system.length).toBeGreaterThan(compactReq.system.length);
    } finally {
      await built.app.close();
    }
  });
});

describe('per-model context window breakdown', () => {
  it('updates breakdown immediately when pinning a 256K local model vs an 8K model', async () => {
    const built = await setupCoder();
    try {
      const prov = built.store.upsertProvider({ id: 'prov_llama_test', kind: 'openai_compat', name: 'Llama Test', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
      const big = built.store.upsertModel({
        id: 'm_big_256k', providerId: prov.id, name: 'qwen-256k', apiName: 'qwen-256k', profileId: 'qwen36-35b-a3b',
        tokenizer: 'approx', contextWindow: 262_144, practicalBudget: 262_144, strategy: 'hierarchical', sizeClass: 'large',
        local: true, modalities: ['text'], strengths: ['code'], typicalQ4GiB: 22, priceIn: 0, priceOut: 0,
        notes: '', parameterSize: '35B', family: 'qwen', source: 'discovered', embedding: false, freeTier: null, enabled: true,
      });
      const small = built.store.upsertModel({
        id: 'm_small_8k', providerId: prov.id, name: 'gemma-8k', apiName: 'gemma-8k', profileId: 'gemma3-4b',
        tokenizer: 'approx', contextWindow: 8192, practicalBudget: 8192, strategy: 'sliding', sizeClass: 'small',
        local: true, modalities: ['text'], strengths: ['chat'], typicalQ4GiB: 3, priceIn: 0, priceOut: 0,
        notes: '', parameterSize: '4B', family: 'gemma3', source: 'discovered', embedding: false, freeTier: null, enabled: true,
      });

      const pinBig = await built.app.inject({
        method: 'PATCH',
        url: `/api/sessions/${built.session.id}`,
        cookies: built.cookies,
        payload: { modelPin: big.id },
      });
      expect(pinBig.statusCode).toBe(200);
      const reserve = built.store.getSettings().outputReserveTokens;
      expect(pinBig.json().breakdown.budget).toBe(262_144 - reserve);

      // Run one turn so lastContext caches the 256K breakdown, then switch down to 8K
      built.provider.steps = [{ text: 'Cached on 256k.' }];
      await built.engine.startTurn({ sessionId: built.session.id, agentId: built.agent.id, content: 'hi', wait: true });
      expect(built.engine.getSessionContextBreakdown(built.session.id)?.budget).toBe(262_144 - reserve);

      const pinSmall = await built.app.inject({
        method: 'PATCH',
        url: `/api/sessions/${built.session.id}`,
        cookies: built.cookies,
        payload: { modelPin: small.id },
      });
      expect(pinSmall.statusCode).toBe(200);
      expect(pinSmall.json().breakdown.budget).toBe(8192 - reserve);
    } finally {
      await built.app.close();
    }
  });
});
