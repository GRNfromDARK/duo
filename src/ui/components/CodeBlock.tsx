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
import { buildCodeBlockLayout } from '../code-block-layout.js';

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
  const layout = buildCodeBlockLayout({ content, language, expanded });

  return (
    <Box flexDirection="column" marginBottom={1}>
      {layout.languageLabel && (
        <Text dimColor>╭─ {layout.languageLabel}</Text>
      )}
      <Box flexDirection="column" marginLeft={1}>
        {layout.displayLines.map((line, i) => (
          <Text key={i} color="cyan">{line}</Text>
        ))}
      </Box>
      {layout.shouldFold && !layout.isExpanded && (
        <Text color="cyan">╰─ [▶ Expand · {layout.lineCount} lines]</Text>
      )}
      {layout.shouldFold && layout.isExpanded && (
        <Text color="cyan">╰─ [▼ Collapse · {layout.lineCount} lines]</Text>
      )}
    </Box>
  );
}
