import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { PageHeader } from '../components/ui';
import { Face } from '../components/Face';
import { t, fmt } from '../i18n';

interface GalleryPersona {
  id: string; name: string; title: string; description: string; accent: string; shape: number; category: string;
  tools: string[]; modelHint: string; starters: string[]; rules: string[]; added: boolean;
  handoffs: { to: string; name: string; when: string }[];
  connectors: { id: string; name: string; builtIn: boolean; status: string }[];
  skills: { slug: string; name: string; description: string; installed: boolean }[];
}

/** Ready-made personas: face, one line, skills, tools and connectors; one click adds a copy you own. */
export function Gallery() {
  const [personas, setPersonas] = useState<GalleryPersona[]>([]);
  const [category, setCategory] = useState('All');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const navigate = useNavigate();
  const load = () => api<{ personas: GalleryPersona[] }>('/api/gallery').then((data) => setPersonas(data.personas)).catch((error) => toast(errorText(error), 'error'));
  useEffect(() => { void load(); }, []);
  const categories = useMemo(() => ['All', ...new Set(personas.map((row) => row.category))], [personas]);
  const shown = personas.filter((row) => category === 'All' || row.category === category);

  async function add(row: GalleryPersona) {
    setBusy(row.id);
    try {
      const { agent } = await api<{ agent: { id: string; name: string } }>(`/api/gallery/${row.id}`, { method: 'POST' });
      toast(t('{0} is ready.', [agent.name]), 'ok');
      window.dispatchEvent(new Event('la-personas-changed'));
      await load();
      navigate(`/?persona=${agent.id}`);
    } catch (error) { toast(errorText(error), 'error'); } finally { setBusy(null); }
  }

  return (
    <div className="page gallery-page">
      <PageHeader title={t('Persona gallery')} description={t('Ready-made personas with their own skills, rules and tools. Add one with a click; you can change anything afterwards.')} />
      <div className="seg gallery-cats" role="group" aria-label={t('Categories')}>
        {categories.map((name) => <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name === 'All' ? t('All') : name}</button>)}
      </div>
      <div className="gallery-grid">
        {shown.map((row) => (
          <article key={row.id} className="gallery-card" style={{ ['--accent' as string]: row.accent }}>
            <header className="gallery-card-head">
              <Face agent={{ id: row.id, name: row.name, accent: row.accent, avatarKind: 'initials', avatarRef: `blob-${row.shape}` }} size={56} />
              <div className="grow">
                <h3>{row.name}</h3>
                <p className="faint gallery-title">{row.title} · {row.category}</p>
              </div>
              {row.added
                ? <span className="badge ok gallery-added"><Check size={12} aria-hidden />{' '}{t('Added')}</span>
                : <button className="btn small primary" disabled={busy === row.id} onClick={() => void add(row)}><Plus size={14} aria-hidden /> {busy === row.id ? t('Adding…') : t('Add')}</button>}
            </header>
            <p className="gallery-desc">{row.description}</p>
            <div className="gallery-chips" aria-label={t('Skills')}>
              {row.skills.map((skill) => <span key={skill.slug} className="chip" title={skill.description}>{skill.name}</span>)}
            </div>
            <div className="gallery-chips connectors" aria-label={t('Connectors')}>
              {row.connectors.map((item) => <span key={item.id} className={`chip conn ${item.status}`} title={item.builtIn ? t('Built-in · {0}', [item.status]) : item.status}><span className={`dot ${item.status === 'healthy' || item.status === 'connected' ? 'on' : ''}`} aria-hidden />{item.name}{item.builtIn ? '' : item.status === 'connected' ? '' : t(' · connect')}</span>)}
            </div>
            <button className="link-btn faint" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>{open === row.id ? t('Less') : t('Rules, tools and teammates')}</button>
            {open === row.id && (
              <div className="gallery-more">
                <p className="faint"><strong>{t('Model:')}</strong> {row.modelHint}</p>
                <p className="faint"><strong>{t('Tools:')}</strong> {row.tools.join(', ')}</p>
                <ul className="gallery-rules">{row.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul>
                {row.handoffs.length > 0 && <p className="faint"><strong>{t('Hands off to:')}</strong> {row.handoffs.map((h) => `${h.name} (${h.when})`).join('; ')}</p>}
                {row.starters.length > 0 && <p className="faint"><strong>{t('Try:')}</strong> “{row.starters[0]}”</p>}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
