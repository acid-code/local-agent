import { onColor } from '@local-agent/shared';

export interface FaceAgent {
  id?: string;
  name: string;
  avatarKind?: 'initials' | 'builtin' | 'upload';
  avatarRef?: string;
  accent?: string;
  emoji?: string;
}

const HAIR: Record<string, string> = {
  nova: '#f4f0e6',
  oak: '#6b4a2e',
  iris: '#2a2340',
  moss: '#1e3a2f',
  ember: '#3a2418',
  tide: '#16324a',
  flint: '#2c3138',
  luma: '#efe6c9',
};

const PALETTE = ['#e4b56a', '#9dccb4', '#9ec0e0', '#e39486', '#d7b4e8', '#ffb08a', '#7cc59a', '#b89cf0', '#56b4e9', '#f2a65a'];

export function Face({ agent, size = 32 }: { agent: FaceAgent; size?: number }) {
  const accent = agent.accent || PALETTE[hash(agent.id || agent.name) % PALETTE.length]!;
  if (agent.avatarKind === 'upload' && agent.id && agent.avatarRef) {
    return <img className="face" alt="" src={`/api/agents/${agent.id}/avatar`} width={size} height={size} style={{ width: size, height: size }} />;
  }
  if (agent.avatarKind === 'builtin' && agent.avatarRef && HAIR[agent.avatarRef]) {
    return <Builtin id={agent.avatarRef} accent={accent} size={size} />;
  }
  // Default look: a cute blob face in the persona's colour. The shape comes from the gallery (avatarRef "blob-N") or the name.
  return <Blob agent={agent} accent={accent} size={size} />;
}

/** Simple flat shapes with two pill eyes (no mouth), like the reference: rounded hexagon, wide blob, rounded triangle, round, pentagon, squircle. */
const BLOB_PATHS = [
  'M46.7 52.5L41.5 55.5Q32.0 61.0 22.5 55.5L17.3 52.5Q7.8 47.0 7.8 36.0L7.8 30.0Q7.8 19.0 17.3 13.5L22.5 10.5Q32.0 5.0 41.5 10.5L46.7 13.5Q56.2 19.0 56.2 30.0L56.2 36.0Q56.2 47.0 46.7 52.5Z',
  'M5 37C5 23 17 13 33 13s26 8 26 21-11 21-28 21S5 50 5 37z',
  'M36.0 15.6L53.6 39.2Q61.4 49.6 48.5 51.1L19.3 54.6Q6.4 56.2 11.5 44.2L23.1 17.2Q28.2 5.2 36.0 15.6Z',
  'M32 7c14.4 0 25 10.6 25 25S46.4 57 32 57 7 46.4 7 32 17.6 7 32 7z',
  'M40.9 12.5L49.7 18.9Q58.6 25.3 55.2 35.8L51.9 46.2Q48.5 56.7 37.5 56.7L26.5 56.7Q15.5 56.7 12.1 46.2L8.8 35.8Q5.4 25.3 14.3 18.9L23.1 12.5Q32.0 6.0 40.9 12.5Z',
  'M38.8 55.2L21.6 53.9Q7.6 52.7 8.8 38.8L10.1 21.6Q11.3 7.6 25.2 8.8L42.4 10.1Q56.4 11.3 55.2 25.2L53.9 42.4Q52.7 56.4 38.8 55.2Z',
];
/** Eye centres per shape: a little up and to the right, so every face looks the same way. */
const EYES: [number, number, number][] = [[35, 45, 27], [37, 48, 27], [31, 41, 36], [35, 45, 27], [35, 45, 29], [35, 45, 27]];
const hash = (text: string) => { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function Blob({ agent, accent, size }: { agent: FaceAgent; accent: string; size: number }) {
  const seed = hash(agent.id || agent.name);
  const ref = /^blob-(\d)$/.exec(agent.avatarRef || '');
  const shape = ref ? Number(ref[1]) % BLOB_PATHS.length : seed % BLOB_PATHS.length;
  const [left, right, y] = EYES[shape]!;
  const ink = '#16181b';
  const blinkDelay = `${((seed % 37) / 10).toFixed(1)}s`;
  const floatDelay = `${((seed % 29) / 10).toFixed(1)}s`;
  return (
    <svg
      className="face blob"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      style={{ ['--blink-delay' as string]: blinkDelay, ['--float-delay' as string]: floatDelay }}
      aria-hidden
    >
      <g className="blob-inner">
        <path className="blob-body" d={BLOB_PATHS[shape]} fill={accent} />
        <g className="blob-eyes">
          <rect className="blob-eye" x={left - 2.9} y={y - 6.5} width="5.8" height="13" rx="2.9" fill={ink} />
          <rect className="blob-eye" x={right - 2.9} y={y - 6.5} width="5.8" height="13" rx="2.9" fill={ink} />
        </g>
      </g>
    </svg>
  );
}

/** Two-letter fallback (kept for places that want text, e.g. tiny chips). */
export function Initials({ agent, size = 24 }: { agent: FaceAgent; size?: number }) {
  const accent = agent.accent || '#e4b56a';
  const initials = agent.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A';
  return <span className="face initials" style={{ background: accent, color: /^#[0-9a-f]{6}$/i.test(accent) ? onColor(accent) : undefined, width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>;
}

function Builtin({ id, accent, size }: { id: string; accent: string; size: number }) {
  const hair = HAIR[id] || '#222';
  return (
    <svg className="face" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="30" fill={accent} />
      <path d="M14 30c2-14 10-20 18-20s16 6 18 20v6H14z" fill={hair} />
      <circle cx="24" cy="34" r="2.2" fill="#1a140c" />
      <circle cx="40" cy="34" r="2.2" fill="#1a140c" />
      <path d="M26 44c2.4 3 9.6 3 12 0" fill="none" stroke="#1a140c" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export const FACE_IDS = Object.keys(HAIR);
