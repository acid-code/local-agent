import crypto from 'node:crypto';
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
export interface ComparisonColumn { heading: string; bullets: string[]; accent?: boolean }
export interface TimelineStep { label?: string; title: string; detail?: string }
export interface TableSpec { headers: string[]; rows: string[][] }
export interface SlideSpec {
  /** split, image, cards, stats, comparison, timeline, table, chart, quote, section, title, bullets. */
  layout?: 'title' | 'bullets' | 'chart' | 'image' | 'quote' | 'section' | 'split' | 'cards' | 'stats' | 'comparison' | 'timeline' | 'table';
  title: string; subtitle?: string; bullets?: string[]; notes?: string;
  /** Small label above the title (e.g. the part of the talk: "מבוא | מחלת העצם"). */
  kicker?: string;
  /** Source line printed at the bottom of the slide. */
  source?: string;
  /** Big-number tiles for layout "stats" (2-4 of them). */
  stats?: { value: string; label: string }[];
  /** Side-by-side cards for layout "comparison" (2-3 columns). */
  columns?: ComparisonColumn[];
  /** Horizontal milestone nodes for layout "timeline" (3-5 steps). */
  steps?: TimelineStep[];
  /** Styled native table for layout "table". */
  table?: TableSpec;
  chart?: ChartSpec;
  /** An existing image file, a short English photo search (query), or a prompt for the image model (resolved before building). */
  image?: { fileId?: string; query?: string; prompt?: string; caption?: string };
}
export type DeckTheme = 'light' | 'dark' | 'warm' | 'ocean' | 'clinical' | 'midnight' | 'editorial' | 'forest' | 'royal';
export interface DeckSpec { title: string; author?: string; lang?: 'he' | 'en' | 'auto'; font?: DeckFont; theme?: DeckTheme; slides: SlideSpec[] }

