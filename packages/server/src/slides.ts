import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import PptxGenJSModule from 'pptxgenjs';
import { isHebrewText } from '@local-agent/shared';
import { OWNER_ID } from './accounts.js';
import { filePath, getFile, saveFile } from './files.js';
import type { Store } from './db.js';
import type { Tool } from './tools.js';

/**
 * Real .pptx decks from a small JSON spec (pptxgenjs), with proper Hebrew: right-to-left paragraphs and deck, Hebrew
 * language tags, a Hebrew font (Heebo or Assistant, OFL) embedded in the file so PowerPoint shows it even where it is
 * not installed, charts, speaker notes and pictures from the image model. The spec rides inside the file
 * (docProps/local-agent-deck.json), so later edit rounds start from it instead of re-guessing the slides.
 */
// pptxgenjs ships CJS with an ESM-style default; under NodeNext the class sits on .default at type level.
const PptxGenJS = ((PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default ?? PptxGenJSModule) as unknown as typeof import('pptxgenjs').default;

export const DECK_FONTS = ['Heebo', 'Assistant'] as const;
export type DeckFont = typeof DECK_FONTS[number];
export const SPEC_PART = 'docProps/local-agent-deck.json';

export interface ChartSpec { type: 'bar' | 'line' | 'pie' | 'doughnut'; labels: string[]; series: { name: string; values: number[] }[]; title?: string }
export interface SlideSpec {
  layout?: 'title' | 'bullets' | 'chart' | 'image' | 'quote' | 'section';
  title: string; subtitle?: string; bullets?: string[]; notes?: string;
  chart?: ChartSpec;
  /** An existing image file, or a prompt for the image model (resolved before building). */
  image?: { fileId?: string; prompt?: string; caption?: string };
}
export interface DeckSpec { title: string; author?: string; lang?: 'he' | 'en' | 'auto'; font?: DeckFont; theme?: 'light' | 'dark' | 'warm'; slides: SlideSpec[] }

const THEMES = {
  light: { bg: 'FFFFFF', text: '1F2937', muted: '6B7280', accent: '2563EB', chart: ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6'] },
  dark: { bg: '111827', text: 'F9FAFB', muted: '9CA3AF', accent: '60A5FA', chart: ['60A5FA', 'FBBF24', '34D399', 'F87171', 'A78BFA'] },
  warm: { bg: 'FFF8F0', text: '3B2F2F', muted: '8A7360', accent: 'D9480F', chart: ['D9480F', 'F59F00', '2B8A3E', '1971C2', '9C36B5'] },
};

export function fontDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, '..', 'assets', 'fonts'), path.join(here, '..', '..', 'assets', 'fonts')]) if (fs.existsSync(dir)) return dir;
  return path.join(here, '..', 'assets', 'fonts');
}

export function deckIsHebrew(spec: DeckSpec) {
  if (spec.lang === 'he') return true;
  if (spec.lang === 'en') return false;
  return isHebrewText([spec.title, ...spec.slides.flatMap((slide) => [slide.title, slide.subtitle ?? '', ...(slide.bullets ?? [])])].join('\n'));
}

