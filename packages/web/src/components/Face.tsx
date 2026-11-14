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

const BLOB_PATHS = [
  // round blob
  'M32 6c13 0 25 9 25 25 0 15-10 27-25 27S7 46 7 31C7 15 19 6 32 6z',
  // ghost with a wavy hem
  'M32 6c12 0 22 9 22 22v26c0 3-3 4-5 2l-4-3-4 3c-2 2-5 2-7 0l-2-2-2 2c-2 2-5 2-7 0l-4-3-4 3c-2 2-5 1-5-2V28C10 15 20 6 32 6z',
  // bean
  'M30 7c14-2 27 8 27 23 0 16-12 27-26 27C17 57 7 48 7 35 7 22 16 9 30 7z',
  // cat ears
  'M14 8l9 8c3-1 6-1 9-1s6 0 9 1l9-8c2-1 3 0 3 2v18c3 4 4 8 4 12 0 11-11 18-25 18S7 51 7 40c0-4 1-8 4-12V10c0-2 1-3 3-2z',
  // drop
  'M32 5c6 8 23 20 23 33 0 11-10 20-23 20S9 49 9 38C9 25 26 13 32 5z',
  // cloud
  'M20 20c1-7 7-12 14-12 6 0 11 4 13 9 6 0 11 5 11 12 0 3-1 5-2 7 1 2 2 4 2 6 0 7-6 13-14 13H22C13 55 6 49 6 41c0-4 2-8 5-10-1-1-1-3-1-4 0-5 4-8 10-7z',
];
const hash = (text: string) => { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function Blob({ agent, accent, size }: { agent: FaceAgent; accent: string; size: number }) {
  const ref = /^blob-(\d)$/.exec(agent.avatarRef || '');
  const shape = ref ? Number(ref[1]) % BLOB_PATHS.length : hash(agent.id || agent.name) % BLOB_PATHS.length;
  const ink = '#2a2118';
  const eyeY = shape === 1 ? 29 : shape === 4 ? 36 : 32;
  return (
    <svg className="face blob" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <path d={BLOB_PATHS[shape]} fill={accent} />
      <path d={BLOB_PATHS[shape]} fill="url(#blob-shade)" />
      <defs>
        <radialGradient id="blob-shade" cx="35%" cy="25%" r="80%">
          <stop offset="0" stopColor="#fff" stopOpacity=".38" />
          <stop offset=".55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".12" />
        </radialGradient>
      </defs>
      <ellipse cx="24" cy={eyeY} rx="3.6" ry="4.6" fill={ink} />
      <ellipse cx="40" cy={eyeY} rx="3.6" ry="4.6" fill={ink} />
      <circle cx="25.3" cy={eyeY - 1.8} r="1.4" fill="#fff" />
      <circle cx="41.3" cy={eyeY - 1.8} r="1.4" fill="#fff" />
      <ellipse cx="17.5" cy={eyeY + 7} rx="3.4" ry="2" fill="#ff7a8a" opacity=".45" />
      <ellipse cx="46.5" cy={eyeY + 7} rx="3.4" ry="2" fill="#ff7a8a" opacity=".45" />
      <path d={`M28.5 ${eyeY + 7}c1.6 2 5.4 2 7 0`} fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
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
