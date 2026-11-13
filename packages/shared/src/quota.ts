/** AI Studio free-tier reading supplied by the owner on 13 Nov 2026, 16:58 Asia/Jerusalem. */

export const FREE_TIER_OBSERVED_AT = '2026-11-13T14:58:00.000Z';

export interface QuotaWindow {
  /** null means the console showed Unlimited. */
  limit: number | null;
  used: number;
}

export interface FreeTierRow {
  id: string;
  apiName: string;
  displayName: string;
  category: string;
  rpm: QuotaWindow;
  tpm: QuotaWindow;
  rpd: QuotaWindow;
  /** Chat routing may select this model. */
  chat: boolean;
  /** Retrieval may call this model. */
  embedding: boolean;
  role: 'lite' | 'flash' | 'reasoning' | 'embedding' | 'live' | 'other';
}

const K = 1000;
const M = 1_000_000;

function w(used: number, limit: number | null): QuotaWindow {
  return { used, limit };
}

/**
 * Limits are the durable fact. Minute-window usage (RPM/TPM) from this
 * reading expires after 90 seconds. Requests-per-day usage is a baseline
 * for the Pacific quota day that contained the reading; this snapshot's
 * RPD counters were all zero.
 */
export const FREE_TIER_SNAPSHOT: FreeTierRow[] = [
  { id: 'gemini-3.1-flash-lite', apiName: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', category: 'Text-out models', rpm: w(1, 15), tpm: w(55_290, 250 * K), rpd: w(0, 500), chat: true, embedding: false, role: 'lite' },
  { id: 'gemini-3.1-flash-lite-image', apiName: 'gemini-3.1-flash-lite-image', displayName: 'Nano Banana 2 Lite', category: 'Multi-modal generative models', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-3.1-flash-tts', apiName: 'gemini-3.1-flash-tts', displayName: 'Gemini 3.1 Flash TTS', category: 'Multi-modal generative models', rpm: w(0, 3), tpm: w(0, 10 * K), rpd: w(0, 10), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-3.6-flash', apiName: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', category: 'Text-out models', rpm: w(1, 5), tpm: w(55_290, 250 * K), rpd: w(0, 20), chat: true, embedding: false, role: 'flash' },
  { id: 'gemini-3.5-flash-lite', apiName: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', category: 'Text-out models', rpm: w(1, 15), tpm: w(55_290, 250 * K), rpd: w(0, 500), chat: true, embedding: false, role: 'lite' },
  { id: 'gemini-3.5-transcribe', apiName: 'gemini-3.5-transcribe', displayName: 'Gemini 3.5 Transcribe', category: 'Live API', rpm: w(0, 3), tpm: w(0, 10 * K), rpd: w(0, 25), chat: false, embedding: false, role: 'live' },
  { id: 'gemini-3.8-flash', apiName: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', category: 'Text-out models', rpm: w(2, 5), tpm: w(110_580, 250 * K), rpd: w(0, 20), chat: true, embedding: false, role: 'flash' },
  { id: 'gemini-2.5-flash-native-audio', apiName: 'gemini-2.5-flash-native-audio', displayName: 'Gemini 2.5 Flash Native Audio Dialog', category: 'Live API', rpm: w(0, null), tpm: w(0, M), rpd: w(0, null), chat: false, embedding: false, role: 'live' },
  { id: 'gemini-3-flash-live', apiName: 'gemini-3-flash-live', displayName: 'Gemini 3 Flash Live', category: 'Live API', rpm: w(0, null), tpm: w(0, 65 * K), rpd: w(0, null), chat: false, embedding: false, role: 'live' },
  { id: 'gemini-3.5-live-translate', apiName: 'gemini-3.5-live-translate', displayName: 'Gemini 3.5 Live Translate', category: 'Live API', rpm: w(0, null), tpm: w(0, 20 * K), rpd: w(0, null), chat: false, embedding: false, role: 'live' },
  { id: 'gemini-3.5-transcribe-live', apiName: 'gemini-3.5-transcribe-live', displayName: 'Gemini 3.5 Transcribe Live', category: 'Live API', rpm: w(0, null), tpm: w(0, 20 * K), rpd: w(0, null), chat: false, embedding: false, role: 'live' },
  { id: 'gemini-3.8-live', apiName: 'gemini-3.8-live', displayName: 'Gemini 3.8 Live', category: 'Live API', rpm: w(0, null), tpm: w(0, 65 * K), rpd: w(0, null), chat: false, embedding: false, role: 'live' },
  { id: 'gemini-3.8-live-thinking', apiName: 'gemini-3.8-live-thinking', displayName: 'Gemini 3.8 Live Extended Thinking', category: 'Live API', rpm: w(0, null), tpm: w(0, 65 * K), rpd: w(0, null), chat: false, embedding: false, role: 'live' },
  { id: 'antigravity', apiName: 'antigravity', displayName: 'Antigravity', category: 'Agents', rpm: w(0, 60), tpm: w(0, 100 * K), rpd: w(0, 100), chat: false, embedding: false, role: 'other' },
  { id: 'deep-research-pro-preview', apiName: 'deep-research-pro-preview', displayName: 'Deep Research Pro Preview', category: 'Agents', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-2.0-flash', apiName: 'gemini-2.0-flash', displayName: 'Gemini 2 Flash', category: 'Text-out models', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'flash' },
  { id: 'gemini-2.0-flash-lite', apiName: 'gemini-2.0-flash-lite', displayName: 'Gemini 2 Flash Lite', category: 'Text-out models', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'lite' },
  { id: 'computer-use-preview', apiName: 'computer-use-preview', displayName: 'Computer Use Preview', category: 'Other models', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-2.5-flash', apiName: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', category: 'Text-out models', rpm: w(0, 5), tpm: w(0, 250 * K), rpd: w(0, 20), chat: true, embedding: false, role: 'flash' },
  { id: 'gemini-3.8-flash-lite-tts', apiName: 'gemini-3.8-flash-lite-tts', displayName: 'Gemini 3.8 Flash Lite TTS', category: 'Multi-modal generative models', rpm: w(0, 3), tpm: w(0, 10 * K), rpd: w(0, 10), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-3.8-flash-tts', apiName: 'gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', category: 'Multi-modal generative models', rpm: w(0, 3), tpm: w(0, 10 * K), rpd: w(0, 10), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-4-argon', apiName: 'gemini-4-argon', displayName: 'Gemini 4 Argon', category: 'Text-out models', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'reasoning' },
  { id: 'gemini-4-carbon', apiName: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon', category: 'Text-out models', rpm: w(0, 0), tpm: w(0, 0), rpd: w(0, 0), chat: false, embedding: false, role: 'reasoning' },
  { id: 'gemini-4-hydrogen', apiName: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', category: 'Text-out models', rpm: w(0, 5), tpm: w(0, 250 * K), rpd: w(0, 20), chat: true, embedding: false, role: 'reasoning' },
  { id: 'gemini-decision-1', apiName: 'gemini-decision-1', displayName: 'Gemini Decision 1', category: 'Decisions API', rpm: w(0, 200), tpm: w(0, 50 * K), rpd: w(0, 10 * K), chat: false, embedding: false, role: 'other' },
  { id: 'gemini-embedding-001', apiName: 'gemini-embedding-001', displayName: 'Gemini Embedding 1', category: 'Other models', rpm: w(0, 100), tpm: w(0, 30 * K), rpd: w(0, K), chat: false, embedding: true, role: 'embedding' },
  { id: 'gemini-embedding-2', apiName: 'gemini-embedding-2', displayName: 'Gemini Embedding 2', category: 'Other models', rpm: w(0, 100), tpm: w(0, 30 * K), rpd: w(0, K), chat: false, embedding: true, role: 'embedding' },
];

export interface LocalQuotaUse {
  rpm: number;
  tpm: number;
  rpd: number;
}

export interface QuotaAvailability {
  open: boolean;
  rpdRemaining: number | null;
  tpmRemaining: number | null;
  rpmRemaining: number | null;
  reason?: string;
}

const MINUTE_MS = 90_000;

export function quotaAvailability(
  row: FreeTierRow,
  local: LocalQuotaUse = { rpm: 0, tpm: 0, rpd: 0 },
  now = Date.now(),
  observedAt = FREE_TIER_OBSERVED_AT,
): QuotaAvailability {
  const minuteFresh = now - Date.parse(observedAt) < MINUTE_MS;
  const rpmUsed = (minuteFresh ? row.rpm.used : 0) + local.rpm;
  const tpmUsed = (minuteFresh ? row.tpm.used : 0) + local.tpm;
  const rpdUsed = row.rpd.used + local.rpd;
  const remain = (window: QuotaWindow, used: number) =>
    window.limit == null ? null : window.limit - used;

  const rpmRemaining = remain(row.rpm, rpmUsed);
  const tpmRemaining = remain(row.tpm, tpmUsed);
  const rpdRemaining = remain(row.rpd, rpdUsed);

  if (row.rpm.limit === 0 || row.tpm.limit === 0 || row.rpd.limit === 0) {
    return { open: false, rpmRemaining, tpmRemaining, rpdRemaining, reason: `${row.displayName} has no free-tier quota on this key.` };
  }
  if (rpmRemaining != null && rpmRemaining <= 0) {
    return { open: false, rpmRemaining, tpmRemaining, rpdRemaining, reason: `${row.displayName} is at its free-tier requests-per-minute cap.` };
  }
  if (tpmRemaining != null && tpmRemaining < 4_000) {
    return { open: false, rpmRemaining, tpmRemaining, rpdRemaining, reason: `${row.displayName} is near its free-tier tokens-per-minute cap.` };
  }
  if (rpdRemaining != null && rpdRemaining <= 0) {
    return { open: false, rpmRemaining, tpmRemaining, rpdRemaining, reason: `${row.displayName} is out of free-tier requests for the day.` };
  }
  return { open: true, rpmRemaining, tpmRemaining, rpdRemaining };
}

export function freeTierByApiName(apiName: string): FreeTierRow | undefined {
  return FREE_TIER_SNAPSHOT.find((row) => row.apiName === apiName || row.id === apiName);
}

export function preferredEmbeddingModel(): FreeTierRow {
  return FREE_TIER_SNAPSHOT.find((row) => row.id === 'gemini-embedding-2')!;
}
