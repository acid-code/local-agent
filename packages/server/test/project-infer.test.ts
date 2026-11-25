import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inferProject, projectPath } from '../src/workshops.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const roots = [{ label: 'api', path: '/data/ws/api' }, { label: 'web', path: '/data/ws/web' }];

describe('project inference from commands', () => {
  it('finds the one project a command points at', () => {
    expect(inferProject(roots, 'cd /data/ws/api && npm test')).toBe('api');
    expect(inferProject(roots, 'ls /data/ws/web/src')).toBe('web');
    expect(inferProject(roots, 'cd web && npm run build')).toBe('web');
    expect(inferProject(roots, 'git -C api status')).toBe('api');
    expect(inferProject(roots, 'npm --prefix ./api test')).toBe('api');
    expect(inferProject(roots, 'diff /data/ws/api/a /data/ws/web/a')).toBeUndefined();
    expect(inferProject(roots, 'npm test')).toBeUndefined();
    expect(inferProject(roots, 'ls /data/ws/apiary')).toBeUndefined();
    expect(inferProject(roots, 'echo webhook')).toBeUndefined();
  });

  it('projectPath uses the inference, paths inside a project, and still asks when unclear', () => {
    expect(projectPath(roots, undefined, '/ws', 'cd /data/ws/web && ls')).toBe('/data/ws/web');
    expect(projectPath(roots, '/data/ws/api/src', '/ws')).toBe('/data/ws/api');
    expect(projectPath(roots, 'api/src', '/ws')).toBe('/data/ws/api');
    expect(projectPath(roots, 'workspace', '/ws')).toBe('/ws');
    expect(() => projectPath(roots, undefined, '/ws', 'npm test')).toThrow(/Name the project/);
    expect(() => projectPath(roots, 'nope', '/ws')).toThrow(/Unknown project/);
  });

  it('infers cwd from existing files mentioned in the command when multiple projects are attached', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-proj-infer-'));
    dirs.push(tmp);
    const api = path.join(tmp, 'api');
    const web = path.join(tmp, 'web');
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(api, { recursive: true });
    fs.mkdirSync(web, { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'gta-game.html'), '<html></html>');
    fs.writeFileSync(path.join(api, 'only-in-api.js'), 'const a = 1;\n');
    const realRoots = [{ label: 'api', path: api }, { label: 'web', path: web }];

    expect(projectPath(realRoots, undefined, ws, "node -e \"fs.readFileSync('gta-game.html','utf8')\"")).toBe(ws);
    expect(projectPath(realRoots, undefined, ws, 'node --check only-in-api.js')).toBe(api);
    expect(() => projectPath(realRoots, undefined, ws, 'npm test')).toThrow(/Name the project/);
  });
});
