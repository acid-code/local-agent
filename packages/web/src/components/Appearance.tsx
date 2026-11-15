import { FONT_OPTIONS, THEMES, themeVars, type ThemePreset } from '@local-agent/shared';
import { useRef, useState } from 'react';
import { useTheme } from '../lib/theme';
import { renderWallpaper, WALLPAPERS } from '../lib/wallpapers';
import { toast } from '../lib/toast';
import { t as tr } from '../i18n';

/** Shrink a photo to at most 2560 px and re-encode (WebP where the browser can, else JPEG) before upload. */
async function shrinkPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(async () => {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img;
  });
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL('image/webp', 0.84);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.86);
  return url.split(',')[1]!;
}

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
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const active = themeVars(choice, window.matchMedia?.('(prefers-color-scheme: dark)').matches).preset;
  const pick = (id: string) => {
    const preset = THEMES.find((theme) => theme.id === id)!;
    if (choice.followSystem) update(preset.scheme === 'dark' ? { darkPreset: id } : { lightPreset: id });
    else update({ preset: id, roundness: undefined, font: undefined, decor: undefined });
  };
  const selected = (preset: ThemePreset) => choice.followSystem ? (preset.scheme === 'dark' ? choice.darkPreset === preset.id : choice.lightPreset === preset.id) : (choice.preset || 'dark') === preset.id;

  return (
    <div className="card" id="appearance">
      <div className="card-head"><h3>{tr('Appearance')}</h3><span className="faint">{active.name}{' '}{tr('· saved to your account')}</span></div>
      <div className="theme-grid" role="group" aria-label={tr('Themes')}>
        {THEMES.map((preset) => (
          <button key={preset.id} type="button" className="theme-card" aria-pressed={selected(preset)} onClick={() => pick(preset.id)} title={preset.blurb}>
            <Swatch preset={preset} />
            <span className="theme-name"><span>{preset.name}</span><span aria-hidden>{preset.emoji}</span></span>
          </button>
        ))}
      </div>

      <div className="theme-preview" aria-label={tr('Live preview')} style={{ marginTop: 14 }}>
        <div className="msg user"><div className="prose"><p>{tr('Can you plan a cosy Sunday for us? ☕')}</p></div></div>
        <div className="msg"><div className="who"><span className="face initials" style={{ width: 24, height: 24, background: 'var(--brass)', color: 'var(--ink)', fontSize: 10 }}>B</span><strong>{tr('Buddy')}</strong><span className="faint">now</span></div><div className="prose"><p>{tr('Of course! Slow breakfast, a walk in the park, then')}{' '}<a href="#appearance" style={{ textDecoration: 'underline' }}>{tr('a picnic list')}</a>.</p></div></div>
        <div className="row"><button type="button" className="btn primary">{tr('Send')}</button><button type="button" className="btn">{tr('Cancel')}</button><span className="muted">{tr('Muted text')}</span><span className="faint">{tr('Faint text')}</span></div>
      </div>

      <div className="appearance-row">
        <label>{tr('Follow system light/dark')}</label>
        <span className="row">
          <label className="toggle"><input type="checkbox" checked={Boolean(choice.followSystem)} onChange={(event) => update({ followSystem: event.target.checked, lightPreset: choice.lightPreset || (active.scheme === 'light' ? active.id : 'light'), darkPreset: choice.darkPreset || (active.scheme === 'dark' ? active.id : 'dark') })} /> <span>{tr('Switch with the device')}</span></label>
          {choice.followSystem && <span className="faint">{tr('Light:')}{' '}{THEMES.find((t) => t.id === choice.lightPreset)?.name || tr('Light')}{' '}{tr('· Dark:')}{' '}{THEMES.find((t) => t.id === choice.darkPreset)?.name || tr('Dark')}. Pick a card to change either one.</span>}
        </span>
      </div>
      <div className="appearance-row">
        <label>{tr('Accent colour')}</label>
        <span className="accent-dots">
          <button type="button" aria-label={tr('Theme default')} aria-pressed={!choice.accent} style={{ background: active.accent }} onClick={() => update({ accent: null })} />
          {ACCENTS.map((color) => <button key={color} type="button" aria-label={tr('Accent {0}', [color])} aria-pressed={choice.accent === color} style={{ background: color }} onClick={() => update({ accent: color })} />)}
          <input type="color" aria-label={tr('Custom accent')} value={choice.accent || active.accent} onChange={(event) => update({ accent: event.target.value })} />
          <span className="faint">{tr('Adjusted automatically if it would be hard to read.')}</span>
        </span>
      </div>
      <div className="appearance-row">
        <label>{tr('Font')}</label>
        <Seg label={tr('Font')} value={choice.font || active.font} options={FONT_OPTIONS.map((font) => [font.id, font.name] as [string, string])} onChange={(font) => update({ font })} />
      </div>
      <div className="appearance-row">
        <label htmlFor="fs">{tr('Text size')}{' '}<span className="faint">{Math.round((choice.fontScale ?? 1) * 100)}%</span></label>
        <input id="fs" type="range" min={0.85} max={1.3} step={0.05} value={choice.fontScale ?? 1} onChange={(event) => update({ fontScale: Number(event.target.value) })} />
      </div>
      <div className="appearance-row">
        <label>{tr('Corners')}</label>
        <Seg label={tr('Corners')} value={choice.roundness ?? active.round} options={[[0.4, 'Crisp'], [1, 'Soft'], [1.6, 'Round'], [2, 'Bubbly']]} onChange={(roundness) => update({ roundness })} />
      </div>
      <div className="appearance-row">
        <label>{tr('Density')}</label>
        <Seg label={tr('Density')} value={choice.density || 'cozy'} options={[['compact', 'Compact'], ['cozy', 'Cozy'], ['roomy', 'Roomy']]} onChange={(density) => update({ density })} />
      </div>
      <div className="appearance-row">
        <label>{tr('Chat bubbles')}</label>
        <Seg label={tr('Chat bubbles')} value={choice.bubbles || 'classic'} options={[['classic', 'Classic'], ['soft', 'Soft bubbles'], ['minimal', 'Minimal']]} onChange={(bubbles) => update({ bubbles })} />
      </div>
      <div className="appearance-row" id="wallpapers">
        <label>{tr('Background')}</label>
        <div>
          <div className="wall-grid" role="group" aria-label={tr('Wallpapers')}>
            <button type="button" className="wall-card" aria-pressed={!choice.wallpaper || choice.wallpaper === 'none'} onClick={() => update({ wallpaper: 'none' })}>
              <span className="wall-thumb">∅</span><span className="wall-name">{tr('None')}</span>
            </button>
            {WALLPAPERS.map((wall) => {
              const art = renderWallpaper(wall.id, 'pattern', active.scheme === 'dark');
              return (
                <button key={wall.id} type="button" className="wall-card" aria-pressed={choice.wallpaper === wall.id} onClick={() => update({ wallpaper: wall.id })}>
                  <span className="wall-thumb" style={{ backgroundImage: art?.image, backgroundSize: '110px 110px' }} />
                  <span className="wall-name">{wall.emoji} {wall.name}</span>
                </button>
              );
            })}
            <button type="button" className="wall-card" aria-pressed={choice.wallpaper === 'upload'} disabled={uploading} onClick={() => fileInput.current?.click()}>
              <span className="wall-thumb" style={choice.wallpaper === 'upload' ? { backgroundImage: `url("/api/me/wallpaper?v=${choice.wallpaperVersion || 0}")`, backgroundSize: 'cover' } : undefined}>{choice.wallpaper === 'upload' ? '' : '📷'}</span>
              <span className="wall-name">{uploading ? tr('Uploading…') : tr('Your photo')}</span>
            </button>
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setUploading(true);
            try {
              const contentBase64 = await shrinkPhoto(file);
              const res = await fetch('/api/me/wallpaper', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentBase64 }) });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.error || 'Upload failed.');
              update({ wallpaper: 'upload', wallpaperVersion: data.version, wallpaperMode: 'scene', wallpaperDim: Math.max(choice.wallpaperDim ?? 0.3, 0.35) });
              toast(tr('Your photo is the background now. It is stored only in your account.'), 'ok');
            } catch (error) { toast((error as Error).message, 'error'); } finally { setUploading(false); }
          }} />
          {choice.wallpaper && choice.wallpaper !== 'none' && (
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              <Seg label={tr('Background style')} value={choice.wallpaperMode || 'scene'} options={[['scene', 'Full scene'], ['pattern', 'Pattern']]} onChange={(wallpaperMode) => update({ wallpaperMode })} />
              <span className="slider-row"><span className="faint" style={{ width: 80 }}>{tr('Visibility')}</span><input type="range" aria-label={tr('Background visibility')} min={0.15} max={1} step={0.05} value={choice.wallpaperOpacity ?? 0.85} onChange={(event) => update({ wallpaperOpacity: Number(event.target.value) })} /><output>{Math.round((choice.wallpaperOpacity ?? 0.85) * 100)}%</output></span>
              <span className="slider-row"><span className="faint" style={{ width: 80 }}>{tr('Blur')}</span><input type="range" aria-label={tr('Background blur')} min={0} max={20} step={1} value={choice.wallpaperBlur ?? 0} onChange={(event) => update({ wallpaperBlur: Number(event.target.value) })} /><output>{choice.wallpaperBlur ?? 0}px</output></span>
              <span className="slider-row"><span className="faint" style={{ width: 80 }}>{tr('Dim')}</span><input type="range" aria-label={tr('Background dim')} min={0} max={0.9} step={0.05} value={choice.wallpaperDim ?? 0.3} onChange={(event) => update({ wallpaperDim: Number(event.target.value) })} /><output>{Math.round((choice.wallpaperDim ?? 0.3) * 100)}%</output></span>
              <span className="faint">{tr('Messages and panels keep a solid backing, so text stays readable on any picture.')}</span>
            </div>
          )}
        </div>
      </div>
      <div className="appearance-row">
        <label>{tr('Decorations')}</label>
        <label className="toggle"><input type="checkbox" checked={choice.decor ?? active.cute} onChange={(event) => update({ decor: event.target.checked })} /> <span>{tr('Little')}{' '}{active.emoji}{' '}{tr('accents, a soft pattern and cute empty states')}</span></label>
      </div>
    </div>
  );
}
