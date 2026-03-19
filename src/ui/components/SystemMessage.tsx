/**
 * SystemMessage — renders system-level messages for routing, interrupts, and waiting.
 * Source: FR-024 (AC-078, AC-079) + FR-025 (AC-080, AC-081)
 *
 * Routing: Minimal → one-line `· [Router] Choice detected → Forwarding to X`
 *          Verbose → includes question + choices details
 * Interrupt: `⚠ INTERRUPTED - <Agent> process terminated (output: N chars)`
 * Waiting: `> Waiting for your instructions...`
 */

import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import type { DisplayMode } from '../display-mode.js';
import { getSystemMessageAppearance } from '../stream-renderer-layout.js';

export interface RoutingDetails {
  question: string;
  choices: string[];
}

export interface SystemMessageProps {
  type: 'routing' | 'interrupt' | 'waiting';
  agentName?: string;
  displayMode?: DisplayMode;
  routingDetails?: RoutingDetails;
  outputChars?: number;
}

function RoutingMessage({
  agentName,
  displayMode = 'minimal',
  routingDetails,
}: {
  agentName: string;
  displayMode: DisplayMode;
  routingDetails?: RoutingDetails;
}): React.ReactElement {
  const isVerbose = displayMode === 'verbose';
  const appearance = getSystemMessageAppearance('routing');

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={appearance.color}>{appearance.prefix} </Text>
        <Text color={appearance.color} bold>[Router]</Text>
        <Text color={appearance.color}> Choice detected → Forwarding to {agentName}</Text>
      </Box>
      {isVerbose && routingDetails && (
        <>
          <Box>
            <Text color={appearance.color}>{appearance.prefix}   </Text>
            <Text color="gray">Question: {routingDetails.question}</Text>
          </Box>
          {routingDetails.choices.map((choice, i) => (
            <Box key={i}>
              <Text color={appearance.color}>{appearance.prefix}   </Text>
              <Text color="gray">  {i + 1}. {choice}</Text>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}

function InterruptMessage({
  agentName,
  outputChars,
}: {
  agentName: string;
  outputChars: number;
}): React.ReactElement {
  const appearance = getSystemMessageAppearance('interrupt');
  return (
    <Box>
      <Text color={appearance.color}>{appearance.prefix} </Text>
      <Text color={appearance.color} bold>INTERRUPTED</Text>
      <Text color={appearance.color}> - {agentName} process terminated (output: {outputChars} chars)</Text>
    </Box>
  );
}

function WaitingMessage(): React.ReactElement {
  const appearance = getSystemMessageAppearance('waiting');
  return (
    <Box>
      <Text color={appearance.color}>{appearance.prefix} </Text>
      <Text color={appearance.color}>Waiting for your instructions...</Text>
    </Box>
  );
}

export function SystemMessage({
  type,
  agentName = '',
  displayMode = 'minimal',
  routingDetails,
  outputChars = 0,
}: SystemMessageProps): React.ReactElement {
  switch (type) {
    case 'routing':
      return (
        <RoutingMessage
          agentName={agentName}
          displayMode={displayMode}
          routingDetails={routingDetails}
        />
      );
    case 'interrupt':
      return (
        <InterruptMessage
          agentName={agentName}
          outputChars={outputChars}
        />
      );
    case 'waiting':
      return <WaitingMessage />;
  }
}
