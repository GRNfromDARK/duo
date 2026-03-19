import React, { useState } from 'react';
import { Text, useInput, useStdout } from '../../tui/primitives.js';
import type { Key } from '../../tui/primitives.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, LabelValueRow, Panel, PromptRow, Row, SectionTitle, SelectionRow } from '../tui-layout.js';

export type CompletionMode = 'menu' | 'continue' | 'new-task';

interface CompletionOption {
  key: '1' | '2' | '3';
  label: string;
  description: string;
}

const OPTIONS: CompletionOption[] = [
  {
    key: '1',
    label: 'Continue current task',
    description: 'Add a follow-up requirement and start another Duo run in this task context.',
  },
  {
    key: '2',
    label: 'Create new task',
    description: 'Start a fresh Duo task with the same project and agent setup.',
  },
  {
    key: '3',
    label: 'Exit Duo',
    description: 'Leave the Duo system now.',
  },
];

export interface CompletionScreenState {
  mode: CompletionMode;
  selected: number;
  value: string;
}

export type CompletionInputAction =
  | { type: 'set_mode'; mode: CompletionMode }
  | { type: 'set_selected'; selected: number }
  | { type: 'set_value'; value: string }
  | { type: 'submit_continue'; value: string }
  | { type: 'submit_new_task'; value: string }
  | { type: 'exit' }
  | { type: 'noop' };

export function processCompletionInput(
  state: CompletionScreenState,
  input: string,
  key: Key,
): CompletionInputAction {
  if (state.mode === 'menu') {
    if (input === '1') return { type: 'set_mode', mode: 'continue' };
    if (input === '2') return { type: 'set_mode', mode: 'new-task' };
    if (input === '3') return { type: 'exit' };
    if (key.upArrow) {
      return { type: 'set_selected', selected: Math.max(0, state.selected - 1) };
    }
    if (key.downArrow) {
      return { type: 'set_selected', selected: Math.min(OPTIONS.length - 1, state.selected + 1) };
    }
    if (key.return) {
      if (state.selected === 0) return { type: 'set_mode', mode: 'continue' };
      if (state.selected === 1) return { type: 'set_mode', mode: 'new-task' };
      return { type: 'exit' };
    }
    return { type: 'noop' };
  }

  if (key.escape) {
    return { type: 'set_mode', mode: 'menu' };
  }

  if (key.return) {
    const trimmed = state.value.trim();
    if (!trimmed) return { type: 'noop' };
    return state.mode === 'continue'
      ? { type: 'submit_continue', value: trimmed }
      : { type: 'submit_new_task', value: trimmed };
  }

  if (key.backspace || key.delete) {
    return { type: 'set_value', value: state.value.slice(0, -1) };
  }

  if (input && !key.ctrl && !key.meta) {
    return { type: 'set_value', value: state.value + input };
  }

  return { type: 'noop' };
}

export interface CompletionScreenProps {
  currentTask: string;
  onContinueCurrentTask: (followUp: string) => void;
  onCreateNewTask: (task: string) => void;
  onExit: () => void;
  variant?: 'fullscreen' | 'inline';
}

export function CompletionScreen({
  currentTask,
  onContinueCurrentTask,
  onCreateNewTask,
  onExit,
  variant = 'fullscreen',
}: CompletionScreenProps): React.ReactElement {
  const { stdout } = useStdout();
  const fullscreenWidth = computeOverlaySurfaceWidth(stdout.columns || 80);
  const [mode, setMode] = useState<CompletionMode>('menu');
  const [selected, setSelected] = useState(0);
  const [value, setValue] = useState('');

  useInput((input, key) => {
    const action = processCompletionInput({ mode, selected, value }, input, key);

    switch (action.type) {
      case 'set_mode':
        setMode(action.mode);
        if (action.mode === 'menu') {
          setValue('');
        }
        return;
      case 'set_selected':
        setSelected(action.selected);
        return;
      case 'set_value':
        setValue(action.value);
        return;
      case 'submit_continue':
        onContinueCurrentTask(action.value);
        return;
      case 'submit_new_task':
        onCreateNewTask(action.value);
        return;
      case 'exit':
        onExit();
        return;
      case 'noop':
        return;
    }
  });

  if (mode === 'continue' || mode === 'new-task') {
    const title = mode === 'continue'
      ? 'Continue Current Task'
      : 'Create New Task';
    const prompt = mode === 'continue'
      ? 'Enter the follow-up requirement for the current task:'
      : 'Enter the new task description:';

    if (variant === 'inline') {
      return (
        <Column>
          <SectionTitle title={title} tone="hero" />
          <FooterHint text={prompt} />
          {mode === 'continue' && (
            <LabelValueRow label="Current" value={currentTask} labelWidth={8} />
          )}
          <Row marginTop={1}>
            <PromptRow value={value} placeholder="Type the next instruction" leadingSpace={false} />
          </Row>
          <FooterHint text="Enter confirms · Esc goes back" />
        </Column>
      );
    }

    return (
      <CenteredContent width={fullscreenWidth} height="100%" justifyContent="center">
        <Panel tone="section" width={fullscreenWidth} paddingX={2}>
          <SectionTitle title={title} tone="hero" />
          <FooterHint text={prompt} />
          {mode === 'continue' && (
            <Column marginTop={1}>
              <LabelValueRow label="Current" value={currentTask} labelWidth={8} />
            </Column>
          )}
          <Row marginTop={1}>
            <PromptRow value={value} placeholder="Type the next instruction" leadingSpace={false} />
          </Row>
          <Row marginTop={1}>
            <FooterHint text="Enter confirms · Esc goes back" />
          </Row>
        </Panel>
      </CenteredContent>
    );
  }

  if (variant === 'inline') {
    return (
      <Column>
        <SectionTitle title="Task completed" tone="hero" />
        <FooterHint text="Choose what Duo should do next." />
        {OPTIONS.map((option, index) => {
          return (
            <SelectionRow
              key={option.key}
              label={`${option.key}. ${option.label}`}
              selected={index === selected}
            />
          );
        })}
      </Column>
    );
  }

  return (
    <CenteredContent width={fullscreenWidth} height="100%" justifyContent="center">
      <Panel tone="section" width={fullscreenWidth} paddingX={2}>
        <SectionTitle title="Task completed" tone="hero" />
        <FooterHint text="Choose what Duo should do next." />
        <Column marginTop={1}>
          {OPTIONS.map((option, index) => {
            return (
              <Column key={option.key} marginBottom={1}>
                <SelectionRow
                  label={`${option.key}. ${option.label}`}
                  selected={index === selected}
                />
                <Row marginLeft={4}>
                  <Text dimColor>{option.description}</Text>
                </Row>
              </Column>
            );
          })}
        </Column>
        <Column>
          <LabelValueRow label="Current" value={currentTask} labelWidth={8} />
        </Column>
        <Row marginTop={1}>
          <FooterHint text="Use 1/2/3, arrow keys, or Enter." />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
