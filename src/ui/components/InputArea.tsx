import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput, usePaste } from '../../tui/primitives.js';
import type { Key } from '../../tui/primitives.js';
import { buildInputAreaLayout } from '../input-area-layout.js';
import { FooterHint, Row } from '../tui-layout.js';

export interface InputAreaProps {
  isLLMRunning: boolean;
  onSubmit: (text: string) => void;
  maxLines?: number;
  /** Notification callback: called whenever the internal value changes */
  onValueChange?: (value: string) => void;
  /** Called when ? or / pressed with empty input */
  onSpecialKey?: (key: string) => void;
  /** Disable input handling (e.g. when overlay is open) */
  disabled?: boolean;
}

export interface InputState {
  value: string;
  cursorPos: number;
}

export const INITIAL_INPUT_STATE: InputState = { value: '', cursorPos: 0 };

export type InputAction =
  | { type: 'submit'; value: string }
  | { type: 'update'; value: string; cursorPos: number }
  | { type: 'special'; key: string }
  | { type: 'noop' };

// ---------------------------------------------------------------------------
// Code-point-safe index helpers
//
// JavaScript strings are UTF-16. Characters outside the Basic Multilingual
// Plane (emoji, some rare CJK extension blocks) are encoded as surrogate
// pairs: a high surrogate (0xD800–0xDBFF) followed by a low surrogate
// (0xDC00–0xDFFF).  Using raw ±1 arithmetic when navigating or deleting can
// land the cursor *inside* a pair, causing one half of the character to be
// rendered as replacement glyphs and producing an incorrect column count.
// ---------------------------------------------------------------------------

/**
 * Return the index of the code-point boundary strictly before `pos`.
 * Steps back 2 if the previous two code units form a surrogate pair; 1 otherwise.
 */
export function prevCodePointIndex(str: string, pos: number): number {
  if (pos <= 0) return 0;
  const lo = str.charCodeAt(pos - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && pos >= 2) {
    const hi = str.charCodeAt(pos - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) {
      return pos - 2;
    }
  }
  return pos - 1;
}

/**
 * Return the index of the code-point boundary strictly after `pos`.
 * Steps forward 2 if the code unit at `pos` is a high surrogate; 1 otherwise.
 */
export function nextCodePointIndex(str: string, pos: number): number {
  if (pos >= str.length) return str.length;
  const hi = str.charCodeAt(pos);
  if (hi >= 0xD800 && hi <= 0xDBFF && pos + 1 < str.length) {
    const lo = str.charCodeAt(pos + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) {
      return pos + 2;
    }
  }
  return pos + 1;
}

/**
 * Pure function: given current state, input char and key flags, return the action.
 * Supports cursor movement (left/right, Home/End, Ctrl+A/Ctrl+E) and
 * insertion/deletion at cursor position.
 */
export function processInput(
  currentValue: string,
  cursorPos: number,
  input: string,
  key: Key,
  maxLines: number,
): InputAction {
  // Enter without modifiers -> submit
  if (key.return && !key.meta && !key.ctrl && !key.shift) {
    if (currentValue.trim().length > 0) {
      return { type: 'submit', value: currentValue };
    }
    return { type: 'noop' };
  }

  // Alt+Enter / Ctrl+Enter / Shift+Enter -> newline at cursor
  if (key.return && (key.meta || key.ctrl || key.shift)) {
    const lines = currentValue.split('\n');
    if (lines.length < maxLines) {
      const newValue = currentValue.slice(0, cursorPos) + '\n' + currentValue.slice(cursorPos);
      return { type: 'update', value: newValue, cursorPos: cursorPos + 1 };
    }
    return { type: 'noop' };
  }

  // Ctrl+A -> move to start of line
  if (key.ctrl && input === 'a') {
    const lineStart = currentValue.lastIndexOf('\n', cursorPos - 1) + 1;
    return { type: 'update', value: currentValue, cursorPos: lineStart };
  }

  // Ctrl+E -> move to end of line
  if (key.ctrl && input === 'e') {
    let lineEnd = currentValue.indexOf('\n', cursorPos);
    if (lineEnd === -1) lineEnd = currentValue.length;
    return { type: 'update', value: currentValue, cursorPos: lineEnd };
  }

  // Ctrl+K -> delete from cursor to end of line
  if (key.ctrl && input === 'k') {
    let lineEnd = currentValue.indexOf('\n', cursorPos);
    if (lineEnd === -1) lineEnd = currentValue.length;
    if (cursorPos === lineEnd && cursorPos < currentValue.length) {
      // At end of line, delete the newline character
      const newValue = currentValue.slice(0, cursorPos) + currentValue.slice(cursorPos + 1);
      return { type: 'update', value: newValue, cursorPos };
    }
    const newValue = currentValue.slice(0, cursorPos) + currentValue.slice(lineEnd);
    return { type: 'update', value: newValue, cursorPos };
  }

  // Backspace -> delete the code point immediately before the cursor.
  // Using prevCodePointIndex ensures a full surrogate pair is removed as one
  // unit rather than leaving an orphaned surrogate in the string.
  if (key.backspace || key.delete) {
    if (cursorPos > 0) {
      const deleteFrom = prevCodePointIndex(currentValue, cursorPos);
      const newValue = currentValue.slice(0, deleteFrom) + currentValue.slice(cursorPos);
      return { type: 'update', value: newValue, cursorPos: deleteFrom };
    }
    return { type: 'update', value: currentValue, cursorPos };
  }

  // Left arrow -> move cursor left by one code point (not one code unit).
  if (key.leftArrow) {
    return { type: 'update', value: currentValue, cursorPos: prevCodePointIndex(currentValue, cursorPos) };
  }

  // Right arrow -> move cursor right by one code point (not one code unit).
  if (key.rightArrow) {
    return { type: 'update', value: currentValue, cursorPos: nextCodePointIndex(currentValue, cursorPos) };
  }

  // Home -> start of current line
  if (key.home) {
    const lineStart = currentValue.lastIndexOf('\n', cursorPos - 1) + 1;
    return { type: 'update', value: currentValue, cursorPos: lineStart };
  }

  // End -> end of current line
  if (key.end) {
    let lineEnd = currentValue.indexOf('\n', cursorPos);
    if (lineEnd === -1) lineEnd = currentValue.length;
    return { type: 'update', value: currentValue, cursorPos: lineEnd };
  }

  // ? and / when input is empty -> special key (open overlay)
  if (currentValue === '' && (input === '?' || input === '/')) {
    return { type: 'special', key: input };
  }

  // Ignore remaining control keys
  if (key.upArrow || key.downArrow ||
      key.pageUp || key.pageDown || key.tab || key.escape) {
    return { type: 'noop' };
  }

  // Ignore ctrl combinations not handled above
  if (key.ctrl) {
    return { type: 'noop' };
  }

  // Safety filter: ignore raw mouse escape sequences if a terminal passes them
  // through unexpectedly. Some runtimes strip the ESC (\x1b) prefix from
  // unknown sequences, so match both full and stripped forms.
  if (input && (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input))) {
    return { type: 'noop' };
  }

  // Regular character input -> insert at cursor position
  if (input) {
    const newValue = currentValue.slice(0, cursorPos) + input + currentValue.slice(cursorPos);
    return { type: 'update', value: newValue, cursorPos: cursorPos + input.length };
  }

  return { type: 'noop' };
}

