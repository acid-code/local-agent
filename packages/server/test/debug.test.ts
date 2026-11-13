import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { geminiQuotaDay, headTailExcerpt, planContext } from '@local-agent/shared';
import { buildApp } from '../src/app.js';
import { doctorChecks, redactValue, searchLogs } from '../src/debug.js';
import { beginOwnerReset, consumeSetupToken, ensureSetupToken, setupTokenValid } from '../src/setup-token.js';
import { saveAvatar } from '../src/avatars.js';
import { explainPull, tryLockRepo, registerSharedRepo } from '../src/repos.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('debug redaction and doctor', () => {
  it('redacts secrets in exports and hides debug logs until the level changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-debug-'));
    dirs.push(dir);
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    store.addLog('debug', 'token sk-live-abcdefghijklmnopqrstuvwxyz', undefined, 'providers');
    store.addLog('info', 'hello from the engine', undefined, 'engine');
    expect(searchLogs(store, { level: 'debug' })).toHaveLength(0);
    store.saveSettings({ ...store.getSettings(), debugLevel: 'debug' }, 'debug on', {});
    store.addLog('debug', 'AIzaSyA123456789012345678901234567890', undefined, 'providers');
    const logs = searchLogs(store, { component: 'providers', level: 'debug' });
    expect(logs.map((row) => row.message).join(' ')).toContain('[redacted]');
    expect(logs.map((row) => row.message).join(' ')).not.toContain('AIza');
    const exported = JSON.stringify(redactValue({ password: 'super-secret-value', note: 'la_abcdefghijklmnopqrstuvwxyz', nested: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } }));
    expect(exported).not.toContain('super-secret-value');
    expect(exported).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(exported).toContain('[redacted]');
    const big = 'x'.repeat(50_000);
    for (let i = 0; i < 80; i += 1) store.addLog('info', big, undefined, 'engine');
    const size = (store.db.prepare('SELECT COALESCE(SUM(LENGTH(message)), 0) AS n FROM logs').get() as { n: number }).n;
    expect(Number(size)).toBeLessThan(2_500_000);
    await app.close();
  });

  it('reports a down Ollama and a full disk as checks, not as a crash', () => {
    const checks = doctorChecks({
      ollamaOk: false, loaded: [{ name: 'gemma', contextLength: 2048 }], dockerOk: true, mcpCount: 1, mcpErrors: 0,
      searxngOk: false, tailscaleOk: false, telegramQueued: 2, dbBytes: 10, diskFreeBytes: 1000, memAvailableGiB: 8,
      geminiOpen: false, lastBackupAt: null,
    });
    expect(checks.find((item) => item.id === 'ollama')?.ok).toBe(false);
    expect(checks.find((item) => item.id === 'disk')?.detail).toMatch(/5 GB/);
    expect(checks.find((item) => item.id === 'telegram')?.detail).toMatch(/waiting/);
    expect(checks.find((item) => item.id === 'ctx:gemma')?.ok).toBe(false);
  });

  it('counts the Gemini day in UTC, not the local evening', () => {
    expect(geminiQuotaDay(new Date('2026-11-13T22:30:00Z'))).toBe('2026-11-13');
    expect(geminiQuotaDay(new Date('2026-11-14T00:05:00Z'))).toBe('2026-11-14');
  });
});

describe('context edges', () => {
  it('keeps a huge newest turn as a head and tail and mixes hierarchical retrieval', () => {
    const huge = `שלום ${'א'.repeat(8000)} end`;
    const plan = planContext({
      strategy: 'hierarchical+retrieval', contextWindow: 500, practicalBudget: 500, outputReserve: 50,
      system: 'instructions', optional: [{ label: 'workshop brief', text: 'w'.repeat(2000) }, { label: 'skills catalog', text: 's'.repeat(2000) }],
      pinned: [], summaries: [{ id: 'root', level: 2, content: 'Root fact from turn 3.', covers: [] }, { id: 'c1', level: 1, content: 'Open chunk.', covers: [] }],
      retrieved: [{ id: 'r', text: 'Retrieved the golden fact.', score: 1 }],
      messages: [{ id: 'old', role: 'user', content: 'old '.repeat(400) }, { id: 'new', role: 'user', content: huge }],
      tokenizer: 'approx',
    });
    expect(plan.recent.some((message) => message.id === 'new')).toBe(true);
    expect(plan.preamble).toMatch(/Root fact/);
    expect(plan.preamble).toMatch(/Retrieved the golden fact|indexed for retrieval/);
    expect(plan.trimmed.join(' ')).toMatch(/skills catalog/);
    const excerpt = headTailExcerpt(huge, 200);
    expect(excerpt.excerpt.startsWith('שלום')).toBe(true);
    expect(excerpt.excerpt.endsWith('end')).toBe(true);
    expect(excerpt.excerpt.includes('\uFFFD')).toBe(false);
  });
});

describe('guards the scenarios rely on', () => {
  it('refuses a reused setup token and can issue a new one after a password reset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-token-'));
    dirs.push(dir);
    const first = ensureSetupToken(dir);
    expect(first.value).toBeTruthy();
    expect(setupTokenValid(dir, first.value || '')).toBe(true);
    consumeSetupToken(dir);
    expect(setupTokenValid(dir, first.value || '')).toBe(false);
    const again = beginOwnerReset(dir);
    expect(again.value).toBeTruthy();
    expect(again.value).not.toBe(first.value);
    expect(setupTokenValid(dir, again.value || '')).toBe(true);
  });

  it('stops a conflicting pull, keeps a live lock, and releases a stale one', async () => {
    expect(explainPull('exit 1\nCONFLICT (content): README.md')).toMatch(/stopped/i);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-lock-'));
    dirs.push(dir);
    const repo = path.join(dir, 'server');
    fs.mkdirSync(repo);
    const { app, store } = await buildApp({ dataDir: dir, startScheduler: false, serveWeb: false });
    registerSharedRepo(store, { label: 'server', path: repo });
    expect(tryLockRepo(store, 'server', 'run-a', 'agent-a').ok).toBe(true);
    expect(tryLockRepo(store, 'server', 'run-b', 'agent-b').ok).toBe(false);
    store.db.prepare('UPDATE shared_repos SET lock_at = ? WHERE label = ?').run(new Date(Date.now() - 10 * 60_000).toISOString(), 'server');
    expect(tryLockRepo(store, 'server', 'run-b', 'agent-b').ok).toBe(true);
    await app.close();
  });

  it('rejects an avatar that is not an image or is too large', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-face-'));
    dirs.push(dir);
    expect(() => saveAvatar(dir, 'agt_abc', Buffer.from('not an image'))).toThrow(/PNG|JPEG|GIF|image/i);
    expect(() => saveAvatar(dir, 'agt_abc', Buffer.alloc(600 * 1024, 1))).toThrow(/512 KB/);
  });
});
