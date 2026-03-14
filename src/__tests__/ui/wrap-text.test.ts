import { describe, it, expect } from 'vitest';
import { wrapText } from '../../ui/message-lines.js';

describe('wrapText', () => {
  // ── Basic cases ──

  it('returns [""] for empty string', () => {
    expect(wrapText('', 20)).toEqual(['']);
  });

  it('returns single line when text fits', () => {
    expect(wrapText('hello world', 20)).toEqual(['hello world']);
  });

  it('returns single line when text exactly fills width', () => {
    expect(wrapText('abcde', 5)).toEqual(['abcde']);
  });

  // ── English word-boundary wrapping ──

  it('breaks at word boundary for English text', () => {
    // "hello world" at width 8 should break between words, not mid-word
    expect(wrapText('hello world', 8)).toEqual(['hello', 'world']);
  });

  it('breaks multiple words at boundaries', () => {
    // "the quick brown fox" at width 10
    const result = wrapText('the quick brown fox', 10);
    expect(result).toEqual(['the quick', 'brown fox']);
  });

  it('breaks at last fitting word boundary', () => {
    // "aaa bbb ccc ddd" at width 8
    const result = wrapText('aaa bbb ccc ddd', 8);
    expect(result).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('handles multiple spaces between words', () => {
    const result = wrapText('hello   world', 8);
    // Should break between hello and world; trailing/leading spaces are trimmed
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]!.trim()).toBe('hello');
    expect(result[result.length - 1]!.trim()).toBe('world');
  });

  // ── Super-long single word fallback to hard break ──

  it('hard-breaks a single word longer than width', () => {
    expect(wrapText('abcdefghij', 5)).toEqual(['abcde', 'fghij']);
  });

  it('hard-breaks extremely long word', () => {
    const result = wrapText('abcdefghijklmno', 5);
    expect(result).toEqual(['abcde', 'fghij', 'klmno']);
  });

  it('word-wraps then hard-breaks for mixed content', () => {
    // "hi abcdefghij" at width 5: "hi" fits, "abcdefghij" must hard-break
    const result = wrapText('hi abcdefghij', 5);
    expect(result[0]).toBe('hi');
    expect(result[1]).toBe('abcde');
    expect(result[2]).toBe('fghij');
  });

  // ── CJK characters (double width) ──

  it('handles CJK characters with correct double-width', () => {
    // Each CJK char is 2 wide. Width=6 fits 3 CJK chars.
    expect(wrapText('你好世界测试', 6)).toEqual(['你好世', '界测试']);
  });

  it('handles CJK that exactly fills width', () => {
    expect(wrapText('你好世', 6)).toEqual(['你好世']);
  });

  it('CJK can break between any two characters', () => {
    // Width 5 fits 2 CJK chars (4 wide) but not 3 (6 wide)
    expect(wrapText('你好世界', 5)).toEqual(['你好', '世界']);
  });

  // ── Mixed CJK and ASCII ──

  it('handles mixed CJK and ASCII', () => {
    // "hi你好" = 2 + 2 + 2 = 6 chars wide. Width=5 should break.
    const result = wrapText('hi你好', 5);
    expect(result).toEqual(['hi你', '好']);
  });

  it('handles ASCII word followed by CJK', () => {
    // "hello世界" at width 8: "hello" = 5, "世" = 2, total 7 fits; "界" = 2, total 9 doesn't
    const result = wrapText('hello世界', 8);
    expect(result).toEqual(['hello世', '界']);
  });

  // ── Edge cases ──

  it('handles single character', () => {
    expect(wrapText('a', 5)).toEqual(['a']);
  });

  it('handles width of 1', () => {
    expect(wrapText('abc', 1)).toEqual(['a', 'b', 'c']);
  });

  it('handles text that is only spaces', () => {
    const result = wrapText('     ', 3);
    // Should produce some output without crashing
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('trims trailing spaces on wrapped lines', () => {
    // When breaking "hello world" at width 6, the line "hello " should not have trailing space
    const result = wrapText('hello world', 6);
    expect(result[0]).toBe('hello');
    expect(result[1]).toBe('world');
  });

  it('handles punctuation as break points', () => {
    // "hello,world" — comma is part of the word, should hard-break if needed
    const result = wrapText('hello, world', 8);
    expect(result).toEqual(['hello,', 'world']);
  });
});
