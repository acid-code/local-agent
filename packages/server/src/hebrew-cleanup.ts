import { codeSwitchRate, foreignWords, isHebrewText, scriptStats } from '@local-agent/shared';

/**
 * Optional second pass for Hebrew text from small models (replies and OCR output): replace stray foreign-script words
 * with Hebrew and fix grammar and gender agreement, without changing meaning. Code, paths and URLs are masked first and
 * must come back untouched; any doubtful result keeps the original.
 */
export type Complete = (prompt: string) => Promise<string>;
export interface CleanupResult { text: string; changed: boolean; reason: string; before: number; after: number }

const MASK = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|\[(?:file|msg):[^\]]+\]|(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+/g;

export function maskProtected(text: string): { masked: string; parts: string[] } {
  const parts: string[] = [];
  const masked = text.replace(MASK, (match) => { parts.push(match); return `⟦${parts.length - 1}⟧`; });
  return { masked, parts };
}

export function unmask(text: string, parts: string[]): string | null {
  for (let index = 0; index < parts.length; index += 1) if (!text.includes(`⟦${index}⟧`)) return null;
  return text.replace(/⟦(\d+)⟧/g, (match, n: string) => parts[Number(n)] ?? match);
}

export function cleanupPrompt(masked: string, kind: 'reply' | 'ocr'): string {
  const what = kind === 'ocr'
    ? 'This is text read from a photo by OCR. Fix obvious OCR mistakes in Hebrew words (wrong or swapped letters, broken words) only when the right word is clear. Keep line breaks, numbers and English words that are really English.'
    : 'This is a chatbot reply in Hebrew. Replace any word in another language or script (English, Russian, Chinese, …) with the natural Hebrew word, unless it is a name, a brand, a unit or a technical term. Fix grammar and keep grammatical gender consistent.';
  return `You are a careful Hebrew editor. ${what}\nDo not add, remove or reorder content. Do not answer the text or add comments. Keep Markdown and every marker like ⟦0⟧ exactly as it is.\nReturn only the corrected text.\n\n<text>\n${masked}\n</text>`;
}

/** Strip wrappers small models add (<text> tags, a "Corrected:" lead-in, code fences around everything). */
function unwrap(raw: string): string {
  let text = raw.trim().replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/^<text>\s*/i, '').replace(/\s*<\/text>$/i, '');
  text = text.replace(/^(?:corrected(?: text)?|הטקסט המתוקן|טקסט מתוקן)\s*:\s*/i, '');
  const fenced = text.match(/^```[a-z]*\n([\s\S]*)\n```$/);
  return (fenced ? fenced[1]! : text).trim();
}

export async function cleanupHebrew(text: string, complete: Complete, opts: { kind?: 'reply' | 'ocr'; minChars?: number } = {}): Promise<CleanupResult> {
  const before = foreignWords(text).length;
  const keep = (reason: string): CleanupResult => ({ text, changed: false, reason, before, after: before });
  if (text.trim().length < (opts.minChars ?? 12)) return keep('too short');
  if (!isHebrewText(text)) return keep('not Hebrew');
  const { masked, parts } = maskProtected(text);
  let raw: string;
  try { raw = await complete(cleanupPrompt(masked, opts.kind ?? 'reply')); } catch (error) { return keep(`cleanup model failed: ${error instanceof Error ? error.message : 'error'}`); }
  const unmasked = unmask(unwrap(raw), parts);
  // Small models sometimes wrap their own words in the marker brackets; those are not ours, drop the brackets.
  const restored = unmasked === null ? null : unmasked.replace(/[⟦⟧]/g, '');
  if (restored === null) return keep('cleanup dropped protected code or links');
  if (!restored.trim() || !isHebrewText(restored)) return keep('cleanup did not return Hebrew');
  const ratio = restored.length / text.length;
  if (ratio < 0.6 || ratio > 1.5) return keep('cleanup changed the length too much');
  const after = foreignWords(restored).length;
  if (after > before || scriptStats(restored).other > scriptStats(text).other) return keep('cleanup made it worse');
  if (codeSwitchRate(restored) > codeSwitchRate(text) + 0.02) return keep('cleanup added foreign words');
  return { text: restored, changed: restored !== text, reason: restored !== text ? 'cleaned' : 'already clean', before, after };
}
