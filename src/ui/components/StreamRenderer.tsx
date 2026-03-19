/**
 * StreamRenderer — streaming markdown content renderer for TUI.
 * Source: FR-023 (AC-075, AC-076, AC-077)
 *
 * Responsibilities:
 * - Renders markdown content with syntax highlighting
 * - Shows streaming indicator (cursor) when actively streaming
 * - Code blocks highlighted before closing ``` (unclosed blocks rendered)
 * - Batched rendering: content parsed per render cycle
 */

import React, { useMemo, useState, useCallback } from 'react';
import { Box, Text } from '../../tui/primitives.js';
import { parseMarkdown } from '../markdown-parser.js';
import { CodeBlock } from './CodeBlock.js';
import type { DisplayMode } from '../display-mode.js';
import { buildStreamRenderModel, toneToColor, type StreamRenderEntry } from '../stream-renderer-layout.js';

export interface StreamRendererProps {
  content: string;
  isStreaming: boolean;
  displayMode?: DisplayMode;
}

const SPINNER_CHARS = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

function SegmentView({
  entry,
  displayMode = 'minimal',
}: {
  entry: StreamRenderEntry;
  displayMode?: DisplayMode;
}): React.ReactElement {
  switch (entry.kind) {
    case 'paragraph':
      return (
        <Box flexDirection="column" marginBottom={entry.spacingAfter}>
          {entry.text.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );

    case 'activity_block':
      return (
        <ActivityBlock
          tone={entry.tone}
          title={entry.title}
          content={entry.content}
          displayMode={displayMode}
          spacingAfter={entry.spacingAfter}
        />
      );

    case 'activity_summary':
      return (
        <ActivitySummary
          tone={entry.tone}
          summary={entry.summary}
          spacingAfter={entry.spacingAfter}
        />
      );

    case 'inline_code':
      return <Text backgroundColor="gray" color="white">{entry.content}</Text>;

    case 'bold':
      return <Text bold>{entry.text}</Text>;

    case 'italic':
      return <Text italic>{entry.text}</Text>;

    case 'list_item': {
      const bullet = entry.marker === '-' || entry.marker === '*'
        ? '  \u2022'
        : `  ${entry.marker}`;
      return (
        <Text>{bullet} {entry.text}</Text>
      );
    }

    case 'table':
      return <TableView headers={entry.headers} rows={entry.rows} spacingAfter={entry.spacingAfter} />;

    case 'code_block':
      return <CodeBlock content={entry.content} language={entry.language} />;
  }
}

function TableView({
  headers,
  rows,
  spacingAfter,
}: {
  headers: string[];
  rows: string[][];
  spacingAfter: number;
}): React.ReactElement {
  const colWidths = headers.map((h, ci) => {
    const dataMax = rows.reduce(
      (max, row) => Math.max(max, (row[ci] || '').length),
      0,
    );
    return Math.max(h.length, dataMax) + 2;
  });

  const pad = (s: string, width: number) => s.padEnd(width);

  return (
    <Box flexDirection="column" marginBottom={spacingAfter}>
      <Text>
        {headers.map((h, i) => pad(h, colWidths[i])).join(' | ')}
      </Text>
      <Text>
        {colWidths.map((w) => '-'.repeat(w)).join('-+-')}
      </Text>
      {rows.map((row, ri) => (
        <Text key={ri}>
          {row.map((cell, ci) => pad(cell, colWidths[ci])).join(' | ')}
        </Text>
      ))}
    </Box>
  );
}

function ActivitySummary({
  tone,
  summary,
  spacingAfter,
}: {
  tone: 'accent' | 'muted' | 'warning' | 'neutral';
  summary: string;
  spacingAfter: number;
}): React.ReactElement {
  const icon = tone === 'warning' ? '⚠' : tone === 'muted' ? '·' : '⏺';
  const color = toneToColor(tone);

  return (
    <Box marginBottom={spacingAfter}>
      <Text color={color}>{icon} {summary}</Text>
    </Box>
  );
}

function ActivityBlock({
  tone,
  title,
  content,
  displayMode = 'minimal',
  spacingAfter,
}: {
  tone: 'accent' | 'muted' | 'warning' | 'neutral';
  title: string;
  content: string;
  displayMode?: DisplayMode;
  spacingAfter: number;
}): React.ReactElement {
  const lines = content.split('\n').filter((line) => line.length > 0);
  const summary = lines[0] ?? '';
  const isVerbose = displayMode === 'verbose';

  const icon = tone === 'warning' ? '⚠' : tone === 'muted' ? '·' : '⏺';
  const color = toneToColor(tone);

  return (
    <Box flexDirection="column" marginBottom={spacingAfter}>
      <Text color={color}>
        {icon} {title}{summary ? `: ${summary}` : ''}
      </Text>
      {isVerbose && lines.length > 1 && (
        <CodeBlock
          content={lines.slice(1).join('\n')}
          language="text"
        />
      )}
    </Box>
  );
}

export function StreamRenderer({
  content,
  isStreaming,
  displayMode = 'minimal',
}: StreamRendererProps): React.ReactElement {
  const renderModel = useMemo(
    () => buildStreamRenderModel(parseMarkdown(content), displayMode),
    [content, displayMode],
  );

  // Track expand/collapse state per code block index (persists across re-renders/scrolls)
  const [expandedBlocks, setExpandedBlocks] = useState<Record<number, boolean>>({});

  const toggleBlock = useCallback((blockIndex: number) => {
    setExpandedBlocks((prev) => ({
      ...prev,
      [blockIndex]: !prev[blockIndex],
    }));
  }, []);

  // Determine spinner character based on content length for deterministic test output
  const spinnerChar = SPINNER_CHARS[content.length % SPINNER_CHARS.length];

  // Count code blocks to assign stable indices
  let codeBlockIndex = 0;

  return (
    <Box flexDirection="column">
      {renderModel.map((entry, i) => {
        if (entry.kind === 'code_block') {
          const idx = codeBlockIndex++;
          return (
            <CodeBlock
              key={i}
              content={entry.content}
              language={entry.language}
              expanded={expandedBlocks[idx]}
              onToggle={() => toggleBlock(idx)}
            />
          );
        }
        return <SegmentView key={i} entry={entry} displayMode={displayMode} />;
      })}
      {isStreaming && (
        <Text color="cyan">{spinnerChar}</Text>
      )}
    </Box>
  );
}
