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
}
