import { describe, expect, it } from 'vitest';
import { checkOrRepair, mergeToolParameters, toolArgumentsSchema } from '../src/contracts.js';
import { CODING_TOOLS } from '../src/coding.js';
import { toolsFor } from '../src/tools.js';

type Props = Record<string, { type?: string; description?: string; enum?: string[] }>;
const own = (name: string) => [...toolsFor([name]), ...CODING_TOOLS].find((tool) => tool.name === name)!.parameters;
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
});
