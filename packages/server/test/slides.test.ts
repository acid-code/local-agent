import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { filePath, saveFile } from '../src/files.js';
import { mockPng } from '../src/images.js';
import { GALLERY } from '../src/gallery.js';
import { buildDeck, makeEot, readDeckSpec, readDeckText, slidesTools, type DeckSpec } from '../src/slides.js';
import type { ToolContext } from '../src/tools.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pw = (tag: string) => ['fixture', tag, '11'].join('-');

const HEBREW: DeckSpec = {
  title: 'סיכום רבעון', lang: 'auto', slides: [
    { title: 'סיכום הרבעון השלישי', subtitle: 'צוות המוצר · נובמבר 2026' },
    { title: 'מה השגנו', bullets: ['השקנו את גרסה 2.0', 'גדלנו ב-35% במשתמשים פעילים'], notes: 'להדגיש את הצמיחה במשתמשים.' },
    { title: 'הכנסות לפי חודש', chart: { type: 'bar', labels: ['יולי', 'אוגוסט', 'ספטמבר'], series: [{ name: 'הכנסות', values: [120, 145, 170] }] } },
  ],
};

async function parts(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
  return { zip, read, names: Object.keys(zip.files) };
}
function duplicateAttributes(xml: string) {
  const bad: string[] = [];
  for (const tag of xml.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const names = [...tag.matchAll(/\s([\w:]+)=/g)].map((match) => match[1]!);
    if (new Set(names).size !== names.length) bad.push(tag.slice(0, 120));
  }
  return bad;
}

describe('Hebrew decks', () => {
  it('are right-to-left with Hebrew language tags and the Heebo font on every run', async () => {
    const { read, names } = await parts(await buildDeck(HEBREW));
    const presentation = await read('ppt/presentation.xml');
    expect(presentation).toMatch(/<p:presentation [^>]*rtl="1"/);
    const slide2 = await read('ppt/slides/slide2.xml');
    expect(slide2).toMatch(/<a:pPr[^>]*rtl="1"/);
    expect(slide2).toMatch(/<a:pPr[^>]*algn="r"/);
    expect(slide2).toMatch(/lang="he-IL"/);
    expect(slide2).toContain('<a:cs typeface="Heebo" pitchFamily="2" charset="-79"/>');
    expect(slide2).toContain('השקנו את גרסה 2.0');
    // Every text run names the complex-script font, or Hebrew falls back to a system font.
    for (const name of names.filter((item) => /^ppt\/slides\/slide\d+\.xml$/.test(item))) {
      const xml = await read(name);
      const runs = xml.match(/<a:rPr[^>]*\/>|<a:rPr[^>]*[^/]>[\s\S]*?<\/a:rPr>/g) ?? [];
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.filter((run) => !run.includes('<a:cs typeface="Heebo" pitchFamily="2" charset="-79"/>'))).toEqual([]);
    }
    // Speaker notes, right-to-left too.
    const notesName = names.find((item) => /^ppt\/notesSlides\/notesSlide2\.xml$/.test(item))!;
    const notes = await read(notesName);
    expect(notes).toContain('להדגיש את הצמיחה');
    expect(notes).toMatch(/<a:pPr[^>]*rtl="1"/);
  });

  it('embeds the Hebrew font (EOT in ppt/fonts) and lists it in presentation.xml', async () => {
    const { zip, read } = await parts(await buildDeck(HEBREW));
    const presentation = await read('ppt/presentation.xml');
    expect(presentation).toContain('embedTrueTypeFonts="1"');
    expect(presentation).toMatch(/<p:embeddedFontLst><p:embeddedFont><p:font typeface="Heebo"[^>]*\/><p:regular r:id="rIdLaFont1"\/>/);
    expect(await read('ppt/_rels/presentation.xml.rels')).toMatch(/Id="rIdLaFont1" Type="[^"]*\/relationships\/font" Target="fonts\/font1\.fntdata"/);
    expect(await read('[Content_Types].xml')).toContain('Extension="fntdata"');
    const eot = Buffer.from(await zip.file('ppt/fonts/font1.fntdata')!.async('uint8array'));
    expect(eot.readUInt32LE(0)).toBe(eot.length); // EOTSize
    expect(eot.readUInt32LE(8)).toBe(0x00020001); // version 2.1
    expect(eot.readUInt16LE(34)).toBe(0x504c); // magic
    const familyLength = eot.readUInt16LE(82);
    expect(eot.toString('utf16le', 84, 84 + familyLength)).toBe('Heebo');
    // The raw TrueType font follows the header.
    const ttf = fs.readFileSync(path.join(__dirname, '../assets/fonts/Heebo.ttf'));
    expect(eot.readUInt32LE(4)).toBe(ttf.length);
    expect(eot.subarray(eot.length - ttf.length).equals(ttf)).toBe(true);
  });

  it('makes a native chart with Hebrew labels that reads right to left', async () => {
    const { read, names } = await parts(await buildDeck(HEBREW));
    const chartName = names.find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))!;
    expect(chartName).toBeTruthy();
    const chart = await read(chartName);
    expect(chart).toContain('ספטמבר');
    expect(chart).toMatch(/<c:orientation val="maxMin"\/>/);
    expect(chart).toContain('typeface="Heebo"');
  });

  it('writes well-formed parts (no duplicate attributes) and keeps the spec for edit rounds', async () => {
    const bytes = await buildDeck({ ...HEBREW, font: 'Assistant', theme: 'warm' });
    const { read, names } = await parts(bytes);
    for (const name of names.filter((item) => item.endsWith('.xml') || item.endsWith('.rels'))) expect(duplicateAttributes(await read(name)), name).toEqual([]);
    const spec = await readDeckSpec(bytes);
    expect(spec).toMatchObject({ title: 'סיכום רבעון', font: 'Assistant', theme: 'warm' });
    expect(spec!.slides).toHaveLength(3);
    expect(await read('ppt/presentation.xml')).toContain('typeface="Assistant"');
    const text = await readDeckText(bytes);
    expect(text[1]).toMatchObject({ title: 'מה השגנו', notes: expect.stringContaining('להדגיש') });
  });

  it('English decks stay left-to-right', async () => {
    const { read } = await parts(await buildDeck({ title: 'Quarter', slides: [{ title: 'Quarter review' }, { title: 'Wins', bullets: ['Shipped 2.0'] }] }));
    expect(await read('ppt/presentation.xml')).not.toMatch(/<p:presentation [^>]*rtl="1"/);
    expect(await read('ppt/slides/slide2.xml')).not.toMatch(/rtl="1"/);
  });

  it('rejects broken specs with a clear reason', async () => {
    await expect(buildDeck({ title: 'x', slides: [] })).rejects.toThrow(/at least one slide/);
    await expect(buildDeck({ title: 'x', slides: [{ title: 'c', chart: { type: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [1] }] } }] })).rejects.toThrow(/one number per label/);
  });

  it('makeEot refuses non-fonts', () => {
    expect(() => makeEot(Buffer.alloc(64))).toThrow();
  });
});

