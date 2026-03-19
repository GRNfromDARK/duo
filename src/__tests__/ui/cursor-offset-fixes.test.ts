/**
 * Tests covering the three cursor-offset bug categories fixed in this branch:
 *
 *  1. \r / \r\n in value — layout must strip carriage-returns before column
 *     calculations so the cursor does not jump to column 0.
 *
 *  2. Surrogate-pair (emoji) navigation — prevCodePointIndex /
 *     nextCodePointIndex must skip full pairs; backspace must remove an emoji
 *     as one unit.
 *
 *  3. Chinese / multi-byte characters — basic smoke tests to confirm that
 *     getCursorLineCol correctly computes line/col for CJK input.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock OpenTUI modules to avoid .scm file loading in the test environment
vi.mock('@opentui/core', () => ({
  createTextAttributes: vi.fn(),
  decodePasteBytes: vi.fn((bytes: Uint8Array) => new TextDecoder().decode(bytes)),
  stripAnsiSequences: vi.fn((s: string) => s),
}));
vi.mock('@opentui/react', () => ({
  useAppContext: vi.fn(() => ({ keyHandler: null, renderer: null })),
  useKeyboard: vi.fn(),
}));

import {
  getCursorLineCol,
  getDisplayLines,
  buildInputAreaLayout,
} from '../../ui/input-area-layout.js';
import {
  processInput,
  prevCodePointIndex,
  nextCodePointIndex,
} from '../../ui/components/InputArea.js';
import type { Key } from '../../tui/primitives.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false,
    hyper: false, capsLock: false, numLock: false,
    ...overrides,
  };
}

// ── 1. \r / \r\n handling ────────────────────────────────────────────────────

describe('getCursorLineCol – strips \\r before column calculation', () => {
  it('treats \\r\\n as a single newline', () => {
    // "hello\r\nworld" — after strip: "hello\nworld"
    const value = 'hello\r\nworld';
    // cursor at the 'w' (index 7 in original, 6 after strip: hello\n = 6)
    // Original string: h=0 e=1 l=2 l=3 o=4 \r=5 \n=6 w=7
    const result = getCursorLineCol(value, 7);
    expect(result).toEqual({ line: 1, col: 0 });
  });

  it('cursor stays on correct line when value has bare \\r', () => {
    // "abc\rdef\nghi" — after \r strip → "abcdef\nghi"
    // cursor at index 4 in the original (pointing to 'd')
    const result = getCursorLineCol('abc\rdef\nghi', 4);
    // before.slice(0,4) = 'abc\r' → stripped = 'abc' → line 0, col 3
    expect(result).toEqual({ line: 0, col: 3 });
  });
});

describe('getDisplayLines – strips \\r from displayed content', () => {
  it('removes \\r from line content so it never reaches the renderer', () => {
    const lines = getDisplayLines('hello\r\nworld\r\n', 5);
    expect(lines).toEqual(['hello', 'world', '']);
  });

  it('handles bare \\r as no-op (collapses into previous chars)', () => {
    const lines = getDisplayLines('abc\rdef', 5);
    expect(lines).toEqual(['abcdef']);
  });
});

describe('buildInputAreaLayout – \\r in value does not corrupt cursor line', () => {
  it('cursor on second line after \\r\\n paste', () => {
    // Simulate value that slipped through with \r\n (paste from Windows)
    const value = 'first\r\nsecond';
    const cursorPos = 8; // points at 's' in 'second' in original string
    const layout = buildInputAreaLayout({ value, cursorPos, isLLMRunning: false, maxLines: 5 });

    // After stripping \r: "first\nsecond", cursorPos 8 maps to col 1 on line 1
    expect(layout.lines.length).toBe(2);
    const cursorLine = layout.lines.find((l) => l.isCursorLine);
    expect(cursorLine).toBeDefined();
    // beforeCursor should be 's' prefix (col 1 → 's')
    expect(cursorLine!.beforeCursor).toBe('s');
  });

  it('placeholder path unaffected by \\r normalisation', () => {
    const layout = buildInputAreaLayout({ value: '', cursorPos: 0, isLLMRunning: false, maxLines: 5 });
    expect(layout.showPlaceholder).toBe(true);
    expect(layout.cursorChar).toBe('█');
  });
});

// ── 2. Surrogate-pair helpers ─────────────────────────────────────────────────

describe('prevCodePointIndex', () => {
  it('steps back 1 for ASCII', () => {
    expect(prevCodePointIndex('hello', 3)).toBe(2);
  });

  it('steps back 1 for BMP Chinese character', () => {
    // '你好' — each char is 1 code unit
    expect(prevCodePointIndex('你好', 2)).toBe(1);
    expect(prevCodePointIndex('你好', 1)).toBe(0);
  });

  it('steps back 2 for a surrogate pair (emoji)', () => {
    // '😀' is U+1F600, encoded as two code units (high + low surrogate)
    // '😀'.length === 2
    const s = 'a😀b';
    // pos 3 = after '😀', before 'b'
    expect(prevCodePointIndex(s, 3)).toBe(1); // skip both surrogates
  });

  it('clamps to 0 at start of string', () => {
    expect(prevCodePointIndex('abc', 0)).toBe(0);
  });

  it('handles isolated low surrogate gracefully (steps back 1)', () => {
    // Construct a string with a lone low surrogate (malformed, but must not crash)
    const lone = 'a' + String.fromCharCode(0xDC00) + 'b';
    expect(prevCodePointIndex(lone, 2)).toBe(1);
  });
});

describe('nextCodePointIndex', () => {
  it('steps forward 1 for ASCII', () => {
    expect(nextCodePointIndex('hello', 1)).toBe(2);
  });

  it('steps forward 1 for BMP Chinese', () => {
    expect(nextCodePointIndex('你好', 0)).toBe(1);
    expect(nextCodePointIndex('你好', 1)).toBe(2);
  });

  it('steps forward 2 for a surrogate pair (emoji)', () => {
    const s = 'a😀b';
    // pos 1 = start of '😀'
    expect(nextCodePointIndex(s, 1)).toBe(3); // skip both surrogates
  });

  it('clamps to string length at end', () => {
    expect(nextCodePointIndex('abc', 3)).toBe(3);
  });

  it('handles isolated high surrogate gracefully (steps forward 1)', () => {
    const lone = 'a' + String.fromCharCode(0xD800) + 'b';
    expect(nextCodePointIndex(lone, 1)).toBe(2);
  });
});

// ── 3. processInput – surrogate-pair safe navigation ──────────────────────────

describe('processInput – surrogate-pair cursor navigation', () => {
  const EMOJI = '😀'; // length 2 in JS
  const VALUE = `ab${EMOJI}cd`; // 'a','b',high,low,'c','d'  → .length === 6

  it('left arrow before emoji jumps to emoji start (not into surrogate pair)', () => {
    // cursor at pos 4 (after emoji, before 'c')
    const result = processInput(VALUE, 4, '', key({ leftArrow: true }), 5);
    expect(result.type).toBe('update');
    if (result.type === 'update') {
      expect(result.cursorPos).toBe(2); // start of emoji
    }
  });

  it('right arrow on emoji start jumps to after emoji', () => {
    // cursor at pos 2 (start of emoji high surrogate)
    const result = processInput(VALUE, 2, '', key({ rightArrow: true }), 5);
    expect(result.type).toBe('update');
    if (result.type === 'update') {
      expect(result.cursorPos).toBe(4); // after emoji
    }
  });

  it('backspace at pos 4 removes full emoji (both surrogates)', () => {
    const result = processInput(VALUE, 4, '', key({ backspace: true }), 5);
    expect(result.type).toBe('update');
    if (result.type === 'update') {
      expect(result.value).toBe('abcd');
      expect(result.cursorPos).toBe(2);
    }
  });

  it('backspace at ASCII position still removes 1 character', () => {
    const result = processInput('hello', 5, '', key({ backspace: true }), 5);
    expect(result.type).toBe('update');
    if (result.type === 'update') {
      expect(result.value).toBe('hell');
      expect(result.cursorPos).toBe(4);
    }
  });
});

// ── 4. CJK / Chinese smoke tests ──────────────────────────────────────────────

describe('getCursorLineCol – Chinese BMP characters', () => {
  it('correctly returns col for cursor after CJK chars', () => {
    // '你好世界' — each char is 1 JS code unit
    expect(getCursorLineCol('你好世界', 0)).toEqual({ line: 0, col: 0 });
    expect(getCursorLineCol('你好世界', 2)).toEqual({ line: 0, col: 2 });
    expect(getCursorLineCol('你好世界', 4)).toEqual({ line: 0, col: 4 });
  });

  it('handles Chinese on second line', () => {
    const value = 'hello\n你好';
    expect(getCursorLineCol(value, 6)).toEqual({ line: 1, col: 0 });
    expect(getCursorLineCol(value, 8)).toEqual({ line: 1, col: 2 });
  });
});

describe('buildInputAreaLayout – Chinese cursor rendering', () => {
  it('places cursor at the correct character within Chinese text', () => {
    // value = '你好世界', cursor at index 2 (pointing at '世')
    const layout = buildInputAreaLayout({
      value: '你好世界',
      cursorPos: 2,
      isLLMRunning: false,
      maxLines: 5,
    });

    expect(layout.lines.length).toBe(1);
    const line = layout.lines[0]!;
    expect(line.isCursorLine).toBe(true);
    expect(line.beforeCursor).toBe('你好');
    expect(line.cursorChar).toBe('世');
    expect(line.afterCursor).toBe('界');
  });

  it('cursor at end of Chinese line shows phantom space', () => {
    const layout = buildInputAreaLayout({
      value: '你好',
      cursorPos: 2,
      isLLMRunning: false,
      maxLines: 5,
    });

    const line = layout.lines[0]!;
    expect(line.beforeCursor).toBe('你好');
    expect(line.cursorChar).toBe(' '); // phantom cursor at end of line
    expect(line.afterCursor).toBe('');
  });
});

describe('buildInputAreaLayout – surrogate-pair cursor rendering', () => {
  const EMOJI = '😀'; // JS length 2

  it('cursor at emoji start renders full emoji as cursorChar', () => {
    const value = `ab${EMOJI}cd`;
    const layout = buildInputAreaLayout({ value, cursorPos: 2, isLLMRunning: false, maxLines: 5 });
    const line = layout.lines[0]!;
    expect(line.beforeCursor).toBe('ab');
    expect(line.cursorChar).toBe(EMOJI);
    expect(line.afterCursor).toBe('cd');
  });

  it('cursor after emoji correctly splits remaining text', () => {
    const value = `ab${EMOJI}cd`;
    const layout = buildInputAreaLayout({ value, cursorPos: 4, isLLMRunning: false, maxLines: 5 });
    const line = layout.lines[0]!;
    expect(line.beforeCursor).toBe(`ab${EMOJI}`);
    expect(line.cursorChar).toBe('c');
    expect(line.afterCursor).toBe('d');
  });
});
