/**
 * Help overlay — displays keybinding list.
 * Source: FR-022 (AC-073)
 */
import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import { KEYBINDING_LIST } from '../keybindings.js';

export interface HelpOverlayProps {
  columns: number;
  rows: number;
}

export function HelpOverlay({ columns, rows }: HelpOverlayProps): React.ReactElement {
  const maxVisible = rows - 6; // title + border + footer

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box justifyContent="center">
        <Text bold color="cyan"> Keybindings </Text>
      </Box>

      <Box flexDirection="column" height={maxVisible} overflow="hidden">
        {KEYBINDING_LIST.slice(0, maxVisible).map((entry) => (
          <Box key={entry.shortcut}>
            <Box width={18}>
              <Text bold color="yellow">{entry.shortcut}</Text>
            </Box>
            <Text>{entry.description}</Text>
          </Box>
        ))}
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    </Box>
  );
}
