import React from 'react';
import { createTextAttributes, type ParsedKey } from '@opentui/core';
import { useAppContext, useKeyboard } from '@opentui/react';

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

  return '';
}

export function useInput(handler: (input: string, key: Key) => void): void {
  useKeyboard((event) => {
    handler(toRuntimeInput(event), toRuntimeKey(event));
  });
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
