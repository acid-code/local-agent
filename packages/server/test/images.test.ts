import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_MODELS, imageCatalog } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { chooseBackend, generateImage, mockPng, sdArgs } from '../src/images.js';
import { pickRunnerAsset } from '../src/image-install.js';
import { untarFirst } from '../src/docker.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const dirs: string[] = [];
const savedKey = process.env.GEMINI_API_KEY;
beforeEach(() => { delete process.env.LA_IMAGE_MOCK; delete process.env.GEMINI_API_KEY; });
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.LA_IMAGE_MOCK;
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
});
const pw = (tag: string) => ['fixture', 'only', tag].join('-');
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });

async function setup(opts: { cloud?: boolean; fetchImpl?: typeof fetch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-img-')); dirs.push(dir);
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: opts.fetchImpl });
  const owner = cookieOf(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
  const created = await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', password: pw('member'), limits: { cloud: opts.cloud ?? true } } });
  const memberId = created.json().member.id as string;
  const member = cookieOf(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
  return { ...built, dir, owner, member, memberId };
}

const cfg = DEFAULT_SETTINGS.imageGen;

describe('image role routing', () => {
  it('auto prefers local, then Gemini, and respects the per-account Gemini limit', () => {
    expect(chooseBackend(cfg, 'auto', { localReady: true, cloudAllowed: true, keyed: true })).toMatchObject({ backend: 'local', slow: true });
    expect(chooseBackend(cfg, 'auto', { localReady: false, cloudAllowed: true, keyed: true }).backend).toBe('gemini');
    expect(chooseBackend(cfg, 'auto', { localReady: false, cloudAllowed: false, keyed: true })).toMatchObject({ backend: null });
    expect(chooseBackend(cfg, 'gemini', { localReady: true, cloudAllowed: false, keyed: true }).reason).toMatch(/not allowed/);
    expect(chooseBackend({ ...cfg, mode: 'off' }, 'auto', { localReady: true, cloudAllowed: true, keyed: true }).backend).toBeNull();
    expect(chooseBackend({ ...cfg, mode: 'gemini' }, 'auto', { localReady: true, cloudAllowed: true, keyed: true }).backend).toBe('gemini');
  });

  it('builds stable-diffusion.cpp arguments from the catalog, FLUX included', () => {
    const flux = IMAGE_MODELS.find((spec) => spec.id === 'flux-schnell')!;
    const args = sdArgs('/d', flux);
    expect(args).toEqual(expect.arrayContaining(['--diffusion-model', '--vae', '--clip_l', '--t5xxl', '--vae-tiling']));
    expect(sdArgs('/d', IMAGE_MODELS[0]!).slice(0, 2)).toEqual(['-m', path.join('/d', 'image', 'models', 'sd_turbo-f16-q8_0.gguf')]);
    expect(imageCatalog([{ ...IMAGE_MODELS[0]!, id: 'my-model', name: 'Mine' }]).map((spec) => spec.id)).toContain('my-model');
    expect(imageCatalog([{ ...IMAGE_MODELS[0]! }]).length).toBe(IMAGE_MODELS.length);
  });

  it('picks the right prebuilt runner and reads a tar', () => {
    const names = ['sd-master-x-bin-Linux-Ubuntu-26.04-x86_64.zip', 'sd-master-x-bin-Linux-Ubuntu-26.04-x86_64-vulkan.zip', 'sd-master-x-bin-win-cpu-x64.zip', 'sd-master-x-bin-win-vulkan-x64.zip', 'sd-master-x-bin-Darwin-macOS-26-arm64.zip'];
    expect(pickRunnerAsset(names, 'linux', 'x64', false)).toBe(names[0]);
    expect(pickRunnerAsset(names, 'linux', 'x64', true)).toBe(names[1]);
    expect(pickRunnerAsset(names, 'win32', 'x64', false)).toBe(names[2]);
    expect(pickRunnerAsset(names, 'darwin', 'arm64', false)).toBe(names[4]);
    const header = Buffer.alloc(512); header.write('sd-cli'); header.write('00000000005\0', 124); header[156] = 48;
    const tar = Buffer.concat([header, Buffer.from('hello'), Buffer.alloc(507), Buffer.alloc(1024)]);
    expect(untarFirst(tar)?.toString()).toBe('hello');
  });

  it('mock runner draws a valid PNG', () => {
    const png = mockPng('a cat', 64, 48);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(64);
  });
});

describe('image generation per account', () => {
  it('saves to the member\'s own files, and the owner cannot see it', async () => {
    process.env.LA_IMAGE_MOCK = '1';
    const { app, dir, owner, member, memberId } = await setup();
    const made = await app.inject({ method: 'POST', url: '/api/images/generate', cookies: member, payload: { prompt: 'a pastel cat in a teacup' } });
    expect(made.statusCode).toBe(200);
    const body = made.json();
    expect(body.backend).toBe('local');
    const raw = await app.inject({ method: 'GET', url: `/api/files/${body.file.id}/raw`, cookies: member });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toMatch(/image\/png/);
    expect((await app.inject({ method: 'GET', url: `/api/files/${body.file.id}/raw`, cookies: owner })).statusCode).toBe(404);
    const stored = fs.readdirSync(path.join(dir, 'users', memberId, 'files'), { recursive: true }).map(String);
    expect(stored.some((name) => name.endsWith('.png'))).toBe(true);
  });

  it('a member with Gemini off gets no cloud image, even with a key', async () => {
    process.env.GEMINI_API_KEY = 'fixture-not-a-key';
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    const { app, member } = await setup({ cloud: false, fetchImpl });
    const res = await app.inject({ method: 'POST', url: '/api/images/generate', cookies: member, payload: { prompt: 'x', backend: 'gemini' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toMatch(/not allowed/);
    expect(called).toBe(false);
    const status = (await app.inject({ method: 'GET', url: '/api/images/status', cookies: member })).json();
    expect(status.gemini.allowed).toBe(false);
    expect(status.admin).toBeUndefined();
  });

  it('Gemini images count against the shared quota and stop at the limit', async () => {
    process.env.GEMINI_API_KEY = 'fixture-not-a-key';
    const png = mockPng('g', 8, 8).toString('base64');
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toContain(':generateContent');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const { app, store, owner, member } = await setup({ fetchImpl });
    store.saveSettings({ ...store.getSettings(), quotaLimits: { 'gemini-2.5-flash-image': { rpd: 2 } } }, 'test', {});
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: '/api/images/generate', cookies: i ? owner : member, payload: { prompt: 'sunset' } })).json().backend).toBe('gemini');
    const third = await app.inject({ method: 'POST', url: '/api/images/generate', cookies: member, payload: { prompt: 'sunset' } });
    expect(third.json().error).toMatch(/quota/);
    expect((await app.inject({ method: 'GET', url: '/api/me/quota', cookies: member })).json().image).toMatchObject({ remaining: 0, limit: 2 });
  });

  it('only the owner manages image models; extra models can be added in settings', async () => {
    const { app, owner, member } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/images/image', cookies: member })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/images/image/download', cookies: member, payload: { id: 'sd-turbo' } })).statusCode).toBe(403);
    const extra = { ...IMAGE_MODELS[0]!, id: 'tiny-sd', name: 'Tiny SD' };
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', cookies: owner, payload: { imageGen: { extraModels: [extra] } } })).statusCode).toBe(200);
    const state = (await app.inject({ method: 'GET', url: '/api/images/image', cookies: owner })).json();
    expect(state.catalog.map((spec: { id: string }) => spec.id)).toEqual(expect.arrayContaining(['sd-turbo', 'sdxl-turbo', 'flux-schnell', 'tiny-sd']));
    const flux = state.catalog.find((spec: { id: string }) => spec.id === 'flux-schnell');
    expect(flux.gated).toBe(true);
    expect(flux.totalBytes).toBeGreaterThan(10 * 1024 ** 3);
    // Gated model without a token explains how to get one instead of starting.
    const gated = await app.inject({ method: 'POST', url: '/api/images/image/download', cookies: owner, payload: { id: 'flux-schnell' } });
    expect(gated.statusCode).toBe(400);
    expect(gated.json().error).toMatch(/HF_TOKEN/);
    const bad = await app.inject({ method: 'PATCH', url: '/api/settings', cookies: owner, payload: { imageGen: { extraModels: [{ ...extra, files: [{ role: 'model', repo: 'a/b', file: '../../etc/passwd', bytes: 1 }] }] } } });
    expect(bad.statusCode).toBe(400);
  });

  it('the /image command and the generate_image tool reach the same pipeline', async () => {
    process.env.LA_IMAGE_MOCK = '1';
    const { app, store, engine, member } = await setup();
    const agent = (await app.inject({ method: 'GET', url: '/api/agents', cookies: member })).json().agents[0];
    const session = (await app.inject({ method: 'POST', url: '/api/sessions', cookies: member, payload: { agentId: agent.id } })).json().session;
    await engine.startTurn({ sessionId: session.id, agentId: agent.id, content: '/image a strawberry cake with sprinkles', wait: true });
    const reply = store.listMessages(session.id).find((message) => message.role === 'assistant');
    expect(reply?.content).toMatch(/\[file:file_[\w]+\]/);
    const tools = (engine as unknown as { tools: (...args: unknown[]) => { name: string }[] }).tools(store.getAgent(agent.id), undefined, undefined, undefined, false, undefined, true);
    expect(tools.map((tool) => tool.name)).toContain('generate_image');
  });
});

describe('wallpapers', () => {
  it('are stored per account under users/<id> and checked by content', async () => {
    const { app, dir, owner, member, memberId } = await setup();
    const png = mockPng('wall', 16, 16).toString('base64');
    expect((await app.inject({ method: 'POST', url: '/api/me/wallpaper', cookies: member, payload: { contentBase64: png } })).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'users', memberId, 'wallpaper.png'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/me/wallpaper', cookies: member })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me/wallpaper', cookies: owner })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/me/wallpaper', cookies: member, payload: { contentBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/me/theme', cookies: member, payload: { preset: 'sakura', wallpaper: 'cherry-blossom', wallpaperMode: 'scene', wallpaperOpacity: 0.6, wallpaperBlur: 4, wallpaperDim: 0.3 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/me/wallpaper', cookies: member })).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'users', memberId, 'wallpaper.png'))).toBe(false);
  });
});
