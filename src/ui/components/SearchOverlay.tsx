/**
 * Search overlay — search message history.
 * Source: FR-022 (AC-072)
 */
import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import type { Message } from '../../types/ui.js';
import { ROLE_STYLES } from '../../types/ui.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, Panel, PromptRow, Row, SectionTitle } from '../tui-layout.js';

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
  const panelWidth = computeOverlaySurfaceWidth(columns);
  const maxResults = rows - 7; // title + search bar + footer + borders

  return (
    <CenteredContent width={panelWidth} height={rows} justifyContent="center">
      <Panel tone="overlay" width={panelWidth} paddingX={2}>
        <Row justifyContent="center">
          <SectionTitle title="Search Messages" tone="hero" />
        </Row>

        <Row marginTop={1}>
          <PromptRow
            prompt="/"
            promptColor="yellow"
            value={query}
            placeholder="Type to search..."
            leadingSpace={false}
          />
        </Row>

        <Column height={maxResults} overflow="hidden" marginTop={1}>
          {query === '' ? (
            <Text dimColor>Enter a search term</Text>
          ) : results.length === 0 ? (
            <Text dimColor>No results found</Text>
          ) : (
            results.slice(0, maxResults).map((msg) => {
              const style = ROLE_STYLES[msg.role];
              const preview = msg.content.length > panelWidth - 18
                ? msg.content.slice(0, panelWidth - 21) + '...'
                : msg.content;
              return (
                <Row key={msg.id}>
                  <Box width={10}>
                    <Text color={style.color} bold>{style.displayName}</Text>
                  </Box>
                  <Text>{preview}</Text>
                </Row>
              );
            })
          )}
        </Column>

        <Row justifyContent="center" marginTop={1}>
          <FooterHint text="Press Esc to close" />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
