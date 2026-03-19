/**
 * Help overlay — displays keybinding list.
 * Source: FR-022 (AC-073)
 */
import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import { KEYBINDING_LIST } from '../keybindings.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, Panel, Row, SectionTitle } from '../tui-layout.js';

export interface HelpOverlayProps {
  columns: number;
  rows: number;
}

export function HelpOverlay({ columns, rows }: HelpOverlayProps): React.ReactElement {
  const panelWidth = computeOverlaySurfaceWidth(columns);
  const maxVisible = rows - 6; // title + border + footer

  return (
    <CenteredContent width={panelWidth} height={rows} justifyContent="center">
      <Panel tone="overlay" width={panelWidth} paddingX={2}>
        <Row justifyContent="center">
          <SectionTitle title="Keybindings" tone="hero" />
        </Row>

        <Column height={maxVisible} overflow="hidden">
          {KEYBINDING_LIST.slice(0, maxVisible).map((entry) => (
            <Row key={entry.shortcut}>
              <Box width={18}>
                <Text bold color="yellow">{entry.shortcut}</Text>
              </Box>
              <Text>{entry.description}</Text>
            </Row>
          ))}
        </Column>

        <Row justifyContent="center" marginTop={1}>
          <FooterHint text="Press Esc to close" />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
