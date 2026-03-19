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
  const contentWidth = Math.max(1, (columns ?? 80) - 1);
  const showRoleTag = block.header.roleTag !== block.header.name;
  const headerColor = block.body.tone === 'muted' ? 'white' : block.body.railColor;
  const tagColor = block.body.tone === 'muted' ? '#b7c0cf' : block.body.railColor;

  return (
    <Column marginBottom={1} width={columns}>
      <Row>
        <Text color={headerColor} bold>{block.header.name}</Text>
        {showRoleTag && (
          <Text color={tagColor} bold>{`  [${block.header.roleTag}]`}</Text>
        )}
        <Text color="gray">{` · ${block.header.time}`}</Text>
        {block.header.tokenText && (
          <Text color="gray">{` · ${block.header.tokenText}`}</Text>
        )}
      </Row>
      <Row marginTop={1}>
        <Box
          width={contentWidth}
          flexDirection="column"
          border={block.body.railKind === 'border' ? ['left'] : false}
          borderColor={block.body.railColor}
          paddingLeft={1}
        >
          {block.body.cliCommand && (
            <Text color="gray" dimColor>$ {block.body.cliCommand}</Text>
          )}
          <Box flexDirection="column" marginTop={block.body.cliCommand ? 1 : 0}>
            <StreamRenderer
              content={block.body.content}
              isStreaming={message.isStreaming ?? false}
              displayMode={displayMode}
            />
          </Box>
        </Box>
      </Row>
    </Column>
  );
}
