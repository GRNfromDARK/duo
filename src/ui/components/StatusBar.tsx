/**
 * StatusBar — Top 1-line status bar for Duo TUI.
 * Source: FR-018 (AC-061, AC-062, AC-063, AC-064)
 *
 * Layout: Left [ Duo  <project>  [████░░] N/Max  Agent ◆ Active  [type]  φ:phase ]
 *         Right [ God:X  800ms  5.0ktok ]
 *
 * Items are hidden progressively when terminal is too narrow.
 */

import React from 'react';
import { Text } from '../../tui/primitives.js';
import { buildStatusBarLayout, computeStatusBarWidth } from '../status-bar-layout.js';
import { Row } from '../tui-layout.js';

export type WorkflowStatus = 'idle' | 'active' | 'error' | 'routing' | 'interrupted' | 'done';

export interface StatusBarProps {
  projectPath: string;
  status: WorkflowStatus;
  activeAgent: string | null;
  tokenCount: number;
  columns: number;
  godAdapter?: string;
  reviewerAdapter?: string;
  coderModel?: string;
  reviewerModel?: string;
  taskType?: string;
  currentPhase?: string;
  godLatency?: number;       // latest God decision latency (ms)
}

const STATUS_CONFIG: Record<WorkflowStatus, { icon: string; label: string; color: string }> = {
  active:      { icon: '◆', label: 'Active',      color: 'green' },
  idle:        { icon: '◇', label: 'Idle',         color: 'white' },
  error:       { icon: '⚠', label: 'Error',        color: 'red' },
  routing:     { icon: '◈', label: 'Routing',      color: 'yellow' },
  interrupted: { icon: '⏸', label: 'Interrupted',  color: 'white' },
  done:        { icon: '◇', label: 'Done',         color: 'green' },
};

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

/**
 * Build a text progress bar: [████░░] style
 */
export function buildProgressBar(current: number, max: number, barWidth: number): string {
  if (max <= 0) return `[${'░'.repeat(barWidth)}]`;
  const filled = Math.min(Math.round((current / max) * barWidth), barWidth);
  const empty = barWidth - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * Segment: a piece of status bar content with optional styling.
 * Priority: lower number = more important (hidden last).
 */
export function StatusBar({
  projectPath,
  status,
  activeAgent,
  tokenCount,
  columns,
  godAdapter,
  reviewerAdapter,
  coderModel,
  reviewerModel,
  taskType,
  currentPhase,
  godLatency,
}: StatusBarProps): React.ReactElement {
  const cfg = STATUS_CONFIG[status];
  const tokenStr = `${formatTokens(tokenCount)}tok`;
  const latencyStr = godLatency !== undefined ? `${godLatency}ms` : undefined;
  const layout = buildStatusBarLayout({
    projectPath,
    statusLabel: cfg.label,
    statusColor: cfg.color,
    activeAgent,
    tokenText: tokenStr,
    taskType,
    currentPhase,
    godLatencyText: latencyStr,
    columns,
  });
  const spacerWidth = Math.max(1, columns - computeStatusBarWidth(layout));

  return (
    <Row height={1} width={columns}>
      {layout.left.map((seg, i) => (
        <Text
          key={seg.kind}
          backgroundColor="black"
          color={seg.color}
          dimColor={seg.dimColor}
          bold={seg.kind === 'brand' || seg.kind === 'status'}
        >
          {i === 0 ? ' ' : '  '}
          {seg.kind === 'status' ? `${cfg.icon} ${seg.text}` : seg.text}
        </Text>
      ))}
      <Text backgroundColor="black">{' '.repeat(spacerWidth)}</Text>
      {layout.right.map((seg, i) => (
        <Text
          key={seg.kind}
          backgroundColor="black"
          color={seg.color}
          dimColor={seg.dimColor}
          bold={false}
        >
          {i === 0 ? '' : '  '}
          {seg.text}
          {i === layout.right.length - 1 ? ' ' : ''}
        </Text>
      ))}
    </Row>
  );
}
