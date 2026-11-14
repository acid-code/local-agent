import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { RULE_FILE_CAP, RULE_TOTAL_CAP, discoverRules, parseMdc, rulesBrief } from '../src/rules.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-rules-')); dirs.push(dir); return dir; };
const write = (root: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const pw = (tag: string) => ['fixture', tag, '13'].join('-');

function repo() {
  const root = tmp();
  write(root, 'AGENTS.md', 'AGENTS-RULE: run npm test before every commit.');
  write(root, 'CLAUDE.md', 'CLAUDE-RULE: prefer small pure functions.');
  write(root, '.cursorrules', 'CURSORRULES-RULE: use pnpm, never npm install -g.');
  write(root, '.github/copilot-instructions.md', 'COPILOT-RULE: write JSDoc on exports.');
  write(root, 'GEMINI.md', 'GEMINI-RULE: answer in British English.');
  write(root, '.windsurfrules', 'WINDSURF-RULE: no default exports.');
  write(root, '.clinerules/01-style.md', 'CLINE-RULE: two-space indent.');
  write(root, 'CONVENTIONS.md', 'AIDER-RULE: tests live next to code.');
  write(root, '.cursor/rules/always.mdc', '---\ndescription: Core style\nalwaysApply: true\n---\nMDC-ALWAYS: strict TypeScript.');
  write(root, '.cursor/rules/react.mdc', '---\ndescription: React components\nglobs: src/**/*.tsx, src/**/*.jsx\nalwaysApply: false\n---\nMDC-GLOB: function components only.');
  write(root, '.cursor/rules/db.mdc', '---\ndescription: How to write database migrations\nalwaysApply: false\n---\nMDC-MANUAL-BODY: never edit old migrations.');
  write(root, 'packages/api/CLAUDE.md', 'NESTED-RULE: API handlers validate with zod.');
  write(root, 'node_modules/x/CLAUDE.md', 'IGNORED-RULE');
  return root;
}

describe('project rule files', () => {
  it('finds every supported rule file and respects alwaysApply, globs and descriptions', () => {
    const root = repo();
    const rules = discoverRules([{ label: 'app', path: root }]);
    const files = rules.map((rule) => rule.file).sort();
    expect(files).toEqual(['.clinerules/01-style.md', '.cursor/rules/always.mdc', '.cursor/rules/db.mdc', '.cursor/rules/react.mdc', '.cursorrules', '.github/copilot-instructions.md', '.windsurfrules', 'AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md', 'GEMINI.md', 'packages/api/CLAUDE.md'].sort());
    const kind = (file: string) => rules.find((rule) => rule.file === file)!.kind;
    expect(kind('.cursor/rules/always.mdc')).toBe('always');
    expect(kind('.cursor/rules/react.mdc')).toBe('glob');
    expect(kind('.cursor/rules/db.mdc')).toBe('manual');
    expect(kind('packages/api/CLAUDE.md')).toBe('nested');
    const brief = rulesBrief(rules);
    for (const marker of ['AGENTS-RULE', 'CLAUDE-RULE', 'CURSORRULES-RULE', 'COPILOT-RULE', 'GEMINI-RULE', 'WINDSURF-RULE', 'CLINE-RULE', 'AIDER-RULE', 'MDC-ALWAYS', 'MDC-GLOB', 'NESTED-RULE']) expect(brief).toContain(marker);
    expect(brief).toContain('applies when working on files matching src/**/*.tsx, src/**/*.jsx');
    expect(brief).toContain('applies inside app/packages/api/');
    // Description-only rules are a menu: the description, not the body.
    expect(brief).toContain('How to write database migrations');
    expect(brief).not.toContain('MDC-MANUAL-BODY');
    expect(brief).not.toContain('IGNORED-RULE');
  });

  it('parses list-style globs and caps big files and the total', () => {
    expect(parseMdc('---\nglobs:\n  - "*.py"\n  - tests/**\n---\nbody').globs).toEqual(['*.py', 'tests/**']);
    const root = tmp();
    write(root, 'AGENTS.md', 'a'.repeat(RULE_FILE_CAP + 500));
    for (const name of ['CLAUDE.md', 'GEMINI.md', 'CONVENTIONS.md', '.windsurfrules']) write(root, name, 'b'.repeat(RULE_FILE_CAP));
    const brief = rulesBrief(discoverRules([{ label: 'big', path: root }]));
    expect(brief).toContain('500 more characters; read big/AGENTS.md');
    expect(brief.length).toBeLessThan(RULE_TOTAL_CAP + 1500);
    expect(brief).toMatch(/not loaded: rules budget used/);
  });
});

class CaptureProvider implements ModelProvider {
  systems: string[] = [];
  async *complete(req: { messages: ChatMessage[] }) {
    this.systems.push(String(req.messages.find((message) => message.role === 'system')?.content ?? ''));
    yield { type: 'token' as const, text: 'ok' };
    yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

describe('rules reach the coder', () => {
  it('puts the workspace rule files in the system prompt, lists them per chat, and honours the per-chat switch', async () => {
    const dir = tmp();
    const provider = new CaptureProvider();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, providerOverride: () => provider as unknown as ModelProvider });
    const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
    const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
    const member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
    const root = repo();
    expect((await built.app.inject({ method: 'POST', url: '/api/workspaces/folder', cookies: owner, payload: { path: root, label: 'app' } })).statusCode).toBe(200);
    const coder = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies: owner, payload: { name: 'Coder', systemPrompt: 'You are Coder.', toolAllowlist: ['read_file', 'apply_patch', 'shell', 'git'], modelId: 'model_rehearsal' } })).json().agent;
    const chat = (await built.app.inject({ method: 'POST', url: '/api/sessions', cookies: owner, payload: { agentId: coder.id, title: 'fix it' } })).json().session;
    expect((await built.app.inject({ method: 'PUT', url: `/api/sessions/${chat.id}/workspaces`, cookies: owner, payload: { items: [{ kind: 'root', id: 'prj:app' }] } })).statusCode).toBe(200);

    const run = await built.engine.startTurn({ sessionId: chat.id, agentId: coder.id, content: 'add a button' });
    await new Promise((resolve) => { const t = setInterval(() => { if (built.store.getRun(run.id)?.status === 'completed') { clearInterval(t); resolve(null); } }, 20); });
    const system = provider.systems.at(-1)!;
    for (const marker of ['AGENTS-RULE', 'CURSORRULES-RULE', 'MDC-ALWAYS', 'CLAUDE-RULE', 'NESTED-RULE']) expect(system).toContain(marker);

    const listed = (await built.app.inject({ method: 'GET', url: `/api/sessions/${chat.id}/rules`, cookies: owner })).json();
    expect(listed.rules).toHaveLength(12);
    const cursorrules = listed.rules.find((rule: { file: string }) => rule.file === '.cursorrules');
    expect(cursorrules).toMatchObject({ enabled: true, kind: 'always' });
    expect((await built.app.inject({ method: 'GET', url: `/api/sessions/${chat.id}/rules`, cookies: member })).statusCode).toBe(404);
    expect((await built.app.inject({ method: 'PUT', url: `/api/sessions/${chat.id}/rules`, cookies: member, payload: { key: cursorrules.key, enabled: false } })).statusCode).toBe(404);
    await built.app.inject({ method: 'PUT', url: `/api/sessions/${chat.id}/rules`, cookies: owner, payload: { key: cursorrules.key, enabled: false } });
    const run2 = await built.engine.startTurn({ sessionId: chat.id, agentId: coder.id, content: 'again' });
    await new Promise((resolve) => { const t = setInterval(() => { if (built.store.getRun(run2.id)?.status === 'completed') { clearInterval(t); resolve(null); } }, 20); });
    expect(provider.systems.at(-1)).not.toContain('CURSORRULES-RULE');
    expect(provider.systems.at(-1)).toContain('AGENTS-RULE');
  });
});