/**
 * Pure function: insert pasted text at cursor position, respecting maxLines.
 */
export function processPaste(
  currentValue: string,
  cursorPos: number,
  pastedText: string,
  maxLines: number,
): InputAction {
  if (!pastedText) return { type: 'noop' };

  const before = currentValue.slice(0, cursorPos);
  const after = currentValue.slice(cursorPos);
  let combined = before + pastedText + after;

  // Enforce maxLines by trimming excess lines from the end
  const lines = combined.split('\n');
  if (lines.length > maxLines) {
    combined = lines.slice(0, maxLines).join('\n');
  }

  const newCursorPos = Math.min(before.length + pastedText.length, combined.length);
  return { type: 'update', value: combined, cursorPos: newCursorPos };
}

export function InputArea({
  isLLMRunning,
  onSubmit,
  maxLines = 5,
  onValueChange,
  onSpecialKey,
  disabled = false,
}: InputAreaProps): React.ReactElement {
  const [state, setState] = useState<InputState>(INITIAL_INPUT_STATE);
  const prevValueRef = useRef(state.value);

  // Notify parent of value changes (notification only, not control)
  useEffect(() => {
    if (state.value !== prevValueRef.current) {
      prevValueRef.current = state.value;
      onValueChange?.(state.value);
    }
  }, [state.value, onValueChange]);
  const layout = buildInputAreaLayout({
    value: state.value,
    cursorPos: state.cursorPos,
    isLLMRunning,
    maxLines,
  });

  useInput((input, key) => {
    if (disabled) return;
    const action = processInput(state.value, state.cursorPos, input, key, maxLines);
    switch (action.type) {
      case 'submit':
        onSubmit(action.value);
        setState(INITIAL_INPUT_STATE);
        break;
      case 'update':
        setState({ value: action.value, cursorPos: action.cursorPos });
        break;
      case 'special':
        onSpecialKey?.(action.key);
        break;
      case 'noop':
        break;
    }
  });

  usePaste((text) => {
    if (disabled) return;
    const action = processPaste(state.value, state.cursorPos, text, maxLines);
    if (action.type === 'update') {
      setState({ value: action.value, cursorPos: action.cursorPos });
    }
  });

  return (
    <Box flexDirection="column" height={layout.height}>
      {layout.showPlaceholder ? (
        <>
          <Row width="100%" justifyContent="space-between">
            <Row>
              <Text color={layout.promptColor} bold>{`${layout.promptIcon} `}</Text>
              <Text inverse>{layout.cursorChar}</Text>
              <Text dimColor>{` ${layout.placeholderText}`}</Text>
            </Row>
            <Text color={layout.statusColor} bold>{layout.statusText}</Text>
          </Row>
          {layout.showHelperRow && <FooterHint text={layout.helperText} />}
        </>
      ) : (
        <>
          {layout.lines.map((line, lineIdx) => {
            const cursorGlyph = line.cursorChar || layout.cursorChar;
            const lineContent = (
              <>
                <Text color={layout.promptColor} bold>{line.prefix}</Text>
                {line.isCursorLine ? (
                  <Text color="white">
                    {line.beforeCursor}
                    <Text inverse>{cursorGlyph}</Text>
                    {line.afterCursor}
                  </Text>
                ) : (
                  <Text color="white">{line.beforeCursor}</Text>
                )}
              </>
            );

            if (lineIdx === 0) {
              return (
                <Row key={lineIdx} width="100%" justifyContent="space-between">
                  <Row>{lineContent}</Row>
                  <Text color={layout.statusColor} bold>{layout.statusText}</Text>
                </Row>
              );
            }

            return <Row key={lineIdx}>{lineContent}</Row>;
          })}
          {layout.showHelperRow && <FooterHint text={layout.helperText} />}
        </>
      )}
    </Box>
  );
}
