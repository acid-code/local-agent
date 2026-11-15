import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { toast } from '../lib/toast';
import { t } from '../i18n';

interface Member { id: string; username: string; displayName: string; limits: { cloud: boolean; maxAgents: number }; disabled: boolean; createdAt: string; agents: number; chats: number }

/** Settings > People (owner only). Members get their own chats, personas, memory, library, files and theme. */
export function People() {
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', cloud: true });
  const [busy, setBusy] = useState(false);
  const load = () => api<{ members: Member[] }>('/api/members').then((data) => setMembers(data.members)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const patch = async (id: string, body: Record<string, unknown>, done: string) => {
    try { await api(`/api/members/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); toast(done, 'ok'); await load(); } catch (error) { toast((error as Error).message, 'error'); }
  };

  return (
    <div className="card" id="people">
      <div className="card-head"><h3>{t('People')}</h3><span className="faint">{members.length} member{members.length === 1 ? '' : 's'}</span></div>
      <p className="muted">{t('A member signs in with their own username on the web, iPhone or desktop app. They get their own chats, personas, memory, library, files, routines and theme. They cannot see yours, and you do not see theirs. They cannot open Setup, Debug, providers, tools, containers or secrets. Models and the Gemini quota are shared; you set the limits.')}</p>
      <ul className="people-list">
        {members.map((member) => (
          <li key={member.id}>
            <span className="who"><strong>{member.displayName}</strong><span className="faint">@{member.username} · {member.agents}{' '}{t('personas ·')}{' '}{member.chats} chats{member.disabled ? t(' · disabled') : ''}</span></span>
            <label className="toggle"><input type="checkbox" checked={member.limits.cloud} onChange={(event) => void patch(member.id, { limits: { cloud: event.target.checked } }, event.target.checked ? 'Gemini is on for this member.' : 'Local models only for this member.')} /> <span>{t('Gemini')}</span></label>
            <label className="toggle"><span className="faint">{t('Max personas')}</span><input type="number" min={1} max={100} style={{ width: 70 }} defaultValue={member.limits.maxAgents} onBlur={(event) => { const value = Number(event.target.value); if (value && value !== member.limits.maxAgents) void patch(member.id, { limits: { maxAgents: value } }, 'Limit saved.'); }} /></label>
            <button className="btn small" type="button" onClick={() => { const password = prompt(t('New password for {0} (at least 8 characters)', [member.displayName])); if (password) void patch(member.id, { password }, 'Password changed. Their devices need to sign in again.'); }}>{t('Reset password')}</button>
            <button className="btn small" type="button" onClick={() => void patch(member.id, { disabled: !member.disabled }, member.disabled ? 'Enabled.' : 'Disabled and signed out.')}>{member.disabled ? t('Enable') : t('Disable')}</button>
            <button className="btn small danger" type="button" onClick={async () => { if (!confirm(t('Delete {0} and all of their chats, personas and files? This cannot be undone.', [member.displayName]))) return; await api(`/api/members/${member.id}`, { method: 'DELETE' }); toast(t('Member deleted.'), 'ok'); await load(); }}>{t('Delete')}</button>
          </li>
        ))}
      </ul>
      <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await post('/api/members', { username: form.username.trim(), displayName: form.displayName.trim() || undefined, password: form.password, limits: { cloud: form.cloud } });
          toast(t('{0} can sign in now.', [form.displayName || form.username]), 'ok');
          setForm({ username: '', displayName: '', password: '', cloud: true });
          await load();
        } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); }
      }}>
        <label className="field"><span>{t('Username')}</span><input required autoComplete="off" autoCapitalize="none" pattern="[a-z0-9_.\-]{2,32}" title={t('2–32 lowercase letters, digits, dot, dash or underscore')} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} /></label>
        <label className="field"><span>{t('Display name')}</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
        <label className="field"><span>{t('Password')}</span><input required type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        <label className="toggle"><input type="checkbox" checked={form.cloud} onChange={(event) => setForm({ ...form, cloud: event.target.checked })} /> <span>{t('Allow Gemini')}</span></label>
        <button className="btn primary" disabled={busy}>{busy ? t('Adding…') : t('Add person')}</button>
      </form>
    </div>
  );
}

interface Quota { cloudAllowed: boolean; keyed: boolean; tier: string; models: { name: string; apiName: string; rpdLimit: number; rpdRemaining: number; open: boolean }[] }

/** Shared Gemini quota as members see it. Read-only; the owner sets it. */
export function QuotaCard() {
  const [quota, setQuota] = useState<Quota | null>(null);
  useEffect(() => { api<Quota>('/api/me/quota').then(setQuota).catch(() => undefined); }, []);
  if (!quota) return null;
  return (
    <div className="card" id="quota">
      <div className="card-head"><h3>{t('Gemini usage today')}</h3><span className="faint">{t('limits set by the owner')}</span></div>
      {!quota.cloudAllowed && <p className="muted">{t('Your account uses local models only. Ask the owner if you want Gemini.')}</p>}
      {quota.cloudAllowed && !quota.keyed && <p className="muted">{t('Gemini not connected. The owner can add a key in setup; until then chats use local models.')}</p>}
      {quota.cloudAllowed && quota.keyed && quota.models.map((model) => (
        <div key={model.apiName} style={{ margin: '10px 0' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>{model.name}</span><span className="faint">{model.rpdRemaining} of {model.rpdLimit}{' '}{t('requests left (daily limit)')}</span></div>
          <div className="quota-bar"><span style={{ width: `${model.rpdLimit ? Math.max(0, Math.min(100, (model.rpdRemaining / model.rpdLimit) * 100)) : 0}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

/** Change your own password. Works for the owner and for members. */
export function AccountCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <form className="card" id="account" onSubmit={async (event) => {
      event.preventDefault();
      try { await post('/api/account/password', { current, next }); toast(t('Password changed.'), 'ok'); setCurrent(''); setNext(''); } catch (error) { toast((error as Error).message, 'error'); }
    }}>
      <h3>{t('Account')}</h3>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field"><span>{t('Current password')}</span><input type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
        <label className="field"><span>{t('New password')}</span><input type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(event) => setNext(event.target.value)} /></label>
        <button className="btn">{t('Change password')}</button>
      </div>
    </form>
  );
}
