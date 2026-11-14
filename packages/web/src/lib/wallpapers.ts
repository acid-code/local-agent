/**
 * Bundled wallpapers. Original vector art drawn in code, so they are tiny, sharp at any size, and need no image files.
 * Each one renders as a repeating pattern tile or as a full scene. Colours of the sky follow light or dark themes.
 */
export interface Wallpaper { id: string; name: string; emoji: string; group: 'Flowers' | 'Cute' | 'Nature' }

type Rand = () => number;
type Motif = (r: Rand) => string;

const g = (x: number, y: number, s: number, rot: number, body: string) => `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(0)}) scale(${s.toFixed(2)})">${body}</g>`;
const ring = (n: number, fn: (angle: number) => string) => Array.from({ length: n }, (_, i) => fn((360 / n) * i)).join('');
const pick = <T,>(r: Rand, items: T[]) => items[Math.floor(r() * items.length)]!;
function seeded(seed: number): Rand { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ---------- Motifs, drawn in a box of roughly -1..1 ----------
const blossom: Motif = (r) => { const c = pick(r, ['#f7b6c8', '#f9c9d6', '#f4a3bb', '#fde0e8']); return ring(5, (a) => `<ellipse cx="0" cy="-0.52" rx="0.36" ry="0.5" fill="${c}" transform="rotate(${a})"/>`) + ring(5, (a) => `<path d="M0 -0.95 l0.08 0.12 l-0.16 0z" fill="#fff" opacity=".7" transform="rotate(${a})"/>`) + '<circle r="0.2" fill="#e0718f"/>' + ring(6, (a) => `<circle cx="0" cy="-0.3" r="0.05" fill="#c04d72" transform="rotate(${a + 15})"/>`); };
const daisy: Motif = () => ring(12, (a) => `<ellipse cx="0" cy="-0.55" rx="0.15" ry="0.45" fill="#fffdf6" stroke="#e8e0cf" stroke-width="0.03" transform="rotate(${a})"/>`) + '<circle r="0.26" fill="#f6c343"/><circle r="0.26" fill="none" stroke="#e0a526" stroke-width="0.05"/>';
const rose: Motif = (r) => { const c = pick(r, [['#e05570', '#b8344f'], ['#f08aa0', '#cf5a77'], ['#f5b3c0', '#e07f98']]); return `<path d="M-0.5 0.55 Q-1 1.1 -0.2 1.0 Q0 0.7 -0.5 0.55z" fill="#6fae74"/><path d="M0.45 0.6 Q1.05 1 0.25 1.05 Q0.1 0.75 0.45 0.6z" fill="#5f9e66"/><circle r="0.75" fill="${c[0]}"/><path d="M-0.55 0.1 Q-0.5 -0.55 0.05 -0.55 Q0.6 -0.5 0.55 0.05 Q0.5 0.5 0 0.45 Q-0.38 0.4 -0.35 0 Q-0.3 -0.3 0.02 -0.28 Q0.3 -0.25 0.27 0.03 Q0.22 0.22 0 0.2" fill="none" stroke="${c[1]}" stroke-width="0.09" stroke-linecap="round"/>`; };
const tulip: Motif = (r) => { const c = pick(r, ['#f2667f', '#f7a541', '#c77ddc', '#f8d34e', '#f48fb1']); return `<path d="M0 0.2 L0 1.4" stroke="#5f9e66" stroke-width="0.12"/><path d="M0 1.1 Q-0.6 0.7 -0.55 0.2 Q-0.2 0.6 0 1.0z" fill="#6fae74"/><path d="M-0.5 -0.6 L-0.5 0 Q-0.5 0.45 0 0.45 Q0.5 0.45 0.5 0 L0.5 -0.6 L0.25 -0.3 L0 -0.7 L-0.25 -0.3z" fill="${c}"/><path d="M-0.25 -0.3 L0 -0.7 L0.25 -0.3 Q0 0.2 -0.25 -0.3z" fill="#fff" opacity=".18"/>`; };
const wildflower: Motif = (r) => {
  const kind = Math.floor(r() * 4);
  const stem = '<path d="M0 0.2 Q0.1 0.8 0 1.4" stroke="#6a9f6a" stroke-width="0.08" fill="none"/>';
  if (kind === 0) return stem + ring(8, (a) => `<path d="M0 0 L-0.12 -0.6 L0 -0.5 L0.12 -0.6z" fill="#6f8fe8" transform="rotate(${a})"/>`) + '<circle r="0.14" fill="#3b4fa8"/>';
  if (kind === 1) return stem + ring(4, (a) => `<circle cx="0" cy="-0.32" r="0.36" fill="#ef5b4c" transform="rotate(${a})"/>`) + '<circle r="0.15" fill="#2a1f1f"/>';
  if (kind === 2) return stem + ring(5, (a) => `<circle cx="0" cy="-0.28" r="0.26" fill="#f7d54a" transform="rotate(${a})"/>`) + '<circle r="0.12" fill="#e8a91e"/>';
  return stem + ring(6, (a) => `<ellipse cx="0" cy="-0.35" rx="0.13" ry="0.32" fill="#d8a6ec" transform="rotate(${a})"/>`) + '<circle r="0.11" fill="#fff4b0"/>';
};
const heart: Motif = (r) => `<path d="M0 0.85 C-1.1 0.1 -0.9 -0.85 -0.35 -0.85 C-0.1 -0.85 0 -0.6 0 -0.5 C0 -0.6 0.1 -0.85 0.35 -0.85 C0.9 -0.85 1.1 0.1 0 0.85z" fill="${pick(r, ['#f48fb1', '#f06292', '#ffb3c7', '#e57399', '#ffd0dc'])}"/><ellipse cx="-0.42" cy="-0.42" rx="0.14" ry="0.09" fill="#fff" opacity=".55" transform="rotate(-35 -0.42 -0.42)"/>`;
const star: Motif = (r) => { const c = pick(r, ['#fff3b0', '#ffe27a', '#ffffff', '#c9d7ff']); return r() < 0.5 ? `<path d="M0 -1 Q0.12 -0.12 1 0 Q0.12 0.12 0 1 Q-0.12 0.12 -1 0 Q-0.12 -0.12 0 -1z" fill="${c}"/>` : `<path d="M0 -1 L0.29 -0.4 L0.95 -0.31 L0.47 0.15 L0.59 0.81 L0 0.5 L-0.59 0.81 L-0.47 0.15 L-0.95 -0.31 L-0.29 -0.4z" fill="${c}" stroke="${c}" stroke-width="0.12" stroke-linejoin="round"/>`; };
const planet: Motif = (r) => { const c = pick(r, [['#b39ddb', '#7e57c2'], ['#f8bbd0', '#ec407a'], ['#80deea', '#26a69a'], ['#ffcc80', '#fb8c00']]); return `<circle r="0.6" fill="${c[0]}"/><path d="M-0.6 0 A0.6 0.6 0 0 0 0.6 0 A0.6 0.25 0 0 1 -0.6 0z" fill="${c[1]}" opacity=".35"/><ellipse rx="1.05" ry="0.26" fill="none" stroke="#fff" stroke-width="0.08" opacity=".75" transform="rotate(-18)"/>`; };
const cloud: Motif = () => '<path d="M-0.9 0.35 Q-1.15 0.35 -1.1 0.05 Q-1.05 -0.25 -0.7 -0.2 Q-0.65 -0.65 -0.15 -0.62 Q0.25 -0.95 0.6 -0.5 Q1.05 -0.55 1.05 -0.1 Q1.25 0.05 1.1 0.3 Q1 0.4 0.8 0.38z" fill="#ffffff" opacity=".95"/><circle cx="-0.25" cy="0" r="0.06" fill="#5a4a5a"/><circle cx="0.25" cy="0" r="0.06" fill="#5a4a5a"/><path d="M-0.1 0.12 Q0 0.2 0.1 0.12" stroke="#5a4a5a" stroke-width="0.04" fill="none"/><circle cx="-0.42" cy="0.12" r="0.08" fill="#f8a5b8" opacity=".7"/><circle cx="0.42" cy="0.12" r="0.08" fill="#f8a5b8" opacity=".7"/>';
const paw: Motif = (r) => { const c = pick(r, ['#c58f73', '#9b7bb5', '#e59aa8', '#8d7b6b']); return `<ellipse cx="0" cy="0.25" rx="0.5" ry="0.42" fill="${c}"/>` + [[-0.55, -0.3], [-0.2, -0.65], [0.2, -0.65], [0.55, -0.3]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="0.18" ry="0.24" fill="${c}"/>`).join(''); };
const catFace: Motif = (r) => { const c = pick(r, ['#f3b37a', '#cfc2b8', '#5b5260', '#f6e8d8']); const ink = c === '#5b5260' ? '#fff3e8' : '#4a3a3a'; return `<path d="M-0.8 -0.2 L-0.75 -0.95 L-0.3 -0.6 Q0 -0.68 0.3 -0.6 L0.75 -0.95 L0.8 -0.2 Q0.85 0.7 0 0.72 Q-0.85 0.7 -0.8 -0.2z" fill="${c}"/><path d="M-0.62 -0.75 L-0.42 -0.58 L-0.6 -0.45z M0.62 -0.75 L0.42 -0.58 L0.6 -0.45z" fill="#f8a5b8"/><circle cx="-0.3" cy="0" r="0.08" fill="${ink}"/><circle cx="0.3" cy="0" r="0.08" fill="${ink}"/><path d="M-0.08 0.16 L0.08 0.16 L0 0.25z" fill="#f48fb1"/><path d="M0 0.25 Q-0.1 0.38 -0.2 0.3 M0 0.25 Q0.1 0.38 0.2 0.3" stroke="${ink}" stroke-width="0.04" fill="none"/>`; };
const shell: Motif = (r) => r() < 0.5
  ? `<path d="M0 0.8 L-0.85 -0.1 Q-0.6 -0.85 0 -0.85 Q0.6 -0.85 0.85 -0.1z" fill="#f9c9b6"/>${[-0.5, -0.17, 0.17, 0.5].map((x) => `<path d="M0 0.8 L${x} -0.8" stroke="#e59b85" stroke-width="0.06"/>`).join('')}`
  : `<path d="M0 -1 L0.25 -0.3 L0.95 -0.3 L0.38 0.12 L0.6 0.85 L0 0.42 L-0.6 0.85 L-0.38 0.12 L-0.95 -0.3 L-0.25 -0.3z" fill="#f7a072" stroke="#f7a072" stroke-width="0.2" stroke-linejoin="round"/>${ring(5, (a) => `<circle cx="0" cy="-0.45" r="0.05" fill="#fff4e0" transform="rotate(${a})"/>`)}`;
const leaf: Motif = (r) => { const c = pick(r, ['#e2733c', '#d9452b', '#f2b134', '#b5562b', '#e8912f']); return r() < 0.6
  ? `<path d="M0 1 L0 0.6 L-0.35 0.75 L-0.3 0.45 L-0.85 0.3 L-0.65 0.1 L-0.95 -0.25 L-0.5 -0.2 L-0.55 -0.65 L-0.2 -0.4 L0 -1 L0.2 -0.4 L0.55 -0.65 L0.5 -0.2 L0.95 -0.25 L0.65 0.1 L0.85 0.3 L0.3 0.45 L0.35 0.75 L0 0.6" fill="${c}" stroke="${c}" stroke-width="0.06" stroke-linejoin="round"/><path d="M0 0.9 L0 -0.7 M0 0.2 L-0.5 -0.15 M0 0.2 L0.5 -0.15" stroke="#7a3518" stroke-width="0.05" opacity=".5"/>`
  : `<path d="M0 -1 Q0.75 -0.3 0 0.85 Q-0.75 -0.3 0 -1z" fill="${c}"/><path d="M0 -0.85 L0 1" stroke="#7a3518" stroke-width="0.05" opacity=".5"/>`; };
const food: Motif = (r) => {
  const kind = Math.floor(r() * 4);
  if (kind === 0) return `<circle r="0.85" fill="#e9b07a"/><circle r="0.72" fill="${pick(r, ['#f48fb1', '#8d6e63', '#ce93d8'])}"/><circle r="0.26" fill="#e9b07a"/>${ring(9, (a) => `<rect x="-0.04" y="-0.58" width="0.08" height="0.18" rx="0.04" fill="${pick(r, ['#fff', '#ffe082', '#80deea', '#a5d6a7'])}" transform="rotate(${a + r() * 30})"/>`)}`;
  if (kind === 1) return '<path d="M0 0.95 Q-0.85 0.4 -0.7 -0.25 Q-0.5 -0.6 0 -0.5 Q0.5 -0.6 0.7 -0.25 Q0.85 0.4 0 0.95z" fill="#ef5350"/><path d="M-0.45 -0.55 L-0.15 -0.4 L0 -0.75 L0.15 -0.4 L0.45 -0.55 L0.2 -0.3 L-0.2 -0.3z" fill="#66bb6a"/>' + [[-0.3, -0.05], [0.25, 0], [0, 0.35], [-0.25, 0.4], [0.3, 0.4], [0, -0.15]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="0.04" ry="0.07" fill="#ffe082"/>`).join('');
  if (kind === 2) return '<path d="M-0.55 -0.35 L-0.4 0.95 L0.4 0.95 L0.55 -0.35z" fill="#d7b49e"/><path d="M-0.6 -0.35 L0.6 -0.35 L0.6 -0.5 L-0.6 -0.5z" fill="#fff" opacity=".85"/><path d="M0.15 -0.5 L0.35 -1.05" stroke="#f48fb1" stroke-width="0.12" stroke-linecap="round"/>' + [[-0.2, 0.7], [0.1, 0.75], [0.25, 0.55], [-0.1, 0.5]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.1" fill="#4e342e"/>`).join('');
  return '<path d="M-0.6 0 L-0.4 0.85 L0.4 0.85 L0.6 0z" fill="#f8bbd0"/><path d="M-0.62 0.05 Q-0.75 -0.35 -0.35 -0.4 Q-0.25 -0.8 0.1 -0.7 Q0.5 -0.75 0.5 -0.35 Q0.8 -0.25 0.62 0.05z" fill="#fff8e1"/><circle cx="0.05" cy="-0.82" r="0.14" fill="#e53935"/>' + [-0.25, 0, 0.25].map((x) => `<path d="M${x} 0.1 L${x * 0.8} 0.85" stroke="#ec7aa0" stroke-width="0.05" opacity=".6"/>`).join('');
};

interface Design extends Wallpaper {
  motifs: Motif[];
  sky: { light: [string, string]; dark: [string, string] };
  /** Draw only in light themes / always dark (space). */
  forceDark?: boolean;
  scene?: (w: number, h: number, r: Rand, dark: boolean) => { back: string; front?: string; place?: (r: Rand) => [number, number] };
}

const meadow = (tint: string) => (w: number, h: number, _r: Rand, dark: boolean) => ({
  back: `<path d="M0 ${h * 0.72} Q${w * 0.25} ${h * 0.6} ${w * 0.5} ${h * 0.7} T${w} ${h * 0.66} V${h} H0z" fill="${dark ? '#2f4a3a' : tint}" opacity=".9"/><path d="M0 ${h * 0.82} Q${w * 0.3} ${h * 0.74} ${w * 0.6} ${h * 0.82} T${w} ${h * 0.8} V${h} H0z" fill="${dark ? '#3a5a45' : '#a9d6a0'}"/>`,
  place: (r: Rand) => [r() * w, h * 0.68 + Math.pow(r(), 0.7) * h * 0.32] as [number, number],
});

const DESIGNS: Design[] = [
  { id: 'cherry-blossom', name: 'Cherry blossom', emoji: '🌸', group: 'Flowers', motifs: [blossom], sky: { light: ['#fff4f7', '#ffe3ec'], dark: ['#1f1520', '#2c1b28'] },
    scene: (w, h, r, dark) => ({ back: `<path d="M-20 ${h * 0.18} Q${w * 0.3} ${h * 0.05} ${w * 0.55} ${h * 0.2} Q${w * 0.7} ${h * 0.28} ${w * 0.95} ${h * 0.12}" stroke="${dark ? '#6b4a52' : '#8a5a5a'}" stroke-width="14" fill="none" stroke-linecap="round"/><path d="M${w * 0.35} ${h * 0.1} Q${w * 0.42} ${h * 0.25} ${w * 0.38} ${h * 0.4}" stroke="${dark ? '#6b4a52' : '#8a5a5a'}" stroke-width="7" fill="none" stroke-linecap="round"/>`, place: (rr) => (rr() < 0.55 ? [rr() * w, h * (0.05 + rr() * 0.3)] : [rr() * w, rr() * h]) as [number, number] }) },
  { id: 'daisies', name: 'Daisies', emoji: '🌼', group: 'Flowers', motifs: [daisy], sky: { light: ['#f3fbff', '#eaf7e8'], dark: ['#14201c', '#1b2a22'] }, scene: meadow('#c9e7b9') },
  { id: 'roses', name: 'Roses', emoji: '🌹', group: 'Flowers', motifs: [rose], sky: { light: ['#fff6f6', '#fbe4e6'], dark: ['#1d1214', '#2a171b'] } },
  { id: 'wildflowers', name: 'Wildflowers', emoji: '🌻', group: 'Flowers', motifs: [wildflower], sky: { light: ['#f4f9ff', '#fdf6e3'], dark: ['#141a22', '#1c2420'] }, scene: meadow('#cfe8b0') },
  { id: 'tulips', name: 'Tulips', emoji: '🌷', group: 'Flowers', motifs: [tulip], sky: { light: ['#f5fbff', '#fff1f4'], dark: ['#151824', '#211a24'] }, scene: meadow('#bfe0b0') },
  { id: 'hearts', name: 'Hearts', emoji: '💕', group: 'Cute', motifs: [heart], sky: { light: ['#fff5f8', '#ffe6ef'], dark: ['#1e1219', '#2a1622'] } },
  { id: 'space', name: 'Stars & space', emoji: '🪐', group: 'Cute', forceDark: true, motifs: [star, star, star, planet], sky: { light: ['#2a2350', '#141030'], dark: ['#1d1840', '#0b0a1c'] },
    scene: (w, h, r) => ({ back: Array.from({ length: 140 }, () => `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * h).toFixed(0)}" r="${(r() * 1.6 + 0.4).toFixed(1)}" fill="#fff" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`).join('') + `<circle cx="${w * 0.82}" cy="${h * 0.22}" r="70" fill="#ffe9a8" opacity=".9"/><circle cx="${w * 0.8 + 28}" cy="${h * 0.22 - 18}" r="62" fill="#1a1538"/>` }) },
  { id: 'clouds', name: 'Clouds', emoji: '☁️', group: 'Cute', motifs: [cloud], sky: { light: ['#dff0ff', '#f6efff'], dark: ['#1a2238', '#251f38'] } },
  { id: 'cats', name: 'Cats & paws', emoji: '🐾', group: 'Cute', motifs: [paw, paw, catFace], sky: { light: ['#fff8f0', '#fdeee4'], dark: ['#1d1814', '#261d18'] } },
  { id: 'seaside', name: 'Seaside', emoji: '🐚', group: 'Nature', motifs: [shell], sky: { light: ['#e3f6ff', '#fff3e0'], dark: ['#0f1d2a', '#1a2430'] },
    scene: (w, h, _r, dark) => ({ back: `<circle cx="${w * 0.78}" cy="${h * 0.24}" r="80" fill="${dark ? '#f0e6c0' : '#ffd166'}" opacity=".9"/><path d="M0 ${h * 0.5} H${w} V${h * 0.72} H0z" fill="${dark ? '#1f4a63' : '#7fc8e8'}"/>` + [0.54, 0.6, 0.66].map((y, i) => `<path d="M0 ${h * y} ${Array.from({ length: 17 }, (_, k) => `Q${(k + 0.5) * w / 16} ${h * y - 10} ${(k + 1) * w / 16} ${h * y}`).join(' ')}" stroke="#fff" stroke-width="${3 - i * 0.6}" fill="none" opacity=".6"/>`).join('') + `<path d="M0 ${h * 0.72} Q${w * 0.5} ${h * 0.68} ${w} ${h * 0.73} V${h} H0z" fill="${dark ? '#5a4a3a' : '#f6deb0'}"/>`, place: (rr) => [rr() * w, h * 0.76 + rr() * h * 0.22] as [number, number] }) },
  { id: 'autumn', name: 'Autumn leaves', emoji: '🍁', group: 'Nature', motifs: [leaf], sky: { light: ['#fff8ec', '#fbe7d0'], dark: ['#1e1712', '#2a1d14'] } },
  { id: 'sweets', name: 'Cute food', emoji: '🍩', group: 'Cute', motifs: [food], sky: { light: ['#fff7fb', '#f1f8ff'], dark: ['#1d1620', '#171c26'] },
    scene: (w, h, _r, dark) => ({ back: `<g opacity="${dark ? 0.25 : 0.45}">${Array.from({ length: 21 }, (_, i) => `<rect x="${i * w / 20 - 20}" y="${h * 0.7}" width="${w / 40}" height="${h * 0.3}" fill="#f48fb1" opacity=".5"/>`).join('')}${Array.from({ length: 7 }, (_, i) => `<rect x="0" y="${h * 0.7 + i * h * 0.045}" width="${w}" height="${h * 0.022}" fill="#f48fb1" opacity=".5"/>`).join('')}</g>` }) },
];

export const WALLPAPERS: Wallpaper[] = DESIGNS.map(({ id, name, emoji, group }) => ({ id, name, emoji, group }));

function svg(w: number, h: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}
const uri = (markup: string) => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}")`;

/** A pattern tile or a full scene as a CSS url(). */
export function renderWallpaper(id: string, mode: 'pattern' | 'scene', dark: boolean): { image: string; size: string; repeat: string } | null {
  const design = DESIGNS.find((item) => item.id === id);
  if (!design) return null;
  const night = dark || Boolean(design.forceDark);
  const [top, bottom] = night ? design.sky.dark : design.sky.light;
  const r = seeded(id.length * 7919 + (mode === 'scene' ? 1 : 2));
  const grad = `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>`;
  if (mode === 'pattern') {
    const T = 200;
    const spots = [[50, 50], [150, 60], [100, 120], [40, 160], [160, 165]];
    const body = spots.map(([x, y]) => g(x! + (r() - 0.5) * 16, y! + (r() - 0.5) * 16, 15 + r() * 9, (r() - 0.5) * 60, pick(r, design.motifs)(r))).join('');
    return { image: uri(svg(T, T, `<rect width="${T}" height="${T}" fill="${top}"/>${body}`)), size: `${T}px ${T}px`, repeat: 'repeat' };
  }
  const W = 1600, H = 1000;
  const extra = design.scene?.(W, H, r, night);
  const place = extra?.place ?? ((rr: Rand) => [rr() * W, rr() * H] as [number, number]);
  const count = design.scene && extra?.place ? 70 : 46;
  const items = Array.from({ length: count }, () => { const [x, y] = place(r); return { x, y, s: 14 + r() * 26 * (0.6 + y / H) }; }).sort((a, b) => a.y - b.y);
  const body = items.map((item) => g(item.x, item.y, item.s, (r() - 0.5) * 50, pick(r, design.motifs)(r))).join('');
  return { image: uri(svg(W, H, `${grad}<rect width="${W}" height="${H}" fill="url(#s)"/>${extra?.back ?? ''}${body}${extra?.front ?? ''}`)), size: 'cover', repeat: 'no-repeat' };
}
