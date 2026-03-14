import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';

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
        <Box flexDirection="column">
          <Text color="green" bold>{title}</Text>
          <Text dimColor>{prompt}</Text>
          {mode === 'continue' && (
            <Text dimColor>Current task: {currentTask}</Text>
          )}
          <Box>
            <Text color="cyan" bold>{'▸ '}</Text>
            <Text color="white">{value}</Text>
            <Text dimColor>█</Text>
          </Box>
          <Text dimColor>Enter confirm, Esc back.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="green" bold>{title}</Text>
        <Box marginTop={1}>
          <Text dimColor>{prompt}</Text>
        </Box>
        {mode === 'continue' && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Current task:</Text>
            <Text color="white">{currentTask}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color="cyan" bold>{'▸ '}</Text>
          <Text color="white">{value}</Text>
          <Text dimColor>█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to confirm, Esc to return.</Text>
        </Box>
      </Box>
    );
  }

  if (variant === 'inline') {
    return (
      <Box flexDirection="column">
        <Text color="green" bold>Task completed</Text>
        <Text dimColor>Choose what Duo should do next.</Text>
        {OPTIONS.map((option, index) => {
          const active = index === selected;
          return (
            <Text key={option.key} color={active ? 'cyan' : 'gray'} bold={active}>
              {active ? '▸ ' : '  '}
              {option.key}. {option.label}
            </Text>
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="green" bold>Task completed</Text>
      <Box marginTop={1}>
        <Text dimColor>Choose what Duo should do next.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((option, index) => {
          const active = index === selected;
          return (
            <Box key={option.key} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={active ? 'cyan' : 'gray'} bold={active}>
                  {active ? '▸ ' : '  '}
                  {option.key}. {option.label}
                </Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>{option.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column">
        <Text dimColor>Current task:</Text>
        <Text color="white">{currentTask}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use 1/2/3, arrow keys, or Enter.</Text>
      </Box>
    </Box>
  );
}
