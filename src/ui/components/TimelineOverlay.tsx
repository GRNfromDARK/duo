/**
 * Event timeline overlay — shows workflow event history.
 * Source: FR-022 (AC-072)
 */
import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, Panel, Row, SectionTitle } from '../tui-layout.js';

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
  const panelWidth = computeOverlaySurfaceWidth(columns);
  const maxVisible = rows - 6;

  return (
    <CenteredContent width={panelWidth} height={rows} justifyContent="center">
      <Panel tone="overlay" width={panelWidth} paddingX={2}>
        <Row justifyContent="center">
          <SectionTitle title="Event Timeline" tone="hero" />
        </Row>

        <Column height={maxVisible} overflow="hidden">
          {events.length === 0 ? (
            <Text dimColor>No events yet</Text>
          ) : (
            events.slice(-maxVisible).map((event, i) => {
              const time = new Date(event.timestamp).toLocaleTimeString();
              const color = EVENT_COLORS[event.type] ?? 'white';
              return (
                <Row key={i}>
                  <Box width={12}>
                    <Text dimColor>{time}</Text>
                  </Box>
                  <Text color={color}>{event.description}</Text>
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
