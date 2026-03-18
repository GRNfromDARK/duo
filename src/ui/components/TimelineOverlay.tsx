/**
 * Event timeline overlay — shows workflow event history.
 * Source: FR-022 (AC-072)
 */
import React from 'react';
import { Box, Text } from '../../tui/primitives.js';

export interface TimelineEvent {
  timestamp: number;
  type: 'task_start' | 'coding' | 'reviewing' | 'converged' | 'interrupted' | 'error';
  description: string;
}

export interface TimelineOverlayProps {
  columns: number;
  rows: number;
  events: TimelineEvent[];
}

const EVENT_COLORS: Record<TimelineEvent['type'], string> = {
  task_start: 'white',
  coding: 'blue',
  reviewing: 'green',
  converged: 'cyan',
  interrupted: 'yellow',
  error: 'red',
};

export function TimelineOverlay({
  columns,
  rows,
  events,
}: TimelineOverlayProps): React.ReactElement {
  const maxVisible = rows - 6;

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
        <Text bold color="cyan"> Event Timeline </Text>
      </Box>

      <Box flexDirection="column" height={maxVisible} overflow="hidden">
        {events.length === 0 ? (
          <Text dimColor>No events yet</Text>
        ) : (
          events.slice(-maxVisible).map((event, i) => {
            const time = new Date(event.timestamp).toLocaleTimeString();
            const color = EVENT_COLORS[event.type] ?? 'white';
            return (
              <Box key={i}>
                <Box width={12}>
                  <Text dimColor>{time}</Text>
                </Box>
                <Text color={color}>{event.description}</Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    </Box>
  );
}
