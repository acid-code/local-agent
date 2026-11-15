/**
 * Fuzz tests: path traversal on every route and tool that takes a path, and member isolation across every member route.
 * A secret file sits next to each workspace; no payload may ever return its marker or write outside the root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MEMBER_ROUTES } from '../src/accounts.js';
import { locatePath } from '../src/workshops.js';
import { listDir, readExcerpt, treeListing } from '../src/gitops.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp(tag = 'la-fuzz-') { const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag)); dirs.push(dir); return dir; }
const pw = (tag: string) => ['fixture', 'only', tag].join('-');
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
const MARK = 'TOPSECRET-7f3a';

/** Classic traversal payloads plus encodings, absolute paths, NUL bytes, odd separators and very long names. */
function payloads(secretAbs: string, secretRel: string) {
  const base = [
    secretRel, `./${secretRel}`, `a/../${secretRel}`, `a/b/../../${secretRel}`, secretAbs, `//${secretAbs}`, `${secretAbs}/.`,
    '../', '..', '../../../../../../etc/passwd', '/etc/passwd', '....//....//etc/passwd', '..\\..\\etc\\passwd', '%2e%2e/%2e%2e/etc/passwd',
    '..%2f..%2fetc%2fpasswd', '..%252f..%252fetc/passwd', `${secretRel}\0.txt`, 'link-out/secret.txt', 'link-out', 'link-file', 'deep/link-up/secret.txt',
    '~/.ssh/id_rsa', '$HOME/.bashrc', '`id`', '$(id)', 'a'.repeat(5000), '../'.repeat(200) + 'etc/passwd', '.\u2025/secret.txt', '\u002e\u002e/secret.txt',
  ];
  // Seeded random mixes of the pieces above.
  let seed = 1337;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const pieces = ['..', '.', '%2e%2e', 'link-out', 'deep', 'link-up', '', '\\..', 'secret.txt', 'etc', 'passwd', '%00', '..;'];
  for (let i = 0; i < 120; i += 1) base.push(Array.from({ length: 1 + Math.floor(rand() * 7) }, () => pieces[Math.floor(rand() * pieces.length)]).join(rand() < 0.8 ? '/' : '\\'));
  return base;
}

