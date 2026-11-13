import { estimateTokens } from './tokens.js';
import type { StrategyName, TokenizerId } from './types.js';

export interface ContextSourceMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface SummaryNode {
  id: string;
  level: 1 | 2;
  content: string;
  covers: string[];
  foldedInto?: string | null;
}

export interface RetrievedChunk {
  id: string;
  text: string;
  score: number;
}

export interface PlanInput {
  strategy: StrategyName;
  contextWindow: number;
  practicalBudget: number;
  outputReserve: number;
  budgetOverride?: number | null;
  system: string;
  pinned: string[];
  summaries: SummaryNode[];
  retrieved: RetrievedChunk[];
  messages: ContextSourceMessage[];
  tokenizer: TokenizerId;
}

export interface ContextPlan {
  strategy: StrategyName;
  budgetTokens: number;
  estimatedTokens: number;
  outputReserve: number;
  preamble: string;
  recent: ContextSourceMessage[];
  droppedIds: string[];
  summaryIds: string[];
  overflow: boolean;
  truncated: boolean;
  notes: string[];
}

function tokens(text: string, tokenizer: TokenizerId) {
  return estimateTokens(text, tokenizer);
}

export function planContext(input: PlanInput): ContextPlan {
  const cap = Math.min(
    input.contextWindow,
    input.practicalBudget,
    input.budgetOverride && input.budgetOverride > 0 ? input.budgetOverride : Number.POSITIVE_INFINITY,
  );
  const budgetTokens = Math.max(256, cap - input.outputReserve);
  const notes: string[] = [];
  const pinnedBlock = input.pinned.length ? `Pinned facts:\n${input.pinned.map((fact) => `- ${fact}`).join('\n')}` : '';

  let summaryNodes: SummaryNode[] = [];
  let extra = '';
  if (input.strategy === 'rolling') {
    const root = [...input.summaries].reverse().find((node) => node.level === 2) ?? input.summaries.at(-1);
    summaryNodes = root ? [root] : [];
  } else if (input.strategy === 'hierarchical') {
    const root = [...input.summaries].reverse().find((node) => node.level === 2);
    const chunks = input.summaries.filter((node) => node.level === 1 && !node.foldedInto).slice(-3);
    summaryNodes = [...(root ? [root] : []), ...chunks];
    notes.push('Hierarchical plan keeps the root summary plus the newest open chunk summaries.');
  } else if (input.strategy === 'retrieval') {
    extra = input.retrieved.map((chunk) => chunk.text).join('\n---\n');
    notes.push(input.retrieved.length ? `Retrieved ${input.retrieved.length} older chunks.` : 'No retrieved chunks.');
  } else {
    notes.push('Pinned strategy keeps facts and only the latest turns.');
  }

  let summaryText = summaryNodes.map((node) => node.content).filter(Boolean).join('\n\n');
  if (extra) summaryText = [summaryText, extra].filter(Boolean).join('\n\n');

  const systemTokens = tokens(input.system, input.tokenizer) + tokens(pinnedBlock, input.tokenizer) + 24;
  let summaryTokens = tokens(summaryText, input.tokenizer);
  let room = budgetTokens - systemTokens - summaryTokens - 32;
  if (room < 160 && summaryText.length > 400) {
    summaryText = summaryText.slice(0, 700);
    summaryTokens = tokens(summaryText, input.tokenizer);
    room = budgetTokens - systemTokens - summaryTokens - 32;
    notes.push('Shrunk the summary block to leave room for the latest turn.');
  }

  const pool = input.strategy === 'pinned' ? input.messages.slice(-4) : input.messages;
  const recent: ContextSourceMessage[] = [];
  let truncated = false;
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    const message = pool[index]!;
    const cost = tokens(message.content, input.tokenizer) + 4;
    if (cost <= room || recent.length === 0) {
      if (cost > room) {
        const keep = Math.max(80, room * 3);
        recent.unshift({ ...message, content: message.content.slice(-keep) });
        truncated = true;
        room = 0;
        notes.push('The newest message was truncated to fit the budget.');
        break;
      }
      recent.unshift(message);
      room -= cost;
      continue;
    }
    break;
  }

  const recentIds = new Set(recent.map((message) => message.id));
  const droppedIds = input.messages.filter((message) => !recentIds.has(message.id)).map((message) => message.id);
  const preamble = [input.system, pinnedBlock, summaryText ? `Earlier in this conversation:\n${summaryText}` : '']
    .filter(Boolean)
    .join('\n\n');
  const estimatedTokens = tokens(preamble, input.tokenizer) + recent.reduce((sum, message) => sum + tokens(message.content, input.tokenizer) + 4, 0);
  const overflow = droppedIds.length > 0 && input.strategy !== 'pinned';
  if (overflow) notes.push(`${droppedIds.length} older messages sit outside this call.`);
  return {
    strategy: input.strategy,
    budgetTokens,
    estimatedTokens,
    outputReserve: input.outputReserve,
    preamble,
    recent,
    droppedIds,
    summaryIds: summaryNodes.map((node) => node.id),
    overflow,
    truncated,
    notes,
  };
}

/** Messages that should be folded into the next summary version. */
export function foldCandidates(
  messages: ContextSourceMessage[],
  coveredIds: Set<string>,
  tokenizer: TokenizerId,
  triggerTokens: number,
): string[] | null {
  const uncovered = messages.filter((message) => !coveredIds.has(message.id));
  if (uncovered.length <= 8) return null;
  const older = uncovered.slice(0, uncovered.length - 6);
  const cost = older.reduce((sum, message) => sum + tokens(message.content, tokenizer) + 4, 0);
  if (cost < triggerTokens) return null;
  return older.map((message) => message.id);
}
