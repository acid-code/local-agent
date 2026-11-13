import { estimateTokens } from './tokens.js';
import type { RequestKind } from './types.js';

export interface Classification {
  kind: RequestKind;
  confidence: number;
  signals: string[];
  estimatedTokens: number;
}

export function classifyRequest(text: string, hasImage = false): Classification {
  const signals: string[] = [];
  const estimatedTokens = estimateTokens(text, 'approx');
  if (hasImage || /\b(screenshot|image|photo|picture|diagram|png|jpe?g|ui mock)\b/i.test(text)) {
    signals.push('image');
    return { kind: 'vision', confidence: 0.86, signals, estimatedTokens };
  }
  if (estimatedTokens > 6000) {
    signals.push('long-input');
    return { kind: 'long-context', confidence: 0.8, signals, estimatedTokens };
  }

  let code = 0;
  let research = 0;
  let hard = 0;
  if (/```/.test(text)) {
    code += 2;
    signals.push('fence');
  }
  if (/\b(function|class|refactor|compile|typescript|python|bug|stack trace|regex|api)\b/i.test(text)) {
    code += 1.2;
    signals.push('code-word');
  }
  if (/\b(search|paper|source|cite|compare|research|news|latest|according to)\b/i.test(text)) {
    research += 1.3;
    signals.push('research-word');
  }
  if (/\b(prove|formal|optimi[sz]e|architecture|trade-?offs?|step by step|derive)\b/i.test(text)) {
    hard += 1.3;
    signals.push('reasoning-word');
  }
  if (/\b(reason|reasoning|think carefully)\b/i.test(text)) {
    hard += 0.8;
    signals.push('reason-word');
  }

  const best = Math.max(code, research, hard, 0.2);
  let kind: RequestKind = 'chat';
  if (best === hard && hard >= code && hard >= research && hard >= 1) kind = 'hard-reasoning';
  else if (best === code && code >= research && code >= 1) kind = 'code';
  else if (best === research && research >= 1) kind = 'research';
  const confidence = kind === 'chat' ? 0.45 : Math.min(0.95, 0.4 + best / 4);
  return { kind, confidence, signals, estimatedTokens };
}