describe('Presenter persona and slide tools', () => {
  it('ships in the gallery with the slides skill', () => {
    const presenter = GALLERY.find((item) => item.id === 'presenter')!;
    expect(presenter.tools).toEqual(expect.arrayContaining(['make_slides', 'read_slides', 'generate_image']));
    expect(presenter.skills.map((skill) => skill.slug)).toContain('hebrew-slides');
  });

  it('make_slides saves a deck with a picture from the image model; edit rounds save v2 from read_slides', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-slides-')); dirs.push(dir);
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } });
    const agent = built.store.listAgents()[0]!;
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const prompts: string[] = [];
    const [make, read] = slidesTools({ dataDir: dir, image: async (prompt, ctx) => { prompts.push(prompt); return { fileId: saveFile(built.store, dir, { name: 'pic.png', bytes: mockPng(prompt), mime: 'image/png', source: 'agent', ownerId: ctx.ownerId }).id }; } });
    const ctx = { agent, store: built.store, sessionId: session.id, signal: new AbortController().signal, workspace: dir, depth: 0 } as unknown as ToolContext;
    const out = await make!.execute({ deck: { ...HEBREW, slides: [...HEBREW.slides, { title: 'החזון', bullets: ['עתיד ירוק'], image: { prompt: 'a green city skyline at sunrise' } }] } }, ctx);
    expect(out).toMatch(/Hebrew, right-to-left/);
    expect(out).toMatch(/1 picture/);
    expect(prompts).toEqual(['a green city skyline at sunrise']);
    const id = /\[file:([^\]]+)\]/.exec(out)![1]!;
    const file = built.store.db.prepare('SELECT name FROM files WHERE id = ?').get(id) as { name: string };
    expect(file.name).toBe('סיכום רבעון.pptx');
    const specText = await read!.execute({ file_id: id }, ctx);
    expect(specText).toContain('revise_file_id');
    const spec = JSON.parse(specText.slice(specText.indexOf('{'))) as DeckSpec;
    expect(spec.slides[3]!.image!.fileId).toBeTruthy(); // the generated picture is reused next round, not regenerated
    spec.slides[1]!.bullets!.push('פתחנו משרד בחיפה');
    const second = await make!.execute({ deck: spec, revise_file_id: id }, ctx);
    const id2 = /\[file:([^\]]+)\]/.exec(second)![1]!;
    expect((built.store.db.prepare('SELECT name FROM files WHERE id = ?').get(id2) as { name: string }).name).toBe('סיכום רבעון v2.pptx');
    expect(prompts).toHaveLength(1);
    const deck = await JSZip.loadAsync(fs.readFileSync(filePath(built.store, dir, id2)!));
    expect(await deck.file('ppt/slides/slide2.xml')!.async('string')).toContain('פתחנו משרד בחיפה');
    expect(Object.keys(deck.files).some((name) => name.startsWith('ppt/media/'))).toBe(true);
    await built.app.close();
  });
});
