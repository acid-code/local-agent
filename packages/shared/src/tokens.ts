import type { TokenizerId } from './types.js';

/**
 * Family-calibrated estimate. This is not the official SentencePiece or
 * Gemini tokenizer. Gemma 4 and Qwen3.6 counts are close enough to budget
 * a window; Gemini countTokens is consulted by the server when a key is set
 * and the estimate sits near the budget.
 *
 * Ratios are characters of non-CJK text per token. CJK ideographs are
 * counted separately because they are usually one token or less.
 */
const CHARS_PER_TOKEN: Record<TokenizerId, number> = {
  gemma4: 3.6,
  qwen3: 3.5,
  gemini: 3.8,
  approx: 4,
};

export function estimateTokens(text: string, tokenizer: TokenizerId = 'approx'): number {
  if (!text) return 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u9fff]/g)?.length ?? 0;
  const rtl = text.match(/[\u0590-\u08ff]/g)?.length ?? 0;
  const rest = Math.max(0, [...text].length - cjk - rtl);
  const ratio = CHARS_PER_TOKEN[tokenizer] ?? 4;
  return Math.max(1, Math.ceil(rest / ratio + cjk / 1.35 + rtl));
}

export function estimateMessageTokens(
  messages: { content: string }[],
  tokenizer: TokenizerId,
): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.content, tokenizer) + 4;
  return total;
}
