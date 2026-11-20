import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MACHINE_PROFILES, planInstall, profileFor } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { pullProgress } from '../src/routes.js';
import { choose } from '../src/runtime-bench.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const mini = MACHINE_PROFILES.find((row) => row.id === 'ryzen-780m-48g')!;

describe('model install plan', () => {
  it('detects the TG105 and fits its defaults under the 40 GB cap', () => {
    expect(profileFor({ cpu: 'AMD Ryzen 7 8745HS w/ Radeon 780M Graphics', ramGiB: 46 }).id).toBe('ryzen-780m-48g');
    expect(profileFor({ cpu: 'Intel i5', ramGiB: 16 }).id).toBe('generic-16g');
    const plan = planInstall(mini, {}, ['gemma3:4b']);
    expect(plan.fits).toBe(true);
    expect(plan.peakGiB).toBeLessThanOrEqual(40);
    expect(plan.pulls).toEqual(['gemma4:26b-a4b', 'gpt-oss:20b', 'embeddinggemma']);
    expect(plan.pulls).not.toContain('sdxl-turbo');
  });
  it('refuses choices that pass the cap and uses catalog sizes', () => {
    const plan = planInstall(mini, { fast: 'qwen3:32b' }, [], { 'qwen3:32b': 20 });
    expect(plan.fits).toBe(false);
    expect(plan.warnings[0]).toMatch(/cap/);
    expect(planInstall(mini, { coder: 'qwen3-coder:30b' }, [], { 'qwen3-coder:30b': 19 }).fits).toBe(true);
  });
  it('compacts pull progress to 10% steps', () => {
    const lines: string[] = [];
    const feed = pullProgress('m', (line) => lines.push(line));
    feed('{"status":"pulling manifest"}\n');
    for (const done of [0, 5, 12, 13, 55, 100]) feed(`{"status":"pulling abcdef123","total":100,"completed":${done}}\n`);
    feed('{"status":"success"}\n');
    expect(lines).toEqual(['m: pulling manifest\n', 'm: 0% of 0.0 GB\n', 'm: 10% of 0.0 GB\n', 'm: 50% of 0.0 GB\n', 'm: 100% of 0.0 GB\n', 'm: success\n']);
  });
  it('bench picks Vulkan only when clearly faster', () => {
    const machine = { cpu: 'x', ramGiB: 48, gpu: 'AMD Radeon 780M (RADV PHOENIX)', vulkan: 'AMD Radeon 780M (RADV PHOENIX)', rocm: null };
    expect(choose([{ runtime: 'ollama-cpu', ok: true, decodeTps: 20, promptTps: 60 }, { runtime: 'ollama-gpu', ok: true, decodeTps: 28, promptTps: 200, gpuShare: 1 }], machine).pick).toBe('ollama-vulkan');
    expect(choose([{ runtime: 'ollama-cpu', ok: true, decodeTps: 20, promptTps: 60 }, { runtime: 'ollama-gpu', ok: true, decodeTps: 21, promptTps: 70, gpuShare: 1 }], machine).pick).toBe('ollama-cpu');
  });
});

describe('install route', () => {
  it('pulls the missing models, then saves the role map', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-models-')); dirs.push(dir);
    const pulled: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }));
      if (url.endsWith('/api/pull')) {
        pulled.push(JSON.parse(String(init?.body)).name);
        return new Response('{"status":"pulling abcdef1","total":10,"completed":10}\n{"status":"success"}\n');
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: ['fixture', 'owner', '11'].join('-') } });
    const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
    const over = await app.inject({ method: 'POST', url: '/api/setup/profile/install', cookies, payload: { confirm: true, id: 'ryzen-780m-48g', choices: { main: 'qwen3:235b' } } });
    expect(over.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/setup/profile/install', cookies, payload: { confirm: true, id: 'ryzen-780m-48g', choices: { coder: 'qwen3-coder:30b' } } });
    expect(ok.statusCode).toBe(200);
    const jobId = ok.json().job.id as string;
    for (let i = 0; i < 50 && store.getJob(jobId)?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getJob(jobId)?.status).toBe('done');
    expect(pulled).toEqual(['gemma4:26b-a4b', 'qwen3-coder:30b', 'embeddinggemma']);
    const settings = store.getSettings();
    expect(settings.autoModels.coder).toBe('qwen3-coder:30b');
    expect(settings.ramBudgetGiB).toBe(40);
    expect(settings.modelProfile?.id).toBe('ryzen-780m-48g');
    await app.close();
  });
});
