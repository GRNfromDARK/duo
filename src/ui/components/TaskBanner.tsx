/**
 * TaskBanner — Persistent task goal display below the status bar.
 * Shows the user's original task/request so it's always visible during execution.
 */

import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import { buildTaskBannerLayout } from '../task-banner-layout.js';

export interface TaskBannerProps {
  taskSummary: string;
  columns: number;
}

export function TaskBanner({ taskSummary, columns }: TaskBannerProps): React.ReactElement {
  const layout = buildTaskBannerLayout({ taskSummary, columns });

  return (
    <Box height={1} width={columns}>
      <Text color="cyan" bold>▸</Text>
      <Text dimColor>{' Task '}</Text>
      <Text dimColor>{'· '}</Text>
      <Text color="white">{layout.displayText}</Text>
    </Box>
  );
}
