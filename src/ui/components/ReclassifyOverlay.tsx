/**
 * ReclassifyOverlay — Ink component for runtime task reclassification.
 * Card C.3: FR-002a (AC-010, AC-011, AC-012)
 *
 * Full-screen overlay: user selects a new task type via arrow keys / number keys.
 * Uses pure state functions from reclassify-overlay.ts.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TaskType } from '../task-analysis-card.js';
import {
  createReclassifyState,
  handleReclassifyKey,
  type ReclassifyOverlayState,
} from '../reclassify-overlay.js';

export interface ReclassifyOverlayProps {
  currentType: string;
  onSelect: (newType: string) => void;
  onCancel: () => void;
}

/** Human-readable descriptions for each task type */
const RECLASSIFY_LABELS: Record<string, string> = {
  explore: 'Explore first, then code',
  code: 'Direct coding implementation',
  review: 'Code review only',
  debug: 'Focused debugging',
};

export function ReclassifyOverlay({
  currentType,
  onSelect,
  onCancel,
}: ReclassifyOverlayProps): React.ReactElement {
  const [state, setState] = useState<ReclassifyOverlayState>(() =>
    createReclassifyState(currentType as TaskType),
  );

  useInput((input, key) => {
    if (state.visible === false) return;

    let keyStr: string;
    if (key.downArrow) keyStr = 'arrow_down';
    else if (key.upArrow) keyStr = 'arrow_up';
    else if (key.return) keyStr = 'enter';
    else if (key.escape) keyStr = 'escape';
    else keyStr = input;

    const { state: next, action } = handleReclassifyKey(state, keyStr);
    setState(next);

    if (action === 'confirm') {
      onSelect(next.selectedType);
    } else if (action === 'cancel') {
      onCancel();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      {/* Header */}
      <Box justifyContent="center">
        <Text color="cyan" bold>{'◈ '}</Text>
        <Text color="cyan" bold>Reclassify Task</Text>
      </Box>

      {/* Current info */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>{'Current type   '}</Text>
          <Text bold>[{currentType}]</Text>
          <Text dimColor>{'  '}{RECLASSIFY_LABELS[currentType] ?? ''}</Text>
        </Box>
      </Box>

      {/* Type selection list */}
      <Box flexDirection="column" marginTop={1}>
        {state.availableTypes.map((type, i) => {
          const isSelected = state.selectedType === type;
          const isCurrent = type === currentType;
          return (
            <Box key={type}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '❯ ' : '  '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                [{i + 1}] {type.padEnd(10)}
              </Text>
              <Text dimColor>{RECLASSIFY_LABELS[type] ?? ''}</Text>
              {isCurrent && <Text color="yellow">{' ← current'}</Text>}
            </Box>
          );
        })}
      </Box>

      {/* Keyboard hints */}
      <Box marginTop={1}>
        <Text dimColor>[↑↓] select   [Enter] confirm   [Esc] cancel</Text>
      </Box>
    </Box>
  );
}
