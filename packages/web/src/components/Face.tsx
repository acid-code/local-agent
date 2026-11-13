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

export function Face({ agent, size = 32 }: { agent: FaceAgent; size?: number }) {
  const accent = agent.accent || '#e4b56a';
  if (agent.avatarKind === 'upload' && agent.id && agent.avatarRef) {
    return <img className="face" alt="" src={`/api/agents/${agent.id}/avatar`} width={size} height={size} style={{ width: size, height: size }} />;
  }
  if (agent.avatarKind === 'builtin' && agent.avatarRef && HAIR[agent.avatarRef]) {
    return <Builtin id={agent.avatarRef} accent={accent} size={size} />;
  }
  const initials = agent.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A';
  return <span className="face initials" style={{ background: accent, width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>;
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
