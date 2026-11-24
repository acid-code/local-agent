import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Store } from '../src/db.js';
import { DockerCtl } from '../src/docker.js';
import { CODING_TOOLS, applySearchReplace, findClosestBlock, runGrep, walkNames } from '../src/coding.js';
import { BUILTIN_TOOLS, READ_FILE_MAX_CHARS, extractFileOutline, setFocusTool } from '../src/tools.js';
import { groupWork, type WorkMessage } from '../../web/src/lib/work-steps.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCtx(dir: string) {
  const store = new Store(path.join(dir, 'db.sqlite'));
  const agent = store.createAgent({ name: 'Coder', systemPrompt: 'test', toolAllowlist: [], workspacePath: dir });
  const session = store.createSession({ agentId: agent.id, mode: 'code' });
  const run = store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'tools', turn: 0 } });
  const ctx = {
    agent,
    workspace: dir,
    signal: new AbortController().signal,
    docker: new DockerCtl('/nonexistent.sock'),
    fetchImpl: fetch,
    searxngUrl: '',
    sandbox: 'host' as const,
    store,
    depth: 0,
    sessionId: session.id,
    runId: run.id,
  };
  return { store, agent, session, run, ctx };
}

describe('wave 1 tools & visibility', () => {
  it('enforces char cap, extractFileOutline, and outlineOnly on read_file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-w1-read-'));
    dirs.push(dir);
    const { store, ctx } = makeCtx(dir);
    try {
      const readTool = BUILTIN_TOOLS.find((t) => t.name === 'read_file')!;
      const lines = [
        '# Top Heading',
        ...Array.from({ length: 180 }, (_, i) => `Line ${i + 1}: ` + 'x'.repeat(160)),
        '## Target Section',
        ...Array.from({ length: 40 }, (_, i) => `Detail ${i}: ok`),
      ];
      const file = path.join(dir, 'big.md');
      fs.writeFileSync(file, lines.join('\n'), 'utf8');

      const outOnly = await readTool.execute({ path: 'big.md', outlineOnly: true }, ctx);
      expect(outOnly).toContain('L1: # Top Heading');
      expect(outOnly).toContain('L182: ## Target Section');
      expect(outOnly).not.toContain('Detail 0: ok');

      const fullCapped = await readTool.execute({ path: 'big.md' }, ctx);
      expect(fullCapped.length).toBeLessThanOrEqual(READ_FILE_MAX_CHARS + 1200);
      expect(fullCapped).toContain('Outline:');
      expect(fullCapped).toContain('L182: ## Target Section');
      expect(fullCapped).toContain('pass startLine=');

      const slice = await readTool.execute({ path: 'big.md', startLine: 182, endLine: 190 }, ctx);
      expect(slice).toContain('182: ## Target Section');

      const tsCode = 'export function alpha() {}\nexport class Beta {}\n';
      expect(extractFileOutline(tsCode, 'a.ts')).toContain('L1: export function alpha()');
      expect(extractFileOutline(tsCode, 'a.ts')).toContain('L2: export class Beta');
    } finally {
      store.close();
    }
  });

  it('upgrades grep (include, filesOnly, context, total count) and glob (skips vendor dirs)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-w1-grep-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'alpha line\nneedle here\nomega line\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'src/b.md'), 'needle markdown\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/c.ts'), 'needle vendor\n', 'utf8');

    const tsHits = await runGrep(dir, 'needle', { include: '*.ts', context: 1 });
    expect(tsHits).toContain('src/a.ts:2: needle here');
    expect(tsHits).toContain('alpha line');
    expect(tsHits).not.toContain('src/b.md');
    expect(tsHits).not.toContain('node_modules');

    const filesOnly = await runGrep(dir, 'needle', { filesOnly: true });
    expect(filesOnly.split('\n').sort()).toEqual(['src/a.ts', 'src/b.md']);

    const globTs = await walkNames(dir, '**/*.ts', 50);
    expect(globTs).toEqual(['src/a.ts']);
  });

  it('provides closest-match hints in applySearchReplace and guards >100-line overwrite in write_file', async () => {
    const before = [
      'function one() {',
      '  return 1;',
      '}',
      'function two(x: number) {',
      '  const doubled = x * 2;',
      '  return doubled + 1;',
      '}',
    ].join('\n');
    const closest = findClosestBlock(before, 'function two(x: number) {\n  const tripled = x * 3;\n  return doubled + 1;\n}');
    expect(closest).toBeTruthy();
    expect(closest!.snippet).toContain('4: function two');

    expect(() => applySearchReplace(before, 'function two(x: number) {\n  const tripled = x * 3;\n  return doubled + 1;\n}', 'x'))
      .toThrow(/Closest match is lines/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-w1-write-'));
    dirs.push(dir);
    const { store, ctx } = makeCtx(dir);
    try {
      const writeTool = BUILTIN_TOOLS.find((t) => t.name === 'write_file')!;
      const patchTool = CODING_TOOLS.find((t) => t.name === 'apply_patch')!;
      expect(patchTool).toBeTruthy();
      const bigFile = path.join(dir, 'large.ts');
      fs.writeFileSync(bigFile, Array.from({ length: 120 }, (_, i) => `const v${i} = ${i};`).join('\n'), 'utf8');

      await expect(writeTool.execute({ path: 'large.ts', content: 'replaced' }, ctx)).rejects.toThrow(/Use apply_patch/);
      const ok = await writeTool.execute({ path: 'large.ts', content: 'replaced', overwrite: true }, ctx);
      expect(ok).toContain('Wrote');
    } finally {
      store.close();
    }
  });

  it('set_focus notifies context and work-steps captures why intent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-w1-focus-'));
    dirs.push(dir);
    const { store, ctx } = makeCtx(dir);
    const bus = new Bus();
    void bus;
    try {
      let seen: { focus?: string; phase?: string } = {};
      const focusTool = setFocusTool();
      const res = await focusTool.execute(
        { focus: 'Inspecting auth flow', phase: 'investigating' },
        { ...ctx, setFocus: (focus, phase) => { seen = { focus, phase }; } },
      );
      expect(res).toContain('Inspecting auth flow');
      expect(seen).toEqual({ focus: 'Inspecting auth flow', phase: 'investigating' });

      const msgs: WorkMessage[] = [
        { id: 'a1', role: 'assistant', content: '', runId: 'r1', toolCalls: [{ id: 'c1', name: 'shell', arguments: '{"command":"npm test","why":"Verify server test suite"}' }] },
        { id: 't1', role: 'tool', content: 'exit 0', toolCallId: 'c1', toolName: 'shell', runId: 'r1' },
      ];
      const grouped = groupWork(msgs)[0];
      expect(grouped?.kind).toBe('work');
      if (grouped?.kind === 'work') {
        expect(grouped.rows[0]).toMatchObject({ type: 'step', why: 'Verify server test suite' });
      }
    } finally {
      store.close();
    }
  });
});
