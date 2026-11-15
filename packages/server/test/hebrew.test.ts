import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeSwitchRate, decideAuto, DEFAULT_AUTO_MAP, estimateTokens, foreignWords, hebrewScore, hebrewVariants, isHebrewText, pickHebrewModel, stripNiqqud, type AutoCandidate, type ChatMessage } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import type { ModelProvider } from '../src/providers.js';
import { cleanupHebrew, maskProtected, unmask } from '../src/hebrew-cleanup.js';
import { languageHint, replyLanguage, wantsCleanup, DEFAULT_LANGUAGE } from '../src/language.js';
import { bm25Scores, tokenize } from '../src/kb.js';
import { ftsQuery, searchChats } from '../src/learning.js';
import { directionOf, recognize, type OcrRunners } from '../src/ocr.js';
import { speak } from '../src/voice.js';
import { en } from '../../web/src/i18n/en';
import { he } from '../../web/src/i18n/he';
import { detectLang } from '../../web/src/i18n/index';

const ROOT = path.resolve(__dirname, '../../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const pw = (tag: string) => ['fixture', tag, '11'].join('-');

describe('i18n', () => {
  it('every UI string in the code has a Hebrew translation and en/he share keys', () => {
    const out = execFileSync('node', ['scripts/i18n-keys.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/ 0 missing in he\.ts/);
    const missing = Object.keys(en).filter((key) => !(key in he));
    expect(missing).toEqual([]);
    expect(Object.keys(en).length).toBeGreaterThan(1000);
  });

  it('keeps placeholders and actually translates', () => {
    const bad: string[] = [];
    let hebrew = 0;
    for (const key of Object.keys(en)) {
      const value = he[key]!;
      const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');
      const extra = (value.match(/\{\w+\}/g) ?? []).filter((hole) => !key.includes(hole));
      if (extra.length || (key.includes('{0}') && !value.includes('{0}'))) bad.push(`${key} → ${value} (${holes(key)} vs ${holes(value)})`);
      if (/[\u05D0-\u05EA]/.test(value)) hebrew += 1;
    }
    expect(bad).toEqual([]);
    expect(hebrew / Object.keys(en).length).toBeGreaterThan(0.9);
  });

  it('detects Hebrew from the browser languages', () => {
    expect(detectLang(['he-IL', 'en-US'])).toBe('he');
    expect(detectLang(['iw'])).toBe('he');
    expect(detectLang(['en-US', 'he'])).toBe('en');
    expect(detectLang(['fr-FR'])).toBe('en');
  });
});

describe('RTL layout', () => {
  const css = fs.readFileSync(path.join(ROOT, 'packages/web/src/styles.css'), 'utf8');
  it('uses logical properties (no physical left/right outside RTL overrides and centering)', () => {
    const offenders = css.split('\n').map((line, index) => ({ line, n: index + 1 }))
      .filter(({ line }) => /(margin|padding|border)-(left|right)\b|text-align:\s*(left|right)|float:\s*(left|right)|(^|[;{\s])(left|right)\s*:/.test(line))
      .filter(({ line }) => !line.startsWith("[dir='rtl']") && !/left:\s*50%;\s*transform:\s*translateX\(-50%\)/.test(line));
    expect(offenders.map(({ n, line }) => `${n}: ${line.slice(0, 80)}`)).toEqual([]);
  });
  it('keeps code, paths and diffs left-to-right and flips directional icons', () => {
    expect(css).toMatch(/\[dir='rtl'\][^{]*pre[^{]*\{[^}]*direction:\s*ltr/);
    expect(css).toMatch(/\[dir='rtl'\][^{]*\.diff/);
    expect(css).toMatch(/\[dir='rtl'\][^{]*lucide-chevron-right[^{]*\{[^}]*scaleX\(-1\)/);
  });
  it('has no physical inline styles in components', () => {
    const files = execFileSync('git', ['ls-files', 'packages/web/src/*.tsx', 'packages/web/src/**/*.tsx'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const hits = files.filter((file) => /(margin|padding)(Left|Right)\s*:|textAlign:\s*'(left|right)'/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('Hebrew text helpers', () => {
  it('strips niqqud, finds prefix variants and code-switching', () => {
    expect(stripNiqqud('שָׁלוֹם')).toBe('שלום');
    expect(hebrewVariants('והבית')).toEqual(expect.arrayContaining(['והבית', 'הבית', 'בית']));
    expect(isHebrewText('שלום, מה שלומך? I am fine')).toBe(true);
    expect(isHebrewText('hello there')).toBe(false);
    expect(foreignWords('אני רוצה to go הביתה עכשיו')).toEqual(['to', 'go']);
    expect(codeSwitchRate('מה שלומך היום חבר')).toBe(0);
    expect(codeSwitchRate('אני 很好 thanks חבר')).toBeGreaterThan(0.3);
    // Code, paths and URLs are not "foreign words".
    expect(foreignWords('הריצו `npm run build` בתיקייה /src/app ואז https://example.com')).toEqual([]);
  });
  it('estimates more tokens per Hebrew character than English', () => {
    const hebrewText = 'זהו משפט בעברית שנועד לבדוק את מעריך הטוקנים של המערכת'.repeat(4);
    const english = 'This is an English sentence meant to check the token estimator'.repeat(4);
    expect(estimateTokens(hebrewText, 'qwen3') / hebrewText.length).toBeGreaterThan(estimateTokens(english, 'qwen3') / english.length * 1.5);
    expect(estimateTokens(hebrewText, 'gemini')).toBeLessThan(estimateTokens(hebrewText, 'qwen3'));
  });
});

describe('Hebrew search', () => {
  it('library BM25 matches Hebrew words with attached prefixes', () => {
    expect(tokenize('והבית של משפחת כהן')).toEqual(expect.arrayContaining(['בית', 'משפחת', 'כהן']));
    const scores = bm25Scores([{ id: 'a', text: 'ביקרנו בבית הספר החדש' }, { id: 'b', text: 'The garden is green' }], 'הספר');
    expect(scores.get('a') ?? 0).toBeGreaterThan(scores.get('b') ?? 0);
  });
  it('builds an FTS query with prefix variants', () => {
    expect(ftsQuery('בבית')).toContain('"בית"');
    expect(ftsQuery('a b')).toBe('');
  });
  it('past-chat search finds Hebrew with prefixes and niqqud', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-he-')); dirs.push(dir);
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } });
    const agent = built.store.listAgents()[0]!;
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    built.store.insertMessage({ sessionId: session.id, role: 'user', content: 'קבענו פגישה עם רופא השיניים ביום שני', toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null });
    built.store.insertMessage({ sessionId: session.id, role: 'assistant', content: 'הַמַּתְכּוֹן לְעוּגַת שׁוֹקוֹלָד', toolCallId: null, toolName: null, toolCalls: null, agentId: null, runId: null, imageUrl: null, routingNote: null });
    expect(searchChats(built.store, { query: 'לרופא', ownerId: agent.ownerId })).toHaveLength(1);
    expect(searchChats(built.store, { query: 'הפגישה', ownerId: agent.ownerId })).toHaveLength(1);
    expect(searchChats(built.store, { query: 'מתכון', ownerId: agent.ownerId })).toHaveLength(1);
    expect(searchChats(built.store, { query: 'אופניים', ownerId: agent.ownerId })).toHaveLength(0);
    await built.app.close();
  });
});

describe('reply language', () => {
  const heMember = { ...DEFAULT_LANGUAGE, choice: 'he' as const, resolved: 'he' as const };
  it('follows member, persona pin and message language', () => {
    expect(replyLanguage(heMember, 'auto', 'hi there')).toBe('he');
    expect(replyLanguage(DEFAULT_LANGUAGE, 'auto', 'מה נשמע?')).toBe('he');
    expect(replyLanguage(DEFAULT_LANGUAGE, 'auto', 'hello')).toBe('en');
    expect(replyLanguage(heMember, 'match', 'What is the time?')).toBe('en');
    expect(replyLanguage(heMember, 'en', 'מה נשמע')).toBe('en');
    expect(replyLanguage(DEFAULT_LANGUAGE, 'he', 'hello')).toBe('he');
  });
  it('adds a Hebrew system hint only for Hebrew', () => {
    expect(languageHint('en')).toBe('');
    expect(languageHint('he')).toMatch(/Hebrew/);
    expect(languageHint('he')).toMatch(/gender/);
  });
  it('runs the cleanup pass by default only for small local models', () => {
    expect(wantsCleanup('auto', { local: true, apiName: 'qwen3:4b' })).toBe(true);
    expect(wantsCleanup('auto', { local: true, apiName: 'gemma3:27b' })).toBe(false);
    expect(wantsCleanup('auto', { local: false, apiName: 'gemini-2.5-flash' })).toBe(false);
    expect(wantsCleanup('on', { local: false, apiName: 'gemini-2.5-flash' })).toBe(true);
    expect(wantsCleanup('off', { local: true, apiName: 'qwen3:0.6b' })).toBe(false);
  });
  it('member language is saved per account and members can set their own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-he-')); dirs.push(dir);
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
    const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    await built.app.inject({ method: 'POST', url: '/api/members', cookies: owner, payload: { username: 'noa', displayName: 'Noa', password: pw('member') } });
    const member = cookie(await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'noa', password: pw('member') } }));
    expect((await built.app.inject({ method: 'GET', url: '/api/me/language', cookies: member })).json().language).toMatchObject({ choice: 'auto', saved: false });
    const put = await built.app.inject({ method: 'PUT', url: '/api/me/language', cookies: member, payload: { choice: 'he', resolved: 'he', cleanup: 'on' } });
    expect(put.statusCode).toBe(200);
    expect((await built.app.inject({ method: 'GET', url: '/api/me/language', cookies: member })).json().language).toMatchObject({ choice: 'he', resolved: 'he', cleanup: 'on', saved: true });
    expect((await built.app.inject({ method: 'GET', url: '/api/me/language', cookies: owner })).json().language).toMatchObject({ choice: 'auto' });
    await built.app.close();
  });
});

describe('Hebrew cleanup pass (fake model)', () => {
  const noisy = 'שלום! הנה הסבר קצר: כדי להתחיל, run את הפקודה `npm install` ואז 打开 את הקובץ /src/index.ts בעורך.';
  it('accepts a cleaner Hebrew rewrite and keeps code and paths intact', async () => {
    const result = await cleanupHebrew(noisy, async (prompt) => {
      const masked = prompt.match(/<text>\n([\s\S]*?)\n<\/text>/)?.[1] ?? prompt;
      return masked.replace('run את', 'הריצו את').replace('打开', 'פתחו');
    });
    expect(result.changed).toBe(true);
    expect(result.text).toContain('`npm install`');
    expect(result.text).toContain('/src/index.ts');
    expect(result.after).toBeLessThan(result.before);
  });
  it('rejects rewrites that drop code, change length or add foreign words', async () => {
    expect((await cleanupHebrew(noisy, async () => 'שלום! הנה הסבר קצר בלי הקוד בכלל, פשוט ככה.')).changed).toBe(false);
    expect((await cleanupHebrew(noisy, async () => 'כן')).changed).toBe(false);
    const worse = await cleanupHebrew(noisy, async (prompt) => (prompt.match(/<text>\n([\s\S]*?)\n<\/text>/)?.[1] ?? prompt).replace('שלום', 'Hello hello'));
    expect(worse.changed).toBe(false);
    expect((await cleanupHebrew(noisy, async () => { throw new Error('down'); })).reason).toMatch(/failed/);
    expect((await cleanupHebrew('Hello, how are you today my friend?', async () => 'x')).reason).toBe('not Hebrew');
  });
  it('catches what real small models did in the quality check (stray brackets, mixed-script words)', async () => {
    // qwen3:1.7b wrapped its own words in marker brackets.
    const bracketed = await cleanupHebrew('ההבדל בין זיכרון RAM לבין דיסק קשיח, whereas הדיסק שומר מידע לאורך זמן.', async () => 'ההבדל בין זיכרון RAM ⟦(זיכרון זמני)⟧ לבין דיסק קשיח, בעוד שהדיסק שומר מידע לאורך זמן.');
    expect(bracketed.text).not.toMatch(/[⟦⟧]/);
    // qwen3:0.6b "fixed" English by writing Hebrew with Devanagari letters inside the word.
    expect(foreignWords('רैम ודיסק')).toEqual(['רैम']);
    const broken = await cleanupHebrew('ה-RAM ו-storing data הם דברים שונים במחשב שלנו', async () => 'הרैम ואחסון נתונים הם דברים שונים במחשב שלנו');
    expect(broken.changed).toBe(false);
  });
  it('masks and unmasks protected spans', () => {
    const { masked, parts } = maskProtected('ראו [file:abc] ו-https://x.io/a וגם `code`');
    expect(masked).not.toMatch(/https|`code`|file:abc/);
    expect(unmask(masked, parts)).toBe('ראו [file:abc] ו-https://x.io/a וגם `code`');
    expect(unmask(masked.replace(/⟦0⟧/, ''), parts)).toBeNull();
  });
});

describe('Hebrew model routing', () => {
  const model = (id: string, apiName: string, extra: Partial<AutoCandidate> = {}): AutoCandidate => ({ id, name: apiName, apiName, local: true, embedding: false, sizeClass: 'small', providerKind: 'ollama', practicalBudget: 8000, enabled: true, ...extra });
  const models = [model('m-qwen', 'qwen3:4b'), model('m-gemma', 'gemma3:4b'), model('m-big', 'gemma3:27b', { sizeClass: 'large' }), model('m-smol', 'smollm2:135m')];
  it('scores Hebrew writers', () => {
    expect(hebrewScore(model('a', 'gemma3:4b'))).toBeGreaterThan(hebrewScore(model('b', 'qwen3:4b')));
    expect(hebrewScore(model('c', 'smollm2:135m'))).toBe(0);
    expect(hebrewScore(model('g', 'gemini-2.5-flash', { local: false, providerKind: 'gemini' }))).toBe(100);
  });
  it('picks the strongest that fits the RAM cap, Gemini when its quota is open', () => {
    expect(pickHebrewModel(models, (row) => !row.apiName.includes('27b'))?.id).toBe('m-gemma');
    expect(pickHebrewModel(models)?.id).toBe('m-big');
    const gemini = model('m-gem', 'gemini-2.5-flash', { local: false, providerKind: 'gemini' });
    expect(pickHebrewModel([...models, gemini])?.id).toBe('m-gem');
    expect(pickHebrewModel([...models, { ...gemini, quotaOpen: false }], (row) => !row.apiName.includes('27b'))?.id).toBe('m-gemma');
  });
  it('decideAuto switches Hebrew chat turns to the best Hebrew model, but not code turns', () => {
    const map = { ...DEFAULT_AUTO_MAP, main: 'qwen3:4b', fast: 'qwen3:4b', coder: 'qwen3:4b' };
    const fits = (row: AutoCandidate) => !row.apiName.includes('27b');
    const chat = decideAuto({ text: 'תכתבי לי ברכה ליום הולדת לאמא שלי', map, models, hebrew: true, fits });
    expect(chat.modelId).toBe('m-gemma');
    expect(chat.trace).toMatch(/hebrew/);
    const code = decideAuto({ text: 'fix the bug in the parser and commit', map, models, hebrew: true, fits });
    expect(code.modelId).toBe('m-qwen');
    const english = decideAuto({ text: 'Write a birthday greeting for my mother', map, models, fits });
    expect(english.modelId).toBe('m-qwen');
  });
});

describe('OCR router (fake engines)', () => {
  const image = Buffer.from('fake');
  const tesseract = (text: string, confidence: number, lowWords = 0, words = 10): OcrRunners['tesseract'] => async () => ({ text, confidence, words, lowWords, ms: 1 });
  const vision = (text: string): OcrRunners['vision'] => async () => ({ text, model: 'fake-vision', ms: 1 });
  it('keeps confident printed text from Tesseract', async () => {
    const result = await recognize(image, { mode: 'auto' }, { tesseract: tesseract('רשימת קניות: חלב, לחם\nMilk and bread', 92), vision: vision('should not run') });
    expect(result.engine).toBe('tesseract');
    expect(result.direction).toBe('mixed');
  });
  it('sends low confidence or many unsure words to the vision model', async () => {
    const low = await recognize(image, { mode: 'auto' }, { tesseract: tesseract('ו׳ן ה ע', 31), vision: vision('לקנות פרחים לאמא') });
    expect(low).toMatchObject({ engine: 'vision', model: 'fake-vision', direction: 'rtl', lang: 'he' });
    const unsure = await recognize(image, { mode: 'auto' }, { tesseract: tesseract('ab cd ef gh ij kl', 70, 5, 10), vision: vision('Call the dentist on Monday') });
    expect(unsure.engine).toBe('vision');
  });
  it('handwriting goes straight to vision and falls back to Tesseract', async () => {
    let calls = 0;
    const counted: OcrRunners['tesseract'] = async () => { calls += 1; return { text: 'x', confidence: 50, words: 1, ms: 1 }; };
    expect((await recognize(image, { mode: 'handwriting' }, { tesseract: counted, vision: vision('```\nHere is the text: מחר יום הולדת\n```') })).text).toBe('מחר יום הולדת');
    expect(calls).toBe(0);
    const fallback = await recognize(image, { mode: 'handwriting' }, { tesseract: counted, vision: null });
    expect(fallback.engine).toBe('tesseract');
    expect(fallback.notes.join(' ')).toMatch(/handwriting may come out wrong/);
  });
  it('keeps Tesseract text when vision fails, and explains missing engines', async () => {
    const result = await recognize(image, { mode: 'auto' }, { tesseract: tesseract('abc', 20), vision: async () => { throw new Error('out of memory'); } });
    expect(result.engine).toBe('tesseract');
    expect(result.notes.join(' ')).toMatch(/out of memory/);
    await expect(recognize(image, { mode: 'printed' }, { tesseract: null, vision: null })).rejects.toThrow(/OCR service is not running/);
    await expect(recognize(image, { mode: 'auto' }, { tesseract: null, vision: null })).rejects.toThrow(/No OCR engine/);
  });
  it('strips bidi marks and classifies direction', async () => {
    const result = await recognize(image, { mode: 'printed' }, { tesseract: tesseract('\u200fשלום עולם\u200e', 90), vision: null });
    expect(result.text).toBe('שלום עולם');
    expect(directionOf('Hello world')).toBe('ltr');
  });

  it('chat photos carry OCR text to the model, and /api/ocr returns it (fake OCR service)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ocr-')); dirs.push(dir);
    const seen: string[] = [];
    const provider = {
      async *complete(req: { messages: ChatMessage[] }) {
        seen.push(req.messages.filter((message) => message.role === 'user').map((message) => String(message.content)).join('\n'));
        yield { type: 'token' as const, text: 'ok' };
        yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ocrCalls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(':8092/health')) return Response.json({ ok: true, langs: ['eng', 'heb'] });
      if (url.includes(':8092/ocr')) { ocrCalls.push(url); return Response.json({ text: 'מבצע: 2 ב-10 ₪\nSale today', confidence: 91, words: 6, lowWords: 0, ms: 5 }); }
      if (url.includes('/api/tags')) return Response.json({ models: [] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const built = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false, fetchImpl: fakeFetch, providerOverride: () => provider as unknown as ModelProvider });
    const cookie = (res: { cookies: { name: string; value: string }[] }) => ({ la_session: res.cookies.find((item) => item.name === 'la_session')!.value });
    const owner = cookie(await built.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'asaf', password: pw('owner') } }));
    const agent = (await built.app.inject({ method: 'POST', url: '/api/agents', cookies: owner, payload: { name: 'Reader', systemPrompt: 'test', toolAllowlist: [], modelId: 'model_rehearsal' } })).json().agent as { id: string; ownerId: string };
    const session = built.store.createSession({ agentId: agent.id, ownerId: agent.ownerId });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const file = (await built.app.inject({ method: 'POST', url: '/api/files', cookies: owner, payload: { name: 'sign.png', contentBase64: png.toString('base64'), sessionId: session.id } })).json().file as { id: string };
    const read = await built.app.inject({ method: 'POST', url: '/api/ocr', cookies: owner, payload: { fileId: file.id, mode: 'printed' } });
    expect(read.statusCode).toBe(200);
    expect(read.json().result).toMatchObject({ engine: 'tesseract', direction: 'mixed' });
    expect(read.json().result.text).toContain('מבצע');
    const sent = await built.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/messages`, cookies: owner, payload: { content: 'מה כתוב בשלט?', agentId: agent.id, modelId: 'model_rehearsal', mentions: [{ kind: 'file', id: file.id, ocr: 'auto' }] } });
    expect(sent.statusCode).toBe(200);
    const until = Date.now() + 4000;
    while (!built.store.listMessages(session.id).some((message) => message.role === 'assistant') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    const user = built.store.listMessages(session.id).find((message) => message.role === 'user')!;
    expect(user.content).toContain('Text read from sign.png');
    expect(user.content).toContain('Sale today');
    expect(ocrCalls.length).toBeGreaterThanOrEqual(2);
    await built.app.close();
  });
});

describe('voice routing by language (fake engines)', () => {
  it('Hebrew uses Piper, then Gemini, else asks for the browser voice', async () => {
    const calls: string[] = [];
    const make = (up: { piper?: boolean; kokoro?: boolean }) => (async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      if (url.endsWith(':8093/health')) return up.piper ? Response.json({ ok: true }) : new Response('', { status: 503 });
      if (url.endsWith(':8880/v1/models')) return up.kokoro ? Response.json({ data: [] }) : new Response('', { status: 503 });
      if (url.includes(':8093')) return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
      if (url.includes(':8880/v1/audio/speech')) return new Response(new Uint8Array([1, 2]), { status: 200 });
      if (url.includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(48).toString('base64') } }] } }] });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    expect((await speak(make({ piper: true }), 'שלום לכולם')).engine).toMatch(/^piper:he_IL/);
    const gemini = await speak(make({}), 'שלום לכולם', { geminiKey: 'test-key' });
    expect(gemini.engine).toMatch(/^gemini:/);
    expect(gemini.bytes.subarray(0, 4).toString()).toBe('RIFF');
    await expect(speak(make({ kokoro: true }), 'שלום לכולם', { geminiKey: '' })).rejects.toMatchObject({ code: 'no_tts' });
    expect((await speak(make({ kokoro: true, piper: true }), 'Hello everyone')).engine).toBe('kokoro');
    expect((await speak(make({ piper: true }), 'Hello everyone')).engine).toMatch(/^piper:en_US/);
  });
});

// Real Tesseract (eng+heb) when the OCR service container is running on this machine; skipped elsewhere (CI).
const ocrUp = await fetch('http://127.0.0.1:8092/health', { signal: AbortSignal.timeout(800) }).then((response) => response.ok).catch(() => false);
const sample = '/workspace/e2e-logs/ocr-img/printed.png';
describe.skipIf(!ocrUp || !fs.existsSync(sample))('real Tesseract', () => {
  it('reads printed Hebrew and English', async () => {
    const { tesseractRunner } = await import('../src/ocr.js');
    const result = await recognize(fs.readFileSync(sample), { mode: 'printed' }, { tesseract: tesseractRunner(fetch), vision: null });
    expect(result.confidence).toBeGreaterThan(80);
    expect(result.text).toMatch(/[\u05D0-\u05EA]{3,}/);
    expect(result.text).toMatch(/[A-Za-z]{3,}/);
    expect(result.direction).toBe('mixed');
  }, 60_000);
});
