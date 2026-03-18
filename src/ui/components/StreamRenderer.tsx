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
import { parseMarkdown, type MarkdownSegment } from '../markdown-parser.js';
import { CodeBlock } from './CodeBlock.js';
import type { DisplayMode } from '../display-mode.js';

export interface StreamRendererProps {
  content: string;
  isStreaming: boolean;
  displayMode?: DisplayMode;
}

const SPINNER_CHARS = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

type DisplaySegment = MarkdownSegment | {
  type: 'activity_summary';
  kind: 'activity' | 'result' | 'error';
  summary: string;
};

function SegmentView({
  segment,
  displayMode = 'minimal',
}: {
  segment: DisplaySegment;
  displayMode?: DisplayMode;
}): React.ReactElement {
  switch (segment.type) {
    case 'text':
      return (
        <Box flexDirection="column">
          {segment.content.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );

    case 'code_block':
      // Handled by StreamRenderer directly for state management
      return <CodeBlock content={segment.content} language={segment.language} />;

    case 'activity_block':
      return (
        <ActivityBlock
          kind={segment.kind}
          title={segment.title}
          content={segment.content}
          displayMode={displayMode}
        />
      );

    case 'activity_summary':
      return (
        <ActivitySummary
          kind={segment.kind}
          summary={segment.summary}
        />
      );

    case 'inline_code':
      return <Text backgroundColor="gray" color="white">{segment.content}</Text>;

    case 'bold':
      return <Text bold>{segment.content}</Text>;

    case 'italic':
      return <Text italic>{segment.content}</Text>;

    case 'list_item': {
      const bullet = segment.marker === '-' || segment.marker === '*'
        ? '  \u2022'
        : `  ${segment.marker}`;
      return (
        <Text>{bullet} {segment.content}</Text>
      );
    }

    case 'table':
      return <TableView headers={segment.headers} rows={segment.rows} />;

    default:
      return <Text>{String((segment as Record<string, unknown>).content ?? '')}</Text>;
  }
}

function TableView({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
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
    <Box flexDirection="column">
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
  kind,
  summary,
}: {
  kind: 'activity' | 'result' | 'error';
  summary: string;
}): React.ReactElement {
  const icon =
    kind === 'error' ? '⚠' :
    kind === 'result' ? '⎿' :
    '⏺';
  const color =
    kind === 'error' ? 'red' :
    kind === 'result' ? 'gray' :
    'cyan';

  return <Text color={color}>{icon} {summary}</Text>;
}

function ActivityBlock({
  kind,
  title,
  content,
  displayMode = 'minimal',
}: {
  kind: 'activity' | 'result' | 'error';
  title: string;
  content: string;
  displayMode?: DisplayMode;
}): React.ReactElement {
  const lines = content.split('\n').filter((line) => line.length > 0);
  const summary = lines[0] ?? '';
  const isVerbose = displayMode === 'verbose';

  const icon =
    kind === 'activity' ? '⏺' :
    kind === 'result' ? '⎿' :
    '⚠';
  const color =
    kind === 'error' ? 'red' :
    kind === 'result' ? 'gray' :
    'cyan';

  return (
    <Box flexDirection="column">
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
  const segments = useMemo(
    () => compactSegments(parseMarkdown(content), displayMode),
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
      {segments.map((segment, i) => {
        if (segment.type === 'code_block') {
          const idx = codeBlockIndex++;
          return (
            <CodeBlock
              key={i}
              content={segment.content}
              language={segment.language}
              expanded={expandedBlocks[idx]}
              onToggle={() => toggleBlock(idx)}
            />
          );
        }
        return <SegmentView key={i} segment={segment} displayMode={displayMode} />;
      })}
      {isStreaming && (
        <Text color="cyan">{spinnerChar}</Text>
      )}
    </Box>
  );
}

function compactSegments(
  segments: MarkdownSegment[],
  displayMode: DisplayMode,
): DisplaySegment[] {
  if (displayMode === 'verbose') {
    return segments;
  }

  const compacted: DisplaySegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.type !== 'activity_block') {
      compacted.push(segment);
      continue;
    }

    const activityRun = [segment];
    while (i + 1 < segments.length && segments[i + 1].type === 'activity_block') {
      activityRun.push(segments[i + 1] as Extract<MarkdownSegment, { type: 'activity_block' }>);
      i++;
    }

    compacted.push(summarizeActivityRun(activityRun));
  }

  return compacted;
}

function summarizeActivityRun(
  run: Array<Extract<MarkdownSegment, { type: 'activity_block' }>>,
): DisplaySegment {
  const latest = run[run.length - 1];
  const latestActivity = [...run].reverse().find((segment) => segment.kind === 'activity') ?? latest;
  const latestSummary = latestActivity.content.split('\n').find((line) => line.trim().length > 0) ?? latestActivity.title;
  const activityCount = run.filter((segment) => segment.kind === 'activity').length;
  const resultCount = run.filter((segment) => segment.kind === 'result').length;
  const errorCount = run.filter((segment) => segment.kind === 'error').length;
  const total = run.length;

  const parts: string[] = [];
  if (activityCount > 0) parts.push(`${activityCount} actions`);
  if (resultCount > 0) parts.push(`${resultCount} results`);
  if (errorCount > 0) parts.push(`${errorCount} errors`);

  const prefix = total > 1
    ? `${parts.join(' · ')} · latest ${latestActivity.title}: ${latestSummary}`
    : `${latestActivity.title}: ${latestSummary}`;

  return {
    type: 'activity_summary',
    kind: latest.kind === 'error' ? 'error' : 'activity',
    summary: prefix,
  };
}
