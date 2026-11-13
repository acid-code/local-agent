import type { Finding } from '@local-agent/shared';
import type { ModelRow, ProviderRow, Store } from './db.js';
import { providerFor } from './providers.js';
import { fetchPublicText, searxngSearch, type SearchHit } from './tools.js';

export const REPUTATION_TERMS = ['malware', 'vulnerability', 'CVE', 'security issue', 'compromised', 'typosquat'] as const;

export interface ReputationLink {
  title: string;
  url: string;
}

export interface ReputationCheck {
  enabled: boolean;
  skipped: boolean;
  warning?: string;
  setupAction?: string;
  queries: string[];
  summary?: string;
  verdict?: 'clear' | 'concern' | 'malicious';
  links: ReputationLink[];
}

const STRONG = [
  { re: /typosquat/i, severity: 'high' as const, detail: 'A fetched page mentions typosquatting.' },
  { re: /malicious package|supply[- ]chain attack|was compromised|credentials stolen|backdoor/i, severity: 'critical' as const, detail: 'A fetched page describes a compromise or a malicious package.' },
  { re: /\bCVE-\d{4}-\d{4,}\b/, severity: 'medium' as const, detail: 'A fetched page cites a CVE.' },
];

export function reputationSubject(name: string, packageName?: string, repoUrl?: string): { subject: string; repo?: string } {
  const repo = repoUrl?.match(/github\.com\/([^/\s]+)\/([^/\s#]+)/i);
  const repoSlug = repo ? `${repo[1]}/${repo[2].replace(/\.git$/, '')}` : undefined;
  const subject = (packageName || name).replace(/^@/, '').trim();
  return { subject, repo: repoSlug };
}

export function reputationQueries(subject: string, repo?: string): string[] {
  const queries = REPUTATION_TERMS.map((term) => `${subject} ${term}`);
  if (repo) {
    queries.push(`${repo} security advisory`);
    queries.push(`site:github.com/${repo} vulnerability OR malware OR CVE`);
    queries.push(`${repo} github issues compromised`);
  } else {
    queries.push(`${subject} github advisory`);
    queries.push(`${subject} github issues security`);
  }
  return queries;
}

export function signalsFromPages(pages: { url: string; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const signal of STRONG) {
      if (!signal.re.test(page.text) || seen.has(signal.detail)) continue;
      seen.add(signal.detail);
      findings.push({ severity: signal.severity, code: 'reputation-page', detail: `${signal.detail} ${page.url}` });
    }
  }
  return findings;
}

export function verdictFinding(summary: string): Finding | null {
  const verdict = summary.match(/VERDICT:\s*(clear|concern|malicious)/i)?.[1]?.toLowerCase();
  if (verdict === 'malicious') return { severity: 'critical', code: 'reputation-summary', detail: summary.slice(0, 1200) };
  if (verdict === 'concern') return { severity: 'high', code: 'reputation-summary', detail: summary.slice(0, 1200) };
  if (verdict === 'clear') return { severity: 'info', code: 'reputation-summary', detail: summary.slice(0, 1200) };
  return null;
}

export async function resolveSearxng(fetchImpl: typeof fetch, configured?: string): Promise<string | null> {
  const candidates = [configured, process.env.SEARXNG_URL, 'http://127.0.0.1:8088', 'http://host.docker.internal:8088'].filter((url): url is string => Boolean(url));
  for (const base of candidates) {
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, '')}/search?q=ping&format=json`, { signal: AbortSignal.timeout(700) });
      if (response.ok) return base.replace(/\/$/, '');
    } catch { /* try the next address */ }
  }
  return null;
}

export async function runReputation(input: {
  subject: string;
  repo?: string;
  fetchImpl: typeof fetch;
  searxngUrl?: string;
  summarize?: (prompt: string) => Promise<string>;
}): Promise<{ check: ReputationCheck; findings: Finding[] }> {
  const queries = reputationQueries(input.subject, input.repo);
  const base = input.searxngUrl?.replace(/\/$/, '') || await resolveSearxng(input.fetchImpl);
  if (!base) {
    return {
      check: {
        enabled: true,
        skipped: true,
        warning: 'SearXNG is not running, so this package was not checked against the public web. Start it from Setup, then vet again.',
        setupAction: 'start-searxng',
        queries,
        links: [],
      },
      findings: [{ severity: 'medium', code: 'reputation-skipped', detail: 'Local web reputation search did not run because SearXNG is not available.' }],
    };
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    try {
      for (const hit of await searxngSearch(base, query, input.fetchImpl)) {
        if (!hit.url || seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push(hit);
      }
    } catch { /* one query failing does not cancel the rest */ }
  }
  const top = hits.slice(0, 4);
  if (input.repo) {
    const advisory = `https://github.com/${input.repo}/security/advisories`;
    if (!seen.has(advisory)) top.push({ title: 'GitHub security advisories', url: advisory, content: '' });
  }
  const pages: { url: string; text: string }[] = [];
  for (const hit of top) {
    try {
      pages.push({ url: hit.url, text: await fetchPublicText(hit.url, input.fetchImpl) });
    } catch { /* keep the search hit even if the fetch fails */ }
  }
  const findings = signalsFromPages(pages);
  const dossier = [
    `Package: ${input.subject}`,
    input.repo ? `Repository: ${input.repo}` : '',
    ...top.map((hit) => `RESULT ${hit.title}\n${hit.url}\n${hit.content}`),
    ...pages.map((page) => `PAGE ${page.url}\n${page.text.slice(0, 1500)}`),
  ].filter(Boolean).join('\n\n');
  let summary = extractiveSummary(top);
  if (input.summarize) {
    try {
      const modelText = await input.summarize(
        `Review these local SearXNG results and fetched pages for an MCP server install. Use only this text. Do not invent CVEs.\nFirst line must be exactly VERDICT: clear or VERDICT: concern or VERDICT: malicious.\nThen write a short summary that includes the links you relied on.\n\n${dossier}`,
      );
      if (modelText.trim()) summary = modelText.trim().slice(0, 2000);
    } catch {
      findings.push({ severity: 'info', code: 'reputation-summary', detail: 'The local model could not summarize the pages. The extract below is from SearXNG only.' });
    }
  }
  const fromVerdict = verdictFinding(summary);
  if (fromVerdict) findings.push(fromVerdict);
  else findings.push({ severity: 'info', code: 'reputation-summary', detail: summary.slice(0, 1200) });
  const verdict = summary.match(/VERDICT:\s*(clear|concern|malicious)/i)?.[1]?.toLowerCase() as ReputationCheck['verdict'];
  return {
    check: {
      enabled: true,
      skipped: false,
      queries,
      summary,
      verdict,
      links: top.filter((hit) => hit.url).map((hit) => ({ title: hit.title || hit.url, url: hit.url })),
    },
    findings,
  };
}

function extractiveSummary(hits: SearchHit[]): string {
  if (!hits.length) return 'Local search returned no pages.';
  return `Extract of local search results. No local model summary was added.\n${hits.slice(0, 4).map((hit) => `- ${hit.title || 'result'}: ${hit.url}`).join('\n')}`;
}

export function localReputationSummarizer(store: Store, fetchImpl: typeof fetch): (prompt: string) => Promise<string> {
  const model = store.listModels().find((item) => item.local && item.enabled && !item.embedding && item.profileId !== 'rehearsal');
  const provider = model ? store.getProvider(model.providerId) : null;
  if (!model || !provider) return async () => '';
  return (prompt: string) => completeLocal(model, provider, prompt, fetchImpl);
}

async function completeLocal(model: ModelRow, provider: ProviderRow, prompt: string, fetchImpl: typeof fetch): Promise<string> {
  const client = providerFor(model, provider, fetchImpl);
  let text = '';
  for await (const event of client.complete({ model: model.apiName, messages: [{ role: 'user', content: prompt }], paceMs: 0 })) {
    if (event.type === 'token') text += event.text;
  }
  return text;
}
