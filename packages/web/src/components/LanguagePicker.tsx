import { useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { api } from '../lib/api';
import { toast, errorText } from '../lib/toast';
import { adoptAccountLanguage, lang, setLanguage, storedChoice, t, type LangChoice } from '../i18n';

interface LanguagePrefs { choice: LangChoice; resolved: 'en' | 'he'; cleanup: 'auto' | 'on' | 'off'; saved?: boolean }

export const saveAccountLanguage = (choice: LangChoice, resolved: 'en' | 'he') => api('/api/me/language', { method: 'PUT', body: JSON.stringify({ choice, resolved }) });

/** Compact picker (login screen, first sign-in): Auto / English / עברית. Changing it reloads into the language. */
export function LanguageSwitch({ signedIn = false }: { signedIn?: boolean }) {
  const [choice, setChoice] = useState<LangChoice>(storedChoice());
  return (
    <label className="lang-switch" title={t('Language')}>
      <Languages size={15} aria-hidden />
      <select aria-label={t('Language')} value={choice} onChange={(event) => { const next = event.target.value as LangChoice; setChoice(next); void setLanguage(next, { save: signedIn ? saveAccountLanguage : undefined }); }}>
        <option value="auto">{t('Auto (browser)')}</option>
        <option value="en">English</option>
        <option value="he">עברית</option>
      </select>
    </label>
  );
}

/** Settings → Language: interface language and the Hebrew cleanup pass, saved on the account. */
export function LanguageSettings() {
  const [prefs, setPrefs] = useState<LanguagePrefs | null>(null);
  useEffect(() => { void api<{ language: LanguagePrefs }>('/api/me/language').then((data) => setPrefs(data.language)).catch(() => setPrefs({ choice: storedChoice(), resolved: lang, cleanup: 'auto' })); }, []);
  if (!prefs) return <p className="faint">{t('Loading…')}</p>;
  const pickLanguage = (choice: LangChoice) => {
    setPrefs({ ...prefs, choice });
    void setLanguage(choice, { save: saveAccountLanguage });
  };
  const pickCleanup = async (cleanup: LanguagePrefs['cleanup']) => {
    setPrefs({ ...prefs, cleanup });
    try { await api('/api/me/language', { method: 'PUT', body: JSON.stringify({ cleanup }) }); } catch (error) { toast(errorText(error), 'error'); }
  };
  return (
    <div className="stack language-settings">
      <div className="field">
        <span>{t('Interface language')}</span>
        <div className="seg" role="radiogroup" aria-label={t('Interface language')}>
          {([['auto', t('Auto (browser)')], ['en', 'English'], ['he', 'עברית']] as [LangChoice, string][]).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={prefs.choice === id} className={prefs.choice === id ? 'on' : ''} onClick={() => pickLanguage(id)} lang={id === 'he' ? 'he' : id === 'en' ? 'en' : undefined}>{label}</button>
          ))}
        </div>
        <p className="faint">{t('Hebrew switches the layout to right-to-left. Personas answer in your language unless a persona is set otherwise.')}</p>
      </div>
      <label className="field">
        <span>{t('Hebrew polishing')}</span>
        <select value={prefs.cleanup} onChange={(event) => void pickCleanup(event.target.value as LanguagePrefs['cleanup'])}>
          <option value="auto">{t('Auto: small local models only')}</option>
          <option value="on">{t('Always')}</option>
          <option value="off">{t('Off')}</option>
        </select>
        <p className="faint">{t('A second pass fixes stray English or foreign words and gender agreement in Hebrew replies and photo text, without changing the meaning.')}</p>
      </label>
    </div>
  );
}

/**
 * After sign-in: a language saved on the account wins (reloads if it differs); an account that never chose one takes
 * this device's choice, so picking עברית on the login screen sticks for that member everywhere.
 */
export async function syncAccountLanguage() {
  try {
    const { language } = await api<{ language: LanguagePrefs }>('/api/me/language');
    if (language.saved) { adoptAccountLanguage(language.choice); return; }
    await saveAccountLanguage(storedChoice(), lang);
  } catch { /* keep the device choice */ }
}
