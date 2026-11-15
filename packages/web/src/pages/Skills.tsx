import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { EmptyState, PageHeader } from '../components/ui';
import { Plus, Sparkles } from 'lucide-react';
import { t } from '../i18n';

interface Skill { slug: string; name: string; description: string; version: number; enabled?: boolean }
interface Agent { id: string; name: string }
interface Fit { slug: string; name: string; score: number; enabled: boolean }

const STARTER = `---
name: Summarize a paper
description: Use when the user asks for a summary of a paper, PDF, or article.
---

Read the source with kb_search first. Then write a short summary with the claim, the method, and the limit. Cite the passage numbers.
`;

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [markdown, setMarkdown] = useState(STARTER);
  const [slug, setSlug] = useState('');
  const [versions, setVersions] = useState<{ version: number; createdAt: string }[]>([]);
  const [sample, setSample] = useState('Summarize this paper for me.');
  const [fits, setFits] = useState<Fit[]>([]);
  const [bundle, setBundle] = useState('');
  const [adding, setAdding] = useState(false);

  async function load() {
    setSkills((await api<{ skills: Skill[] }>('/api/skills')).skills);
    setAgents((await api<{ agents: Agent[] }>('/api/agents')).agents);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <PageHeader title={t('Skills')} description={t('A skill is a SKILL.md with a when-to-use description, plus optional scripts. Personas load one when it fits, unless you turn it off for them.')} actions={<button className="btn primary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><Plus size={16} aria-hidden />{' '}{t('New skill')}</button>} />
      {adding && (
      <form className="card section" onSubmit={async (event) => { event.preventDefault(); const saved = await post<{ skill: Skill }>('/api/skills', { skillMd: markdown, slug: slug || undefined }); setSlug(saved.skill.slug); await load(); setAdding(false); await open(saved.skill.slug); }}>
        <label className="field"><span>{t('Slug, optional')}</span><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="summarize-a-paper" /></label>
        <label className="field"><span>{t('SKILL.md')}</span><textarea value={markdown} rows={14} onChange={(event) => setMarkdown(event.target.value)} /></label>
        <button className="btn primary">{t('Save version')}</button>
      </form>
      )}
      {!adding && skills.length === 0 && <EmptyState icon={Sparkles} title={t('No skills yet')} action={<button className="btn primary" onClick={() => setAdding(true)}>{t('New skill')}</button>}>{t('Write a SKILL.md: a name, when to use it, and the steps. Every persona sees the catalog.')}</EmptyState>}
      {skills.map((skill) => (
        <article key={skill.slug} className="card">
          <h3>{skill.name}</h3>
          <p className="muted">{skill.description}</p>
          <p className="faint mono">{skill.slug}{' '}{t('· v')}{skill.version}</p>
          <div className="row">
            <button className="btn" onClick={() => { setAdding(true); void open(skill.slug); }}>{t('Edit')}</button>
            <button className="btn" onClick={async () => {
              const data = await api<{ skillMd: string; files: { path: string; content: string }[] }>(`/api/skills/${skill.slug}/export`);
              setBundle(JSON.stringify(data, null, 2));
            }}>{t('Export')}</button>
          </div>
          {agents.map((agent) => (
            <label key={agent.id} className="field">
              <span>{agent.name}</span>
              <input type="checkbox" defaultChecked onChange={async (event) => { await post(`/api/skills/${skill.slug}/enable`, { agentId: agent.id, enabled: event.target.checked }); }} />
            </label>
          ))}
        </article>
      ))}
      {versions.length > 0 && <p className="muted">{t('Versions:')}{' '}{versions.map((version) => `v${version.version}`).join(', ')}</p>}
      <form className="card" onSubmit={async (event) => { event.preventDefault(); setFits((await post<{ fits: Fit[] }>('/api/skills/test', { text: sample })).fits); }}>
        <label className="field"><span>{t('Test a message')}</span><textarea value={sample} onChange={(event) => setSample(event.target.value)} /></label>
        <button className="btn">{t('See which skill fits')}</button>
        {fits.map((fit) => <p key={fit.slug} className="mono">{fit.slug} · {(fit.score * 100).toFixed(0)}%{fit.enabled ? '' : t(' · off')}</p>)}
      </form>
      <form className="card" onSubmit={async (event) => { event.preventDefault(); await post('/api/skills/import', JSON.parse(bundle)); await load(); }}>
        <label className="field"><span>{t('Import JSON')}</span><textarea value={bundle} rows={6} onChange={(event) => setBundle(event.target.value)} /></label>
        <button className="btn">{t('Import')}</button>
      </form>
    </div>
  );

  async function open(next: string) {
    const data = await api<{ markdown: string; versions: { version: number; createdAt: string }[] }>(`/api/skills/${next}`);
    setSlug(next);
    setMarkdown(data.markdown);
    setVersions(data.versions);
  }
}
