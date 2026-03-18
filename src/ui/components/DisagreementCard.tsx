/**
 * DisagreementCard — displays when Coder and Reviewer disagree.
 * Source: FR-026 (AC-083, AC-084)
 */

import React from 'react';
import { Box, Text, useInput } from '../../tui/primitives.js';

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
  const disputedPoints = totalPoints - agreedPoints;

  useInput((input) => {
    const key = input.toLowerCase();
    if (key === 'c') onAction('continue');
    else if (key === 'd') onAction('decide');
    else if (key === 'a') onAction('accept_coder');
    else if (key === 'b') onAction('accept_reviewer');
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box>
        <Text color="yellow" bold>⚡ DISAGREEMENT</Text>
        <Text color="yellow"> · Round {currentRound}</Text>
      </Box>
      <Text color="gray">
        Agreed: {agreedPoints}/{totalPoints}    Disputed: {disputedPoints}/{totalPoints}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color="cyan" bold>[C]</Text><Text> Continue  </Text>
          <Text color="cyan" bold>[D]</Text><Text> Decide manually</Text>
        </Box>
        <Box>
          <Text color="cyan" bold>[A]</Text><Text> Accept Coder's  </Text>
          <Text color="cyan" bold>[B]</Text><Text> Accept Reviewer's</Text>
        </Box>
      </Box>
    </Box>
  );
}