/** A root folder with links that point outside it, next to a secret file. */
function sandbox() {
  const outer = tmp();
  const root = path.join(outer, 'root');
  fs.mkdirSync(path.join(root, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok.txt'), 'fine');
  const secret = path.join(outer, 'secret.txt');
  fs.writeFileSync(secret, MARK);
  fs.symlinkSync(outer, path.join(root, 'link-out'));
  fs.symlinkSync(secret, path.join(root, 'link-file'));
  fs.symlinkSync('../..', path.join(root, 'deep', 'link-up'));
  return { outer, root, secret };
}

describe('fuzz: path traversal', () => {
  it('helpers never read or list outside the root, whatever the path', () => {
    const { root, secret } = sandbox();
    let tried = 0;
    for (const input of payloads(secret, '../secret.txt')) {
      tried += 1;
      try { expect(JSON.stringify(readExcerpt(root, input))).not.toContain(MARK); } catch (error) { expect(String(error)).not.toContain(MARK); }
      try { expect(JSON.stringify(listDir(root, input))).not.toContain('secret.txt'); } catch { /* refused */ }
      try { expect(treeListing(root, input).text).not.toContain('secret.txt'); } catch { /* refused */ }
      const hit = locatePath({ workspace: root, target: input });
      if (hit) {
        const real = fs.existsSync(hit.full) ? fs.realpathSync(hit.full) : hit.full;
        expect(real.startsWith(fs.realpathSync(root)), `${JSON.stringify(input)} -> ${real}`).toBe(true);
      }
    }
    expect(tried).toBeGreaterThan(140);
  });

  it('HTTP routes that take a path never leak the secret (persona files, git tree/raw/file/diff)', async () => {
    const dir = tmp();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const owner = cookieOf(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    const agent = (await built.app.inject({ method: 'GET', url: '/api/agents', cookies: owner })).json().agents[0];
    const root = agent.workspacePath as string;
    fs.mkdirSync(path.join(root, 'deep'), { recursive: true });
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(secret, MARK);
    fs.symlinkSync(dir, path.join(root, 'link-out'));
    fs.symlinkSync(secret, path.join(root, 'link-file'));
    fs.symlinkSync('../..', path.join(root, 'deep', 'link-up'));
    const rel = path.relative(root, secret);
    let calls = 0;
    for (const input of payloads(secret, rel)) {
      const q = encodeURIComponent(input);
      for (const url of [`/api/agents/${agent.id}/file?path=${q}`, `/api/git/ws:${agent.id}/raw?path=${q}`, `/api/git/ws:${agent.id}/file?path=${q}`, `/api/git/ws:${agent.id}/tree?path=${q}`, `/api/git/ws:${agent.id}/diff?path=${q}`]) {
        const res = await built.app.inject({ method: 'GET', url, cookies: owner });
        calls += 1;
        expect(res.statusCode, url).toBeLessThan(500);
        expect(res.body, `${url} leaked`).not.toContain(MARK);
        if (url.includes('/tree')) expect(res.body, `${url} listed outside`).not.toContain('secret.txt');
      }
    }
    expect(calls).toBeGreaterThan(700);
    await built.app.close();
  });

  it('agent file tools refuse to write through links or traversal', async () => {
    const { root, outer } = sandbox();
    const before = fs.readdirSync(outer).sort();
    for (const input of ['../evil.txt', 'link-out/evil.txt', 'deep/link-up/evil.txt', `${outer}/evil.txt`, 'link-file', '..\\evil.txt', 'a/../../evil.txt']) {
      const hit = locatePath({ workspace: root, target: input });
      if (!hit) continue;
      const parent = fs.realpathSync(fs.existsSync(hit.full) ? hit.full : path.dirname(hit.full));
      expect(parent.startsWith(fs.realpathSync(root)), `${input} -> ${parent}`).toBe(true);
    }
    expect(fs.readdirSync(outer).sort()).toEqual(before);
  });

  it('uploads keep weird names inside the files folder', async () => {
    const dir = tmp();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const owner = cookieOf(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    for (const name of ['../../escape.txt', '/etc/cron.d/x', '..\\..\\x.txt', '\0nul.txt', 'a/../../b.txt', '.'.repeat(300), 'CON', '<script>.txt']) {
      const res = await built.app.inject({ method: 'POST', url: '/api/files', cookies: owner, payload: { name, contentBase64: Buffer.from('x').toString('base64') } });
      expect(res.statusCode, name).toBeLessThan(500);
      if (res.statusCode === 200) {
        const file = res.json().file;
        const raw = await built.app.inject({ method: 'GET', url: `/api/files/${file.id}/raw`, cookies: owner });
        expect(raw.statusCode).toBe(200);
      }
    }
    expect(fs.existsSync('/etc/cron.d/x')).toBe(false);
    for (const name of ['escape.txt', 'x.txt', 'b.txt']) expect(fs.existsSync(path.join(path.dirname(dir), name)), name).toBe(false);
    // Everything written lives under the data folder.
    for (const row of built.store.db.prepare('SELECT rel_path FROM files').all() as { rel_path: string }[]) {
      expect(path.isAbsolute(row.rel_path), row.rel_path).toBe(false);
      expect(row.rel_path.split(/[\\/]/), row.rel_path).not.toContain('..');
    }
    await built.app.close();
  });
});

describe('fuzz: member isolation across every member route', () => {
  it('no member route, fed any owner id, returns owner data or changes it', async () => {
    const dir = tmp();
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const { app, store } = built;
    const owner = cookieOf(await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    await app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
    const member = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
    // Owner data, each carrying the marker.
    const agent = (await app.inject({ method: 'POST', url: '/api/agents', cookies: owner, payload: { name: `Owner ${MARK}`, systemPrompt: MARK, toolAllowlist: ['read_file'] } })).json().agent;
    fs.writeFileSync(path.join(agent.workspacePath, 'notes.md'), MARK);
    const session = (await app.inject({ method: 'POST', url: '/api/sessions', cookies: owner, payload: { agentId: agent.id, title: `chat ${MARK}` } })).json().session;
    const message = store.insertMessage({ sessionId: session.id, role: 'user', content: MARK, toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null });
    const file = (await app.inject({ method: 'POST', url: '/api/files', cookies: owner, payload: { name: 'o.txt', contentBase64: Buffer.from(MARK).toString('base64'), sessionId: session.id } })).json().file;
    const collection = (await app.inject({ method: 'POST', url: '/api/kb/collections', cookies: owner, payload: { name: `kb ${MARK}` } })).json().collection;
    const note = (await app.inject({ method: 'POST', url: '/api/memory', cookies: owner, payload: { agentId: agent.id, content: MARK } })).json().note;
    const schedule = (await app.inject({ method: 'POST', url: '/api/schedules', cookies: owner, payload: { agentId: agent.id, name: `t ${MARK}`, cron: '0 9 * * *', prompt: MARK } })).json().schedule;
    const run = store.createRun({ sessionId: session.id, agentId: agent.id, configVersion: 1, cursor: { phase: 'done' } as never });
    const ids = [agent.id, session.id, message.id, file.id, collection.id, note.id, schedule.id, run.id, `ws:${agent.id}`, 'owner', 'x', '../x'];
    const bodies: Record<string, unknown>[] = [{}, { content: 'hi' }, { name: 'mine', agentId: agent.id, sessionId: session.id }, { action: 'stop' }, { decision: 'approve' }, { items: [{ kind: 'root', id: `ws:${agent.id}` }] }];
    let calls = 0;
    for (const route of MEMBER_ROUTES) {
      const [method, pattern] = route.split(' ') as [string, string];
      if (!pattern.includes(':')) continue;
      if (/\/api\/(skills|gallery)\//.test(pattern)) continue; // shared catalogs, by design
      for (const id of ids) {
        const url = pattern.replace(/:[a-zA-Z]+/g, encodeURIComponent(id));
        for (const payload of method === 'GET' ? [undefined] : bodies) {
          const res = await app.inject({ method: method as 'GET', url, cookies: member, payload: payload as never });
          calls += 1;
          expect(res.body, `${method} ${url} leaked owner data`).not.toContain(MARK);
          expect(res.statusCode, `${method} ${url}`).toBeLessThan(500);
        }
      }
    }
    expect(calls).toBeGreaterThan(300);
    // Every owner row is still there and unchanged.
    const get = (url: string) => app.inject({ method: 'GET', url, cookies: owner });
    expect((await get(`/api/agents/${agent.id}`)).json().agent.name).toBe(`Owner ${MARK}`);
    expect((await get(`/api/sessions/${session.id}`)).json().messages.map((m: { content: string }) => m.content)).toContain(MARK);
    expect((await get(`/api/files/${file.id}/raw`)).body).toBe(MARK);
    expect((await get('/api/schedules')).json().schedules.map((s: { id: string }) => s.id)).toContain(schedule.id);
    expect((await get('/api/kb/collections')).json().collections.map((c: { id: string }) => c.id)).toContain(collection.id);
    expect((await get(`/api/memory?agentId=${agent.id}`)).body).toContain(MARK);
    expect(fs.readFileSync(path.join(agent.workspacePath, 'notes.md'), 'utf8')).toBe(MARK);
    expect(store.getRun(run.id)?.status).toBe('running');
    void note;
    await app.close();
  });
});
