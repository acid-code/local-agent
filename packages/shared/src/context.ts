import { estimateTokens } from './tokens.js';
import type { ContextBreakdown, StrategyName, TokenizerId } from './types.js';

export type { ContextBreakdown };

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
  /** Dropped from the end when the instructions alone are tight. Skills last, so they go first. */
  optional?: { label: string; text: string }[];
  pinned: string[];
  summaries: SummaryNode[];
  retrieved: RetrievedChunk[];
  messages: ContextSourceMessage[];
  tokenizer: TokenizerId;
  /**
   * Run-aware mode. Every message of the current run (from its user turn on) is kept, tool results in full up to a
   * large cap; older chat history fills the remaining token budget. Tool results already shown as a digest stay a
   * digest, and the oldest history message in this run stays fixed, so the prompt only grows at the end (prompt cache).
   */
  run?: {
    /** Ids of the messages that belong to the current run, the user turn included. */
    messageIds: string[];
    /** Tool results of this run already shown as digests. Monotonic within a run. */
    digestIds?: string[];
    /** Oldest pre-run message kept in this run (fixed after the first step). '' = none; undefined = first step. */
    historyFloorId?: string;
  };
  /** Optional token breakdown hints from the caller for the Cursor-style context indicator. */
  breakdownHints?: {
    systemPrompt?: number;
    personaAndTools?: number;
    memory?: number;
    files?: number;
  };
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
  trimmed: string[];
  excerpted: { id: string; omitted: string }[];
  breakdown: ContextBreakdown;
  /** Run-aware mode: digested tool results (old plus new) and the fixed history floor, to store on the run. */
  digestIds?: string[];
  historyFloorId?: string;
}

