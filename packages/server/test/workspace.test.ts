import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { findContextTool, indexText, pptxText, zipNames } from '../src/files.js';
import { CONTEXT_MARK, expandMentions } from '../src/mentions.js';
import { githubRepoOf, redactUrl, validBranch } from '../src/gitops.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ws-')); dirs.push(dir); return dir; }
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

async function setup(fetchImpl?: typeof fetch) {
  const dir = tmp();
  const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl });
  const res = await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'owner', password: ['fixture', 'only', '03'].join('-') } });
  const cookies = { la_session: res.cookies.find((item) => item.name === 'la_session')!.value };
  return { ...built, dir, cookies };
}

/** A tiny zip with stored (uncompressed) entries, enough for the zip readers. */
function storedZip(entries: Record<string, string>) {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text); const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('files', () => {
  it('uploads, serves with ranges, searches, and deletes', async () => {
    const { app, store, cookies } = await setup();
    const agent = store.createAgent({ name: 'House', systemPrompt: 'x', toolAllowlist: [], workspacePath: tmp() });
    const session = store.createSession({ agentId: agent.id, title: 'Files' });
    const up = await app.inject({ method: 'POST', url: '/api/files', cookies, payload: { name: 'notes.md', contentBase64: Buffer.from('# Heron\nThe codename is BLUE HERON.').toString('base64'), sessionId: session.id } });
    expect(up.statusCode).toBe(200);
    const file = up.json().file;
    expect(file.mime).toBe('text/markdown');
    const raw = await app.inject({ method: 'GET', url: `/api/files/${file.id}/raw`, cookies });
    expect(raw.body).toContain('BLUE HERON');
    expect(raw.headers['content-security-policy']).toMatch(/sandbox/);
    const part = await app.inject({ method: 'GET', url: `/api/files/${file.id}/raw`, cookies, headers: { range: 'bytes=0-6' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('# Heron');
    const dl = await app.inject({ method: 'GET', url: `/api/files/${file.id}/raw?download=1`, cookies });
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    const html = await app.inject({ method: 'POST', url: '/api/files', cookies, payload: { name: 'x.html', contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64') } });
    const served = await app.inject({ method: 'GET', url: `/api/files/${html.json().file.id}/raw`, cookies });
    expect(served.headers['content-type']).toMatch(/^text\/plain/);
    const found = await app.inject({ method: 'GET', url: '/api/files?q=heron', cookies });
    expect(found.json().files.map((f: { id: string }) => f.id)).toEqual([file.id]);
    expect(found.json().files[0].snippet).toMatch(/BLUE HERON/);
    const ctx = await app.inject({ method: 'GET', url: '/api/context/search?q=heron', cookies });
    expect(ctx.json().files).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/files/${file.id}/raw`, cookies })).statusCode).toBe(404);
    await app.close();
  });

  it('indexes office and zip files', () => {
    const pptx = storedZip({ 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p><a:p><a:r><a:t>Q1 &amp; Q2</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide2.xml': '<a:p><a:t>Thanks</a:t></a:p>' });
    expect(pptxText(pptx)).toEqual(['Roadmap\nQ1 & Q2', 'Thanks']);
    expect(indexText('deck.pptx', pptx)).toMatch(/--- slide 2 ---\nThanks/);
    expect(zipNames(storedZip({ 'AndroidManifest.xml': 'x', 'classes.dex': 'y' }))).toEqual(['AndroidManifest.xml', 'classes.dex']);
    expect(indexText('app.apk', storedZip({ 'classes.dex': 'y' }))).toBe('classes.dex');
  });

  it('lets the agent find and cite earlier messages and files', async () => {
    const { app, store, dir } = await setup();
    const agent = store.createAgent({ name: 'House', systemPrompt: 'x', toolAllowlist: [], workspacePath: tmp() });
    const session = store.createSession({ agentId: agent.id, title: 'Cite' });
    const msg = store.insertMessage({ sessionId: session.id, role: 'assistant', content: 'The mini PC has 48 GB of RAM.', toolCallId: null, toolName: null, toolCalls: null, agentId: agent.id, runId: null, imageUrl: null, routingNote: null });
    const { saveFile } = await import('../src/files.js');
    const file = saveFile(store, dir, { name: 'specs.txt', bytes: Buffer.from('RAM: 48 GB\nGPU: 780M'), source: 'upload' });
    const tool = findContextTool();
    const ctx = { store, sessionId: session.id, agent } as never;
    const hits = await tool.execute({ query: '48 GB' }, ctx);
    expect(hits).toContain(`[msg:${msg.id}]`);
    expect(hits).toContain(`[file:${file.id}]`);
    expect(await tool.execute({ id: `[file:${file.id}#page=1]` }, ctx)).toContain('GPU: 780M');
    expect(await tool.execute({ id: msg.id }, ctx)).toContain('48 GB of RAM');
    await app.close();
  });
});

describe('@-mentions', () => {
  it('inlines folders as trees and files as bounded excerpts, saying when it cut', async () => {
    const { app, store, cookies } = await setup();
    const ws = tmp();
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
    fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(70_000));
    const agent = store.createAgent({ name: 'House', systemPrompt: 'x', toolAllowlist: [], workspacePath: ws });
    const root = `ws:${agent.id}`;
    const text = expandMentions(store, [{ kind: 'path', root, path: 'src' }, { kind: 'path', root, path: 'src/a.ts', start: 10, end: 12 }, { kind: 'path', root, path: 'big.txt' }, { kind: 'path', root, path: '../etc' }]);
    expect(text).toContain('a.ts');
    expect(text).toContain('line 10\nline 11\nline 12');
    expect(text).not.toContain('line 13\n');
    expect(text).toMatch(/Truncated/);
    expect(text).toMatch(/outside the workspace/);
    const tree = await app.inject({ method: 'GET', url: `/api/git/${encodeURIComponent(root)}/tree?path=src`, cookies });
    expect(tree.json().entries[0]).toMatchObject({ name: 'a.ts', path: 'src/a.ts', dir: false });
    const escape = await app.inject({ method: 'GET', url: `/api/git/${encodeURIComponent(root)}/file?path=../../etc/passwd`, cookies });
    expect(escape.statusCode).toBe(400);
    // Sent with a message, the context rides after a hidden marker.
    const session = store.createSession({ agentId: agent.id, title: 'Mention' });
    const sent = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies, payload: { content: 'Look at [@' + root + ':src/a.ts#L1-2]', mentions: [{ kind: 'path', root, path: 'src/a.ts', start: 1, end: 2 }] } });
    expect(sent.statusCode).toBe(200);
    const user = store.listMessages(session.id).find((m) => m.role === 'user')!;
    expect(user.content).toContain(CONTEXT_MARK);
    expect(user.content.split(CONTEXT_MARK)[1]).toContain('line 1\nline 2');
    await app.close();
  });
});

describe('git in workspaces', () => {
  it('clones a local remote, branches, commits, pushes, pulls, and guards main', async () => {
    const calls: { url: string; auth: string; body: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.authorization || ''), body: String(init?.body || '') });
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/demo/pull/7', number: 7 }), { status: 201 });
    }) as typeof fetch;
    const { app, store, cookies, vault } = await setup(fakeFetch);
    const remote = path.join(tmp(), 'demo.git');
    sh(path.dirname(remote), 'init', '--bare', '-b', 'main', remote);
    const seed = tmp();
    sh(seed, 'clone', remote, '.');
    fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
    sh(seed, 'add', '.'); sh(seed, 'commit', '-m', 'init'); sh(seed, 'push', 'origin', 'HEAD:main');

    store.createAgent({ name: 'Coder', systemPrompt: 'x', toolAllowlist: [], workspacePath: tmp() });
    const shop = await app.inject({ method: 'POST', url: '/api/workshops', cookies, payload: { name: 'Demo', projects: [{ label: 'seed', path: seed }] } });
    expect(shop.statusCode).toBe(200);
    const workshopId = shop.json().workshop?.id ?? shop.json().session?.workshopId;
    const clone = await app.inject({ method: 'POST', url: '/api/git/clone', cookies, payload: { url: remote, label: 'demo', workshopId } });
    expect(clone.statusCode).toBe(200);
    const roots = (await app.inject({ method: 'GET', url: '/api/git/roots', cookies })).json().roots as { id: string; workshops: string[] }[];
    expect(roots.find((r) => r.id === 'prj:demo')?.workshops).toEqual(['Demo']);
    const act = (payload: object) => app.inject({ method: 'POST', url: '/api/git/prj%3Ademo/action', cookies, payload });
    const clonePath = clone.json().path as string;
    fs.writeFileSync(path.join(clonePath, 'README.md'), 'hello\nworld\n');
    fs.writeFileSync(path.join(clonePath, 'new.txt'), 'brand new\n');
    let status = (await app.inject({ method: 'GET', url: '/api/git/prj%3Ademo/status', cookies })).json().status;
    expect(status.branch).toBe('main');
    expect(status.files.map((f: { path: string }) => f.path).sort()).toEqual(['README.md', 'new.txt']);
    const diff = (await app.inject({ method: 'GET', url: '/api/git/prj%3Ademo/diff?path=README.md', cookies })).json().diff;
    expect(diff).toContain('+world');
    expect((await app.inject({ method: 'GET', url: '/api/git/prj%3Ademo/diff?path=new.txt', cookies })).json().diff).toContain('+brand new');
    expect((await act({ action: 'commit', message: '' })).statusCode).toBe(400);
    expect((await act({ action: 'branch', name: 'feature/hello' })).statusCode).toBe(200);
    expect((await act({ action: 'commit', message: 'Say world' })).statusCode).toBe(200);
    const pushed = await act({ action: 'push' });
    expect(pushed.statusCode).toBe(200);
    expect(sh(remote, 'log', '--oneline', 'feature/hello')).toContain('Say world');
    // main is guarded
    await act({ action: 'checkout', name: 'main' });
    const guarded = await act({ action: 'push' });
    expect(guarded.statusCode).toBe(400);
    expect(guarded.json().error).toMatch(/explicit confirmation/);
    // pull fast-forwards a change made elsewhere
    sh(seed, 'pull', 'origin', 'main');
    fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), 'v1\n');
    sh(seed, 'add', '.'); sh(seed, 'commit', '-m', 'changelog'); sh(seed, 'push', 'origin', 'HEAD:main');
    expect((await act({ action: 'pull' })).statusCode).toBe(200);
    status = (await app.inject({ method: 'GET', url: '/api/git/prj%3Ademo/status', cookies })).json().status;
    expect(status.log[0].subject).toBe('changelog');
    // open a PR: needs a token, never echoes it
    await act({ action: 'checkout', name: 'feature/hello' });
    expect((await act({ action: 'open_pr', title: 'Hello' })).json().error).toMatch(/GITHUB_TOKEN/);
    const token = ['ghp', 'fixture', 'token', '0001'].join('_');
    vault.put({ name: 'GITHUB_TOKEN', value: token, actor: 'test' });
    await act({ action: 'remote', url: 'https://github.com/acme/demo.git' });
    const pr = await act({ action: 'open_pr', title: 'Hello', body: 'From the panel' });
    expect(pr.json().pr).toEqual({ url: 'https://github.com/acme/demo/pull/7', number: 7 });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/demo/pulls');
    expect(calls[0]!.auth).toBe(`Bearer ${token}`);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ head: 'feature/hello', base: 'main', title: 'Hello' });
    const rootsAfter = JSON.stringify((await app.inject({ method: 'GET', url: '/api/git/roots', cookies })).json());
    expect(rootsAfter).not.toContain(token);
    await app.close();
  });

  it('parses GitHub remotes and branch names', () => {
    expect(githubRepoOf('git@github.com:acid-code/local-agent.git')).toEqual({ owner: 'acid-code', repo: 'local-agent' });
    expect(githubRepoOf('https://github.com/acid-code/local-agent')).toEqual({ owner: 'acid-code', repo: 'local-agent' });
    expect(redactUrl('https://user:secret@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(validBranch('feature/x-1')).toBe(true);
    expect(validBranch('-rf')).toBe(false);
    expect(validBranch('a..b')).toBe(false);
  });
});
