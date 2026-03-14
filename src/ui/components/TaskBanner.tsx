/**
 * TaskBanner — Persistent task goal display below the status bar.
 * Shows the user's original task/request so it's always visible during execution.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { computeStringWidth, getCharWidth } from '../message-lines.js';

export interface TaskBannerProps {
  taskSummary: string;
  columns: number;
}

/**
 * Truncate text to fit within maxWidth terminal columns, adding "…" if truncated.
 * CJK-aware: correctly measures double-width characters.
 */
export function truncateText(text: string, maxWidth: number): string {
  // Normalize: collapse newlines and extra whitespace into single spaces
  const normalized = text.replace(/\s+/g, ' ').trim();
  const totalWidth = computeStringWidth(normalized);
  if (totalWidth <= maxWidth) return normalized;
  if (maxWidth <= 1) return '…';

  // Walk character by character, measuring terminal width
  const chars = [...normalized];
  let currentWidth = 0;
  const ellipsisWidth = 1; // "…" is 1 column wide
  const targetWidth = maxWidth - ellipsisWidth;
  let result = '';

  for (const ch of chars) {
    const w = getCharWidth(ch);
    if (currentWidth + w > targetWidth) break;
    result += ch;
    currentWidth += w;
  }

  return result + '…';
}

export function TaskBanner({ taskSummary, columns }: TaskBannerProps): React.ReactElement {
  const prefixText = '▸ Task: ';
  const prefixWidth = computeStringWidth(prefixText);
  // Available width for the task text (leave 1 char right padding)
  const availableWidth = Math.max(1, columns - prefixWidth - 1);
  const displayText = truncateText(taskSummary, availableWidth);

  return (
    <Box height={1} width={columns}>
      <Text color="cyan" bold>{prefixText}</Text>
      <Text color="white">{displayText}</Text>
    </Box>
  );
}
