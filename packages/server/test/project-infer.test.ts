import { describe, expect, it } from 'vitest';
import { inferProject, projectPath } from '../src/workshops.js';

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
});
