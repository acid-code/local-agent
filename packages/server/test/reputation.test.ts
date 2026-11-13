import { describe, expect, it } from 'vitest';
import { vetSpec } from '../src/mcp.js';
import { reputationQueries, REPUTATION_TERMS, runReputation, signalsFromPages } from '../src/reputation.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MCP reputation search', () => {
  it('asks SearXNG for the package plus GitHub advisories', () => {
    const queries = reputationQueries('@scope/server', 'example/server');
    for (const term of REPUTATION_TERMS) expect(queries.some((query) => query.includes(term))).toBe(true);
    expect(queries.some((query) => query.includes('example/server') && query.includes('advisory'))).toBe(true);
    expect(queries.some((query) => query.includes('site:github.com/example/server'))).toBe(true);
  });

  it('raises the risk score from a fetched page and the local summary', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/search?')) {
        return json({ results: [{ title: 'report', url: 'https://example.com/report', content: 'discussion' }] });
      }
      if (String(url).includes('example.com/report')) return new Response('<p>This package was compromised and shipped a backdoor.</p>', { status: 200 });
      if (String(url).includes('registry.npmjs.org')) return json({ license: 'MIT', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license: 'MIT', scripts: {} } } });
      if (String(url).includes('api.npmjs.org')) return json({ downloads: 10_000 });
      if (String(url).includes('osv.dev')) return json({ vulns: [] });
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    const report = await vetSpec({
      name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'safe-files'], source: 'test',
    }, fetchImpl, {
      searxngUrl: 'http://searx.test',
      summarize: async () => 'VERDICT: malicious\nReported compromised: https://example.com/report',
    });
    expect(report.reputation?.skipped).toBe(false);
    expect(report.reputation?.links.some((link) => link.url.includes('example.com/report'))).toBe(true);
    expect(report.findings.some((finding) => finding.code === 'reputation-summary' && finding.severity === 'critical')).toBe(true);
    expect(report.findings.some((finding) => finding.code === 'reputation-page')).toBe(true);
    expect(report.score).toBeGreaterThan(40);
    const quiet = signalsFromPages([{ url: 'https://example.com/ok', text: 'A normal readme for a file server.' }]);
    expect(quiet).toEqual([]);
  });

  it('warns and points at Setup when SearXNG is down', async () => {
    const fetchImpl = (async () => { throw new Error('offline'); }) as typeof fetch;
    const report = await vetSpec({
      name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'safe-files'], source: 'test',
    }, fetchImpl, { reputation: true });
    expect(report.reputation?.warning).toMatch(/SearXNG/);
    expect(report.reputation?.setupAction).toBe('start-searxng');
    expect(report.findings.some((finding) => finding.code === 'reputation-skipped')).toBe(true);
  });

  it('can be turned off for one install', async () => {
    let searched = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/search?')) searched = true;
      if (String(url).includes('registry.npmjs.org')) return json({ license: 'MIT', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license: 'MIT', scripts: {} } } });
      if (String(url).includes('api.npmjs.org')) return json({ downloads: 10_000 });
      if (String(url).includes('osv.dev')) return json({ vulns: [] });
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const report = await vetSpec({
      name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'safe-files'], source: 'test',
    }, fetchImpl, { reputation: false, searxngUrl: 'http://searx.test' });
    expect(searched).toBe(false);
    expect(report.reputation?.enabled).toBe(false);
    expect(report.reputation?.warning).toBeUndefined();
  });

  it('uses the shared SearXNG helper rather than a cloud search endpoint', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('/search?')) return json({ results: [{ title: 'clean', url: 'https://example.com/clean', content: 'readme' }] });
      if (String(url).includes('example.com/clean')) return new Response('<p>Ordinary documentation.</p>', { status: 200 });
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const ran = await runReputation({ subject: 'safe-files', fetchImpl, searxngUrl: 'http://127.0.0.1:8088', summarize: async () => 'VERDICT: clear\nNo public compromise reports. https://example.com/clean' });
    expect(seen.every((url) => url.startsWith('http://127.0.0.1:8088/search') || url.startsWith('https://example.com/'))).toBe(true);
    expect(ran.check.verdict).toBe('clear');
    expect(ran.findings.some((finding) => finding.severity === 'info')).toBe(true);
  });
});
