export type SandboxMode = 'docker-or-host' | 'docker-only' | 'host';

export interface Settings {
  version: number;
  goodModelId: string | null;
  autoResume: boolean;
  sandbox: SandboxMode;
  maxSteps: number;
  outputReserveTokens: number;
  summaryTriggerTokens: number;
  searxngUrl: string;
  approvalForDestructive: boolean;
  mcpAllowHost: boolean;
  geminiTier: 'free' | 'paid';
  /** sandbox-auto approves edits inside the agent workspace. Host paths and git push always ask. */
  codeApproval: 'sandbox-auto' | 'always';
  killed: boolean;
  readOnly: boolean;
  dailyTokenLimit: number | null;
  dailySpendLimitUsd: number | null;
  quotaLimits: Record<string, { rpm?: number; rpd?: number }>;
  backupCron: string;
  backupTransport: 'none' | 'rsync' | 'rclone' | 's3';
  backupTarget: string;
  imapHost: string;
  imapPort: number;
  imapMailbox: string;
  agentLimits: Record<string, { maxTokensPerDay?: number; maxSpendUsd?: number; maxRunMs?: number; readOnly?: boolean }>;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  goodModelId: null,
  autoResume: true,
  sandbox: 'docker-or-host',
  maxSteps: 12,
  outputReserveTokens: 2048,
  summaryTriggerTokens: 1800,
  searxngUrl: '',
  approvalForDestructive: true,
  mcpAllowHost: false,
  geminiTier: 'free',
  codeApproval: 'sandbox-auto',
  killed: false,
  readOnly: false,
  dailyTokenLimit: null,
  dailySpendLimitUsd: null,
  quotaLimits: {},
  backupCron: '0 3 * * *',
  backupTransport: 'none',
  backupTarget: '',
  imapHost: '',
  imapPort: 993,
  imapMailbox: 'INBOX',
  agentLimits: {},
};

export function normalizeSettings(value: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(value ?? {}), version: value?.version || DEFAULT_SETTINGS.version };
}