interface Palette { bg: string; text: string; muted: string; accent: string; accent2: string; panel: string; surface: string; border: string; hero: string; onHero: string; chart: string[] }
const THEMES: Record<DeckTheme, Palette> = {
  light: { bg: 'F8FAFC', text: '0F172A', muted: '64748B', accent: '2563EB', accent2: 'F59E0B', panel: 'EFF4F9', surface: 'FFFFFF', border: 'DCE4EE', hero: '1E3A8A', onHero: 'FFFFFF', chart: ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6'] },
  dark: { bg: '111827', text: 'F9FAFB', muted: '9CA3AF', accent: '60A5FA', accent2: 'FBBF24', panel: '1F2937', surface: '182232', border: '334155', hero: '0B1220', onHero: 'FFFFFF', chart: ['60A5FA', 'FBBF24', '34D399', 'F87171', 'A78BFA'] },
  warm: { bg: 'FFF8F0', text: '3B2F2F', muted: '8A7360', accent: 'D9480F', accent2: 'F59F00', panel: 'FFEEDB', surface: 'FFFFFF', border: 'F0D9C2', hero: '7C2D12', onHero: 'FFF8F0', chart: ['D9480F', 'F59F00', '2B8A3E', '1971C2', '9C36B5'] },
  ocean: { bg: 'F4F8FB', text: '0F2A3D', muted: '5B7285', accent: '0E7490', accent2: 'F59E0B', panel: 'E8F2F7', surface: 'FFFFFF', border: 'D1E3EC', hero: '0B2A3D', onHero: 'FFFFFF', chart: ['0E7490', 'F59E0B', '10B981', 'E11D48', '6366F1'] },
  clinical: { bg: 'FFFFFF', text: '1B2B3A', muted: '64748B', accent: '0F766E', accent2: '2563EB', panel: 'EEF4F7', surface: 'FFFFFF', border: 'D8E4EA', hero: '0F2B46', onHero: 'FFFFFF', chart: ['0F766E', '2563EB', 'F59E0B', 'E11D48', '7C3AED'] },
  midnight: { bg: '0F172A', text: 'F8FAFC', muted: '94A3B8', accent: '38BDF8', accent2: 'F59E0B', panel: '1E293B', surface: '162033', border: '334155', hero: '090F1D', onHero: 'F8FAFC', chart: ['38BDF8', 'F59E0B', '34D399', 'F472B6', 'A78BFA'] },
  editorial: { bg: 'FAF7F2', text: '1C1917', muted: '78716C', accent: 'C2410C', accent2: '0F766E', panel: 'F3EDE3', surface: 'FFFFFF', border: 'E7E0D6', hero: '1C1917', onHero: 'FAF7F2', chart: ['C2410C', '0F766E', 'D97706', '2563EB', '7C3AED'] },
  forest: { bg: 'F4F8F5', text: '122B22', muted: '527065', accent: '059669', accent2: 'D97706', panel: 'E7F1EC', surface: 'FFFFFF', border: 'CFE2D8', hero: '133429', onHero: 'F4F8F5', chart: ['059669', 'D97706', '0284C7', 'E11D48', '7C3AED'] },
  royal: { bg: 'F8F7FC', text: '1E1B4B', muted: '64748B', accent: '6D28D9', accent2: 'F43F5E', panel: 'EFEAFD', surface: 'FFFFFF', border: 'DDD6FE', hero: '1E1B4B', onHero: 'FFFFFF', chart: ['6D28D9', 'F43F5E', '0EA5E9', '10B981', 'F59E0B'] },
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
  if (spec.slides.length > 40) throw new Error('Keep a deck to 40 slides or fewer.');
  for (const [index, slide] of spec.slides.entries()) {
    if (!slide || typeof slide.title !== 'string') throw new Error(`Slide ${index + 1} needs a title.`);
    slide.title = slide.title.trim().slice(0, 70);
    if (!slide.title) throw new Error(`Slide ${index + 1} needs a non-empty title.`);
    if (slide.bullets) slide.bullets = slide.bullets.map((line) => line.trim()).filter(Boolean);
    if (slide.subtitle) slide.subtitle = slide.subtitle.trim().slice(0, 180);
    if (slide.notes) slide.notes = slide.notes.trim().slice(0, 1200);
    if (slide.stats && (!Array.isArray(slide.stats) || slide.stats.some((tile) => !tile || typeof tile.value !== 'string' || typeof tile.label !== 'string'))) throw new Error(`Slide ${index + 1}: each stat needs a value and a label (strings).`);
    if (slide.columns) {
      if (!Array.isArray(slide.columns) || !slide.columns.length || slide.columns.some((col) => !col || typeof col.heading !== 'string' || !Array.isArray(col.bullets))) {
        throw new Error(`Slide ${index + 1}: each comparison column needs a heading and bullets array.`);
      }
      slide.columns = slide.columns.slice(0, 3).map((col) => ({
        heading: col.heading.trim().slice(0, 60),
        bullets: col.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 5),
        ...(col.accent ? { accent: true } : {}),
      }));
    }
    if (slide.steps) {
      if (!Array.isArray(slide.steps) || !slide.steps.length || slide.steps.some((step) => !step || typeof step.title !== 'string')) {
        throw new Error(`Slide ${index + 1}: each timeline step needs a title.`);
      }
      slide.steps = slide.steps.slice(0, 5).map((step) => ({
        ...(step.label ? { label: String(step.label).trim().slice(0, 16) } : {}),
        title: step.title.trim().slice(0, 48),
        ...(step.detail ? { detail: String(step.detail).trim().slice(0, 140) } : {}),
      }));
    }
    if (slide.table) {
      const { headers, rows } = slide.table;
      if (!Array.isArray(headers) || !headers.length || !Array.isArray(rows) || !rows.length) {
        throw new Error(`Slide ${index + 1}: table needs non-empty headers and rows.`);
      }
      const cols = Math.min(6, headers.length);
      slide.table = {
        headers: headers.slice(0, cols).map((h) => String(h ?? '').trim()),
        rows: rows.slice(0, 8).map((row) => Array.from({ length: cols }, (_, i) => String((Array.isArray(row) ? row[i] : '') ?? '').trim())),
      };
    }
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

function resolveSlideLayout(slide: SlideSpec, index: number) {
  return slide.layout ?? (
    index === 0 ? 'title'
      : slide.table ? 'table'
        : slide.steps ? 'timeline'
          : slide.columns ? 'comparison'
            : slide.chart ? 'chart'
              : slide.stats ? 'stats'
                : slide.image ? 'split'
                  : 'bullets'
  );
}

/** Picture, stats and density review of a deck, so the agent can fix a plain/ugly deck before the user sees it. */
export function lintDeck(input: DeckSpec, images: Map<number, Picture>): string[] {
  const spec = validateDeck(input);
  const warnings: string[] = [];
  const bare: number[] = [];
  const dense: number[] = [];
  spec.slides.forEach((slide, index) => {
    const layout = resolveSlideLayout(slide, index);
    const hasVisualOrStructured = images.has(index) || Boolean(slide.chart || slide.stats || slide.columns?.length || slide.steps?.length || slide.table);
    if (index > 0 && !hasVisualOrStructured && layout !== 'section' && layout !== 'quote') bare.push(index + 1);
    if ((slide.bullets?.length ?? 0) > 5 || (slide.bullets ?? []).some((line) => wordCount(line) > 16)) dense.push(index + 1);
  });
  const total = spec.slides.length;
  if (total > 3 && (total - 1 - bare.length) / (total - 1) < 0.6) warnings.push(`Only ${total - 1 - bare.length} of ${total - 1} content slides have a picture, chart or stats (slides without: ${bare.join(', ')}). Give at least 60% of them a real picture: image {query: "short English photo search"} for photos/diagrams, or image {prompt} for generated art.`);
  if (dense.length) warnings.push(`Slides ${dense.join(', ')} are text-heavy (more than 5 bullets or a bullet over 16 words). Cut to 3-4 short bullets, use layout "cards" or "stats", and move detail into notes.`);
  if (spec.slides.some((slide) => slide.title.length > 70)) warnings.push('Some titles are over 70 characters; make titles short noun phrases.');
  if (!spec.slides.some((slide) => slide.source)) warnings.push('No slide has a "source" line; add one under every slide that states facts or numbers.');
  if (spec.slides.length > 28) warnings.push('This deck has more than 28 slides. Split it into a shorter executive narrative or a separate appendix.');
  const repeated = spec.slides.slice(1).filter((slide, index) => {
    const previous = spec.slides[index];
    const layout = resolveSlideLayout(slide, index + 1);
    const previousLayout = resolveSlideLayout(previous, index);
    return layout === previousLayout;
  }).length;
  if (repeated > 4) warnings.push('Several neighboring slides repeat the same layout. Alternate title, split, cards, stats, comparison, timeline, table, and chart layouts.');
  return warnings;
}

/** Parse lightweight inline **bold** and *italic* markdown into PptxGenJS text runs so raw asterisks never leak into slides. */
export function parseInlineRuns(
  line: string,
  base: Record<string, unknown>,
  opts: { bullet?: true | { characterCode: string; indent: number }; breakLine?: boolean } = {},
) {
  const tokens: { text: string; bold?: boolean; italic?: boolean }[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) tokens.push({ text: line.slice(last, match.index) });
    if (match[1]) tokens.push({ text: match[1], bold: true });
    else if (match[2]) tokens.push({ text: match[2], italic: true });
    last = pattern.lastIndex;
  }
  if (last < line.length) tokens.push({ text: line.slice(last) });
  if (!tokens.length) tokens.push({ text: line });
  return tokens.map((tok, i) => ({
    text: tok.text,
    options: {
      ...base,
      ...(tok.bold ? { bold: true } : {}),
      ...(tok.italic ? { italic: true } : {}),
      ...(i === 0 && opts.bullet ? { bullet: opts.bullet } : {}),
      ...(i === tokens.length - 1 && opts.breakLine ? { breakLine: true } : {}),
    },
  }));
}

/** Split a card line formatted as "**Title:** body" or "Title: body" into a bold card heading and concise body copy. */
export function splitCardLeadIn(raw: string): { heading: string | null; body: string } {
  const boldColon = /^\*\*([^*]{2,48}?):\*\*\s*(.+)$/.exec(raw.trim());
  if (boldColon) return { heading: boldColon[1]!.trim(), body: boldColon[2]!.trim() };
  const plainColon = /^([^:\n]{2,42}?):\s+(.+)$/.exec(raw.replace(/\*\*/g, '').trim());
  if (plainColon && wordCount(plainColon[1]!) <= 6) return { heading: plainColon[1]!.trim(), body: plainColon[2]!.trim() };
  return { heading: null, body: raw.trim() };
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
  const bulletOpt = rtl ? { characterCode: '25CF', indent: 18 } : true;
  const bulletRuns = (lines: string[], extra: Record<string, unknown> = {}) =>
    lines.flatMap((line) => parseInlineRuns(line, { ...text, ...extra }, { bullet: bulletOpt, breakLine: true }));
  const cardShadow = { type: 'outer' as const, blur: 6, offset: 2, angle: 45, opacity: 0.08, color: '000000' };
  /** The reading side is the right in Hebrew and the left in English; "far" is the opposite edge. */
  const readX = (width: number, margin = 0.7) => (rtl ? W - margin - width : margin);

  for (const [index, slide] of spec.slides.entries()) {
    const page = pres.addSlide();
    const picture = images.get(index);
    const requested = resolveSlideLayout(slide, index);
    // A picture-less split/image slide falls back to a plain content slide instead of leaving a hole.
    const layout = (requested === 'split' || requested === 'image') && !picture ? 'bullets' : requested;
    const number = String(index + 1).padStart(2, '0');
    let footerOnDark = false;
    const topBand = () => page.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.07, fill: { color: theme.accent }, line: { color: theme.accent } });
    const kicker = (x: number, y: number, w: number, color: string) => { if (slide.kicker) page.addText(slide.kicker, { ...text, x, y, w, h: 0.4, fontSize: 13, bold: true, color, charSpacing: 1.5 }); };
    const heading = (x: number, y: number, w: number) => {
      kicker(x, y, w, theme.accent);
      page.addText(slide.title, { ...text, x, y: y + (slide.kicker ? 0.36 : 0), w, h: 1.05, fontSize: 30, bold: true, valign: 'top', fit: 'shrink' });
      page.addShape(pres.ShapeType.rect, { x: rtl ? x + w - 1.2 : x, y: y + (slide.kicker ? 1.46 : 1.08), w: 1.2, h: 0.06, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
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
      topBand();
      const half = W / 2;
      page.addImage({ data: data(picture), x: rtl ? 0 : half, y: 0.07, w: half, h: H - 0.07, sizing: { type: 'cover', w: half, h: H - 0.07 } });
      page.addShape(pres.ShapeType.rect, { x: half - 0.025, y: 0.07, w: 0.05, h: H - 0.07, fill: { color: theme.accent2 }, line: { color: theme.accent2 } });
      if (slide.image?.caption) {
        page.addShape(pres.ShapeType.rect, { x: rtl ? 0 : half, y: H - 0.6, w: half, h: 0.6, fill: { color: '000000', transparency: 42 }, line: { color: '000000', transparency: 100 } });
        page.addText(slide.image.caption, { ...text, color: 'FFFFFF', x: (rtl ? 0 : half) + 0.3, y: H - 0.6, w: half - 0.6, h: 0.6, fontSize: 12, valign: 'middle', align: 'center' });
      }
      const tx = rtl ? half + 0.5 : 0.7;
      const tw = half - 1.2;
      heading(tx, 0.6, tw);
      const lines = slide.bullets ?? [];
      if (lines.length) page.addText(bulletRuns(lines), { ...text, x: tx, y: 2.35, w: tw, h: 4.3, fontSize: lines.length > 4 ? 17 : 20, valign: 'top', paraSpaceAfter: 12, fit: 'shrink' });
    } else if (layout === 'stats') {
      page.background = { color: theme.bg };
      topBand();
      heading(readX(11.9), 0.5, 11.9);
      const tiles = (slide.stats ?? []).slice(0, 4);
      const gap = 0.35;
      const tw = tiles.length ? (11.9 - gap * (tiles.length - 1)) / tiles.length : 0;
      tiles.forEach((tile, i) => {
        const x = 0.7 + (rtl ? tiles.length - 1 - i : i) * (tw + gap);
        const stripe = i % 2 === 0 ? theme.accent : theme.accent2;
        page.addShape(pres.ShapeType.roundRect, { x, y: 2.35, w: tw, h: 3.15, rectRadius: 0.1, fill: { color: theme.surface }, line: { color: theme.border, pt: 1 }, shadow: cardShadow });
        page.addShape(pres.ShapeType.rect, { x, y: 2.35, w: tw, h: 0.08, fill: { color: stripe }, line: { color: stripe } });
        page.addText(tile.value, { ...text, color: stripe, x: x + 0.15, y: 2.75, w: tw - 0.3, h: 1.4, fontSize: tiles.length > 3 ? 44 : 54, bold: true, align: 'center', valign: 'middle', fit: 'shrink' });
        page.addText(tile.label, { ...text, color: theme.muted, x: x + 0.25, y: 4.2, w: tw - 0.5, h: 1.1, fontSize: 16, align: 'center', valign: 'top', fit: 'shrink' });
      });
      if (slide.bullets?.length) page.addText(bulletRuns(slide.bullets.slice(0, 2)), { ...text, x: readX(11.9), y: 5.75, w: 11.9, h: 1.05, fontSize: 16, valign: 'top', fit: 'shrink' });
    } else if (layout === 'cards') {
      page.background = { color: theme.bg };
      topBand();
      heading(readX(11.9), 0.5, 11.9);
      const items = (slide.bullets ?? []).slice(0, 6);
      const cols = items.length > 4 ? 3 : 2;
      const rows = Math.ceil(items.length / cols);
      const gap = 0.32;
      const cw = (11.9 - gap * (cols - 1)) / cols;
      const ch = Math.min(2.2, (4.4 - gap * (rows - 1)) / rows);
      items.forEach((line, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = 0.7 + (rtl ? cols - 1 - col : col) * (cw + gap);
        const y = 2.35 + row * (ch + gap);
        page.addShape(pres.ShapeType.roundRect, { x, y, w: cw, h: ch, rectRadius: 0.1, fill: { color: theme.surface }, line: { color: theme.border, pt: 1 }, shadow: cardShadow });
        page.addShape(pres.ShapeType.rect, { x, y, w: cw, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent } });
        const badgeX = rtl ? x + cw - 0.68 : x + 0.22;
        page.addShape(pres.ShapeType.ellipse, { x: badgeX, y: y + 0.24, w: 0.44, h: 0.44, fill: { color: theme.accent }, line: { color: theme.accent } });
        page.addText(String(i + 1), { ...text, color: 'FFFFFF', x: badgeX, y: y + 0.24, w: 0.44, h: 0.44, fontSize: 14, bold: true, align: 'center', valign: 'middle' });
        const split = splitCardLeadIn(line);
        if (split.heading) {
          const hx = rtl ? x + 0.2 : x + 0.78;
          const hw = cw - 0.98;
          page.addText(split.heading, { ...text, x: hx, y: y + 0.2, w: hw, h: 0.5, fontSize: 16, bold: true, valign: 'middle', fit: 'shrink' });
          page.addText(parseInlineRuns(split.body, { ...text, color: theme.muted }), { ...text, color: theme.muted, x: x + 0.24, y: y + 0.78, w: cw - 0.48, h: ch - 0.92, fontSize: 14, valign: 'top', fit: 'shrink' });
        } else {
          page.addText(parseInlineRuns(split.body, text), { ...text, x: x + 0.24, y: y + 0.8, w: cw - 0.48, h: ch - 0.94, fontSize: 16, valign: 'top', fit: 'shrink' });
        }
      });
    } else if (layout === 'comparison' && slide.columns?.length) {
      page.background = { color: theme.bg };
      topBand();
      heading(readX(11.9), 0.5, 11.9);
      const cols = slide.columns.slice(0, 3);
      const gap = 0.35;
      const cw = (11.9 - gap * (cols.length - 1)) / cols.length;
      cols.forEach((col, i) => {
        const x = 0.7 + (rtl ? cols.length - 1 - i : i) * (cw + gap);
        const headColor = col.accent ? theme.accent2 : theme.accent;
        page.addShape(pres.ShapeType.roundRect, { x, y: 2.3, w: cw, h: 4.35, rectRadius: 0.1, fill: { color: theme.surface }, line: { color: col.accent ? theme.accent2 : theme.border, pt: col.accent ? 1.5 : 1 }, shadow: cardShadow });
        page.addShape(pres.ShapeType.rect, { x, y: 2.3, w: cw, h: 0.65, fill: { color: headColor }, line: { color: headColor } });
        page.addText(col.heading, { ...text, color: 'FFFFFF', x: x + 0.2, y: 2.34, w: cw - 0.4, h: 0.57, fontSize: 18, bold: true, align: 'center', valign: 'middle', fit: 'shrink' });
        if (col.bullets.length) {
          page.addText(bulletRuns(col.bullets), { ...text, x: x + 0.25, y: 3.1, w: cw - 0.5, h: 3.35, fontSize: cols.length > 2 ? 15 : 17, valign: 'top', paraSpaceAfter: 10, fit: 'shrink' });
        }
      });
    } else if (layout === 'timeline' && slide.steps?.length) {
      page.background = { color: theme.bg };
      topBand();
      heading(readX(11.9), 0.5, 11.9);
      const steps = slide.steps.slice(0, 5);
      const gap = 0.28;
      const sw = (11.9 - gap * (steps.length - 1)) / steps.length;
      page.addShape(pres.ShapeType.rect, { x: 0.7 + sw / 2, y: 2.95, w: Math.max(1, 11.9 - sw), h: 0.05, fill: { color: theme.accent }, line: { color: theme.accent } });
      steps.forEach((step, i) => {
        const x = 0.7 + (rtl ? steps.length - 1 - i : i) * (sw + gap);
        const pillColor = i % 2 === 0 ? theme.accent : theme.accent2;
        const badgeW = step.label && step.label.length > 3 ? Math.min(sw - 0.2, 1.4) : 0.62;
        page.addShape(pres.ShapeType.roundRect, { x: x + sw / 2 - badgeW / 2, y: 2.67, w: badgeW, h: 0.56, rectRadius: 0.28, fill: { color: pillColor }, line: { color: pillColor } });
        page.addText(step.label || String(i + 1).padStart(2, '0'), { ...text, color: 'FFFFFF', x: x + sw / 2 - badgeW / 2, y: 2.67, w: badgeW, h: 0.56, fontSize: 14, bold: true, align: 'center', valign: 'middle', fit: 'shrink' });
        page.addShape(pres.ShapeType.roundRect, { x, y: 3.45, w: sw, h: 3.1, rectRadius: 0.1, fill: { color: theme.surface }, line: { color: theme.border, pt: 1 }, shadow: cardShadow });
        page.addText(step.title, { ...text, x: x + 0.18, y: 3.65, w: sw - 0.36, h: 0.75, fontSize: steps.length > 4 ? 15 : 17, bold: true, align: 'center', valign: 'top', fit: 'shrink' });
        if (step.detail) page.addText(step.detail, { ...text, color: theme.muted, x: x + 0.18, y: 4.45, w: sw - 0.36, h: 1.9, fontSize: steps.length > 4 ? 13 : 14, align: 'center', valign: 'top', fit: 'shrink' });
      });
    } else if (layout === 'table' && slide.table) {
      page.background = { color: theme.bg };
      topBand();
      heading(readX(11.9), 0.5, 11.9);
      const headers = rtl ? [...slide.table.headers].reverse() : slide.table.headers;
      const rows = slide.table.rows.map((row) => (rtl ? [...row].reverse() : row));
      const headCells = headers.map((cell) => ({
        text: cell,
        options: { ...text, color: 'FFFFFF', bold: true, fontSize: 14, fill: { color: theme.accent }, valign: 'middle' as const },
      }));
      const bodyRows = rows.map((row, rIdx) => row.map((cell) => ({
        text: cell,
        options: { ...text, fontSize: 13, fill: { color: rIdx % 2 === 0 ? theme.surface : theme.panel }, valign: 'middle' as const },
      })));
      page.addTable([headCells, ...bodyRows], {
        x: 0.7, y: 2.28, w: 11.9, rowH: 0.5,
        border: { type: 'solid', pt: 0.75, color: theme.border },
        margin: [6, 10, 6, 10],
        fontFace: font,
      });
    } else {
      // bullets / chart (and picture-less split/image): crisp open-canvas bullets with a left/right accent rail, or chart/picture beside.
      page.background = { color: theme.bg };
      topBand();
      const hasSide = Boolean(slide.chart || picture);
      const boxW = hasSide ? 5.9 : 11.9;
      heading(readX(boxW), 0.5, boxW);
      const sideX = rtl ? 0.7 : W - 0.7 - 5.7;
      const lines = slide.bullets ?? [];
      if (lines.length) {
        page.addShape(pres.ShapeType.rect, { x: rtl ? readX(boxW) + boxW - 0.06 : readX(boxW), y: 2.35, w: 0.06, h: Math.min(4.2, Math.max(1.8, lines.length * 0.9)), fill: { color: theme.accent }, line: { color: theme.accent } });
        page.addText(bulletRuns(lines), { ...text, x: rtl ? readX(boxW) : readX(boxW) + 0.22, y: 2.32, w: boxW - 0.25, h: 4.3, fontSize: hasSide || lines.length > 4 ? 18 : 22, valign: 'top', paraSpaceAfter: 14, fit: 'shrink' });
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
    description: 'Create or revise a PowerPoint deck (.pptx) directly in-process (never call localhost HTTP endpoints or write custom pptxgenjs shell scripts). Load the hebrew-slides skill first for design craft. Pass the whole deck as JSON: {title, lang:"he"|"en"|"auto", font:"Heebo"|"Assistant", theme:"clinical"|"ocean"|"midnight"|"editorial"|"forest"|"royal"|"warm"|"dark"|"light", slides:[{layout, title, kicker?, subtitle?, bullets?, stats?, columns?, steps?, table?, chart?, image?, source?, notes?}]}. Layouts: "title" (hero with image), "section" (big number divider), "split" (full-height picture + 3-4 bullets), "image" (full-bleed photo + caption), "cards" (3-6 "**Heading:** body" cards), "stats" (stats:[{value, label}], 2-4 KPIs), "comparison" (columns:[{heading, bullets, accent?}], 2-3 side-by-side panels), "timeline" (steps:[{label?, title, detail?}], 3-5 horizontal milestones), "table" (table:{headers, rows}), "chart" (bar/line/pie/doughnut), "quote", "bullets" (sparingly). DESIGN RULES: >=60% visual/structured slides (real photo/diagram via image:{query:"short English photo search words"}, generated art via image:{prompt}, chart, stats, comparison, timeline, or table); vary layouts; <=4 concise "**Lead:** detail" bullets (<12 words each); add kicker, source, and speaker notes. For 6+ slides use slide_draft in batches of 3-5 slides, then make_slides({draft_id}). Fix any DESIGN CHECK warning with make_slides({revise_file_id}).',
    parameters: { type: 'object', properties: { deck: { type: 'object', description: 'The whole deck (omit when passing draft_id).' }, draft_id: { type: 'string', description: 'Build from a slide_draft instead of passing deck.' }, file_name: { type: 'string' }, revise_file_id: { type: 'string' } }, additionalProperties: false },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const ownerId = ctx.agent.ownerId || OWNER_ID;
      const fromDraft = args.draft_id ? readDraft(deps.dataDir, String(args.draft_id), ownerId) : null;
      if (!fromDraft && args.deck === undefined) throw new Error('Pass deck (the whole deck) or draft_id (from slide_draft).');
      const spec = validateDeck(fromDraft ?? (typeof args.deck === 'string' ? JSON.parse(args.deck) : args.deck));
      const notes: string[] = [];
      const images = await loadImages(ctx.store, deps, spec, { ownerId, sessionId: ctx.sessionId, agentId: ctx.agent.id, signal: ctx.signal }, notes);
      const bytes = await buildDeck(spec, images);
      const lint = lintDeck(spec, images);
      const previous = args.revise_file_id ? getFile(ctx.store, String(args.revise_file_id).replace(/^file:/, '')) : null;
      const base = String(args.file_name || previous?.name || spec.title).replace(/\.pptx$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'deck';
      const version = previous ? ` v${(Number(previous.name.match(/ v(\d+)\.pptx$/i)?.[1]) || 1) + 1}` : '';
      const file = saveFile(ctx.store, deps.dataDir, { name: `${base.replace(/ v\d+$/i, '')}${version}.pptx`, bytes, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sessionId: ctx.sessionId ?? null, agentId: ctx.agent.id, source: 'agent', ownerId });
      const rtl = deckIsHebrew(spec);
      ctx.store.addLog('info', `PPTX created: ${file.name}; ${spec.slides.length} slides; ${images.size} resolved pictures; theme=${spec.theme ?? 'clinical'}; lang=${rtl ? 'he' : 'en'}; lint=${lint.length ? lint.join(' | ') : 'passed'}`, {
        fileId: file.id,
        reviseFileId: previous?.id ?? null,
        slideCount: spec.slides.length,
        pictureCount: images.size,
        layouts: spec.slides.map((slide) => slide.layout ?? 'auto'),
        imageQueries: spec.slides.map((slide) => slide.image?.query).filter(Boolean),
        lint,
      }, 'slides');
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
  const draft: Tool = {
    name: 'slide_draft',
    description: 'Build a deck cleanly in batches (up to 40 slides), then render it in-process with make_slides {draft_id}. Actions: start {title, lang?, font?, theme?} returns draft_id; add {draft_id, slides} (recommended: array of 3-5 slides per call) or add {draft_id, slide} appends slides; replace {draft_id, index, slide} swaps slide N (1-based); remove {draft_id, index}; show {draft_id} lists the slides. Each slide is validated on add.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'add', 'replace', 'remove', 'show'] },
        draft_id: { type: 'string' },
        title: { type: 'string', description: 'Deck title (start).' },
        lang: { type: 'string', enum: ['he', 'en', 'auto'] },
        font: { type: 'string' },
        theme: { type: 'string' },
        index: { type: 'integer', description: '1-based slide number (replace, remove).' },
        slide: { type: 'object', description: 'One slide: {layout, title, kicker?, subtitle?, bullets?, stats?, columns?, steps?, table?, chart?, image?, source?, notes?}.' },
        slides: { type: 'array', items: { type: 'object' }, description: 'Batch of 1-6 slides to append in one call (recommended for 8+ slide decks so drafting finishes in 3-5 steps).' },
      },
      required: ['action'],
    },
    mutates: () => false,
    approval: () => null,
    async execute(args, ctx) {
      const ownerId = ctx.agent.ownerId || OWNER_ID;
      const action = String(args.action || '');
      if (action === 'start') {
        const title = String(args.title || '').trim();
        if (!title) throw new Error('start needs a deck title.');
        const id = `draft_${crypto.randomBytes(6).toString('hex')}`;
        writeDraft(deps.dataDir, id, { ownerId, deck: { title, lang: args.lang, font: args.font, theme: args.theme, slides: [] } as unknown as DeckSpec });
        return `Draft ${id} started for "${title}". Add slides in batches of 3-5: slide_draft {action:"add", draft_id:"${id}", slides:[...]}. Then make_slides {draft_id:"${id}"}.`;
      }
      const id = String(args.draft_id || '');
      const deck = readDraft(deps.dataDir, id, ownerId);
      if (!deck) throw new Error(`No draft ${id || '(missing draft_id)'}. Start one with action "start".`);
      const checkSlide = (raw: unknown) => {
        const slide = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return validateDeck({ title: deck.title, slides: [slide] }).slides[0]!;
      };
      const at = (value: unknown) => {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 1 || index > deck.slides.length) throw new Error(`index must be 1-${deck.slides.length}.`);
        return index - 1;
      };
      if (action === 'add') {
        const batch = Array.isArray(args.slides) && args.slides.length ? args.slides : args.slide !== undefined ? [args.slide] : [];
        if (!batch.length) throw new Error('add needs slide or slides.');
        if (batch.length > 6) throw new Error('Pass at most 6 slides per slide_draft add call.');
        if (deck.slides.length + batch.length > 40) throw new Error('A deck holds at most 40 slides.');
        for (const item of batch) deck.slides.push(checkSlide(item));
      } else if (action === 'replace') {
        deck.slides[at(args.index)] = checkSlide(args.slide);
      } else if (action === 'remove') {
        deck.slides.splice(at(args.index), 1);
      } else if (action !== 'show') {
        throw new Error('action is start, add, replace, remove or show.');
      }
      if (action !== 'show') writeDraft(deps.dataDir, id, { ownerId, deck });
      const list = deck.slides.map((slide, index) => `${index + 1}. [${slide.layout ?? 'auto'}] ${slide.title}${slide.image ? ' 🖼' : ''}`).join('\n');
      return `${action === 'show' ? 'Draft' : `Saved (${action})`}: ${deck.slides.length} slide(s).\n${list || '(no slides yet)'}\nNext: add another slide batch, or make_slides {draft_id:"${id}"} to render.`;
    },
  };
  return [make, read, draft];
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

function draftFile(dataDir: string, id: string) {
  if (!/^draft_[a-f0-9]{12}$/.test(id)) return null;
  return path.join(dataDir, 'slide-drafts', `${id}.json`);
}
function writeDraft(dataDir: string, id: string, value: { ownerId: string; deck: DeckSpec }) {
  const file = draftFile(dataDir, id)!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
/** A draft deck for its owner (the owner account can read every draft). */
export function readDraft(dataDir: string, id: string, ownerId: string): DeckSpec | null {
  const file = draftFile(dataDir, id);
  if (!file || !fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { ownerId: string; deck: DeckSpec };
  if (value.ownerId !== ownerId && ownerId !== OWNER_ID) return null;
  return value.deck;
}
