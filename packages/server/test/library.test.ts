import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  chunkDocument, createCollection, extractDocxText, extractPdfText, extractText, hybridRank, ingestBuffer, searchKnowledge, windowText,
} from '../src/kb.js';
import { hashEmbedder } from '../src/kb.js';
import { importSkill, listSkills, loadSkill, parseSkillMd, saveSkill, setSkillEnabled, skillFit } from '../src/skills.js';
import { assertImapReadOnly, ChangeDebouncer, fireTrigger, githubSignature, githubSignatureOk, imapCommands } from '../src/triggers.js';
import { createTrigger } from '../src/triggers.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-lib-'));
  dirs.push(dir);
  return dir;
}

function zipStore(name: string, data: Buffer) {
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  return Buffer.concat([local, nameBuf, data]);
}

describe('knowledge base', () => {
  it('keeps markdown headings and overlaps long sections', () => {
    const body = 'a'.repeat(500);
    const text = `# Intro\nshort\n\n## Detail\n${body}`;
    const chunks = chunkDocument(text, 'markdown', { size: 200, overlap: 40 });
    expect(chunks.some((chunk) => chunk.heading === '# Intro')).toBe(true);
    expect(chunks.some((chunk) => chunk.heading === '## Detail')).toBe(true);
    const detail = chunks.filter((chunk) => chunk.heading === '## Detail');
    expect(detail.length).toBeGreaterThan(1);
    const overlap = detail[0].text.slice(-40);
    expect(detail[1].text.includes(overlap.trim())).toBe(true);
    expect(windowText('hello', 20, 5)).toEqual(['hello']);
  });

  it('extracts text from a simple PDF and a DOCX', () => {
    const pdf = Buffer.from('%PDF-1.1\nBT (Hello from a pdf) Tj ET\n');
    expect(extractPdfText(pdf)).toContain('Hello from a pdf');
    const xml = '<w:document><w:p><w:t>Hello from a docx</w:t></w:p></w:document>';
    const docx = zipStore('word/document.xml', Buffer.from(xml));
    expect(extractDocxText(docx)).toContain('Hello from a docx');
    expect(extractText('notes.md', Buffer.from('# Title\nbody')).kind).toBe('markdown');
    expect(extractText('main.ts', Buffer.from('export function run() {}\n')).kind).toBe('code');
  });

  it('ranks a rare keyword with BM25 beside the vector score and skips an unchanged file', async () => {
    const dir = tmp();
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const collection = createCollection(store, { name: 'Manuals' });
    const embed = hashEmbedder();
    const first = await ingestBuffer(store, collection.id, { name: 'manual.txt', bytes: Buffer.from('The xylophone manual explains tuning pegs and felt hammers.') }, embed);
    const again = await ingestBuffer(store, collection.id, { name: 'manual.txt', bytes: Buffer.from('The xylophone manual explains tuning pegs and felt hammers.') }, embed);
    expect(again.skipped).toBe(true);
    await ingestBuffer(store, collection.id, { name: 'weather.txt', bytes: Buffer.from('Tomorrow the weather is rain and wind across the valley.') }, embed);
    const changed = await ingestBuffer(store, collection.id, { name: 'manual.txt', bytes: Buffer.from('The xylophone manual now includes a brass mute.') }, embed);
    expect(changed.skipped).toBe(false);
    expect(changed.chunks).toBeGreaterThan(0);
    const hits = await searchKnowledge(store, 'xylophone mute', { collectionId: collection.id, embed });
    expect(hits[0]?.document).toBe('manual.txt');
    expect(hits[0]?.text).toMatch(/xylophone/);
    const ranked = hybridRank([
      { id: 'a', text: 'xylophone tuning manual', vector: null },
      { id: 'b', text: 'rain and weather tomorrow', vector: null },
    ], 'xylophone', new Float32Array([1, 0]), 2);
    expect(ranked[0]?.id).toBe('a');
    expect(first.chunks).toBeGreaterThan(0);
    const usage = (await app.inject({ method: 'GET', url: '/api/resources' })).statusCode;
    expect(usage).toBe(401);
    await app.close();
  });
});

