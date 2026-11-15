/**
 * Hebrew text helpers shared by the server (search, routing, the cleanup pass) and the web app (direction, voice).
 * Hebrew attaches one-letter prefixes (ו ה ב ל מ ש כ) to words, so search terms get prefix-stripped variants.
 */
const HEBREW = /[\u05D0-\u05EA]/g;
const LATIN = /[A-Za-z]/g;
/** Points and cantillation marks (niqqud). Search ignores them. */
const NIQQUD = /[\u0591-\u05C7]/g;
const PREFIX = 'והבלמשכ';

export function stripNiqqud(text: string): string { return text.replace(NIQQUD, ''); }

/** Letter counts per script, for direction, voice and language choices. */
export function scriptStats(text: string) {
  const hebrew = text.match(HEBREW)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  // Letters that are neither Hebrew nor Latin (Cyrillic, CJK, Arabic, …): what small models leak into Hebrew replies.
  const other = (text.match(/\p{L}/gu)?.length ?? 0) - hebrew - latin;
  return { hebrew, latin, other: Math.max(0, other) };
}

/** True when Hebrew letters are at least as many as Latin ones (and there is some Hebrew). */
export function isHebrewText(text: string): boolean {
  const { hebrew, latin } = scriptStats(text);
  return hebrew > 0 && hebrew >= latin;
}

/** The word plus forms with up to two leading prefix letters removed (הבית → בית), each at least 2 letters. */
export function hebrewVariants(word: string): string[] {
  const out = [word];
  let rest = word;
  for (let i = 0; i < 2 && rest.length > 3 && PREFIX.includes(rest[0]!); i += 1) {
    rest = rest.slice(1);
    out.push(rest);
  }
  return out;
}

/**
 * Words in a Hebrew reply that are in another script: Latin words that are not code, names or units, and any
 * Cyrillic/CJK/Arabic. Used to measure code-switching and to decide whether the cleanup pass should run.
 */
export function foreignWords(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    // File paths, file names and dotted identifiers (/src/app, ~/x, index.ts, a_b) are code, not prose.
    .replace(/(?:^|\s)[~.]?\/[^\s]*/g, ' ').replace(/[\w-]+\.[a-z]{1,5}\b/gi, ' ').replace(/\w*_\w*/g, ' ');
  const words = prose.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? [];
  return words.filter((word) => {
    // A word mixing Hebrew with another script (a stray Devanagari or Arabic letter) is broken, not Hebrew.
    if (/[\u05D0-\u05EA]/.test(word)) return /[^\u0590-\u05FF\uFB1D-\uFB4F'’\-\p{M}]/u.test(word.replace(/[\u0591-\u05C7]/g, ''));
    if (/^[A-Za-z]/.test(word)) {
      // Acronyms, product names and units are fine in Hebrew text (API, GPU, Gemini, iPhone).
      if (/^[A-Z0-9]{2,}$/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word) || /^[a-z]+[A-Z]/.test(word)) return false;
      if (/^[A-Z][a-z]+$/.test(word)) return false;
      return word.length > 1;
    }
    return true;
  });
}

/** Share of words in another script, 0..1. */
export function codeSwitchRate(text: string): number {
  const all = text.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? [];
  return all.length ? foreignWords(text).length / all.length : 0;
}
