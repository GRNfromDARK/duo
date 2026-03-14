import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  CompletionScreen,
  processCompletionInput,
} from '../../ui/components/CompletionScreen.js';
import type { Key } from 'ink';

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

describe('CompletionScreen', () => {
  it('renders the three completion actions', () => {
    const { lastFrame } = render(
      <CompletionScreen
        currentTask="Ship the auth flow"
        onContinueCurrentTask={vi.fn()}
        onCreateNewTask={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const output = lastFrame()!;
    expect(output).toContain('Task completed');
    expect(output).toContain('Continue current task');
    expect(output).toContain('Create new task');
    expect(output).toContain('Exit Duo');
  });

  it('renders an inline variant for the main layout footer', () => {
    const { lastFrame } = render(
      <CompletionScreen
        currentTask="Ship the auth flow"
        onContinueCurrentTask={vi.fn()}
        onCreateNewTask={vi.fn()}
        onExit={vi.fn()}
        variant="inline"
      />,
    );

    const output = lastFrame()!;
    expect(output).toContain('Task completed');
    expect(output).toContain('Choose what Duo should do next');
    expect(output).toContain('1. Continue current task');
  });

  it('switches to follow-up input when the user selects continue', () => {
    expect(
      processCompletionInput(
        { mode: 'menu', selected: 0, value: '' },
        '1',
        key(),
      ),
    ).toEqual({ type: 'set_mode', mode: 'continue' });
  });

  it('submits follow-up text when continue mode receives Enter', () => {
    expect(
      processCompletionInput(
        { mode: 'continue', selected: 0, value: 'add audit logging' },
        '',
        key({ return: true }),
      ),
    ).toEqual({ type: 'submit_continue', value: 'add audit logging' });
  });

  it('submits the new task text when new-task mode receives Enter', () => {
    expect(
      processCompletionInput(
        { mode: 'new-task', selected: 1, value: 'Build CSV export' },
        '',
        key({ return: true }),
      ),
    ).toEqual({ type: 'submit_new_task', value: 'Build CSV export' });
  });

  it('exits immediately when exit is selected by number', () => {
    expect(
      processCompletionInput(
        { mode: 'menu', selected: 0, value: '' },
        '3',
        key(),
      ),
    ).toEqual({ type: 'exit' });
  });
});
