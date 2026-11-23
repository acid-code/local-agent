import { describe, it, expect } from 'vitest';
import { detectDegenerateRepeat } from '../src/engine.js';

describe('detectDegenerateRepeat', () => {
  it('ignores Markdown table separators, horizontal rules, and indentation', () => {
    expect(detectDegenerateRepeat('| Model | Fit |\n|-------|------------------------------------------------|')).toBeNull();
    expect(detectDegenerateRepeat('Section\n' + '-'.repeat(80))).toBeNull();
    expect(detectDegenerateRepeat('Header\n' + '='.repeat(80))).toBeNull();
    expect(detectDegenerateRepeat('Box\n' + '─'.repeat(80))).toBeNull();
    expect(detectDegenerateRepeat('Indent\n' + ' '.repeat(80))).toBeNull();
    expect(detectDegenerateRepeat('| --- '.repeat(30))).toBeNull();
  });

  it('catches genuine single-char and multi-char repetition collapses', () => {
    expect(detectDegenerateRepeat('answer ' + '/'.repeat(60))).toBe('/'.repeat(60));
    expect(detectDegenerateRepeat('thinking ' + 'a'.repeat(65))).toBe('a'.repeat(65));
    expect(detectDegenerateRepeat('loop ' + 'foo '.repeat(20))).toBe('foo '.repeat(20));
  });
});
