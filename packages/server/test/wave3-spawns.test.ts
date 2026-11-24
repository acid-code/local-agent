import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { LiveEvent } from '../src/bus.js';
import type { CompletionRequest, ModelProvider } from '../src/providers.js';

const dirs: string[] = [];
const worktrees: string[] = [];
afterEach(() => {
  for (const wt of worktrees.splice(0)) {
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@local-agent.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\nalpha\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

type SeenReq = { model: string; noThink?: boolean; numCtx?: number; toolNames: string[] };

class RoleCaptureProvider implements ModelProvider {
  constructor(
    private readonly seen: SeenReq[],
    private readonly onRequest: (req: CompletionRequest) => { text?: string; toolCalls?: ToolCall[] },
  ) {}

  async *complete(req: CompletionRequest) {
    this.seen.push({
      model: req.model,
      noThink: req.noThink,
      numCtx: req.numCtx,
      toolNames: (req.tools ?? []).map((t) => t.name),
    });
    const out = this.onRequest(req);
    if (out.text) yield { type: 'token' as const, text: out.text };
    yield {
      type: 'done' as const,
      finishReason: out.toolCalls?.length ? 'tool_calls' : 'stop',
      toolCalls: out.toolCalls,
      usage: { inputTokens: 8, outputTokens: 8 },
    };
  }
}

async function setupWithFastAndMain(handler: (req: CompletionRequest) => { text?: string; toolCalls?: ToolCall[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-w3-'));
  dirs.push(dir);
  const seen: SeenReq[] = [];
  const built = await buildApp({
    dataDir: dir,
    startScheduler: false,
    serveWeb: false,
    providerOverride: () => new RoleCaptureProvider(seen, handler) as unknown as ModelProvider,
  });
  built.store.upsertProvider({ id: 'prov_ollama', kind: 'openai_compat', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true });
  built.store.upsertProvider({ id: 'prov_llama', kind: 'openai_compat', name: 'llama-server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true });
  built.store.upsertModel({
    id: 'm_fast_4b', providerId: 'prov_ollama', name: 'qwen3.5:4b', apiName: 'qwen3.5:4b', profileId: 'p',
    tokenizer: 'approx', contextWindow: 32768, practicalBudget: 16384, strategy: 'rolling', sizeClass: 'small',
    local: true, modalities: ['text'], strengths: ['chat'], typicalQ4GiB: 3.4, priceIn: 0, priceOut: 0, notes: '',
    parameterSize: '4B', family: 'qwen3', source: 'discovered', embedding: false, freeTier: null, enabled: true,
  } as never);
  built.store.upsertModel({
    id: 'm_main_35b', providerId: 'prov_llama', name: 'Qwen3.6-35B-A3B', apiName: 'qwen3.6-35b-a3b', profileId: 'p',
    tokenizer: 'approx', contextWindow: 32768, practicalBudget: 32768, strategy: 'rolling', sizeClass: 'large',
    local: true, modalities: ['text', 'code'], strengths: ['chat', 'code', 'reasoning'], typicalQ4GiB: 23, priceIn: 0, priceOut: 0, notes: '',
    parameterSize: '35B', family: 'qwen3', source: 'discovered', embedding: false, freeTier: null, enabled: true,
  } as never);
  const cur = built.store.getSettings();
  built.store.saveSettings({ ...cur, autoModels: { ...cur.autoModels, fast: 'qwen3.5:4b', main: 'qwen3.6-35b-a3b' } }, 'test', cur);

  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['w3', 'pass', 'test'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  const agent = (await built.app.inject({
    method: 'POST', url: '/api/agents', cookies,
    payload: { name: 'Coder', systemPrompt: 'Build carefully.', toolAllowlist: [], modelId: 'm_main_35b' },
  })).json().agent as { id: string; ownerId: string; workspacePath: string };
  initRepo(agent.workspacePath);
  const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
  built.store.updateSession(session.id, { mode: 'code' });
  return { ...built, agent, session: built.store.getSession(session.id)!, seen };
}

describe('wave 3 spawns 2.0: role-scoped helpers, live streaming, and worktree isolation', () => {
  it('scopes research and verify helpers to 4B noThink <=16K + tight tool menus and streams live step events', async () => {
    const events: LiveEvent[] = [];
    let parentStep = 0;
    const built = await setupWithFastAndMain((req) => {
      const allUsers = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
      // Child research helper turn (local README)
      if (allUsers.includes('Role: research') && allUsers.includes('Search local README')) {
        if (!req.messages.some((m) => m.role === 'tool')) {
          return { toolCalls: [{ id: 'hr1', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }] };
        }
        return { text: 'R'.repeat(3000) };
      }
      // Child verify helper turn
      if (allUsers.includes('Role: verify')) {
        return { text: 'PASS: exit 0' };
      }
      // Child web research helper turn
      if (allUsers.includes('Role: research') && allUsers.includes('docs online')) {
        return { text: 'Found online docs.' };
      }
      // Parent orchestration turns
      if (!allUsers.includes('background helper')) {
        if (parentStep === 0) {
          parentStep += 1;
          return {
            toolCalls: [{
              id: 'sp1', name: 'spawn_agent',
              arguments: JSON.stringify({ role: 'research', goal: 'Search local README', scope: 'README.md', done_when: 'Quote line 2', why: 'Check repo title', wait: true }),
            }],
          };
        }
        if (parentStep === 1) {
          parentStep += 1;
          return {
            toolCalls: [
              { id: 'sp2', name: 'spawn_agent', arguments: JSON.stringify({ role: 'verify', goal: 'Run echo check', wait: true }) },
              { id: 'sp3', name: 'spawn_agent', arguments: JSON.stringify({ role: 'research', goal: 'Find API docs online', wait: true }) },
            ],
          };
        }
      }
      return { text: 'All helpers reported back.' };
    });

    const off = built.bus.subscribeAll((ev) => {
      if (ev.type === 'helper') events.push(ev);
    });
    try {
      const run = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Run research and verify helpers',
        wait: true,
      });
      expect(run.status).toBe('completed');

      const fastReqs = built.seen.filter((r) => r.model === 'qwen3.5:4b');
      expect(fastReqs.length).toBeGreaterThanOrEqual(3);
      // Research (local): 4 tools only, noThink, <=16K ctx
      const localResearch = fastReqs[0]!;
      expect(localResearch.noThink).toBe(true);
      expect(localResearch.numCtx).toBeLessThanOrEqual(16_384);
      expect(new Set(localResearch.toolNames)).toEqual(new Set(['read_file', 'grep', 'glob', 'list_dir']));
      // Verify: 3 tools only, noThink, <=16K ctx
      const verifyReq = fastReqs.find((r) => r.toolNames.includes('shell'));
      expect(verifyReq, `Seen: ${JSON.stringify(built.seen)}`).toBeDefined();
      expect(verifyReq!.noThink).toBe(true);
      expect(verifyReq!.numCtx).toBeLessThanOrEqual(16_384);
      expect(new Set(verifyReq!.toolNames)).toEqual(new Set(['shell', 'read_file', 'grep']));
      // Research (web-mentioned): adds web_search + web_fetch
      const webResearch = fastReqs.find((r) => r.toolNames.includes('web_search'))!;
      expect(new Set(webResearch.toolNames)).toEqual(new Set(['read_file', 'grep', 'glob', 'list_dir', 'web_search', 'web_fetch']));

      // Result cap on research/verify helpers (2500 chars) + live progress events recorded
      const helpers = built.engine.autonomy.listHelpers(built.session.id);
      const localHelper = helpers.find((h) => h.task === 'Search local README')!;
      expect(localHelper.result?.length).toBe(2500);
      expect(localHelper.stepCount).toBe(1);
      expect(localHelper.recentSteps?.[0]?.tool).toBe('read_file');
      expect(localHelper.recentSteps?.[0]?.status).toBe('completed');
      expect(events.some((ev) => {
        const h = ev.helper as { currentStep?: string; stepCount?: number } | undefined;
        return h?.stepCount === 1 && typeof h?.currentStep === 'string';
      })).toBe(true);
    } finally {
      off();
      await built.app.close();
    }
  });

  it('isolates coder helpers in a git worktree: cleans up when clean, preserves and reports diff when dirty', async () => {
    let parentStep = 0;
    const built = await setupWithFastAndMain((req) => {
      const allUsers = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
      // Coder 1 (clean): read README only, do not edit
      if (allUsers.includes('Role: coder') && allUsers.includes('Inspect only')) {
        return { text: 'No edits needed.' };
      }
      // Coder 2 (dirty): write change in worktree
      if (allUsers.includes('Role: coder') && allUsers.includes('Modify README')) {
        if (!req.messages.some((m) => m.role === 'tool')) {
          return { toolCalls: [{ id: 'cw1', name: 'apply_patch', arguments: JSON.stringify({ path: 'README.md', search: 'alpha', replace: 'ALPHA_WT' }) }] };
        }
        return { text: 'Updated README in isolated worktree.' };
      }
      if (!allUsers.includes('background helper')) {
        if (parentStep === 0) {
          parentStep += 1;
          return { toolCalls: [{ id: 'sc1', name: 'spawn_agent', arguments: JSON.stringify({ role: 'coder', goal: 'Inspect only', wait: true }) }] };
        }
        if (parentStep === 1) {
          parentStep += 1;
          return { toolCalls: [{ id: 'sc2', name: 'spawn_agent', arguments: JSON.stringify({ role: 'coder', goal: 'Modify README', wait: true }) }] };
        }
      }
      return { text: 'Coder helpers complete.' };
    });

    try {
      const run = await built.engine.startTurn({
        sessionId: built.session.id,
        agentId: built.agent.id,
        content: 'Delegate coder work',
        wait: true,
      });
      expect(run.status).toBe('completed');

      const helpers = built.engine.autonomy.listHelpers(built.session.id);
      const cleanHelper = helpers.find((h) => h.task === 'Inspect only')!;
      const dirtyHelper = helpers.find((h) => h.task === 'Modify README')!;
      if (dirtyHelper.worktreePath) worktrees.push(dirtyHelper.worktreePath);

      // Clean worktree was removed on finish
      expect(cleanHelper.worktreePath).toBeNull();
      expect(fs.existsSync(path.join('/tmp/la-worktrees', cleanHelper.id))).toBe(false);

      // Dirty worktree was kept on disk, reported in result, and main repo remained untouched
      expect(dirtyHelper.worktreePath).toBe(path.join('/tmp/la-worktrees', dirtyHelper.id));
      expect(fs.existsSync(dirtyHelper.worktreePath!)).toBe(true);
      expect(dirtyHelper.result).toMatch(/\[worktree\] Isolated changes kept at \/tmp\/la-worktrees\//);
      expect(dirtyHelper.result).toMatch(/README\.md/);
      expect(fs.readFileSync(path.join(dirtyHelper.worktreePath!, 'README.md'), 'utf8')).toContain('ALPHA_WT');
      expect(fs.readFileSync(path.join(built.agent.workspacePath, 'README.md'), 'utf8')).toContain('alpha');
    } finally {
      await built.app.close();
    }
  });
});
