import { FONT_OPTIONS, THEMES, themeVars, type ThemePreset } from '@local-agent/shared';
import { useTheme } from '../lib/theme';

const ACCENTS = ['#e4b56a', '#e88aa8', '#b89cf0', '#7cc59a', '#ffb08a', '#7fb2e5', '#e06c75'];

function Swatch({ preset }: { preset: ThemePreset }) {
  return (
    <span className="theme-swatch" style={{ background: preset.bg }}>
      <span className="sw-bar" style={{ background: preset.accent }} />
      <span className="sw-bubble" style={{ background: preset.bg3 }} />
      <span className="sw-line" style={{ background: preset.muted }} />
      <span className="sw-line" style={{ background: preset.faint, width: '55%' }} />
    </span>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (value: T) => void; label: string }) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {options.map(([id, name]) => <button key={String(id)} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{name}</button>)}
    </span>
  );
}

/** Settings > Appearance. Every change applies live and is saved to this account (and this device as a fallback). */
export function Appearance() {
  const [choice, update] = useTheme();
  const active = themeVars(choice, window.matchMedia?.('(prefers-color-scheme: dark)').matches).preset;
  const pick = (id: string) => {
    const preset = THEMES.find((theme) => theme.id === id)!;
    if (choice.followSystem) update(preset.scheme === 'dark' ? { darkPreset: id } : { lightPreset: id });
    else update({ preset: id, roundness: undefined, font: undefined, decor: undefined });
  };
  const selected = (preset: ThemePreset) => choice.followSystem ? (preset.scheme === 'dark' ? choice.darkPreset === preset.id : choice.lightPreset === preset.id) : (choice.preset || 'dark') === preset.id;

  return (
    <div className="card" id="appearance">
      <div className="card-head"><h3>Appearance</h3><span className="faint">{active.name} · saved to your account</span></div>
      <div className="theme-grid" role="list">
        {THEMES.map((preset) => (
          <button key={preset.id} type="button" role="listitem" className="theme-card" aria-pressed={selected(preset)} onClick={() => pick(preset.id)} title={preset.blurb}>
            <Swatch preset={preset} />
            <span className="theme-name"><span>{preset.name}</span><span aria-hidden>{preset.emoji}</span></span>
          </button>
        ))}
      </div>

      <div className="theme-preview" aria-label="Live preview" style={{ marginTop: 14 }}>
        <div className="msg user"><div className="prose"><p>Can you plan a cosy Sunday for us? ☕</p></div></div>
        <div className="msg"><div className="who"><span className="face initials" style={{ width: 24, height: 24, background: 'var(--brass)', color: 'var(--ink)', fontSize: 10 }}>B</span><strong>Buddy</strong><span className="faint">now</span></div><div className="prose"><p>Of course! Slow breakfast, a walk in the park, then <a href="#appearance">a picnic list</a>.</p></div></div>
        <div className="row"><button type="button" className="btn primary">Send</button><button type="button" className="btn">Cancel</button><span className="muted">Muted text</span><span className="faint">Faint text</span></div>
      </div>

      <div className="appearance-row">
        <label>Follow system light/dark</label>
        <span className="row">
          <label className="toggle"><input type="checkbox" checked={Boolean(choice.followSystem)} onChange={(event) => update({ followSystem: event.target.checked, lightPreset: choice.lightPreset || (active.scheme === 'light' ? active.id : 'light'), darkPreset: choice.darkPreset || (active.scheme === 'dark' ? active.id : 'dark') })} /> <span>Switch with the device</span></label>
          {choice.followSystem && <span className="faint">Light: {THEMES.find((t) => t.id === choice.lightPreset)?.name || 'Light'} · Dark: {THEMES.find((t) => t.id === choice.darkPreset)?.name || 'Dark'}. Pick a card to change either one.</span>}
        </span>
      </div>
      <div className="appearance-row">
        <label>Accent colour</label>
        <span className="accent-dots">
          <button type="button" aria-label="Theme default" aria-pressed={!choice.accent} style={{ background: active.accent }} onClick={() => update({ accent: null })} />
          {ACCENTS.map((color) => <button key={color} type="button" aria-label={`Accent ${color}`} aria-pressed={choice.accent === color} style={{ background: color }} onClick={() => update({ accent: color })} />)}
          <input type="color" aria-label="Custom accent" value={choice.accent || active.accent} onChange={(event) => update({ accent: event.target.value })} />
          <span className="faint">Adjusted automatically if it would be hard to read.</span>
        </span>
      </div>
      <div className="appearance-row">
        <label>Font</label>
        <Seg label="Font" value={choice.font || active.font} options={FONT_OPTIONS.map((font) => [font.id, font.name] as [string, string])} onChange={(font) => update({ font })} />
      </div>
      <div className="appearance-row">
        <label htmlFor="fs">Text size <span className="faint">{Math.round((choice.fontScale ?? 1) * 100)}%</span></label>
        <input id="fs" type="range" min={0.85} max={1.3} step={0.05} value={choice.fontScale ?? 1} onChange={(event) => update({ fontScale: Number(event.target.value) })} />
      </div>
      <div className="appearance-row">
        <label>Corners</label>
        <Seg label="Corners" value={choice.roundness ?? active.round} options={[[0.4, 'Crisp'], [1, 'Soft'], [1.6, 'Round'], [2, 'Bubbly']]} onChange={(roundness) => update({ roundness })} />
      </div>
      <div className="appearance-row">
        <label>Density</label>
        <Seg label="Density" value={choice.density || 'cozy'} options={[['compact', 'Compact'], ['cozy', 'Cozy'], ['roomy', 'Roomy']]} onChange={(density) => update({ density })} />
      </div>
      <div className="appearance-row">
        <label>Chat bubbles</label>
        <Seg label="Chat bubbles" value={choice.bubbles || 'classic'} options={[['classic', 'Classic'], ['soft', 'Soft bubbles'], ['minimal', 'Minimal']]} onChange={(bubbles) => update({ bubbles })} />
      </div>
      <div className="appearance-row">
        <label>Decorations</label>
        <label className="toggle"><input type="checkbox" checked={choice.decor ?? active.cute} onChange={(event) => update({ decor: event.target.checked })} /> <span>Little {active.emoji} accents, a soft pattern and cute empty states</span></label>
      </div>
    </div>
  );
}
