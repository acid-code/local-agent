import { DEFAULT_AUTO_MAP, type AutoMap, type ImageModelSpec } from '@local-agent/shared';

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
  /** How many web_search hits go back to the model. */
  searchHits: number;
  approvalForDestructive: boolean;
  /** Which risk tiers ask first: cautious (low+), balanced (medium+), autonomous (high only). High always asks. */
  approvalMode?: 'cautious' | 'balanced' | 'autonomous';
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
  gitName: string;
  gitEmail: string;
  gitSshKey: string;
  autoModels: AutoMap;
  /** info hides debug lines. debug shows them. Read on every write, so it changes without a restart. */
  debugLevel: 'info' | 'debug';
  /** api name -> whether Ollama reported tool support. Absent means unknown. */
  toolSupport: Record<string, boolean>;
  agentLimits: Record<string, { maxTokensPerDay?: number; maxSpendUsd?: number; maxRunMs?: number; readOnly?: boolean; approvalMode?: 'cautious' | 'balanced' | 'autonomous' }>;
  /** The image role. Auto tries the local runner first, then Gemini when the account may use it. */
  imageGen: ImageGenSettings;
  /** Hard RAM cap for everything local-agent runs (Ollama models + KV cache, image runner, server). */
  ramBudgetGiB: number;
  /** Second guard: never start a job that would leave less than this much free system RAM. */
  ramSystemReserveGiB: number;
  /** Machine profile the installer applied, and the model it picked for Hebrew replies. */
  modelProfile?: { id: string; hebrew: string | null; at: string } | null;
  /** Whether personas may auto-start each other's runs via send_message / handoff. Default true. */
  personaAutoStart?: boolean;
}

export interface ImageGenSettings {
  mode: 'auto' | 'local' | 'gemini' | 'off';
  /** sdcpp runs stable-diffusion.cpp's sd-cli. http talks to an AUTOMATIC1111-compatible /sdapi/v1/txt2img (sd-webui, Forge, sd.cpp sd-server). */
  backend: 'sdcpp' | 'http';
  /** Empty means <dataDir>/image/bin/sd-cli, where the installer puts it. */
  sdBinary: string;
  /** Catalog id of the local model (models live in <dataDir>/image/models). */
  localModel: string;
  /** More Hugging Face models, same shape as IMAGE_MODELS in @local-agent/shared. */
  extraModels: ImageModelSpec[];
  httpUrl: string;
  geminiModel: string;
  steps: number;
  size: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  goodModelId: null,
  autoResume: true,
  sandbox: 'docker-or-host',
  maxSteps: 24,
  outputReserveTokens: 2048,
  summaryTriggerTokens: 1800,
  searxngUrl: '',
  searchHits: 6,
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
  personaAutoStart: true,
  imapHost: '',
  imapPort: 993,
  imapMailbox: 'INBOX',
  gitName: 'local-agent',
  gitEmail: 'agent@local',
  gitSshKey: '',
  autoModels: { ...DEFAULT_AUTO_MAP },
  debugLevel: 'info',
  toolSupport: {},
  agentLimits: {},
  ramBudgetGiB: 40,
  ramSystemReserveGiB: 1.5,
  imageGen: { mode: 'auto', backend: 'sdcpp', sdBinary: '', localModel: 'sd-turbo', extraModels: [], httpUrl: '', geminiModel: 'gemini-2.5-flash-image', steps: 1, size: 512 },
};

export function normalizeSettings(value: Partial<Settings> | null | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(value ?? {}),
    // An empty saved main slot means "default" (Qwen3.6 on llama-server), not "let Auto guess" (it guessed gemma4).
    autoModels: { ...DEFAULT_AUTO_MAP, ...(value?.autoModels ?? {}), main: value?.autoModels?.main?.trim() || DEFAULT_AUTO_MAP.main },
    toolSupport: { ...(value?.toolSupport ?? {}) },
    imageGen: { ...DEFAULT_SETTINGS.imageGen, ...(value?.imageGen ?? {}) },
    version: value?.version || DEFAULT_SETTINGS.version,
  };
}