describe('skills', () => {
  it('versions a skill, hides it per persona, and round-trips import', async () => {
    const dir = tmp();
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const agent = store.createAgent({ name: 'Reader', systemPrompt: 'test', toolAllowlist: [], workspacePath: dir, modelId: 'model_rehearsal' });
    const raw = '---\nname: Summarize a paper\ndescription: Use when the user asks for a summary of a paper or article.\n---\n\nCite the source.\n';
    const saved = await saveSkill(store, dir, raw);
    expect(saved.version).toBe(1);
    const next = await saveSkill(store, dir, raw.replace('Cite the source.', 'Cite the passage.'), saved.slug);
    expect(next.version).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'skills', saved.slug, 'SKILL.md'), 'utf8')).toMatch(/passage/);
    expect(skillFit(saved.description, 'please summarize this paper')).toBeGreaterThan(0.5);
    setSkillEnabled(store, agent.id, saved.slug, false);
    expect(listSkills(store, agent.id)[0]?.enabled).toBe(false);
    await expect(loadSkill(store, dir, agent.id, saved.slug)).rejects.toThrow(/turned off/);
    setSkillEnabled(store, agent.id, saved.slug, true);
    const loaded = await loadSkill(store, dir, agent.id, saved.slug);
    expect(loaded).toMatch(/passage/);
    const imported = await importSkill(store, dir, {
      slug: 'with-script',
      skillMd: '---\nname: With script\ndescription: Use when a script should run beside the note.\n---\n\nRun the helper.\n',
      files: [{ path: 'scripts/run.sh', content: 'echo ok\n' }],
    });
    const text = await loadSkill(store, dir, agent.id, imported.slug);
    expect(text).toMatch(/echo ok/);
    expect(() => parseSkillMd('nope')).toThrow(/frontmatter/);
    await app.close();
  });
});

describe('triggers', () => {
  it('rejects a bad webhook secret, accepts a GitHub signature, and test-fires a checkpointed run', async () => {
    const dir = tmp();
    const { app, store, engine, vault } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const agent = store.createAgent({ name: 'Watch', systemPrompt: 'Reply briefly.', toolAllowlist: [], workspacePath: dir, modelId: 'model_rehearsal' });
    const secret = 'hook-secret-value';
    const hook = createTrigger(store, vault, { name: 'Ping', kind: 'webhook', agentId: agent.id, prompt: 'Event:\n{{event}}', secret });
    const denied = await app.inject({ method: 'POST', url: `/api/hooks/${hook.id}`, payload: { hello: 'there' }, headers: { 'x-local-agent-secret': 'nope' } });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      method: 'POST', url: `/api/hooks/${hook.id}`, payload: { hello: 'there' }, headers: { 'x-local-agent-secret': secret },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().runId).toBeTruthy();

    const gh = createTrigger(store, vault, { name: 'Git', kind: 'github', agentId: agent.id, prompt: 'Look at {{event}}', secret });
    const body = JSON.stringify({ zen: 'keep going' });
    const signature = githubSignature(secret, Buffer.from(body));
    expect(githubSignatureOk(secret, Buffer.from(body), signature)).toBe(true);
    expect(githubSignatureOk(secret, Buffer.from(body), 'sha256=00')).toBe(false);
    const signed = await app.inject({
      method: 'POST',
      url: `/api/hooks/github/${gh.id}`,
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    });
    expect(signed.statusCode).toBe(200);

    const fired = await fireTrigger(store, engine, hook, { test: true }, { test: true, wait: true });
    const run = store.getRun(fired.runId);
    expect(run?.status).toBe('completed');
    const checkpoints = store.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE run_id = ?').get(fired.runId) as { n: number };
    expect(Number(checkpoints.n)).toBeGreaterThan(0);

    const commands = imapCommands('INBOX', ['4']);
    expect(commands[0]).toBe('EXAMINE INBOX');
    expect(commands.join('\n')).toMatch(/BODY\.PEEK/);
    expect(() => assertImapReadOnly(commands)).not.toThrow();
    expect(() => assertImapReadOnly(['APPEND INBOX {5}'])).toThrow(/read-only/);

    vi.useFakeTimers();
    const batches: string[][] = [];
    const debouncer = new ChangeDebouncer(50, (paths) => batches.push(paths));
    debouncer.push('a.txt');
    debouncer.push('a.txt');
    debouncer.push('b.txt');
    await vi.advanceTimersByTimeAsync(50);
    expect(batches).toEqual([['a.txt', 'b.txt']]);
    await app.close();
  });
});
