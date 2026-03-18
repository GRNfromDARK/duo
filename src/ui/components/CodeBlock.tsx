/**
 * CodeBlock — collapsible code block component for TUI.
 * Source: FR-015 (AC-052, AC-053, AC-054)
 *
 * - >10 lines: auto-fold, show first 5 lines + expand button
 * - Enter key toggles expand/collapse (via onToggle callback)
 * - Controlled expanded prop for parent state management
 */

import React from 'react';
import { Box, Text } from '../../tui/primitives.js';

const FOLD_THRESHOLD = 10;
const PREVIEW_LINES = 5;

export interface CodeBlockProps {
  content: string;
  language?: string;
  /** Controlled expand state. When undefined, auto-decides based on line count. */
  expanded?: boolean;
  /** Called when user wants to toggle expand/collapse. */
  onToggle?: () => void;
}

export function CodeBlock({
  content,
  language,
  expanded,
  onToggle,
}: CodeBlockProps): React.ReactElement {
  const lines = content.length === 0 ? [] : content.split('\n');
  const lineCount = lines.length;
  const shouldFold = lineCount > FOLD_THRESHOLD;

  // Determine if currently expanded
  const isExpanded = shouldFold ? (expanded ?? false) : true;
  const displayLines = isExpanded ? lines : lines.slice(0, PREVIEW_LINES);

  return (
    <Box flexDirection="column" marginY={0}>
      {language && (
        <Text dimColor> {language}</Text>
      )}
      <Box flexDirection="column">
        {displayLines.map((line, i) => (
          <Text key={i} backgroundColor="gray" color="white"> {line} </Text>
        ))}
      </Box>
      {shouldFold && !isExpanded && (
        <Text color="cyan"> [▶ Expand · {lineCount} lines]</Text>
      )}
      {shouldFold && isExpanded && (
        <Text color="cyan"> [▼ Collapse · {lineCount} lines]</Text>
      )}
    </Box>
  );
}
