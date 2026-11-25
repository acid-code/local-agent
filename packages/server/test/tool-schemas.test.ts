import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkOrRepair, mergeToolParameters, toolArgumentsSchema } from '../src/contracts.js';
import { CODING_TOOLS } from '../src/coding.js';
import { argumentsError } from '../src/engine.js';
import { toolsFor, type ToolContext } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Props = Record<string, { type?: string; description?: string; enum?: string[] }>;
const toolOf = (name: string) => [...toolsFor([name]), ...CODING_TOOLS].find((tool) => tool.name === name)!;
const own = (name: string) => toolOf(name).parameters;
const offered = (name: string) => mergeToolParameters(name, own(name)) as { properties: Props; required?: string[] };

describe('tool schemas the model sees', () => {
  it('read_file offers startLine and endLine, with descriptions', () => {
    const schema = offered('read_file');
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['path', 'startLine', 'endLine']));
    expect(schema.properties.startLine!.description).toMatch(/1-based/);
    expect(schema.required).toEqual(['path']);
  });

  it('read_file keeps startLine and endLine through the contract check (they used to be stripped)', async () => {
    const checked = await checkOrRepair(toolArgumentsSchema('read_file'), { path: 'big.ts', startLine: 400, endLine: '613' }, async () => { throw new Error('no repair'); });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value).toMatchObject({ path: 'big.ts', startLine: 400, endLine: 613 });
  });

  it('unknown arguments are passed through to the tool, not dropped', async () => {
    const checked = await checkOrRepair(toolArgumentsSchema('shell'), { command: 'ls', timeoutSec: 5 }, async () => ({}));
    expect(checked.ok && (checked.value as Record<string, unknown>).timeoutSec).toBe(5);
  });

  it('plan has real fields instead of an empty object, and no arguments reads the plan', async () => {
    const schema = offered('plan');
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['items', 'itemId', 'status', 'text']));
    expect(schema.properties.items!.type).toBe('array');
    expect((await checkOrRepair(toolArgumentsSchema('plan'), {}, async () => ({}))).ok).toBe(true);
    expect((await checkOrRepair(toolArgumentsSchema('plan'), { itemId: 'p1', status: 'done' }, async () => ({}))).ok).toBe(true);
  });

  it('keeps tool and contract descriptions and the contract enum', () => {
    expect(offered('shell').properties.cwd!.description).toMatch(/project/i);
    const git = offered('git');
    expect(git.properties.action!.enum).toContain('open_pr');
    expect(git.properties.project!.description).toBeTruthy();
    expect(offered('list_dir').properties.path!.description).toBeTruthy();
  });

  it('every contract-backed core tool exposes each field its own schema declared', () => {
    for (const name of ['read_file', 'shell', 'git', 'apply_patch', 'plan', 'web_search', 'web_fetch', 'write_file', 'create_file']) {
      const mine = Object.keys((own(name) as { properties?: Props }).properties ?? {});
      const shown = Object.keys(offered(name).properties);
      for (const key of mine) expect(shown, `${name}.${key}`).toContain(key);
    }
  });

  it('documents practical and hard size limits directly in tool descriptions', () => {
    expect(toolOf('write_file').description).toMatch(/150 lines|append=true/i);
    expect(toolOf('create_file').description).toMatch(/150 lines|append=true/i);
    expect(toolOf('shell').description).toMatch(/4,000/);
    expect(toolOf('read_file').description).toMatch(/400 lines|16,000/);
  });

  it('supports append=true on write_file and create_file while keeping the >100-line overwrite guard', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-append-'));
    dirs.push(dir);
    const ctx = { workspace: dir } as unknown as ToolContext;
    const writeTool = toolOf('write_file');
    const createTool = toolOf('create_file');

    const initial = `${Array.from({ length: 110 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
    await createTool.execute({ path: 'game.html', content: initial }, ctx);

    await expect(writeTool.execute({ path: 'game.html', content: 'replaced' }, ctx)).rejects.toThrow(/already has 111 lines/i);

    const out = await writeTool.execute({ path: 'game.html', content: 'appended line\n', append: true }, ctx);
    expect(out).toMatch(/Appended 14 bytes/i);
    const finalText = fs.readFileSync(path.join(dir, 'game.html'), 'utf8');
    expect(finalText.endsWith('line 110\nappended line\n')).toBe(true);

    const out2 = await createTool.execute({ path: 'new-append.txt', content: 'first ', append: true }, ctx);
    expect(out2).toMatch(/Appended 6 bytes/i);
    expect(fs.readFileSync(path.join(dir, 'new-append.txt'), 'utf8')).toBe('first ');
  });

  it('gives actionable limit errors for oversized shell commands and truncated large tool JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-shell-limit-'));
    dirs.push(dir);
    const ctx = { workspace: dir } as unknown as ToolContext;
    await expect(toolOf('shell').execute({ command: 'x'.repeat(4001) }, ctx)).rejects.toThrow(/4,000 chars.*append=true/i);

    const msg = argumentsError('create_file', `{"content":"${'x'.repeat(12000)}`, 1)!;
    expect(msg).toMatch(/TRUNCATED BY OUTPUT LIMIT/i);
    expect(msg).toMatch(/append: true/i);
    expect(msg).toMatch(/modular files/i);
  });
});
