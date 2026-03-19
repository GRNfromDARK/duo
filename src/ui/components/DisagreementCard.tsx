/**
 * DisagreementCard — displays when Coder and Reviewer disagree.
 * Source: FR-026 (AC-083, AC-084)
 */

import React from 'react';
import { Text, useInput, useStdout } from '../../tui/primitives.js';
import { computeOverlaySurfaceWidth } from '../screen-shell-layout.js';
import { CenteredContent, Column, Panel, Row, SectionTitle } from '../tui-layout.js';

export type DisagreementAction = 'continue' | 'decide' | 'accept_coder' | 'accept_reviewer';

export interface DisagreementCardProps {
  currentRound: number;
  agreedPoints: number;
  totalPoints: number;
  onAction: (action: DisagreementAction) => void;
}

export function DisagreementCard({
  currentRound,
  agreedPoints,
  totalPoints,
  onAction,
}: DisagreementCardProps): React.ReactElement {
  const { stdout } = useStdout();
  const panelWidth = computeOverlaySurfaceWidth(stdout.columns || 80);
  const disputedPoints = totalPoints - agreedPoints;

  useInput((input) => {
    const key = input.toLowerCase();
    if (key === 'c') onAction('continue');
    else if (key === 'd') onAction('decide');
    else if (key === 'a') onAction('accept_coder');
    else if (key === 'b') onAction('accept_reviewer');
  });

  return (
    <CenteredContent width={panelWidth} height="100%" justifyContent="center">
      <Panel tone="warning" width={panelWidth} paddingX={2}>
        <Row>
          <SectionTitle title="Disagreement" tone="warning" />
          <Text color="yellow"> · Round {currentRound}</Text>
        </Row>
        <Text color="gray">
          Agreed: {agreedPoints}/{totalPoints}    Disputed: {disputedPoints}/{totalPoints}
        </Text>
        <Column marginTop={1}>
          <Row>
            <Text color="cyan" bold>[C]</Text><Text> Continue  </Text>
            <Text color="cyan" bold>[D]</Text><Text> Decide manually</Text>
          </Row>
          <Row>
            <Text color="cyan" bold>[A]</Text><Text> Accept Coder's  </Text>
            <Text color="cyan" bold>[B]</Text><Text> Accept Reviewer's</Text>
          </Row>
        </Column>
      </Panel>
    </CenteredContent>
  );
}
