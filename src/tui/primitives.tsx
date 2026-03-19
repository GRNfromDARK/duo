import React from 'react';
import { createTextAttributes, decodePasteBytes, stripAnsiSequences, type ParsedKey } from '@opentui/core';
import type { PasteEvent } from '@opentui/core';
import { useAppContext, useKeyboard, useRenderer as _useRenderer } from '@opentui/react';

export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  super: boolean;
  hyper: boolean;
  capsLock: boolean;
  numLock: boolean;
}

export interface BoxProps extends Record<string, unknown> {
  children?: React.ReactNode;
}

export interface TextProps extends Record<string, unknown> {
  children?: React.ReactNode;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

const InTextContext = React.createContext(false);

function toRuntimeKey(event: Partial<ParsedKey>): Key {
  const name = event.name ?? '';

  return {
    upArrow: name === 'up',
    downArrow: name === 'down',
    leftArrow: name === 'left',
    rightArrow: name === 'right',
    pageDown: name === 'pagedown',
    pageUp: name === 'pageup',
    home: name === 'home',
    end: name === 'end',
    return: name === 'return' || name === 'enter',
    escape: name === 'escape',
    ctrl: Boolean(event.ctrl),
    shift: Boolean(event.shift),
    tab: name === 'tab',
    backspace: name === 'backspace',
    delete: name === 'delete',
    meta: Boolean(event.meta ?? event.option),
    super: Boolean(event.super),
    hyper: Boolean(event.hyper),
    capsLock: Boolean(event.capsLock),
    numLock: Boolean(event.numLock),
  };
}

function toRuntimeInput(event: Partial<ParsedKey>): string {
  if (typeof event.name === 'string' && event.name.length === 1) {
    return event.name;
  }

  if (event.name === 'space') {
    return ' ';
  }

  // Support multi-character sequences (e.g. rapid typing or non-bracketed paste fallback)
  if (typeof event.sequence === 'string' && event.sequence.length > 1 && !event.ctrl && !event.meta) {
    // Only forward printable multi-char sequences (no escape sequences)
    if (!/[\x00-\x1f]/.test(event.sequence)) {
      return event.sequence;
    }
  }

  return '';
}

export function useInput(handler: (input: string, key: Key) => void): void {
  useKeyboard((event) => {
    handler(toRuntimeInput(event), toRuntimeKey(event));
  });
}

/**
 * Subscribe to terminal paste events (bracketed paste mode).
 * The handler receives the decoded, ANSI-stripped paste text.
 */
export function usePaste(handler: (text: string) => void): void {
  const { keyHandler } = useAppContext();
  const handlerRef = React.useRef(handler);
  React.useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  const stableHandler = React.useCallback((event: PasteEvent) => {
    const raw = decodePasteBytes(event.bytes);
    // Bun.stripANSI removes ANSI escape sequences but leaves \r intact.
    // Normalise \r\n → \n and bare \r → \n so that Windows-style line endings
    // in pasted text cannot corrupt cursor-position calculations downstream.
    const cleaned = stripAnsiSequences(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (cleaned.length > 0) {
      handlerRef.current(cleaned);
    }
  }, []);
  React.useEffect(() => {
    keyHandler?.on('paste', stableHandler);
    return () => {
      keyHandler?.off('paste', stableHandler);
    };
  }, [keyHandler, stableHandler]);
}

/**
 * Access the underlying CliRenderer instance.
 * Useful for checking selection state and writing to the clipboard via OSC52.
 */
export function useRenderer() {
  return _useRenderer();
}

export function useApp(): { exit: () => void } {
  const { renderer } = useAppContext();

  return {
    exit: () => renderer?.destroy(),
  };
}

export function useStdout(): { stdout: NodeJS.WriteStream } {
  return {
    stdout: process.stdout,
  };
}

export function Box({ children, ...props }: BoxProps): React.ReactElement {
  return React.createElement('box', props, children);
}

export const ScrollBox = React.forwardRef<unknown, BoxProps>(function ScrollBox(
  { children, ...props },
  ref,
) {
  return React.createElement('scrollbox', { ...props, ref }, children);
});

export function Text({
  children,
  color,
  backgroundColor,
  bold,
  dimColor,
  italic,
  underline,
  inverse,
  ...props
}: TextProps): React.ReactElement {
  const insideText = React.useContext(InTextContext);
  const attributes = createTextAttributes({
    bold,
    dim: dimColor,
    italic,
    underline,
    inverse,
  });

  const nodeType = insideText ? 'span' : 'text';
  const normalizedChildren = React.Children.map(children, (child) => {
    if (typeof child === 'number' || typeof child === 'bigint') {
      return String(child);
    }

    return child;
  });

  return React.createElement(
    InTextContext.Provider,
    { value: true },
    React.createElement(
      nodeType,
      {
        ...props,
        fg: color ?? props.fg,
        bg: backgroundColor ?? props.bg,
        attributes: attributes || props.attributes,
      },
      normalizedChildren,
    ),
  );
}
