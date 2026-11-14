/** Inline illustrations for empty states. Colours come from the theme, so they fit every preset. Shown only when decorations are on. */
export function CuteArt({ kind = 'chat' }: { kind?: 'chat' | 'files' | 'agents' }) {
  return (
    <div className="cute-art" aria-hidden>
      <svg viewBox="0 0 220 140">
        <ellipse cx="110" cy="128" rx="70" ry="7" fill="rgba(var(--text-rgb), 0.06)" />
        {kind === 'files' ? (
          <g>
            <rect x="62" y="34" width="96" height="78" rx="18" fill="var(--bg-3)" stroke="var(--brass)" strokeWidth="3" />
            <path d="M62 52c0-10 8-18 18-18h22l10 12h28c10 0 18 8 18 18" fill="rgba(var(--brass-rgb), 0.25)" />
          </g>
        ) : kind === 'agents' ? (
          <g>
            <circle cx="110" cy="72" r="42" fill="var(--bg-3)" stroke="var(--brass)" strokeWidth="3" />
            <path d="M80 62c4-18 16-26 30-26s26 8 30 26" fill="rgba(var(--brass-rgb), 0.35)" />
          </g>
        ) : (
          <path d="M58 104c-16 0-26-10-26-23s10-23 25-23c3-17 17-28 34-28 14 0 26 7 31 19 4-2 8-3 13-3 17 0 30 12 30 28 13 1 22 10 22 21s-9 9-22 9z" fill="var(--bg-3)" stroke="var(--brass)" strokeWidth="3" strokeLinejoin="round" />
        )}
        <circle cx="94" cy="78" r="4.5" fill="var(--text)" />
        <circle cx="126" cy="78" r="4.5" fill="var(--text)" />
        <path d="M102 90c4 5 12 5 16 0" fill="none" stroke="var(--text)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="84" cy="88" r="6" fill="rgba(var(--coral-rgb), 0.45)" />
        <circle cx="136" cy="88" r="6" fill="rgba(var(--coral-rgb), 0.45)" />
        <path d="M176 24l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="var(--brass)" />
        <path d="M40 30l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="var(--sky)" />
        <path d="M188 92c-3-4-9-2-9 2 0 4 9 9 9 9s9-5 9-9c0-4-6-6-9-2z" fill="rgba(var(--coral-rgb), 0.8)" />
      </svg>
    </div>
  );
}
