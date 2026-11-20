import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { turboInspectTool, vercelTool } from '../src/vercel.js';
import type { ToolContext } from '../src/tools.js';

function makeCtx(workspace: string, fetchImpl?: typeof fetch, secrets: Record<string, string> = {}): ToolContext {
  return {
    agent: { id: 'a1', ownerId: 'owner', name: 'Coder', workspacePath: workspace } as ToolContext['agent'],
    workspace,
    signal: new AbortController().signal,
    docker: {} as ToolContext['docker'],
    fetchImpl: fetchImpl ?? (async () => new Response('{}', { status: 200 })),
    searxngUrl: '',
    sandbox: 'local',
    store: {} as ToolContext['store'],
    depth: 0,
    secretEnv: () => secrets,
    roots: [{ label: 'repo', path: workspace, write: true }],
  };
}

describe('vercel + turbo tools', () => {
  it('turbo_inspect flags missing BLOB_READ_WRITE_TOKEN in turbo.json and next.config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-turbo-'));
    try {
      fs.writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ tasks: { build: { outputs: ['.next/**'] } } }));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mono', devDependencies: { turbo: '^2.3.0' }, scripts: { build: 'turbo build' } }));
      fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ name: 'web', scripts: { build: 'next build' } }));
      fs.writeFileSync(path.join(dir, 'apps/web/next.config.mjs'), 'export default { reactStrictMode: true };');

      const out = await turboInspectTool().execute({}, makeCtx(dir));
      expect(out).toContain('Turbo v2 `tasks`');
      expect(out).toContain('BLOB_READ_WRITE_TOKEN');
      expect(out).toContain('blob.vercel-storage.com');
      expect(out).toContain('apps/web');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('vercel gates writes with approval and reads deployment logs + env vars', async () => {
    const tool = vercelTool();
    expect(tool.mutates({ action: 'list_projects' })).toBe(false);
    expect(tool.approval({ action: 'list_projects' })).toBeNull();
    expect(tool.mutates({ action: 'set_env' })).toBe(true);
    expect(tool.approval({ action: 'set_env', key: 'BLOB_READ_WRITE_TOKEN', project: 'my-app' })).toContain('BLOB_READ_WRITE_TOKEN');
    expect(tool.approval({ action: 'redeploy', project: 'my-app' })).toContain('redeploy');

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/v9/projects/my-app/env')) {
        return new Response(JSON.stringify({ envs: [{ id: 'e1', key: 'DATABASE_URL', type: 'encrypted', target: ['production'] }] }), { status: 200 });
      }
      if (url.includes('/v13/deployments/dpl_1')) {
        return new Response(JSON.stringify({ id: 'dpl_1', readyState: 'ERROR', url: 'my-app.vercel.app', errorCode: 'BUILD_FAILED', errorMessage: 'Missing BLOB_READ_WRITE_TOKEN' }), { status: 200 });
      }
      if (url.includes('/v3/deployments/dpl_1/events')) {
        return new Response(JSON.stringify([{ created: 1700000000000, type: 'stderr', payload: { text: 'Error: Vercel Blob: No token found' } }]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-vercel-'));
    try {
      const ctx = makeCtx(dir, mockFetch, { VERCEL_TOKEN: 'vcp_test_123' });
      const envOut = await tool.execute({ action: 'list_env', project: 'my-app' }, ctx);
      expect(envOut).toContain('DATABASE_URL');
      expect(envOut).toContain('No BLOB_READ_WRITE_TOKEN');

      const logOut = await tool.execute({ action: 'get_deployment_logs', deploymentId: 'dpl_1' }, ctx);
      expect(logOut).toContain('BUILD_FAILED');
      expect(logOut).toContain('Vercel Blob: No token found');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