export function validateDeck(raw: unknown): DeckSpec {
  const spec = raw as DeckSpec;
  if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string' || !Array.isArray(spec.slides) || !spec.slides.length) throw new Error('A deck needs a title and at least one slide.');
  if (spec.slides.length > 60) throw new Error('Keep a deck to 60 slides or fewer.');
  for (const [index, slide] of spec.slides.entries()) {
    if (!slide || typeof slide.title !== 'string') throw new Error(`Slide ${index + 1} needs a title.`);
    if (slide.chart) {
      const { labels, series } = slide.chart;
      if (!Array.isArray(labels) || !Array.isArray(series) || !series.length || series.some((row) => !Array.isArray(row.values) || row.values.length !== labels.length || row.values.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
        throw new Error(`Slide ${index + 1}: each chart series needs one number per label.`);
      }
    }
  }
  return { ...spec, font: DECK_FONTS.includes(spec.font as DeckFont) ? spec.font : 'Heebo', theme: spec.theme && spec.theme in THEMES ? spec.theme : 'light' };
}

/** Build the .pptx. `images` maps a slide index to picture bytes (already generated or loaded). */
export async function buildDeck(input: DeckSpec, images: Map<number, { bytes: Buffer; mime: string }> = new Map()): Promise<Buffer> {
  const spec = validateDeck(input);
  const rtl = deckIsHebrew(spec);
  const theme = THEMES[spec.theme ?? 'light'];
  const font = spec.font ?? 'Heebo';
  const lang = rtl ? 'he-IL' : 'en-US';
  const align = rtl ? 'right' : 'left';
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pres.rtlMode = rtl;
  pres.title = spec.title;
  pres.author = spec.author || 'local-agent';
  pres.company = 'local-agent';
  pres.theme = { headFontFace: font, bodyFontFace: font };
  const text = { fontFace: font, color: theme.text, lang, rtlMode: rtl, align } as const;

  for (const [index, slide] of spec.slides.entries()) {
    const page = pres.addSlide();
    page.background = { color: theme.bg };
    const layout = slide.layout ?? (index === 0 ? 'title' : slide.chart ? 'chart' : slide.image ? 'image' : 'bullets');
    if (layout === 'title' || layout === 'section') {
      page.addShape(pres.ShapeType.rect, { x: rtl ? 12.73 : 0, y: 0, w: 0.6, h: 7.5, fill: { color: theme.accent }, line: { color: theme.accent } });
      page.addText(slide.title, { ...text, x: 0.9, y: 2.3, w: 11.5, h: 1.6, fontSize: layout === 'title' ? 44 : 36, bold: true });
      if (slide.subtitle) page.addText(slide.subtitle, { ...text, x: 0.9, y: 3.9, w: 11.5, h: 1, fontSize: 22, color: theme.muted });
    } else if (layout === 'quote') {
      page.addText(slide.title, { ...text, x: 1.2, y: 2, w: 10.9, h: 2.6, fontSize: 32, italic: true, align: 'center' });
      if (slide.subtitle) page.addText(`— ${slide.subtitle}`, { ...text, x: 1.2, y: 4.8, w: 10.9, h: 0.8, fontSize: 18, color: theme.muted, align: 'center' });
    } else {
      page.addText(slide.title, { ...text, x: 0.6, y: 0.35, w: 12.1, h: 1, fontSize: 32, bold: true, color: theme.accent });
      const picture = images.get(index);
      const hasSide = Boolean(slide.chart || picture);
      // Text column on the reading side: right in Hebrew, left in English.
      const textBox = hasSide ? { x: rtl ? 6.9 : 0.6, w: 5.8 } : { x: 0.6, w: 12.1 };
      const sideBox = { x: rtl ? 0.6 : 6.9, y: 1.6, w: 5.8, h: 5.2 };
      if (slide.bullets?.length) {
        page.addText(slide.bullets.map((line) => ({ text: line, options: { bullet: rtl ? { characterCode: '25CF', indent: 18 } : true, breakLine: true } })), { ...text, ...textBox, y: 1.6, h: 5.2, fontSize: 20, valign: 'top', paraSpaceAfter: 8 });
      }
      if (slide.chart) {
        const kind = { bar: pres.ChartType.bar, line: pres.ChartType.line, pie: pres.ChartType.pie, doughnut: pres.ChartType.doughnut }[slide.chart.type] ?? pres.ChartType.bar;
        page.addChart(kind as unknown as Parameters<typeof page.addChart>[0], slide.chart.series.map((row) => ({ name: row.name, labels: slide.chart!.labels, values: row.values })), {
          ...(hasSide && slide.bullets?.length ? sideBox : { x: 0.9, y: 1.6, w: 11.5, h: 5.2 }),
          chartColors: theme.chart, showLegend: slide.chart.series.length > 1 || kind === pres.ChartType.pie, legendPos: 'b', legendFontFace: font, legendColor: theme.text,
          catAxisLabelFontFace: font, valAxisLabelFontFace: font, catAxisLabelColor: theme.text, valAxisLabelColor: theme.muted, dataLabelFontFace: font,
          showTitle: Boolean(slide.chart.title), title: slide.chart.title, titleFontFace: font, titleColor: theme.text,
          // Hebrew charts read right to left: categories start at the right.
          catAxisOrientation: (rtl && kind !== pres.ChartType.pie && kind !== pres.ChartType.doughnut ? 'maxMin' : 'minMax') as 'minMax', valAxisLabelPos: 'nextTo',
          showValue: kind === pres.ChartType.pie || kind === pres.ChartType.doughnut, showPercent: kind === pres.ChartType.pie,
        });
      } else if (picture) {
        page.addImage({ data: `${picture.mime};base64,${picture.bytes.toString('base64')}`, ...sideBox, sizing: { type: 'contain', w: sideBox.w, h: sideBox.h } });
        if (slide.image?.caption) page.addText(slide.image.caption, { ...text, x: sideBox.x, y: 6.85, w: sideBox.w, h: 0.4, fontSize: 12, color: theme.muted, align: 'center' });
      }
    }
    page.addText(`${index + 1}`, { ...text, x: rtl ? 0.3 : 12.4, y: 6.95, w: 0.6, h: 0.35, fontSize: 11, color: theme.muted, align: rtl ? 'left' : 'right' });
    if (slide.notes) page.addNotes(slide.notes);
  }
  const raw = await pres.write({ outputType: 'nodebuffer' }) as Buffer;
  return finishPptx(raw, spec, rtl, font);
}

/** Post-process the package: complex-script font and language on every run, the deck's RTL flag, the embedded font and the spec. */
export async function finishPptx(raw: Buffer, spec: DeckSpec, rtl: boolean, font: DeckFont): Promise<Buffer> {
  const zip = await JSZip.loadAsync(raw);
  for (const name of Object.keys(zip.files).filter((file) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(file))) {
    let xml = await zip.file(name)!.async('string');
    if (rtl) {
      // Hebrew is a complex script: PowerPoint picks the <a:cs> font and the bidi language for it.
      xml = xml.replace(/<a:rPr([^>]*?)(\/?)>/g, (match, attrs: string, selfClose: string) => {
        let next = attrs.includes(' lang=') ? attrs : `${attrs} lang="he-IL"`;
        if (!next.includes(' altLang=')) next += ' altLang="en-US"';
        return selfClose ? `<a:rPr${next}><a:latin typeface="${font}"/><a:cs typeface="${font}" pitchFamily="2" charset="-79"/></a:rPr>` : `<a:rPr${next}>`;
      });
      xml = xml.replace(/(<a:rPr[^>]*>)((?:(?!<\/a:rPr>)[\s\S])*?)<\/a:rPr>/g, (match, open: string, inner: string) => inner.includes('<a:cs ') ? match : `${open}${inner}<a:cs typeface="${font}" pitchFamily="2" charset="-79"/></a:rPr>`);
      // pptxgenjs tags the complex-script font with a CJK charset; Hebrew is charset 177 (-79).
      xml = xml.replace(/<a:cs typeface="([^"]+)"[^>]*\/>/g, '<a:cs typeface="$1" pitchFamily="2" charset="-79"/>');
      if (name.includes('notesSlides')) xml = xml.replace(/<a:pPr(?![^>]*rtl=)/g, '<a:pPr rtl="1" algn="r"').replace(/<a:p>(?!<a:pPr)/g, '<a:p><a:pPr rtl="1" algn="r"/>');
    }
    zip.file(name, xml);
  }
  const ttf = fs.readFileSync(path.join(fontDir(), `${font}.ttf`));
  zip.file(`ppt/fonts/font1.fntdata`, makeEot(ttf));
  const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  if (!contentTypes.includes('Extension="fntdata"')) zip.file('[Content_Types].xml', contentTypes.replace('<Default ', '<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default '));
  const relsName = 'ppt/_rels/presentation.xml.rels';
  const rels = await zip.file(relsName)!.async('string');
  zip.file(relsName, rels.replace('</Relationships>', '<Relationship Id="rIdLaFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>'));
  let presentation = await zip.file('ppt/presentation.xml')!.async('string');
  if (rtl && !/<p:presentation[^>]*\srtl=/.test(presentation)) presentation = presentation.replace('<p:presentation ', '<p:presentation rtl="1" ');
  presentation = presentation.replace(/<p:presentation ([^>]*?)>/, (match, attrs: string) => `<p:presentation ${attrs.replace(/\s(embedTrueTypeFonts|saveSubsetFonts)="[^"]*"/g, '')} embedTrueTypeFonts="1" saveSubsetFonts="0">`);
  // Embedded font list sits right after the slide size / notes size (schema order).
  const embedded = `<p:embeddedFontLst><p:embeddedFont><p:font typeface="${font}" pitchFamily="2" charset="-79"/><p:regular r:id="rIdLaFont1"/></p:embeddedFont></p:embeddedFontLst>`;
  presentation = presentation.includes('<p:notesSz') ? presentation.replace(/(<p:notesSz[^>]*\/>)/, `$1${embedded}`) : presentation.replace('</p:sldSz>', `</p:sldSz>${embedded}`);
  zip.file('ppt/presentation.xml', presentation);
  zip.file(SPEC_PART, JSON.stringify(spec, null, 1));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Read the spec back out of a deck this app made (for edit rounds and previews). */
export async function readDeckSpec(bytes: Buffer): Promise<DeckSpec | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const part = zip.file(SPEC_PART);
    return part ? validateDeck(JSON.parse(await part.async('string'))) : null;
  } catch { return null; }
}

