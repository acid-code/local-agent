import { BadgeCheck, Container, ShieldAlert } from 'lucide-react';
import { t } from '../i18n';

export type Trust = 'built-in' | 'official' | 'docker' | 'community';

const LABEL: Record<Trust, { text: string; title: string; cls: string }> = {
  'built-in': { text: t('Built-in'), title: t('Ships with the app and runs in-process.'), cls: 'ok' },
  official: { text: t('Official'), title: t('Published by the MCP project or the service itself.'), cls: 'ok' },
  docker: { text: t('Docker'), title: t('Built and signed by Docker in its MCP catalog.'), cls: 'ok' },
  community: { text: t('Community'), title: t('Published by someone else. Read its source before trusting it with tokens; installing needs your explicit OK.'), cls: 'warn' },
};

export function TrustBadge({ trust }: { trust: Trust | null | undefined }) {
  if (!trust) return null;
  const row = LABEL[trust];
  const Icon = trust === 'community' ? ShieldAlert : trust === 'docker' ? Container : BadgeCheck;
  return <span className={`badge trust-badge ${row.cls}`} title={row.title}><Icon size={12} aria-hidden /> {row.text}</span>;
}

/** "sha256:f6056fc1…" or "@2.8.1": what exactly runs. */
export function pinLabel(ref: string | null | undefined) {
  if (!ref) return '';
  const digest = /@sha256:([0-9a-f]{8})/.exec(ref);
  if (digest) return `pinned sha256:${digest[1]}…`;
  const version = /@(\d+\.\d+\.\d+)$/.exec(ref);
  return version ? `pinned @${version[1]}` : 'not pinned';
}
