import { LanguageSwitch } from '../components/LanguagePicker';
import { useState, type FormEvent } from 'react';
import { post } from '../lib/api';
import type { Me } from '../App';
import { t } from '../i18n';

export function Login({ me, onIn }: { me: Me; onIn: (username: string) => void }) {
  const [username, setUsername] = useState('asaf');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const setup = me.needsSetup;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const path = setup ? '/api/setup' : '/api/auth/login';
      const result = await post<{ username: string }>(path, { username, password });
      onIn(result.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    }
  }

  return (
    <div className="login">
      <LanguageSwitch />
      <form className="card" onSubmit={submit}>
        <div className="word"><i>local</i> <span>agent</span></div>
        <h1>{setup ? t('Claim this machine.') : t('Welcome back.')}</h1>
        <p className="lede">{setup ? t('One owner. The UI stays locked until this account exists.') : t('Your agents are on the box. This login stays on the LAN or Tailscale.')}</p>
        <label className="field"><span>{t('Username')}</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label className="field"><span>{t('Password')}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} /></label>
        {error && <p className="badge bad">{error}</p>}
        <button className="btn primary" type="submit">{setup ? t('Create owner') : t('Enter')}</button>
      </form>
    </div>
  );
}