/** Slide text straight from the XML, for decks made elsewhere (preview and "what is in this deck"). */
export async function readDeckText(bytes: Buffer): Promise<{ title: string; lines: string[]; notes: string }[]> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out = [];
  for (const name of slides) {
    const xml = await zip.file(name)!.async('string');
    const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) => [...match[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decode(t[1]!)).join('')).filter(Boolean);
    const notesName = name.replace('slides/slide', 'notesSlides/notesSlide');
    const notesXml = zip.file(notesName) ? await zip.file(notesName)!.async('string') : '';
    const notes = [...notesXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decode(t[1]!)).filter((line) => !/^\d+$/.test(line)).join(' ');
    out.push({ title: paragraphs[0] ?? '', lines: paragraphs.slice(1), notes });
  }
  return out;
}
const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ── Embedded OpenType (uncompressed) for PowerPoint's ppt/fonts/*.fntdata ─────────────────────────────────────
function tables(ttf: Buffer) {
  const count = ttf.readUInt16BE(4);
  const out = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    out.set(ttf.toString('latin1', at, at + 4), { offset: ttf.readUInt32BE(at + 8), length: ttf.readUInt32BE(at + 12) });
  }
  return out;
}
function nameRecord(ttf: Buffer, nameTable: { offset: number }, id: number): string {
  const base = nameTable.offset;
  const count = ttf.readUInt16BE(base + 2);
  const strings = base + ttf.readUInt16BE(base + 4);
  let fallback = '';
  for (let i = 0; i < count; i += 1) {
    const at = base + 6 + i * 12;
    const platform = ttf.readUInt16BE(at); const nameId = ttf.readUInt16BE(at + 6);
    if (nameId !== id) continue;
    const length = ttf.readUInt16BE(at + 8); const offset = ttf.readUInt16BE(at + 10);
    const raw = ttf.subarray(strings + offset, strings + offset + length);
    if (platform === 3 || platform === 0) return Buffer.from(raw).swap16().toString('utf16le');
    fallback ||= raw.toString('latin1');
  }
  return fallback;
}

