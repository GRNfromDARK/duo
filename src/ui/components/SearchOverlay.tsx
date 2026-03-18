/**
 * Search overlay — search message history.
 * Source: FR-022 (AC-072)
 */
import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import type { Message } from '../../types/ui.js';
import { ROLE_STYLES } from '../../types/ui.js';

export interface SearchOverlayProps {
  columns: number;
  rows: number;
  query: string;
  results: Message[];
}

export function SearchOverlay({
  columns,
  rows,
  query,
  results,
}: SearchOverlayProps): React.ReactElement {
  const maxResults = rows - 7; // title + search bar + footer + borders

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
        <Text bold color="cyan"> Search Messages </Text>
      </Box>

      {/* Search input display */}
      <Box marginTop={1}>
        <Text bold color="yellow">/ </Text>
        {query ? (
          <Text>{query}<Text dimColor>█</Text></Text>
        ) : (
          <Text dimColor>Type to search...</Text>
        )}
      </Box>

      {/* Results */}
      <Box flexDirection="column" height={maxResults} overflow="hidden" marginTop={1}>
        {query === '' ? (
          <Text dimColor>Enter a search term</Text>
        ) : results.length === 0 ? (
          <Text dimColor>No results found</Text>
        ) : (
          results.slice(0, maxResults).map((msg) => {
            const style = ROLE_STYLES[msg.role];
            const preview = msg.content.length > columns - 20
              ? msg.content.slice(0, columns - 23) + '...'
              : msg.content;
            return (
              <Box key={msg.id}>
                <Box width={10}>
                  <Text color={style.color} bold>{style.displayName}</Text>
                </Box>
                <Text>{preview}</Text>
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
