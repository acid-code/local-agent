export type TokenizerId = 'gemma4' | 'qwen3' | 'gemini' | 'approx';

export type StrategyName = 'rolling' | 'hierarchical' | 'hierarchical+retrieval' | 'pinned' | 'retrieval';

export type RequestKind =
  | 'code'
  | 'research'
  | 'chat'
  | 'vision'
  | 'long-context'
  | 'hard-reasoning';

export type SizeClass = 'small' | 'large';

export type Modality = 'text' | 'image';

export type ProviderKind = 'openai_compat' | 'gemini' | 'openrouter' | 'rehearsal';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  imageUrl?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type RunPhase = 'route' | 'context' | 'model' | 'tools' | 'summarize' | 'done';

export type RunStatus =
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'awaiting_secret'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export interface RunCursor {
  phase: RunPhase;
  /** Recovery rounds after a reply claimed success over a failed tool call, and the note sent back to the model. */
  recovery?: { rounds: number; note?: string };
  /** A task list with 2+ items was set: allow more model turns. taskRounds counts verify-before-done send-backs. */
  longTask?: boolean;
  taskRounds?: number;
  /** Background helper limits: fewer model steps, a shorter wall clock, and only these tools. */
  maxSteps?: number;
  timeoutMs?: number;
  toolSubset?: string[];
  helperId?: string;
  /** Set by the /image chat command: generate a picture instead of calling a chat model. */
  imagePrompt?: string;
  /** Scheduled or triggered run: queued behind chat replies and images when memory is short. */
  background?: boolean;
  turn: number;
  modelId?: string;
  messageModelId?: string;
  toolCalls?: ToolCall[];
  completedToolIds?: string[];
  approvalId?: string;
  agentUpdatedAt?: string;
  configVersion?: number;
  routingReason?: string;
  switched?: boolean;
  lastMessageId?: string;
  weightNote?: string;
  depth?: number;
  /** Workshop or a change to a shared repo: plan first, then implement. */
  stage?: 'plan' | 'implement';
  syncNote?: string;
  branched?: boolean;
  /** Set when /model or /auto is the whole message, so the run answers without calling a model. */
  commandAck?: string;
  /** The named model in /model was not installed. */
  pinMiss?: string;
  reasoning?: boolean;
  autoRole?: string;
  budgetOverride?: number;
  contextEscalated?: boolean;
  providerFallback?: boolean;
  contextUsed?: number;
  contextBudget?: number;
  /** The user message this run answers. Routing and context stop at it. */
  userMessageId?: string;
  /** One retry after an empty answer, with thinking turned off. */
  emptyRetry?: boolean;
  noThink?: boolean;
  /** One retry on the next Auto tier after a model rejected tools. */
  toolRetry?: boolean;
  /** Send no tools on this turn. */
  noTools?: boolean;
  /** One retry on the next Auto tier after the model was missing from Ollama. */
  missingRetry?: boolean;
  /** One automatic nudge when Researcher answers a factual question without searching first. */
  researchRetried?: boolean;
  /** One automatic nudge when a high-confidence skill was not loaded. */
  skillRetried?: boolean;
}

export interface ContextBreakdown {
  budget: number;
  used: number;
  remaining: number;
  outputReserve: number;
  systemPrompt: number;
  personaAndTools: number;
  memory: number;
  history: number;
  files: number;
}
