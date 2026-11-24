export type TokenizerId = 'gemma4' | 'qwen3' | 'gemini' | 'approx';

export type ReasoningEffort = 'auto' | 'off' | 'low' | 'medium' | 'high';

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
  /** The model's own reasoning for this assistant turn. Sent back to llama-server so the prompt matches its cache. */
  reasoning?: string;
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

export type WorkPhase = 'planning' | 'investigating' | 'editing' | 'verifying' | 'fixing' | 'summarizing';

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
  /** Human-readable live focus phrase and workflow phase surfaced to UI pills. */
  focus?: string;
  workPhase?: WorkPhase;
  /** User steering queued while the run is active. It changes the next model step without restarting or stopping work. */
  steering?: { id: string; content: string };
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
  /** Persona-to-persona messaging hop counter (refused above 3). */
  hop?: number;
  sourceMessageId?: string;
  sourceAgentId?: string;
  sourceSessionId?: string;
  sourceRunId?: string;
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
  /** Retry with conservative anti-repetition sampling after a degenerate output loop. */
  safeSampling?: boolean;
  noThink?: boolean;
  /** One retry on the next Auto tier after a model rejected tools. */
  toolRetry?: boolean;
  /** Send no tools on this turn. */
  noTools?: boolean;
  /** Set once when maxSteps is reached so the model gets one final tool-free turn to synthesize its answer. */
  finalSynthesis?: boolean;
  /** One retry on the next Auto tier after the model was missing from Ollama. */
  missingRetry?: boolean;
  /** One automatic retry on the uncensored local llama-server after a clear refusal. */
  uncensoredRetry?: boolean;
  /** Switched once to a tool-capable model because the chosen one cannot call tools. */
  toolFallback?: boolean;
  /** Tool calls with malformed arguments so far in this run (capped). */
  badArgs?: number;
  /** Acceptance checks from the plan; the done check verifies them before the run may finish. */
  acceptance?: string[];
  /** Model the run left for the uncensored fallback, and the turn the fallback answers; the run returns after it. */
  uncensoredFrom?: string;
  uncensoredAt?: number;
  /** Snapshot of open tasks used to stop verification send-backs when the plan does not progress. */
  taskSnapshot?: string;
  /** One automatic nudge when Researcher answers a factual question without searching first. */
  researchRetried?: boolean;
  /** One automatic nudge when a high-confidence skill was not loaded. */
  skillRetried?: boolean;
  /** Run-aware context: tool results of this run shown as digests (only grows), and the fixed oldest history message. */
  digestIds?: string[];
  historyFloorId?: string;
  /** System prompt and per-run context frozen at the first model step, so the prompt prefix stays byte-identical. */
  frozen?: { modelId: string; system: string; turnContext: string };
  /** Notes for the model (recovery, steering, nudges), each pinned after the message that was last when it was added. */
  notes?: { anchorId: string; text: string }[];
  /** Tools found with find_tools during this run. Appended to the offered list, never removed. */
  extraTools?: string[];
  /** Retries after llama-server dropped the connection or restarted. */
  transientRetries?: number;
  /** Consecutive identical tool calls (name + arguments) for the loop breaker. */
  loop?: { sig: string; count: number };
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
