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
  /** split = picture bleeding off one half + text on the other; cards = bullets as numbered cards; stats = big-number tiles; image = full-bleed hero picture. */
  layout?: 'title' | 'bullets' | 'chart' | 'image' | 'quote' | 'section' | 'split' | 'cards' | 'stats';
  title: string; subtitle?: string; bullets?: string[]; notes?: string;
  /** Small label above the title (e.g. the part of the talk: "מבוא | מחלת העצם"). */
  kicker?: string;
  /** Source line printed at the bottom of the slide. */
  source?: string;
  /** Big-number tiles for layout "stats" (2-4 of them). */
  stats?: { value: string; label: string }[];
  chart?: ChartSpec;
  /** An existing image file, a short English photo search (query), or a prompt for the image model (resolved before building). */
  image?: { fileId?: string; query?: string; prompt?: string; caption?: string };
}
export type DeckTheme = 'light' | 'dark' | 'warm' | 'ocean' | 'clinical';
export interface DeckSpec { title: string; author?: string; lang?: 'he' | 'en' | 'auto'; font?: DeckFont; theme?: DeckTheme; slides: SlideSpec[] }

interface Palette { bg: string; text: string; muted: string; accent: string; accent2: string; panel: string; hero: string; onHero: string; chart: string[] }
const THEMES: Record<DeckTheme, Palette> = {
  light: { bg: 'FFFFFF', text: '1F2937', muted: '6B7280', accent: '2563EB', accent2: 'F59E0B', panel: 'F3F4F6', hero: '1E3A8A', onHero: 'FFFFFF', chart: ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6'] },
  dark: { bg: '111827', text: 'F9FAFB', muted: '9CA3AF', accent: '60A5FA', accent2: 'FBBF24', panel: '1F2937', hero: '0B1220', onHero: 'FFFFFF', chart: ['60A5FA', 'FBBF24', '34D399', 'F87171', 'A78BFA'] },
  warm: { bg: 'FFF8F0', text: '3B2F2F', muted: '8A7360', accent: 'D9480F', accent2: 'F59F00', panel: 'FFEEDB', hero: '7C2D12', onHero: 'FFF8F0', chart: ['D9480F', 'F59F00', '2B8A3E', '1971C2', '9C36B5'] },
  ocean: { bg: 'F4F8FB', text: '0F2A3D', muted: '5B7285', accent: '0E7490', accent2: 'F59E0B', panel: 'FFFFFF', hero: '0B2A3D', onHero: 'FFFFFF', chart: ['0E7490', 'F59E0B', '10B981', 'E11D48', '6366F1'] },
  clinical: { bg: 'FFFFFF', text: '1B2B3A', muted: '64748B', accent: '0F766E', accent2: '2563EB', panel: 'EEF4F7', hero: '0F2B46', onHero: 'FFFFFF', chart: ['0F766E', '2563EB', 'F59E0B', 'E11D48', '7C3AED'] },
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
    if (slide.stats && (!Array.isArray(slide.stats) || slide.stats.some((tile) => !tile || typeof tile.value !== 'string' || typeof tile.label !== 'string'))) throw new Error(`Slide ${index + 1}: each stat needs a value and a label (strings).`);
    if (slide.chart) {
      const { labels, series } = slide.chart;
      if (!Array.isArray(labels) || !Array.isArray(series) || !series.length || series.some((row) => !Array.isArray(row.values) || row.values.length !== labels.length || row.values.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
        throw new Error(`Slide ${index + 1}: each chart series needs one number per label.`);
      }
    }
  }
  return { ...spec, font: DECK_FONTS.includes(spec.font as DeckFont) ? spec.font : 'Heebo', theme: spec.theme && spec.theme in THEMES ? spec.theme : 'clinical' };
}

type Picture = { bytes: Buffer; mime: string };
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Picture, stats and density review of a deck, so the agent can fix a plain/ugly deck before the user sees it. */
export function lintDeck(input: DeckSpec, images: Map<number, Picture>): string[] {
  const spec = validateDeck(input);
  const warnings: string[] = [];
  const bare: number[] = [];
  const dense: number[] = [];
  spec.slides.forEach((slide, index) => {
    const layout = slide.layout ?? (index === 0 ? 'title' : slide.chart ? 'chart' : slide.stats ? 'stats' : slide.image ? 'split' : 'bullets');
    if (index > 0 && !images.has(index) && !slide.chart && !slide.stats && layout !== 'section' && layout !== 'quote') bare.push(index + 1);
    if ((slide.bullets?.length ?? 0) > 5 || (slide.bullets ?? []).some((line) => wordCount(line) > 16)) dense.push(index + 1);
  });
  const total = spec.slides.length;
  if (total > 3 && (total - 1 - bare.length) / (total - 1) < 0.6) warnings.push(`Only ${total - 1 - bare.length} of ${total - 1} content slides have a picture, chart or stats (slides without: ${bare.join(', ')}). Give at least 60% of them a real picture: image {query: "short English photo search"} for photos/diagrams, or image {prompt} for generated art.`);
  if (dense.length) warnings.push(`Slides ${dense.join(', ')} are text-heavy (more than 5 bullets or a bullet over 16 words). Cut to 3-4 short bullets, use layout "cards" or "stats", and move detail into notes.`);
  if (spec.slides.some((slide) => slide.title.length > 70)) warnings.push('Some titles are over 70 characters; make titles short noun phrases.');
  if (!spec.slides.some((slide) => slide.source)) warnings.push('No slide has a "source" line; add one under every slide that states facts or numbers.');
  return warnings;
}

/** Build the .pptx. `images` maps a slide index to picture bytes (already generated or loaded). */
export async function buildDeck(input: DeckSpec, images: Map<number, Picture> = new Map()): Promise<Buffer> {
  const spec = validateDeck(input);
  const rtl = deckIsHebrew(spec);
  const theme = THEMES[spec.theme ?? 'clinical'];
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
  const W = 13.33;
  const H = 7.5;
  const text = { fontFace: font, color: theme.text, lang, rtlMode: rtl, align } as const;
  const data = (picture: Picture) => `${picture.mime};base64,${picture.bytes.toString('base64')}`;
  const bullet = (line: string) => ({ text: line, options: { bullet: rtl ? { characterCode: '25CF', indent: 18 } : true, breakLine: true } });
  /** The reading side is the right in Hebrew and the left in English; "far" is the opposite edge. */
  const readX = (width: number, margin = 0.7) => (rtl ? W - margin - width : margin);

  for (const [index, slide] of spec.slides.entries()) {
    const page = pres.addSlide();
    const picture = images.get(index);
    const requested = slide.layout ?? (index === 0 ? 'title' : slide.chart ? 'chart' : slide.stats ? 'stats' : slide.image ? 'split' : 'bullets');
    // A picture-less split/image slide falls back to a plain content slide instead of leaving a hole.
    const layout = (requested === 'split' || requested === 'image') && !picture ? 'bullets' : requested;
    const number = String(index + 1).padStart(2, '0');
    let footerOnDark = false;
    const kicker = (x: number, y: number, w: number, color: string) => { if (slide.kicker) page.addText(slide.kicker, { ...text, x, y, w, h: 0.4, fontSize: 14, bold: true, color, charSpacing: 1 }); };
    const heading = (x: number, y: number, w: number) => {
      kicker(x, y, w, theme.accent);
      page.addText(slide.title, { ...text, x, y: y + (slide.kicker ? 0.38 : 0), w, h: 1.1, fontSize: 32, bold: true, valign: 'top', fit: 'shrink' });
      page.addShape(pres.ShapeType.rect, { x: rtl ? x + w - 1.1 : x, y: y + (slide.kicker ? 1.52 : 1.14), w: 1.1, h: 0.07, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
    };

    if (layout === 'title' || layout === 'section' || layout === 'quote') {
      footerOnDark = true;
      page.background = { color: theme.hero };
      if (picture && layout === 'title') {
        page.addImage({ data: data(picture), x: 0, y: 0, w: W, h: H, sizing: { type: 'cover', w: W, h: H } });
        page.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: theme.hero, transparency: 28 }, line: { color: theme.hero, transparency: 100 } });
      } else {
        page.addShape(pres.ShapeType.ellipse, { x: rtl ? -2.2 : W - 5.2, y: -2.4, w: 7, h: 7, fill: { color: theme.accent, transparency: 55 }, line: { color: theme.accent, transparency: 100 } });
        page.addShape(pres.ShapeType.ellipse, { x: rtl ? W - 4.4 : -1.8, y: H - 3.4, w: 5.6, h: 5.6, fill: { color: theme.accent2, transparency: 78 }, line: { color: theme.accent2, transparency: 100 } });
      }
      page.addShape(pres.ShapeType.rect, { x: readX(0.14, 0.7), y: 2.2, w: 0.14, h: 2.6, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
      const tx = readX(10.6, 1.05);
      if (layout === 'section') page.addText(number, { ...text, color: theme.accent2, x: tx, y: 1.5, w: 4, h: 0.9, fontSize: 40, bold: true });
      kicker(tx, layout === 'section' ? 2.35 : 1.8, 10.6, theme.accent2);
      if (layout === 'quote') {
        page.addText('“', { ...text, color: theme.accent2, x: tx, y: 1.1, w: 2, h: 1.4, fontSize: 96, bold: true, align: 'left', rtlMode: false });
        page.addText(slide.title, { ...text, color: theme.onHero, x: tx, y: 2.3, w: 10.6, h: 3, fontSize: 34, italic: true, valign: 'top', fit: 'shrink' });
        if (slide.subtitle) page.addText(`— ${slide.subtitle}`, { ...text, color: theme.accent2, x: tx, y: 5.4, w: 10.6, h: 0.7, fontSize: 18 });
      } else {
        page.addText(slide.title, { ...text, color: theme.onHero, x: tx, y: 2.2, w: 10.6, h: 1.9, fontSize: layout === 'title' ? 50 : 40, bold: true, valign: 'middle', fit: 'shrink' });
        if (slide.subtitle) page.addText(slide.subtitle, { ...text, color: theme.onHero, x: tx, y: 4.2, w: 10.6, h: 1.1, fontSize: 22, valign: 'top', transparency: 15 });
      }
    } else if (layout === 'image' && picture) {
      footerOnDark = true;
      page.background = { color: theme.hero };
      page.addImage({ data: data(picture), x: 0, y: 0, w: W, h: H, sizing: { type: 'cover', w: W, h: H } });
      page.addShape(pres.ShapeType.rect, { x: 0, y: H - 2.5, w: W, h: 2.5, fill: { color: '000000', transparency: 38 }, line: { color: '000000', transparency: 100 } });
      kicker(readX(11.9, 0.7), H - 2.35, 11.9, theme.accent2);
      page.addText(slide.title, { ...text, color: 'FFFFFF', x: readX(11.9, 0.7), y: H - 1.95, w: 11.9, h: 0.9, fontSize: 32, bold: true, fit: 'shrink' });
      const caption = slide.image?.caption || slide.subtitle;
      if (caption) page.addText(caption, { ...text, color: 'E5E7EB', x: readX(11.9, 0.7), y: H - 1.05, w: 11.9, h: 0.6, fontSize: 16, valign: 'top' });
    } else if (layout === 'split' && picture) {
      page.background = { color: theme.bg };
      const half = W / 2;
      page.addImage({ data: data(picture), x: rtl ? 0 : half, y: 0, w: half, h: H, sizing: { type: 'cover', w: half, h: H } });
      if (slide.image?.caption) {
        page.addShape(pres.ShapeType.rect, { x: rtl ? 0 : half, y: H - 0.6, w: half, h: 0.6, fill: { color: '000000', transparency: 45 }, line: { color: '000000', transparency: 100 } });
        page.addText(slide.image.caption, { ...text, color: 'FFFFFF', x: (rtl ? 0 : half) + 0.3, y: H - 0.6, w: half - 0.6, h: 0.6, fontSize: 12, valign: 'middle', align: 'center' });
      }
      const tx = rtl ? half + 0.5 : 0.7;
      const tw = half - 1.2;
      heading(tx, 0.6, tw);
      const lines = slide.bullets ?? [];
      if (lines.length) page.addText(lines.map(bullet), { ...text, x: tx, y: 2.35, w: tw, h: 4.3, fontSize: lines.length > 4 ? 18 : 21, valign: 'top', paraSpaceAfter: 10, fit: 'shrink' });
    } else if (layout === 'stats') {
      page.background = { color: theme.bg };
      heading(readX(11.9), 0.55, 11.9);
      const tiles = (slide.stats ?? []).slice(0, 4);
      const gap = 0.35;
      const tw = tiles.length ? (11.9 - gap * (tiles.length - 1)) / tiles.length : 0;
      tiles.forEach((tile, i) => {
        const x = 0.7 + (rtl ? tiles.length - 1 - i : i) * (tw + gap);
        page.addShape(pres.ShapeType.roundRect, { x, y: 2.45, w: tw, h: 3.0, rectRadius: 0.12, fill: { color: theme.panel }, line: { color: theme.panel } });
        page.addShape(pres.ShapeType.rect, { x: x + tw / 2 - 0.4, y: 2.45, w: 0.8, h: 0.08, fill: { color: theme.accent }, line: { color: theme.accent } });
        page.addText(tile.value, { ...text, color: theme.accent, x: x + 0.15, y: 2.75, w: tw - 0.3, h: 1.4, fontSize: tiles.length > 3 ? 46 : 56, bold: true, align: 'center', valign: 'middle', fit: 'shrink' });
        page.addText(tile.label, { ...text, color: theme.muted, x: x + 0.25, y: 4.2, w: tw - 0.5, h: 1.1, fontSize: 17, align: 'center', valign: 'top', fit: 'shrink' });
      });
      if (slide.bullets?.length) page.addText(slide.bullets.slice(0, 2).map(bullet), { ...text, x: readX(11.9), y: 5.7, w: 11.9, h: 1.1, fontSize: 17, valign: 'top', fit: 'shrink' });
    } else if (layout === 'cards') {
      page.background = { color: theme.bg };
      heading(readX(11.9), 0.55, 11.9);
      const items = (slide.bullets ?? []).slice(0, 6);
      const cols = items.length > 4 ? 3 : 2;
      const rows = Math.ceil(items.length / cols);
      const gap = 0.3;
      const cw = (11.9 - gap * (cols - 1)) / cols;
      const ch = Math.min(2.2, (4.4 - gap * (rows - 1)) / rows);
      items.forEach((line, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = 0.7 + (rtl ? cols - 1 - col : col) * (cw + gap);
        const y = 2.4 + row * (ch + gap);
        page.addShape(pres.ShapeType.roundRect, { x, y, w: cw, h: ch, rectRadius: 0.1, fill: { color: theme.panel }, line: { color: theme.panel } });
        page.addShape(pres.ShapeType.ellipse, { x: rtl ? x + cw - 0.75 : x + 0.25, y: y + 0.25, w: 0.5, h: 0.5, fill: { color: theme.accent }, line: { color: theme.accent } });
        page.addText(String(i + 1), { ...text, color: 'FFFFFF', x: rtl ? x + cw - 0.75 : x + 0.25, y: y + 0.25, w: 0.5, h: 0.5, fontSize: 16, bold: true, align: 'center', valign: 'middle' });
        page.addText(line, { ...text, x: x + 0.25, y: y + 0.85, w: cw - 0.5, h: ch - 1.0, fontSize: 18, valign: 'top', fit: 'shrink' });
      });
    } else {
      // bullets / chart (and picture-less split/image): clean content slide with an optional chart or picture on the far side.
      page.background = { color: theme.bg };
      const hasSide = Boolean(slide.chart || picture);
      const boxW = hasSide ? 5.9 : 11.9;
      heading(readX(boxW), 0.55, boxW);
      const sideX = rtl ? 0.7 : W - 0.7 - 5.7;
      const lines = slide.bullets ?? [];
      if (lines.length) {
        page.addShape(pres.ShapeType.roundRect, { x: readX(boxW) - 0.1, y: 2.3, w: boxW + 0.2, h: 4.4, rectRadius: 0.1, fill: { color: theme.panel }, line: { color: theme.panel } });
        page.addText(lines.map(bullet), { ...text, x: readX(boxW) + 0.2, y: 2.45, w: boxW - 0.4, h: 4.1, fontSize: hasSide || lines.length > 4 ? 19 : 23, valign: 'top', paraSpaceAfter: 12, fit: 'shrink' });
      }
      if (slide.chart) {
        const kind = { bar: pres.ChartType.bar, line: pres.ChartType.line, pie: pres.ChartType.pie, doughnut: pres.ChartType.doughnut }[slide.chart.type] ?? pres.ChartType.bar;
        page.addChart(kind as unknown as Parameters<typeof page.addChart>[0], slide.chart.series.map((row) => ({ name: row.name, labels: slide.chart!.labels, values: row.values })), {
          ...(hasSide && lines.length ? { x: sideX, y: 2.3, w: 5.7, h: 4.4 } : { x: 0.9, y: 2.2, w: 11.5, h: 4.6 }),
          chartColors: theme.chart, showLegend: slide.chart.series.length > 1 || kind === pres.ChartType.pie, legendPos: 'b', legendFontFace: font, legendColor: theme.text,
          catAxisLabelFontFace: font, valAxisLabelFontFace: font, catAxisLabelColor: theme.text, valAxisLabelColor: theme.muted, dataLabelFontFace: font,
          showTitle: Boolean(slide.chart.title), title: slide.chart.title, titleFontFace: font, titleColor: theme.text,
          // Hebrew charts read right to left: categories start at the right.
          catAxisOrientation: (rtl && kind !== pres.ChartType.pie && kind !== pres.ChartType.doughnut ? 'maxMin' : 'minMax') as 'minMax', valAxisLabelPos: 'nextTo',
          showValue: kind === pres.ChartType.pie || kind === pres.ChartType.doughnut, showPercent: kind === pres.ChartType.pie,
        });
      } else if (picture) {
        page.addImage({ data: data(picture), x: sideX, y: 2.3, w: 5.7, h: 4.4, sizing: { type: 'cover', w: 5.7, h: 4.4 } });
        if (slide.image?.caption) page.addText(slide.image.caption, { ...text, x: sideX, y: 6.72, w: 5.7, h: 0.35, fontSize: 11, color: theme.muted, align: 'center' });
      }
    }
    const footColor = footerOnDark ? 'D1D5DB' : theme.muted;
    page.addText(number, { ...text, color: footColor, x: rtl ? 0.5 : W - 1.2, y: 7.0, w: 0.7, h: 0.3, fontSize: 11, bold: true, align: rtl ? 'left' : 'right' });
    if (slide.source) page.addText(slide.source, { ...text, color: footColor, x: readX(10.6, 0.7), y: 7.0, w: 10.6, h: 0.3, fontSize: 10, italic: true, fit: 'shrink' });
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
type ImageCtx = { ownerId: string; sessionId?: string | null; agentId?: string | null; signal?: AbortSignal };
export interface SlideDeps {
  dataDir: string;
  /** Generate a picture from a prompt (local Stable Diffusion / Gemini). */
  image?: (prompt: string, ctx: ImageCtx) => Promise<{ fileId: string }>;
  /** Find a real photo or diagram on the web (Wikimedia Commons / SearXNG) from short English search words. */
  photo?: (query: string, ctx: ImageCtx) => Promise<{ fileId: string }>;
}

async function loadImages(store: Store, deps: SlideDeps, spec: DeckSpec, ctx: ImageCtx, notes: string[]) {
  const images = new Map<number, { bytes: Buffer; mime: string }>();
  const resolveOne = async (index: number) => {
    const slide = spec.slides[index]!;
    if (!slide.image) return;
    let fileId = slide.image.fileId?.replace(/^file:/, '');
    const errors: string[] = [];
    // 1. a real photo/diagram by search words, 2. generated art from the prompt (which itself falls back to a web search).
    if (!fileId && slide.image.query && deps.photo) {
      try { fileId = (await deps.photo(slide.image.query, ctx)).fileId; } catch (error) { errors.push(error instanceof Error ? error.message : 'photo search failed'); }
    }
    if (!fileId && slide.image.prompt && deps.image) {
      try { fileId = (await deps.image(slide.image.prompt, ctx)).fileId; } catch (error) { errors.push(error instanceof Error ? error.message : 'image model failed'); }
    }
    if (fileId) slide.image = { ...slide.image, fileId };
    else if (errors.length) { notes.push(`Slide ${index + 1}: no picture (${errors.join('; ')}). Try a simpler English image.query.`); return; }
    const file = fileId ? getFile(store, fileId) : null;
    if (!file || (file.ownerId && file.ownerId !== ctx.ownerId && ctx.ownerId !== OWNER_ID) || !/^image\/(png|jpe?g|gif)/.test(file.mime)) { if (fileId) notes.push(`Slide ${index + 1}: picture ${fileId} not found or not PNG/JPEG.`); return; }
    images.set(index, { bytes: fs.readFileSync(filePath(store, deps.dataDir, file.id)!), mime: file.mime });
  };
  // Three at a time: image search is quick, local generation is serialised by the RAM budget anyway.
  const queue = spec.slides.map((_, index) => index).filter((index) => spec.slides[index]!.image);
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (let next = queue.shift(); next !== undefined; next = queue.shift()) await resolveOne(next); }));
  return images;
}

export function slidesTools(deps: SlideDeps): Tool[] {
  const make: Tool = {
    name: 'make_slides',
    description: 'Create or revise a PowerPoint deck (.pptx) that looks designed, not like a text dump. Pass the whole deck as JSON: {title, lang:"he"|"en"|"auto", font:"Heebo"|"Assistant", theme:"clinical"|"ocean"|"light"|"dark"|"warm", slides:[{layout, title, kicker?, subtitle?, bullets?, stats?, chart?, image?, source?, notes?}]}. Layouts: "title" (hero, put image on it), "section" (big number divider), "split" (full-height picture on one half + 3-4 bullets), "image" (full-bleed picture with caption), "cards" (3-6 short points as numbered cards), "stats" (stats:[{value:"1 in 3", label:"..."}] big-number tiles, 2-4), "chart" (chart:{type:"bar"|"line"|"pie"|"doughnut", labels, series:[{name, values}], title?} + optional bullets), "quote", "bullets" (plain, use sparingly). DESIGN RULES: at least 60% of slides carry a real picture: image:{query:"short English photo search words, e.g. osteoclast bone resorption diagram"} finds a real photo/diagram (Wikimedia Commons), image:{prompt:"vivid scene, no text"} generates art, image:{fileId} reuses a file (fetch_image gives file ids); add image.caption. Vary layouts (never 3 identical in a row), 3-4 bullets of at most 12 words, one idea per slide, kicker = the section label above the title, source = the source line printed at the bottom, notes = 2-4 spoken sentences. Hebrew decks are right-to-left with an embedded Hebrew font. For an edit round call read_slides first, change the JSON, and pass revise_file_id so the new version is saved next to the old one. The result lists design problems (missing pictures, text-heavy slides): fix them and call make_slides again with revise_file_id before replying. Returns a [file:<id>] reference to put in the reply.',
    parameters: { type: 'object', properties: { deck: { type: 'object' }, file_name: { type: 'string' }, revise_file_id: { type: 'string' } }, required: ['deck'], additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const ownerId = ctx.agent.ownerId || OWNER_ID;
      const spec = validateDeck(typeof args.deck === 'string' ? JSON.parse(args.deck) : args.deck);
      const notes: string[] = [];
      const images = await loadImages(ctx.store, deps, spec, { ownerId, sessionId: ctx.sessionId, agentId: ctx.agent.id, signal: ctx.signal }, notes);
      const bytes = await buildDeck(spec, images);
      const lint = lintDeck(spec, images);
      const previous = args.revise_file_id ? getFile(ctx.store, String(args.revise_file_id).replace(/^file:/, '')) : null;
      const base = String(args.file_name || previous?.name || spec.title).replace(/\.pptx$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'deck';
      const version = previous ? ` v${(Number(previous.name.match(/ v(\d+)\.pptx$/i)?.[1]) || 1) + 1}` : '';
      const file = saveFile(ctx.store, deps.dataDir, { name: `${base.replace(/ v\d+$/i, '')}${version}.pptx`, bytes, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sessionId: ctx.sessionId ?? null, agentId: ctx.agent.id, source: 'agent', ownerId });
      const rtl = deckIsHebrew(spec);
      return `Saved [file:${file.id}] (${spec.slides.length} slides, ${rtl ? 'Hebrew, right-to-left' : 'left-to-right'}, font ${spec.font}${images.size ? `, ${images.size} of ${spec.slides.length} slides with a picture` : ', no pictures'}). ${notes.join(' ')}${lint.length ? ` DESIGN CHECK - fix before replying (call make_slides again with revise_file_id="${file.id}"): ${lint.join(' ')}` : ' Design check passed.'} Mention [file:${file.id}] in the reply; the user can preview it and ask for changes.`;
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
