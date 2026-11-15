import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { t } from '../i18n';

type Role = 'fast' | 'main' | 'hebrew' | 'coder' | 'vision' | 'embed' | 'image';
interface Row { role: Role; model: string; sizeGiB: number; resident: boolean; installed: boolean; viaOllama: boolean; changed: boolean }
interface Plan { profileId: string; ramCapGiB: number; rows: Row[]; pulls: string[]; downloadGiB: number; residentGiB: number; peakGiB: number; fits: boolean; warnings: string[] }
interface RoleInfo { role: Role; model: string; why: string; alt?: string; measured?: boolean }
interface Profile { machine: { cpu: string; ramGiB: number; gpu: string | null }; detected: string; profile: { id: string; title: string; roles: RoleInfo[]; runtime: { pick: string; why: string } }; plan: Plan; applied: { id: string } | null; profiles: { id: string; title: string }[]; bench: { pick: string; why: string; at: string } | null }

const ROLE_LABEL: Record<Role, string> = { main: 'Main', fast: 'Fast chat', hebrew: 'Hebrew', coder: 'Coder', vision: 'Vision / OCR', embed: 'Embeddings', image: 'Image' };

/** Recommended models for this machine: detect, show the plan against the RAM cap, let the user change roles, pull with progress. */
export function ModelInstaller({ compact = false, onDone }: { compact?: boolean; onDone?: () => void }) {
  const [data, setData] = useState<Profile | null>(null);
  const [profileId, setProfileId] = useState('');
  const [choices, setChoices] = useState<Partial<Record<Role, string>>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [log, setLog] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Profile>(`/api/setup/profile${profileId ? `?id=${encodeURIComponent(profileId)}` : ''}`).then((next) => { setData(next); setPlan(next.plan); setChoices({}); }).catch((err: Error) => setError(err.message));
  }, [profileId]);
  useEffect(() => {
    if (!data || !Object.keys(choices).length) return;
    const timer = setTimeout(() => { void post<{ plan: Plan }>('/api/setup/profile/plan', { id: data.profile.id, choices }).then((next) => setPlan(next.plan)).catch((err: Error) => setError(err.message)); }, 400);
    return () => clearTimeout(timer);
  }, [choices, data]);

  async function install() {
    if (!data) return;
    setError(''); setLog(''); setStatus('running');
    try {
      const res = await post<{ job: { id: string } }>('/api/setup/profile/install', { confirm: true, id: data.profile.id, choices });
      const timer = setInterval(async () => {
        const job = await api<{ job: { status: string; output: string } }>(`/api/jobs/${res.job.id}`);
        setLog(job.job.output);
        if (job.job.status !== 'running') { clearInterval(timer); setStatus(job.job.status); if (job.job.status === 'done') onDone?.(); }
      }, 1500);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setStatus(''); }
  }

  if (!data || !plan) return error ? <p className="error">{error}</p> : <p className="muted">{t('Detecting this machine…')}</p>;
  const why = new Map(data.profile.roles.map((row) => [row.role, row]));
  const lastLine = log.trim().split('\n').slice(-1)[0];
  return (
    <div className="model-installer">
      <p className="muted">{data.machine.cpu}, {data.machine.ramGiB} GB RAM{data.machine.gpu ? `, ${data.machine.gpu}` : ''}. {t('Runtime')}: <strong>{data.bench?.pick ?? data.profile.runtime.pick}</strong>{data.bench ? ` (${t('measured')})` : ''}.</p>
      <label className="field"><span>{t('Profile')}</span>
        <select value={data.profile.id} onChange={(event) => setProfileId(event.target.value)}>
          {data.profiles.map((row) => <option key={row.id} value={row.id}>{row.title}{row.id === data.detected ? ` (${t('detected')})` : ''}</option>)}
        </select>
      </label>
      <table className="table">
        <thead><tr><th>{t('Role')}</th><th>{t('Model')}</th><th>GB</th><th /></tr></thead>
        <tbody>
          {plan.rows.map((row) => (
            <tr key={row.role}>
              <td>{t(ROLE_LABEL[row.role])}{row.resident ? <span className="faint"> · {t('kept loaded')}</span> : null}</td>
              <td>
                <input aria-label={t(ROLE_LABEL[row.role])} value={choices[row.role] ?? row.model} onChange={(event) => setChoices({ ...choices, [row.role]: event.target.value })} list={`alt-${row.role}`} />
                {why.get(row.role)?.alt && <datalist id={`alt-${row.role}`}><option value={why.get(row.role)!.model} /><option value={why.get(row.role)!.alt!.split(' ')[0]} /></datalist>}
                {!compact && <div className="faint small">{why.get(row.role)?.why}{why.get(row.role)?.measured ? ` (${t('measured')})` : ''}</div>}
              </td>
              <td>{row.sizeGiB ? row.sizeGiB : '—'}</td>
              <td><span className={`badge ${row.installed ? 'ok' : ''}`}>{row.installed ? t('installed') : row.viaOllama ? t('to pull') : t('on first use')}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={plan.fits ? 'muted' : 'error'}>{t('Peak RAM')} ~{plan.peakGiB} GB {t('of')} {plan.ramCapGiB} GB · {t('download')} ~{plan.downloadGiB} GB ({plan.pulls.length} {t('models')})</p>
      {plan.warnings.map((line) => <p key={line} className="faint small">{line}</p>)}
      <div className="row">
        <button className="btn primary" disabled={!plan.fits || status === 'running'} onClick={() => void install()}>{status === 'running' ? t('Installing…') : plan.pulls.length ? t('Install recommended models') : t('Save role map')}</button>
        {data.applied && <span className="faint">{t('Applied')}: {data.applied.id}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {log && (compact ? <p className="faint">{lastLine}</p> : <pre className="command">{log}</pre>)}
      {status === 'done' && <p className="ok">{t('Models installed and roles saved.')}</p>}
    </div>
  );
}
