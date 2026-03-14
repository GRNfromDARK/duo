import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputArea, processInput, getDisplayLines, getCursorLineCol } from '../../ui/components/InputArea.js';
import type { Key } from 'ink';

// Helper: create a Key object with all false defaults
function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

// ── processInput (pure function) tests ──

describe('processInput', () => {
  it('appends regular character input at end', () => {
    const result = processInput('hel', 3, 'l', key(), 5);
    expect(result).toEqual({ type: 'update', value: 'hell', cursorPos: 4 });
  });

  it('inserts character at cursor position in the middle', () => {
    const result = processInput('hllo', 1, 'e', key(), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 2 });
  });

  it('inserts character at the beginning', () => {
    const result = processInput('ello', 0, 'h', key(), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 1 });
  });

  it('appends multi-character input', () => {
    const result = processInput('', 0, 'hello', key(), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 5 });
  });

  it('submits on Enter when value is non-empty', () => {
    const result = processInput('fix the bug', 11, '', key({ return: true }), 5);
    expect(result).toEqual({ type: 'submit', value: 'fix the bug' });
  });

  it('returns noop on Enter when value is empty', () => {
    const result = processInput('', 0, '', key({ return: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('returns noop on Enter when value is whitespace-only', () => {
    const result = processInput('   ', 3, '', key({ return: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('adds newline at cursor on Alt+Enter (meta+return)', () => {
    const result = processInput('line1', 5, '', key({ return: true, meta: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'line1\n', cursorPos: 6 });
  });

  it('adds newline at cursor in the middle of text', () => {
    const result = processInput('line1line2', 5, '', key({ return: true, meta: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'line1\nline2', cursorPos: 6 });
  });

  it('does not add newline when at maxLines', () => {
    const fiveLines = 'a\nb\nc\nd\ne'; // 5 lines
    const result = processInput(fiveLines, 9, '', key({ return: true, meta: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('handles backspace at end', () => {
    const result = processInput('hello', 5, '', key({ backspace: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hell', cursorPos: 4 });
  });

  it('handles backspace in the middle', () => {
    const result = processInput('hello', 3, '', key({ backspace: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'helo', cursorPos: 2 });
  });

  it('handles backspace at beginning (no-op but returns update)', () => {
    const result = processInput('hello', 0, '', key({ backspace: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 0 });
  });

  it('handles backspace on empty string', () => {
    const result = processInput('', 0, '', key({ backspace: true }), 5);
    expect(result).toEqual({ type: 'update', value: '', cursorPos: 0 });
  });

  it('handles delete key at cursor', () => {
    const result = processInput('hello', 5, '', key({ delete: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hell', cursorPos: 4 });
  });

  // ── Cursor movement ──

  it('left arrow moves cursor left', () => {
    const result = processInput('hello', 3, '', key({ leftArrow: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 2 });
  });

  it('left arrow at beginning stays at 0', () => {
    const result = processInput('hello', 0, '', key({ leftArrow: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 0 });
  });

  it('right arrow moves cursor right', () => {
    const result = processInput('hello', 3, '', key({ rightArrow: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 4 });
  });

  it('right arrow at end stays at end', () => {
    const result = processInput('hello', 5, '', key({ rightArrow: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 5 });
  });

  it('Home key moves to start of current line', () => {
    const result = processInput('abc\ndef', 6, '', key({ home: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'abc\ndef', cursorPos: 4 });
  });

  it('End key moves to end of current line', () => {
    const result = processInput('abc\ndef', 4, '', key({ end: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'abc\ndef', cursorPos: 7 });
  });

  it('Ctrl+A moves to start of current line', () => {
    const result = processInput('abc\ndef', 6, 'a', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'abc\ndef', cursorPos: 4 });
  });

  it('Ctrl+E moves to end of current line', () => {
    const result = processInput('abc\ndef', 4, 'e', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'abc\ndef', cursorPos: 7 });
  });

  it('Ctrl+A on first line moves to position 0', () => {
    const result = processInput('hello', 3, 'a', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 0 });
  });

  it('Ctrl+E on single line moves to end', () => {
    const result = processInput('hello', 2, 'e', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 5 });
  });

  // ── Ctrl+K (kill to end of line) ──

  it('Ctrl+K deletes from cursor to end of line', () => {
    const result = processInput('hello world', 5, 'k', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'hello', cursorPos: 5 });
  });

  it('Ctrl+K at end of line deletes newline', () => {
    const result = processInput('abc\ndef', 3, 'k', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'update', value: 'abcdef', cursorPos: 3 });
  });

  // ── Special keys ──

  it('? on empty input triggers special', () => {
    const result = processInput('', 0, '?', key(), 5);
    expect(result).toEqual({ type: 'special', key: '?' });
  });

  it('/ on empty input triggers special', () => {
    const result = processInput('', 0, '/', key(), 5);
    expect(result).toEqual({ type: 'special', key: '/' });
  });

  it('? with non-empty input inserts character', () => {
    const result = processInput('hi', 2, '?', key(), 5);
    expect(result).toEqual({ type: 'update', value: 'hi?', cursorPos: 3 });
  });

  it('ignores tab and escape', () => {
    expect(processInput('x', 1, '', key({ tab: true }), 5)).toEqual({ type: 'noop' });
    expect(processInput('x', 1, '', key({ escape: true }), 5)).toEqual({ type: 'noop' });
  });

  it('ignores page up/down', () => {
    expect(processInput('x', 1, '', key({ pageUp: true }), 5)).toEqual({ type: 'noop' });
    expect(processInput('x', 1, '', key({ pageDown: true }), 5)).toEqual({ type: 'noop' });
  });

  it('ignores up/down arrows', () => {
    expect(processInput('x', 1, '', key({ upArrow: true }), 5)).toEqual({ type: 'noop' });
    expect(processInput('x', 1, '', key({ downArrow: true }), 5)).toEqual({ type: 'noop' });
  });

  it('returns noop for empty input with no special keys', () => {
    const result = processInput('hello', 5, '', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('submits multiline text on Enter', () => {
    const result = processInput('line1\nline2', 11, '', key({ return: true }), 5);
    expect(result).toEqual({ type: 'submit', value: 'line1\nline2' });
  });

  it('ignores unhandled ctrl combinations', () => {
    const result = processInput('hello', 3, 'x', key({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  // ── Mouse escape sequence filtering ──

  it('filters SGR mouse wheel-up escape sequence', () => {
    const result = processInput('', 0, '\x1b[<64;10;5M', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('filters SGR mouse wheel-down escape sequence', () => {
    const result = processInput('', 0, '\x1b[<65;10;5M', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('filters SGR mouse click sequence', () => {
    const result = processInput('', 0, '\x1b[<0;10;5M', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('filters SGR mouse release sequence (lowercase m)', () => {
    const result = processInput('', 0, '\x1b[<0;10;5m', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('filters SGR sequence without ESC prefix (Ink may strip it)', () => {
    const result = processInput('', 0, '[<64;10;5M', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('does not filter normal text that happens to contain M', () => {
    const result = processInput('', 0, 'M', key(), 5);
    expect(result).toEqual({ type: 'update', value: 'M', cursorPos: 1 });
  });

  it('does not insert mouse sequences into existing text', () => {
    const result = processInput('hello', 5, '\x1b[<65;20;10M', key(), 5);
    expect(result).toEqual({ type: 'noop' });
  });
});

// ── getCursorLineCol tests ──

describe('getCursorLineCol', () => {
  it('returns line 0, col at cursor for single line', () => {
    expect(getCursorLineCol('hello', 3)).toEqual({ line: 0, col: 3 });
  });

  it('returns correct line and col for multiline', () => {
    expect(getCursorLineCol('abc\ndef', 5)).toEqual({ line: 1, col: 1 });
  });

  it('cursor at newline boundary', () => {
    expect(getCursorLineCol('abc\ndef', 4)).toEqual({ line: 1, col: 0 });
  });

  it('cursor at start', () => {
    expect(getCursorLineCol('hello', 0)).toEqual({ line: 0, col: 0 });
  });

  it('cursor at end of multiline', () => {
    expect(getCursorLineCol('abc\ndef', 7)).toEqual({ line: 1, col: 3 });
  });
});

// ── getDisplayLines tests ──

describe('getDisplayLines', () => {
  it('returns single line for simple text', () => {
    expect(getDisplayLines('hello', 5)).toEqual(['hello']);
  });

  it('splits multiline text', () => {
    expect(getDisplayLines('a\nb\nc', 5)).toEqual(['a', 'b', 'c']);
  });

  // AC-4: input height auto-adapts (max 5 lines)
  it('caps at maxLines', () => {
    const text = 'a\nb\nc\nd\ne\nf\ng';
    const result = getDisplayLines(text, 5);
    expect(result).toHaveLength(5);
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns empty first line for empty string', () => {
    expect(getDisplayLines('', 5)).toEqual(['']);
  });

  it('handles trailing newline', () => {
    expect(getDisplayLines('a\n', 5)).toEqual(['a', '']);
  });
});

// ── Component rendering tests ──

describe('InputArea', () => {
  // AC-1: input area always visible
  it('renders placeholder when LLM is running', () => {
    const { lastFrame } = render(
      <InputArea isLLMRunning={true} onSubmit={vi.fn()} />
    );
    const output = lastFrame()!;
    expect(output).toContain('Type to interrupt, or wait for completion...');
    expect(output).toContain('◆');
  });

  it('renders cursor when not running LLM (waiting for input)', () => {
    const { lastFrame } = render(
      <InputArea isLLMRunning={false} onSubmit={vi.fn()} />
    );
    const output = lastFrame()!;
    expect(output).toContain('▸');
    expect(output).not.toContain('Type to interrupt');
  });

  it('renders without crashing with maxLines prop', () => {
    const { lastFrame } = render(
      <InputArea isLLMRunning={false} onSubmit={vi.fn()} maxLines={3} />
    );
    expect(lastFrame()).toBeDefined();
  });

  it('defaults maxLines to 5', () => {
    const { lastFrame } = render(
      <InputArea isLLMRunning={false} onSubmit={vi.fn()} />
    );
    expect(lastFrame()).toBeDefined();
  });

  // Verify stdin interaction doesn't crash (integration smoke tests)
  it('handles stdin input without crashing', () => {
    const { lastFrame, stdin } = render(
      <InputArea isLLMRunning={false} onSubmit={vi.fn()} />
    );
    stdin.write('a');
    stdin.write('\r');
    expect(lastFrame()).toBeDefined();
  });

  it('handles Alt+Enter sequence without crashing', () => {
    const { lastFrame, stdin } = render(
      <InputArea isLLMRunning={false} onSubmit={vi.fn()} />
    );
    stdin.write('x');
    stdin.write('\x1B\r');
    stdin.write('y');
    expect(lastFrame()).toBeDefined();
  });

  it('calls onValueChange when input changes', async () => {
    const onValueChange = vi.fn();
    const { stdin } = render(
      <InputArea isLLMRunning={false} onSubmit={vi.fn()} onValueChange={onValueChange} />
    );
    stdin.write('a');
    // useEffect fires asynchronously; wait for next tick
    await new Promise((r) => setTimeout(r, 50));
    expect(onValueChange).toHaveBeenCalledWith('a');
  });
});
