/**
 * Context summary overlay — shows current session context.
 * Source: FR-022 (AC-072)
 */
import React from 'react';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, FooterHint, LabelValueRow, Panel, Row, SectionTitle } from '../tui-layout.js';

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
  const panelWidth = computeOverlaySurfaceWidth(columns);
  return (
    <CenteredContent width={panelWidth} height={rows} justifyContent="center">
      <Panel tone="overlay" width={panelWidth} paddingX={2}>
        <Row justifyContent="center">
          <SectionTitle title="Context Summary" tone="hero" />
        </Row>

        <Column marginTop={1}>
          <LabelValueRow label="Coder" value={coderName} valueColor="blue" />
          <LabelValueRow label="Reviewer" value={reviewerName} valueColor="green" />
          <LabelValueRow label="Task" value={taskSummary} />
          <LabelValueRow label="Tokens" value={String(tokenEstimate)} />
        </Column>

        <Row justifyContent="center" marginTop={1}>
          <FooterHint text="Press Esc to close" />
        </Row>
      </Panel>
    </CenteredContent>
  );
}
