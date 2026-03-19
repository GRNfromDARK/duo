import React from 'react';
import { Box, Text } from '../../tui/primitives.js';
import type { Message } from '../../types/ui.js';
import type { DisplayMode } from '../display-mode.js';
import { StreamRenderer } from './StreamRenderer.js';
import { buildMessageBlocks } from '../message-blocks.js';
import { Column, Row } from '../tui-layout.js';

export interface MessageViewProps {
  message: Message;
  displayMode?: DisplayMode;
  columns?: number;
}
export function MessageView({
  message,
  displayMode = 'minimal',
  columns,
}: MessageViewProps): React.ReactElement {
  const block = buildMessageBlocks([message], displayMode)[0]!;
  const contentWidth = Math.max(1, (columns ?? 80) - 3);

  return (
    <Column marginBottom={1} width={columns}>
      <Row>
        <Text color={block.body.railColor} bold>{block.header.label}</Text>
        <Text color="gray">{` · ${block.header.time}`}</Text>
        {block.header.tokenText && (
          <Text color="gray">{` · ${block.header.tokenText}`}</Text>
        )}
      </Row>
      {block.body.cliCommand && (
        <Row marginTop={1}>
          <Text color={block.body.railColor}>{block.body.railSymbol} </Text>
          <Text color="gray" dimColor>$ {block.body.cliCommand}</Text>
        </Row>
      )}
      <Row marginTop={block.body.cliCommand ? 0 : 1}>
        <Text color={block.body.railColor}>{block.body.railSymbol} </Text>
        <Box width={contentWidth} flexDirection="column">
          <StreamRenderer
            content={block.body.content}
            isStreaming={message.isStreaming ?? false}
            displayMode={displayMode}
          />
        </Box>
      </Row>
    </Column>
  );
}
