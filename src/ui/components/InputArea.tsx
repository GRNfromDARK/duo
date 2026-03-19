import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from '../../tui/primitives.js';
import type { Key } from '../../tui/primitives.js';
import { buildInputAreaLayout } from '../input-area-layout.js';

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

  // Backspace -> delete char before cursor
  if (key.backspace || key.delete) {
    if (cursorPos > 0) {
      const newValue = currentValue.slice(0, cursorPos - 1) + currentValue.slice(cursorPos);
      return { type: 'update', value: newValue, cursorPos: cursorPos - 1 };
    }
    return { type: 'update', value: currentValue, cursorPos };
  }

  // Left arrow -> move cursor left
  if (key.leftArrow) {
    return { type: 'update', value: currentValue, cursorPos: Math.max(0, cursorPos - 1) };
  }

  // Right arrow -> move cursor right
  if (key.rightArrow) {
    return { type: 'update', value: currentValue, cursorPos: Math.min(currentValue.length, cursorPos + 1) };
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

  return (
    <Box flexDirection="column" height={layout.height}>
      {layout.showPlaceholder ? (
        <Box>
          <Text color={layout.promptColor} bold>{layout.promptIcon} </Text>
          <Text dimColor>{layout.placeholderText}</Text>
        </Box>
      ) : (
        layout.lines.map((line, lineIdx) => (
          <Box key={lineIdx}>
            <Text color={layout.promptColor} bold>{line.prefix}</Text>
            {line.isCursorLine ? (
              <Text color="white">
                {line.beforeCursor}
                <Text inverse>{line.cursorChar}</Text>
                {line.afterCursor}
              </Text>
            ) : (
              <Text color="white">{line.beforeCursor}</Text>
            )}
          </Box>
        ))
      )}
    </Box>
  );
}