/** EOT 2.1 header + the raw TrueType data (no MTX compression, no XOR), the layout PowerPoint reads from .fntdata. */
export function makeEot(ttf: Buffer): Buffer {
  const map = tables(ttf);
  const os2 = map.get('OS/2'); const head = map.get('head'); const name = map.get('name');
  if (!os2 || !head || !name) throw new Error('Not a TrueType font.');
  const o = os2.offset;
  const str = (value: string) => { const body = Buffer.from(value, 'utf16le'); const size = Buffer.alloc(2); size.writeUInt16LE(body.length); return Buffer.concat([Buffer.alloc(2), size, body]); };
  const fixed = Buffer.alloc(82);
  fixed.writeUInt32LE(ttf.length, 4); // FontDataSize
  fixed.writeUInt32LE(0x00020001, 8); // Version 2.1
  fixed.writeUInt32LE(0, 12); // Flags
  ttf.copy(fixed, 16, o + 32, o + 42); // PANOSE
  fixed.writeUInt8(1, 26); // Charset DEFAULT
  fixed.writeUInt8(ttf.readUInt16BE(o + 62) & 1, 27); // Italic (fsSelection bit 0)
  fixed.writeUInt32LE(ttf.readUInt16BE(o + 4), 28); // Weight
  fixed.writeUInt16LE(ttf.readUInt16BE(o + 8), 32); // fsType
  fixed.writeUInt16LE(0x504c, 34); // MagicNumber
  for (let i = 0; i < 4; i += 1) fixed.writeUInt32LE(ttf.readUInt32BE(o + 42 + i * 4), 36 + i * 4); // UnicodeRange1-4
  const version = ttf.readUInt16BE(o);
  if (version >= 1) { fixed.writeUInt32LE(ttf.readUInt32BE(o + 78), 52); fixed.writeUInt32LE(ttf.readUInt32BE(o + 82), 56); } // CodePageRange1-2
  fixed.writeUInt32LE(ttf.readUInt32BE(head.offset + 8), 60); // CheckSumAdjustment
  // Reserved1-4 (16 bytes) stay zero; then names.
  const names = Buffer.concat([str(nameRecord(ttf, name, 1)), str(nameRecord(ttf, name, 2)), str(nameRecord(ttf, name, 5)), str(nameRecord(ttf, name, 4))]);
  const rootString = Buffer.alloc(4); // Padding5 + RootStringSize 0
  const header = Buffer.concat([fixed, names.subarray(2), rootString]); // FamilyName has no padding before it
  header.writeUInt32LE(header.length + ttf.length, 0); // EOTSize
  return Buffer.concat([header, ttf]);
}

