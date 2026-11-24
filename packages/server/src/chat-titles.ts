/**
 * Chat titles and previews for the sidebar. Titles are 3-6 words in English written by the small side model after the first
 * exchange, with a plain-text fallback when no model is around.
 * A title the user typed (rename) is never replaced. Pure helpers here; the engine does the model call.
 */
import { CONTEXT_MARK } from './mentions.js';

/** Where a chat's title came from: '' = the first-message stub, 'auto' = generated, 'fallback' = heuristic, 'user' = renamed. */
export type TitleSource = '' | 'auto' | 'fallback' | 'user';

export const hasHebrew = (text: string): boolean => /[\u0590-\u05FF]/.test(text);

/** Strips our own markers, tool/action tags, markdown and links, so previews and prompts read as plain text. */
export function cleanText(raw: string): string {
  let text = String(raw ?? '');
  const mark = text.indexOf(CONTEXT_MARK.trim());
  if (mark >= 0) text = text.slice(0, mark);
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(tool_call|tool_result|think|thinking)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(tool_call|tool_result|think|thinking)>/gi, ' ')
    // [action: search …], [tool: read_file …], [routing: …], [context …], [system …]
    .replace(/\[(?:action|tool|tools|routing|routed|context|system|status|step|trace|note)\b[^\]]*\]?/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[*_`#>|~]+/g, '')
    .replace(/^[\s\-•]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Notices we write into the chat ourselves (stopped/failed replies) are not what the chat is about. */
export function isNotice(text: string): boolean {
  return /^(⚠️?|❌|⛔)\s*/u.test(text.trim()) || /^This reply (stopped|failed)\b/i.test(text.trim());
}

/** The newest message worth showing as a preview: cleaned, not a notice, not empty. */
export function previewOf(messages: { role: string; content: string }[], max = 280): { role: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = cleanText(m.content);
    if (!text || isNotice(m.content) || isNotice(text)) continue;
    return { role: m.role, text: text.length > max ? `${text.slice(0, max - 1)}…` : text };
  }
  return null;
}

/** The prompt for the side model: the first exchange, trimmed. */
export function titlePrompt(user: string, reply: string): string {
  return [
    'Write a short title in English (3 to 6 words) summarizing this chat.',
    'Always write the title in English only — translate the topic to English if the chat uses another language.',
    'No quotes, no emoji, no trailing punctuation. Reply with the English title only.',
    '',
    `User: ${cleanText(user).slice(0, 600)}`,
    reply ? `Assistant: ${cleanText(reply).slice(0, 400)}` : '',
  ].filter((line) => line !== undefined).join('\n');
}

/** Cleans what the model wrote into an English title, or null when it is unusable (e.g. contains Hebrew or lacks Latin letters). */
export function parseTitle(raw: string): string | null {
  let text = cleanText(String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, ''));
  text = text.split(/\n/)[0] ?? '';
  text = text.replace(/^(title|כותרת)\s*[:：-]\s*/i, '').replace(/^["'“”«»‘’]+|["'“”«»‘’]+$/g, '').replace(/[.!?。:;,]+$/u, '').trim();
  if (!text || hasHebrew(text) || !/[A-Za-z]/.test(text)) return null;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 10) return null;
  const title = words.slice(0, 8).join(' ');
  return title.length > 64 ? `${title.slice(0, 63)}…` : title;
}

/** A plain fallback: the first few words of the user's first message. */
export function fallbackTitle(user: string): string {
  const words = cleanText(user).split(/\s+/).filter(Boolean);
  if (!words.length) return 'New chat';
  const title = words.slice(0, 6).join(' ').replace(/[.!?,:;]+$/u, '');
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

/** A chat still needs a generated title (unnamed, heuristic fallback, or an old auto-title containing Hebrew). */
export function needsTitle(source: string | null | undefined, title?: string | null): boolean {
  if (source === 'user') return false;
  if (source === 'auto') return Boolean(title && hasHebrew(title));
  return true;
}
