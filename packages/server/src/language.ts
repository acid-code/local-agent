import type { Store } from './db.js';
import { isHebrewText } from '@local-agent/shared';

/**
 * Per-account language: the UI choice (auto/en/he), what it resolved to in the browser, and the Hebrew cleanup pass.
 * Personas reply in the member's language unless the persona overrides it.
 */
export type Lang = 'en' | 'he';
export interface LanguagePrefs { choice: 'auto' | Lang; resolved: Lang; cleanup: 'auto' | 'on' | 'off' }
export const DEFAULT_LANGUAGE: LanguagePrefs = { choice: 'auto', resolved: 'en', cleanup: 'auto' };

const ready = new WeakSet<Store>();
function table(store: Store) {
  if (ready.has(store)) return;
  store.db.exec('CREATE TABLE IF NOT EXISTS account_language (account_id TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated_at TEXT NOT NULL)');
  ready.add(store);
}

export function getLanguage(store: Store, accountId: string): LanguagePrefs & { saved: boolean } {
  table(store);
  const row = store.db.prepare('SELECT prefs FROM account_language WHERE account_id = ?').get(accountId) as { prefs: string } | undefined;
  if (!row) return { ...DEFAULT_LANGUAGE, saved: false };
  try { return { ...DEFAULT_LANGUAGE, ...(JSON.parse(row.prefs) as Partial<LanguagePrefs>), saved: true }; } catch { return { ...DEFAULT_LANGUAGE, saved: false }; }
}

export function setLanguage(store: Store, accountId: string, prefs: Partial<LanguagePrefs>): LanguagePrefs & { saved: boolean } {
  const { saved: _saved, ...current } = getLanguage(store, accountId);
  void _saved;
  const next = { ...current, ...prefs };
  store.db.prepare('INSERT INTO account_language (account_id, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at')
    .run(accountId, JSON.stringify(next), new Date().toISOString());
  return { ...next, saved: true };
}

export function deleteLanguage(store: Store, accountId: string) {
  table(store);
  store.db.prepare('DELETE FROM account_language WHERE account_id = ?').run(accountId);
}

/** Persona override: 'auto' follows the member, 'en'/'he' pins it, 'match' answers in the language of each message. */
export type PersonaLanguage = 'auto' | 'match' | Lang;

/** The language this turn should be answered in. */
export function replyLanguage(member: LanguagePrefs, persona: PersonaLanguage | undefined, message: string): Lang {
  const messageLang: Lang | null = isHebrewText(message) ? 'he' : /[A-Za-z]{3,}/.test(message) ? 'en' : null;
  if (persona === 'he' || persona === 'en') return persona;
  if (persona === 'match') return messageLang ?? member.resolved;
  // Default: a Hebrew message gets Hebrew; otherwise the member's language.
  return messageLang === 'he' ? 'he' : member.resolved;
}

/** One system-prompt line. Empty for English (the default behaviour). */
export function languageHint(lang: Lang): string {
  if (lang !== 'he') return '';
  return '\n\nLanguage: reply in natural, fluent Modern Hebrew (עברית), right-to-left prose. Do not mix in English, Russian, Chinese or other scripts except for code, file paths, commands, URLs and proper names. Keep grammatical gender consistent; when the user\'s gender is unknown, address them in a neutral way or with the plural form.';
}

/** Should the Hebrew cleanup pass run after this reply? auto = only for small local models. */
export function wantsCleanup(setting: 'auto' | 'on' | 'off' | undefined, model: { local: boolean; apiName: string; sizeClass?: string }): boolean {
  if (setting === 'off') return false;
  if (setting === 'on') return true;
  if (!model.local) return false;
  const size = Number(model.apiName.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? NaN);
  return Number.isFinite(size) ? size < 9 : model.sizeClass !== 'large';
}
