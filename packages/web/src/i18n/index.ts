/**
 * UI language. English text is the key; he.ts maps each key to Hebrew (a test keeps en/he in step).
 * The language is fixed for a page load: changing it saves the choice and reloads, so module-level labels follow too.
 */
import { he } from './he';

export type Lang = 'en' | 'he';
export type LangChoice = Lang | 'auto';
const KEY = 'la-lang';
// English is the identity map (en.ts exists for the parity test), so only Hebrew ships a table.
const TABLES: Record<Lang, Record<string, string>> = { en: {}, he };

/** he (or the old iw) anywhere in the browser's languages means Hebrew. */
export function detectLang(languages: readonly string[] = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language])): Lang {
  const first = languages.find((item) => /^(he|iw|en)\b/i.test(item));
  return first && /^(he|iw)\b/i.test(first) ? 'he' : 'en';
}

export function storedChoice(): LangChoice {
  try { const value = localStorage.getItem(KEY); return value === 'he' || value === 'en' ? value : 'auto'; } catch { return 'auto'; }
}

export function resolveLang(choice: LangChoice): Lang { return choice === 'auto' ? detectLang() : choice; }

export const lang: Lang = resolveLang(storedChoice());
export const dir: 'rtl' | 'ltr' = lang === 'he' ? 'rtl' : 'ltr';
export const locale = lang === 'he' ? 'he-IL' : 'en-US';

if (typeof document !== 'undefined') {
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
}

type Vars = (string | number | null | undefined)[] | Record<string, string | number | null | undefined>;

/** Translate one UI string. {0}/{name} placeholders are filled from vars. Unknown keys show the English. */
export function t(key: string, vars?: Vars): string {
  const text = TABLES[lang][key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = Array.isArray(vars) ? vars[Number(name)] : vars[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Translate text that may be a known key (a template persona's name, a server message); else return it as is. */
export function tMaybe(text: string | null | undefined): string {
  if (!text) return '';
  return TABLES[lang][text] ?? text;
}

/** Save the choice locally (and on the account when signed in), then reload into it. */
export async function setLanguage(choice: LangChoice, opts: { reload?: boolean; save?: (choice: LangChoice, resolved: Lang) => Promise<unknown> } = {}) {
  try { localStorage.setItem(KEY, choice); } catch { /* private mode */ }
  await opts.save?.(choice, resolveLang(choice)).catch(() => undefined);
  if (opts.reload !== false && resolveLang(choice) !== lang) window.location.reload();
}

/** Apply the account's saved choice on sign-in. Returns true when the page reloads into another language. */
export function adoptAccountLanguage(choice: LangChoice | null | undefined): boolean {
  if (!choice) return false;
  const current = storedChoice();
  if (choice === current) return false;
  try { localStorage.setItem(KEY, choice); } catch { return false; }
  if (resolveLang(choice) !== lang) { window.location.reload(); return true; }
  return false;
}

export const fmt = {
  date: (value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) => new Intl.DateTimeFormat(locale, options).format(new Date(value)),
  time: (value: string | number | Date) => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(value)),
  dateTime: (value: string | number | Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)),
  number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
  /** "5 minutes ago" / "לפני 5 דקות". */
  ago: (value: string | number | Date) => {
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    const abs = Math.abs(seconds);
    if (abs < 45) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), 'day');
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
  },
};

/** True when text is mostly Hebrew letters (for voice and direction choices). */
export function isHebrew(text: string): boolean {
  const he = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return he > 0 && he >= latin;
}