// ── Agent tools ───────────────────────────────────────────────────────────────────────────────────────────────
export interface SlideDeps { dataDir: string; image?: (prompt: string, ctx: { ownerId: string; sessionId?: string | null; agentId?: string | null; signal?: AbortSignal }) => Promise<{ fileId: string }> }

async function loadImages(store: Store, deps: SlideDeps, spec: DeckSpec, ctx: { ownerId: string; sessionId?: string | null; agentId?: string | null; signal?: AbortSignal }, notes: string[]) {
  const images = new Map<number, { bytes: Buffer; mime: string }>();
  for (const [index, slide] of spec.slides.entries()) {
    if (!slide.image) continue;
    let fileId = slide.image.fileId?.replace(/^file:/, '');
    if (!fileId && slide.image.prompt && deps.image) {
      try { fileId = (await deps.image(slide.image.prompt, ctx)).fileId; slide.image = { ...slide.image, fileId }; } catch (error) { notes.push(`Slide ${index + 1}: no picture (${error instanceof Error ? error.message : 'image model failed'}).`); continue; }
    }
    const file = fileId ? getFile(store, fileId) : null;
    if (!file || (file.ownerId && file.ownerId !== ctx.ownerId && ctx.ownerId !== OWNER_ID) || !/^image\/(png|jpe?g|gif)/.test(file.mime)) { if (fileId) notes.push(`Slide ${index + 1}: picture ${fileId} not found or not PNG/JPEG.`); continue; }
    images.set(index, { bytes: fs.readFileSync(filePath(store, deps.dataDir, file.id)!), mime: file.mime });
  }
  return images;
}

