/**
 * Context summary overlay — shows current session context.
 * Source: FR-022 (AC-072)
 */
import React from 'react';
import { Box, Text } from 'ink';

export interface ContextOverlayProps {
  columns: number;
  rows: number;
  coderName: string;
  reviewerName: string;
  taskSummary: string;
  tokenEstimate: number;
}

export function ContextOverlay({
  columns,
  rows,
  coderName,
  reviewerName,
  taskSummary,
  tokenEstimate,
}: ContextOverlayProps): React.ReactElement {
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
        <Text bold color="cyan"> Context Summary </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Box width={16}>
            <Text bold>Coder:</Text>
          </Box>
          <Text color="blue">{coderName}</Text>
        </Box>

        <Box>
          <Box width={16}>
            <Text bold>Reviewer:</Text>
          </Box>
          <Text color="green">{reviewerName}</Text>
        </Box>

        <Box>
          <Box width={16}>
            <Text bold>Task:</Text>
          </Box>
          <Text>{taskSummary}</Text>
        </Box>

        <Box>
          <Box width={16}>
            <Text bold>Tokens:</Text>
          </Box>
          <Text>{tokenEstimate}</Text>
        </Box>
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    </Box>
  );
}