/** Largest tool result kept whole inside the current run (about 6K tokens). */
export const RUN_TOOL_CAP_CHARS = 24_000;
/** Size of a tool-result digest (head, outline of the middle, tail). */
export const DIGEST_CHARS = 1_800;
const OUTLINE = /^\s*(?:\d+:\s*)?(?:export\s|async\s|function\s|class\s|interface\s|type\s|enum\s|def\s|struct\s|impl\s|fn\s|pub\s|public\s|private\s|protected\s|const\s+\w+\s*=\s*(?:async\s*)?\(|#{1,3}\s|describe\(|it\(|test\(|@@\s|diff --git|error|Error|FAIL|✗|exit\s+\d)/;

/**
 * A compact, deterministic stand-in for a long tool result: the head, an outline of what the middle holds (declarations,
 * headings, errors, with their line numbers when the tool printed them), the tail, and how to read the rest.
 */
export function digestToolOutput(content: string, messageId: string, maxChars = DIGEST_CHARS): string {
  const chars = codePoints(content);
  if (chars.length <= maxChars) return content;
  const head = chars.slice(0, Math.floor(maxChars * 0.45)).join('');
  const tail = chars.slice(-Math.floor(maxChars * 0.2)).join('');
  const middle = chars.slice(Math.floor(maxChars * 0.45), chars.length - Math.floor(maxChars * 0.2)).join('');
  const outline = middle.split('\n').filter((line) => OUTLINE.test(line)).map((line) => line.trim().slice(0, 100)).slice(0, 24);
  const lines = content.split('\n').length;
  return `${head}\n…[digest: ${chars.length - maxChars} of ${chars.length} characters (${lines} lines) not shown${outline.length ? '; outline of the hidden part:' : ''}]\n${outline.join('\n')}${outline.length ? '\n' : ''}…[read the hidden part with read_output message=${messageId}, or re-read a slice of the file with startLine/endLine]…\n${tail}`;
}

function tokens(text: string, tokenizer: TokenizerId) {
  return estimateTokens(text, tokenizer);
}

export function shrinkBudget(budget: number): number {
  return Math.max(256, Math.floor(budget * 0.75));
}

export function isContextOverflowError(message: string): boolean {
  return /context length|maximum context|num_ctx|n_ctx|too many tokens|context window|context size|exceed_context_size|context_length_exceeded|prompt is too long|overflow/i.test(message);
}

export function rootCapTokens(practicalBudget: number): number {
  return Math.min(1200, Math.max(200, Math.floor(practicalBudget * 0.2)));
}

export function codePoints(text: string): string[] {
  return [...text];
}

export function headTailExcerpt(content: string, maxChars: number): { excerpt: string; omitted: string } {
  const chars = codePoints(content);
  if (chars.length <= maxChars) return { excerpt: content, omitted: '' };
  const head = Math.max(20, Math.floor(maxChars * 0.45));
  const tail = Math.max(20, Math.floor(maxChars * 0.45));
  const omitted = chars.slice(head, Math.max(head, chars.length - tail)).join('');
  const excerpt = `${chars.slice(0, head).join('')}\n…[${omitted.length} characters indexed for retrieval]…\n${chars.slice(-tail).join('')}`;
  return { excerpt, omitted };
}

export function hardCapText(content: string, tokenizer: TokenizerId, capTokens: number): string {
  if (estimateTokens(content, tokenizer) <= capTokens) return content;
  return headTailExcerpt(content, capTokens * 3).excerpt;
}

export function planContext(input: PlanInput): ContextPlan {
  const cap = Math.min(
    input.contextWindow,
    input.practicalBudget,
    input.budgetOverride && input.budgetOverride > 0 ? input.budgetOverride : Number.POSITIVE_INFINITY,
  );
  const budgetTokens = Math.max(256, cap - input.outputReserve);
  const notes: string[] = [];
  const trimmed: string[] = [];
  const optional = [...(input.optional ?? [])];
  let system = input.system;
  const optionalCost = () => tokens([system, ...optional.map((part) => part.text)].join('\n\n'), input.tokenizer);
  while (optional.length && optionalCost() > budgetTokens * 0.6) {
    const dropped = optional.pop();
    if (dropped) trimmed.push(dropped.label);
  }
  if (optional.length) system = [system, ...optional.map((part) => part.text)].filter(Boolean).join('\n\n');
  if (trimmed.length) notes.push(`Trimmed optional context: ${trimmed.join(', ')}.`);
  if (tokens(input.system, input.tokenizer) > budgetTokens) notes.push('The instructions alone are larger than this model budget.');
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
  } else if (input.strategy === 'hierarchical+retrieval') {
    const root = [...input.summaries].reverse().find((node) => node.level === 2);
    const chunks = input.summaries.filter((node) => node.level === 1 && !node.foldedInto).slice(-3);
    summaryNodes = [...(root ? [root] : []), ...chunks];
    const retrievalBudget = Math.max(80, Math.floor(budgetTokens * 0.25));
    extra = headTailExcerpt(input.retrieved.map((chunk) => chunk.text).join('\n---\n'), retrievalBudget * 3).excerpt;
    notes.push('Hierarchical plus retrieval keeps the root, the open chunk summaries, and retrieved passages in separate shares of the budget.');
  } else if (input.strategy === 'retrieval') {
    extra = input.retrieved.map((chunk) => chunk.text).join('\n---\n');
    notes.push(input.retrieved.length ? `Retrieved ${input.retrieved.length} older chunks.` : 'No retrieved chunks.');
  } else {
    notes.push('Pinned strategy keeps facts and only the latest turns.');
  }

  let summaryText = summaryNodes.map((node) => node.content).filter(Boolean).join('\n\n');
  if (extra) summaryText = [summaryText, extra].filter(Boolean).join('\n\n');

  const systemTokens = tokens(system, input.tokenizer) + tokens(pinnedBlock, input.tokenizer) + 24;
  let summaryTokens = tokens(summaryText, input.tokenizer);
  let room = budgetTokens - systemTokens - summaryTokens - 32;
  if (room < 160 && summaryText.length > 400) {
    summaryText = summaryText.slice(0, 700);
    summaryTokens = tokens(summaryText, input.tokenizer);
    room = budgetTokens - systemTokens - summaryTokens - 32;
    notes.push('Shrunk the summary block to leave room for the latest turn.');
  }

  if (input.run) {
    return planRunAware(input, { system, pinnedBlock, summaryText, summaryTokens, room, budgetTokens, summaryNodes, notes, trimmed });
  }
  const pool = input.strategy === 'pinned'
    ? input.messages.slice(-4)
    : input.strategy === 'rolling'
      ? input.messages.slice(-8)
      : input.strategy === 'hierarchical'
        ? input.messages.slice(-12)
        : input.strategy === 'hierarchical+retrieval'
          ? input.messages.slice(-14)
          : input.strategy === 'retrieval'
            ? input.messages.slice(-14)
            : input.messages.slice(-8);
  const prepared = pool.map((message) => prepareMessage(message, input.tokenizer));
  const excerpted = prepared.flatMap((item) => item.omitted ? [{ id: item.message.id, omitted: item.omitted }] : []);
  const recent: ContextSourceMessage[] = [];
  let truncated = excerpted.length > 0;
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    const message = prepared[index]!.message;
    const cost = tokens(message.content, input.tokenizer) + 4;
    if (cost <= room || recent.length === 0) {
      if (cost > room) {
        const fit = headTailExcerpt(message.content, Math.max(80, room * 3));
        recent.unshift({ ...message, content: fit.excerpt });
        if (fit.omitted) excerpted.push({ id: message.id, omitted: fit.omitted });
        truncated = true;
        room = 0;
        notes.push('The newest message was excerpted, head and tail, to fit the budget.');
        break;
      }
      recent.unshift(message);
      room -= cost;
      continue;
    }
    break;
  }
  const newestUser = [...input.messages].reverse().find((message) => message.role === 'user');
  if (newestUser && !recent.some((message) => message.id === newestUser.id)) {
    const fit = headTailExcerpt(newestUser.content, Math.max(120, Math.floor(budgetTokens * 0.25) * 3));
    recent.unshift({ ...newestUser, content: fit.excerpt });
    if (fit.omitted) excerpted.push({ id: newestUser.id, omitted: fit.omitted });
    notes.push('Kept the newest user turn.');
  }

  const recentIds = new Set(recent.map((message) => message.id));
  const droppedIds = input.messages.filter((message) => !recentIds.has(message.id)).map((message) => message.id);
  const preamble = [system, pinnedBlock, summaryText ? `Earlier in this conversation:\n${summaryText}` : '']
    .filter(Boolean)
    .join('\n\n');
  const estimatedTokens = tokens(preamble, input.tokenizer) + recent.reduce((sum, message) => sum + tokens(message.content, input.tokenizer) + 4, 0);
  const overflow = droppedIds.length > 0 && input.strategy !== 'pinned';
  if (overflow) notes.push(`${droppedIds.length} older messages sit outside this call.`);
  const hints = input.breakdownHints ?? {};
  const pinnedToks = tokens(pinnedBlock, input.tokenizer);
  const fileMessageToks = recent.reduce((sum, message) => {
    if (message.role === 'tool' || /\[file:|\[Attached|<!--context-->/i.test(message.content)) {
      return sum + tokens(message.content, input.tokenizer) + 4;
    }
    return sum;
  }, 0);
  const recentToks = recent.reduce((sum, message) => sum + tokens(message.content, input.tokenizer) + 4, 0);
  const filesToks = (hints.files ?? 0) + fileMessageToks;
  const historyToks = Math.max(0, summaryTokens + recentToks - fileMessageToks);
  const memoryToks = (hints.memory ?? 0) + pinnedToks;
  const personaAndToolsToks = hints.personaAndTools ?? 0;
  const systemPromptToks = hints.systemPrompt ?? Math.max(0, tokens(system, input.tokenizer) - memoryToks - (hints.files ?? 0));
  const totalUsed = estimatedTokens + (hints.personaAndTools ?? 0);
  const breakdown: ContextBreakdown = {
    budget: budgetTokens,
    used: totalUsed,
    remaining: Math.max(0, budgetTokens - totalUsed),
    outputReserve: input.outputReserve,
    systemPrompt: Math.max(0, systemPromptToks),
    personaAndTools: Math.max(0, personaAndToolsToks),
    memory: Math.max(0, memoryToks),
    history: Math.max(0, historyToks),
    files: Math.max(0, filesToks),
  };
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
    trimmed,
    excerpted,
    breakdown,
  };
}

function prepareMessage(message: ContextSourceMessage, tokenizer: TokenizerId): { message: ContextSourceMessage; omitted: string } {
  const cap = message.role === 'tool' ? 4000 : 12000;
  if (codePoints(message.content).length <= cap) return { message, omitted: '' };
  const fit = headTailExcerpt(message.content, cap);
  const reference = message.role === 'tool' ? `\nRead more with read_output message=${message.id} offset=0.` : '';
  return { message: { ...message, content: `${fit.excerpt}${reference}` }, omitted: fit.omitted };
}

/** Messages that should be folded into the next summary version. */
/** Small models keep the 1800-token trigger. Large models wait until about half their practical budget. */
export function summaryTriggerFor(model: { sizeClass: 'small' | 'large'; practicalBudget: number }, smallDefault = 1800): number {
  if (model.sizeClass !== 'large') return smallDefault;
  return Math.max(smallDefault, Math.floor(model.practicalBudget * 0.5));
}

export function foldCandidates(
  messages: ContextSourceMessage[],
  coveredIds: Set<string>,
  tokenizer: TokenizerId,
  triggerTokens: number,
  /** When set, fold early once the open messages near this budget, whatever their count. */
  budgetTokens?: number,
): string[] | null {
  const uncovered = messages.filter((message) => !coveredIds.has(message.id));
  if (budgetTokens && uncovered.length > 2) {
    const total = uncovered.reduce((sum, message) => sum + tokens(message.content, tokenizer) + 4, 0);
    if (total >= budgetTokens * 0.8) return uncovered.slice(0, -2).map((message) => message.id);
  }
  if (uncovered.length <= 8) return null;
  const older = uncovered.slice(0, uncovered.length - 6);
  const cost = older.reduce((sum, message) => sum + tokens(message.content, tokenizer) + 4, 0);
  if (cost < triggerTokens) return null;
  return older.map((message) => message.id);
}

function planRunAware(
  input: PlanInput,
  ctx: { system: string; pinnedBlock: string; summaryText: string; summaryTokens: number; room: number; budgetTokens: number; summaryNodes: SummaryNode[]; notes: string[]; trimmed: string[] },
): ContextPlan {
  const run = input.run!;
  const runIds = new Set(run.messageIds);
  const digests = new Set(run.digestIds ?? []);
  const excerpted: { id: string; omitted: string }[] = [];
  const notes = ctx.notes;
  const cost = (message: ContextSourceMessage) => tokens(message.content, input.tokenizer) + 4;
  const firstRun = input.messages.findIndex((message) => runIds.has(message.id));
  const runMessages = firstRun >= 0 ? input.messages.slice(firstRun) : [];
  const before = firstRun >= 0 ? input.messages.slice(0, firstRun) : input.messages.slice();

  const render = (message: ContextSourceMessage): ContextSourceMessage => {
    if (message.role === 'tool') {
      if (digests.has(message.id)) return { ...message, content: digestToolOutput(message.content, message.id) };
      if (codePoints(message.content).length > RUN_TOOL_CAP_CHARS) {
        const fit = headTailExcerpt(message.content, RUN_TOOL_CAP_CHARS);
        excerpted.push({ id: message.id, omitted: fit.omitted });
        return { ...message, content: `${fit.excerpt}\nRead more with read_output message=${message.id} offset=0.` };
      }
      return message;
    }
    if (codePoints(message.content).length > 12_000) {
      const fit = headTailExcerpt(message.content, 12_000);
      excerpted.push({ id: message.id, omitted: fit.omitted });
      return { ...message, content: fit.excerpt };
    }
    return message;
  };

  // 1. The current run, whole. Over budget: turn the oldest full tool results into digests (never the newest two).
  let rendered = runMessages.map(render);
  let runCost = rendered.reduce((sum, message) => sum + cost(message), 0);
  const newDigests: string[] = [];
  if (runCost > ctx.room) {
    const toolIds = runMessages.filter((message) => message.role === 'tool' && !digests.has(message.id)).map((message) => message.id);
    for (const id of toolIds.slice(0, Math.max(0, toolIds.length - 2))) {
      if (runCost <= ctx.room) break;
      digests.add(id);
      newDigests.push(id);
      rendered = runMessages.map(render);
      runCost = rendered.reduce((sum, message) => sum + cost(message), 0);
    }
    if (newDigests.length) notes.push(`Condensed ${newDigests.length} older tool result${newDigests.length === 1 ? '' : 's'} of this run into digests.`);
  }
  let truncated = excerpted.length > 0;
  if (runCost > ctx.room && rendered.length) {
    // Still too big: cut the middle of the largest message of the run, head and tail kept.
    const largest = rendered.reduce((best, message, index) => (cost(message) > cost(rendered[best]!) ? index : best), 0);
    const over = runCost - ctx.room;
    const target = Math.max(240, codePoints(rendered[largest]!.content).length - (over + 64) * 3);
    const fit = headTailExcerpt(rendered[largest]!.content, target);
    excerpted.push({ id: rendered[largest]!.id, omitted: fit.omitted });
    rendered[largest] = { ...rendered[largest]!, content: fit.excerpt };
    runCost = rendered.reduce((sum, message) => sum + cost(message), 0);
    truncated = true;
    notes.push('This run is larger than the budget; the middle of its largest message was cut.');
  }

  // 2. Earlier history: from the fixed floor (or newest-first by tokens on the first step), older tool results as digests.
  let room = ctx.room - runCost;
  const maxOlder = input.strategy === 'pinned' ? 4 : 60;
  const olderRendered = before.map((message) => (message.role === 'tool' ? { ...message, content: digestToolOutput(message.content, message.id) } : render(message)));
  let start = before.length;
  const floorIndex = run.historyFloorId ? before.findIndex((message) => message.id === run.historyFloorId) : -1;
  if (floorIndex >= 0) {
    start = floorIndex;
    let olderCost = olderRendered.slice(start).reduce((sum, message) => sum + cost(message), 0);
    while (start < before.length && olderCost > room) { olderCost -= cost(olderRendered[start]!); start += 1; }
  } else if (run.historyFloorId !== '') {
    let used = 0;
    while (start > 0 && before.length - start < maxOlder) {
      const next = cost(olderRendered[start - 1]!);
      if (used + next > room) break;
      used += next;
      start -= 1;
    }
  }
  // Never open with a tool result whose call was cut off.
  while (start < before.length && before[start]!.role === 'tool') start += 1;
  const older = olderRendered.slice(start);
  room -= older.reduce((sum, message) => sum + cost(message), 0);
  const recent = [...older, ...rendered];
  const recentIds = new Set(recent.map((message) => message.id));
  const droppedIds = input.messages.filter((message) => !recentIds.has(message.id)).map((message) => message.id);
  const preamble = [ctx.system, ctx.pinnedBlock, ctx.summaryText ? `Earlier in this conversation:\n${ctx.summaryText}` : ''].filter(Boolean).join('\n\n');
  const estimatedTokens = tokens(preamble, input.tokenizer) + recent.reduce((sum, message) => sum + cost(message), 0);
  if (droppedIds.length && input.strategy !== 'pinned') notes.push(`${droppedIds.length} older messages sit outside this call.`);
  const hints = input.breakdownHints ?? {};
  const pinnedToks = tokens(ctx.pinnedBlock, input.tokenizer);
  const fileMessageToks = recent.reduce((sum, message) => (message.role === 'tool' || /\[file:|\[Attached|<!--context-->/i.test(message.content) ? sum + cost(message) : sum), 0);
  const recentToks = recent.reduce((sum, message) => sum + cost(message), 0);
  const memoryToks = (hints.memory ?? 0) + pinnedToks;
  const totalUsed = estimatedTokens + (hints.personaAndTools ?? 0);
  return {
    strategy: input.strategy,
    budgetTokens: ctx.budgetTokens,
    estimatedTokens,
    outputReserve: input.outputReserve,
    preamble,
    recent,
    droppedIds,
    summaryIds: ctx.summaryNodes.map((node) => node.id),
    overflow: droppedIds.length > 0 && input.strategy !== 'pinned',
    truncated,
    notes,
    trimmed: ctx.trimmed,
    excerpted,
    breakdown: {
      budget: ctx.budgetTokens,
      used: totalUsed,
      remaining: Math.max(0, ctx.budgetTokens - totalUsed),
      outputReserve: input.outputReserve,
      systemPrompt: Math.max(0, hints.systemPrompt ?? Math.max(0, tokens(ctx.system, input.tokenizer) - memoryToks - (hints.files ?? 0))),
      personaAndTools: Math.max(0, hints.personaAndTools ?? 0),
      memory: Math.max(0, memoryToks),
      history: Math.max(0, ctx.summaryTokens + recentToks - fileMessageToks),
      files: Math.max(0, (hints.files ?? 0) + fileMessageToks),
    },
    digestIds: [...digests],
    // '' means "no earlier history in this run", so later steps do not start adding some (that would change the prefix).
    historyFloorId: older[0]?.id ?? '',
  };
}
