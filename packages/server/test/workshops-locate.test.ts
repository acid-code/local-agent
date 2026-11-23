import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locatePath, projectPath } from '../src/workshops.js';
import { BUILTIN_TOOLS, type ToolContext } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-locate-'));
  dirs.push(dir);
  return dir;
}

describe('workshops path resolution and read_file fallback', () => {
  it('resolves repo labels case-insensitively and strips guessed container prefixes', () => {
    const base = tmp();
    const workspace = path.join(base, 'ws');
    const repo = path.join(base, 'repos', 'llama.cpp-apu-upgrade');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    const roots = [{ label: 'llama.cpp-apu-upgrade', path: repo }];

    expect(locatePath({ workspace, roots, target: 'Llama.cpp-apu-upgrade/README.md' })?.full).toBe(path.join(repo, 'README.md'));
    expect(locatePath({ workspace, roots, target: '/data/workspaces/projects/llama.cpp-apu-upgrade/README.md' })?.full).toBe(path.join(repo, 'README.md'));
    expect(locatePath({ workspace, roots, target: 'data/workspaces/projects/llama.cpp-APU-upgrade/README.md' })?.full).toBe(path.join(repo, 'README.md'));
    expect(locatePath({ workspace, roots, target: '/data/repos/Llama.cpp-apu-upgrade/README.md' })?.full).toBe(path.join(repo, 'README.md'));
    expect(locatePath({ workspace, roots, target: '/data/repos/llama.cpp-apu-upgrade/../../etc/passwd' })).toBeNull();

    const multi = [roots[0]!, { label: 'local-agent', path: path.join(base, 'repos', 'local-agent') }];
    expect(projectPath(multi, 'Llama.cpp-APU-Upgrade', workspace)).toBe(repo);
    expect(projectPath(multi, '/data/repos/Llama.cpp-apu-upgrade/src', workspace)).toBe(repo);
  });

  it('returns directory contents when read_file is called on a directory instead of EISDIR', async () => {
    const base = tmp();
    const repo = path.join(base, 'llama.cpp-apu-upgrade');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');

    const readTool = BUILTIN_TOOLS.find((t) => t.name === 'read_file')!;
    const out = await readTool.execute(
      { path: '/data/repos/llama.cpp-apu-upgrade' },
      { workspace: base, roots: [{ label: 'llama.cpp-apu-upgrade', path: repo }] } as unknown as ToolContext,
    );
    expect(out).toContain('Directory /data/repos/llama.cpp-apu-upgrade');
    expect(out).toContain('dir  src');
    expect(out).toContain('file README.md');
  });
});