export function slidesTools(deps: SlideDeps): Tool[] {
  const make: Tool = {
    name: 'make_slides',
    description: 'Create or revise a PowerPoint deck (.pptx). Pass the whole deck as JSON: {title, lang:"he"|"en"|"auto", font:"Heebo"|"Assistant", theme:"light"|"dark"|"warm", slides:[{layout:"title"|"bullets"|"chart"|"image"|"quote"|"section", title, subtitle?, bullets?: string[], notes?: string (speaker notes), chart?: {type:"bar"|"line"|"pie"|"doughnut", labels:string[], series:[{name, values:number[]}], title?}, image?: {fileId?, prompt?, caption?}}]}. Hebrew decks are right-to-left with an embedded Hebrew font. image.prompt makes a picture with the image model. For an edit round, call read_slides first, change the JSON, and pass revise_file_id so the new version is saved next to the old one. Returns a [file:<id>] reference to put in the reply.',
    parameters: { type: 'object', properties: { deck: { type: 'object' }, file_name: { type: 'string' }, revise_file_id: { type: 'string' } }, required: ['deck'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const ownerId = ctx.agent.ownerId || OWNER_ID;
      const spec = validateDeck(typeof args.deck === 'string' ? JSON.parse(args.deck) : args.deck);
      const notes: string[] = [];
      const images = await loadImages(ctx.store, deps, spec, { ownerId, sessionId: ctx.sessionId, agentId: ctx.agent.id, signal: ctx.signal }, notes);
      const bytes = await buildDeck(spec, images);
      const previous = args.revise_file_id ? getFile(ctx.store, String(args.revise_file_id).replace(/^file:/, '')) : null;
      const base = String(args.file_name || previous?.name || spec.title).replace(/\.pptx$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'deck';
      const version = previous ? ` v${(Number(previous.name.match(/ v(\d+)\.pptx$/i)?.[1]) || 1) + 1}` : '';
      const file = saveFile(ctx.store, deps.dataDir, { name: `${base.replace(/ v\d+$/i, '')}${version}.pptx`, bytes, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sessionId: ctx.sessionId ?? null, agentId: ctx.agent.id, source: 'agent', ownerId });
      const rtl = deckIsHebrew(spec);
      return `Saved [file:${file.id}] (${spec.slides.length} slides, ${rtl ? 'Hebrew, right-to-left' : 'left-to-right'}, font ${spec.font}${images.size ? `, ${images.size} picture(s)` : ''}). ${notes.join(' ')} Mention [file:${file.id}] in the reply; the user can preview it and ask for changes.`;
    },
  };
  const read: Tool = {
    name: 'read_slides',
    description: 'Read a .pptx deck: returns the JSON spec for decks made with make_slides (edit it and call make_slides with revise_file_id), or the slide text and notes for other decks.',
    parameters: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const id = String(args.file_id || '').replace(/^file:/, '');
      const file = getFile(ctx.store, id);
      const ownerId = ctx.agent.ownerId || OWNER_ID;
      if (!file || (file.ownerId && file.ownerId !== ownerId && ownerId !== OWNER_ID)) return 'File not found.';
      const bytes = fs.readFileSync(filePath(ctx.store, deps.dataDir, id)!);
      const spec = await readDeckSpec(bytes);
      if (spec) return `Deck spec (edit and pass to make_slides with revise_file_id="${id}"):\n${JSON.stringify(spec, null, 1)}`;
      const slides = await readDeckText(bytes);
      return slides.map((slide, index) => `Slide ${index + 1}: ${slide.title}\n${slide.lines.map((line) => `- ${line}`).join('\n')}${slide.notes ? `\nNotes: ${slide.notes}` : ''}`).join('\n\n') || 'No slides found.';
    },
  };
  return [make, read];
}

// ── Slide pictures for the file viewer (LibreOffice + pdftoppm when installed; the viewer falls back to slide text) ──
const rendering = new Map<string, Promise<string[]>>();
function which(bin: string) {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)));
}
export function canRenderSlides() { return !process.env.LA_NO_SLIDE_RENDER && (which('soffice') || which('libreoffice')) && which('pdftoppm'); }

/** PNG per slide, cached next to the data folder by file id. Returns absolute paths, or [] when the tools are missing. */
export async function renderSlides(dataDir: string, fileId: string, pptx: string): Promise<string[]> {
  if (!canRenderSlides()) return [];
  const dir = path.join(dataDir, 'previews', fileId.replace(/[^\w-]/g, ''));
  const list = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^s-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).map((name) => path.join(dir, name)) : []);
  if (list().length) return list();
  const running = rendering.get(fileId);
  if (running) return running;
  const job = (async () => {
    const { execFile } = await import('node:child_process');
    const run = (bin: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(bin, args, { timeout: 90_000, env: { ...process.env, HOME: dir } }, (error) => (error ? reject(error) : resolve())));
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'deck.pptx');
    fs.copyFileSync(pptx, input);
    await run(which('soffice') ? 'soffice' : 'libreoffice', ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input]);
    await run('pdftoppm', ['-r', '60', '-png', path.join(dir, 'deck.pdf'), path.join(dir, 's')]);
    for (const name of fs.readdirSync(dir)) {
      const match = /^s-0*(\d+)\.png$/.exec(name);
      if (match && name !== `s-${match[1]}.png`) fs.renameSync(path.join(dir, name), path.join(dir, `s-${match[1]}.png`));
      if (!/\.png$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    return list();
  })().finally(() => rendering.delete(fileId));
  rendering.set(fileId, job);
  return job;
}
