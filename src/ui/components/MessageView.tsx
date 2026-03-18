import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import { ROLE_STYLES } from '../../types/ui.js';
import type { Message } from '../../types/ui.js';
import type { DisplayMode } from '../display-mode.js';
import { StreamRenderer } from './StreamRenderer.js';

export interface MessageViewProps {
  message: Message;
  displayMode?: DisplayMode;
}

function formatTime(timestamp: number, verbose: boolean): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  if (!verbose) return `${h}:${m}`;
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

export function MessageView({ message, displayMode = 'minimal' }: MessageViewProps): React.ReactElement {
  const style = ROLE_STYLES[message.role];
  const label = message.roleLabel
    ? `${style.displayName} · ${message.roleLabel}`
    : style.displayName;
  const isVerbose = displayMode === 'verbose';
  const meta = message.metadata;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={style.color}>{style.border} </Text>
        <Text color={style.color} bold>[{label}]</Text>
        <Text color="gray"> {formatTime(message.timestamp, isVerbose)}</Text>
        {isVerbose && meta?.tokenCount != null && (
          <Text color="gray"> [{formatTokenCount(meta.tokenCount)} tokens]</Text>
        )}
      </Box>
      {isVerbose && meta?.cliCommand && (
        <Box>
          <Text color={style.color}>{style.border} </Text>
          <Text color="gray" dimColor>$ {meta.cliCommand}</Text>
        </Box>
      )}
      <Box>
        <Text color={style.color}>{style.border} </Text>
        <StreamRenderer
          content={message.content}
          isStreaming={message.isStreaming ?? false}
          displayMode={displayMode}
        />
      </Box>
    </Box>
  );
}
