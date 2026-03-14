/**
 * StatusBar — Top 1-line status bar for Duo TUI.
 * Source: FR-018 (AC-061, AC-062, AC-063, AC-064)
 *
 * Layout: Left [ Duo  <project>  [████░░] N/Max  Agent ◆ Active  [type]  φ:phase ]
 *         Right [ God:X  ↓L3  800ms  5.0ktok ]
 *
 * Items are hidden progressively when terminal is too narrow.
 */

import React from 'react';
import { Box, Text } from 'ink';

export type WorkflowStatus = 'idle' | 'active' | 'error' | 'routing' | 'interrupted' | 'done';

export interface StatusBarProps {
  projectPath: string;
  round: number;
  maxRounds: number;
  status: WorkflowStatus;
  activeAgent: string | null;
  tokenCount: number;
  columns: number;
  godAdapter?: string;
  reviewerAdapter?: string;
  taskType?: string;
  currentPhase?: string;
  degradationLevel?: string; // L1/L2/L3/L4
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
  const filled = Math.round((current / max) * barWidth);
  const empty = barWidth - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * Segment: a piece of status bar content with optional styling.
 * Priority: lower number = more important (hidden last).
 */
interface Segment {
  text: string;
  color?: string;
  dimColor?: boolean;
  priority: number; // 1 = critical, 5 = least important
}

export function StatusBar({
  projectPath,
  round,
  maxRounds,
  status,
  activeAgent,
  tokenCount,
  columns,
  godAdapter,
  reviewerAdapter,
  taskType,
  currentPhase,
  degradationLevel,
  godLatency,
}: StatusBarProps): React.ReactElement {
  const cfg = STATUS_CONFIG[status];
  const tokenStr = `${formatTokens(tokenCount)}tok`;
  const agentStr = activeAgent ? `${activeAgent} ${cfg.icon} ${cfg.label}` : `${cfg.icon} ${cfg.label}`;
  const progressBar = buildProgressBar(round, maxRounds, 6);
  const roundStr = `${progressBar} ${round}/${maxRounds}`;

  // Show God adapter only when it differs from reviewer
  const showGod = godAdapter && reviewerAdapter && godAdapter !== reviewerAdapter;
  const godStr = showGod ? `God:${godAdapter}` : '';
  const taskTypeStr = taskType ? `[${taskType}]` : '';
  const phaseStr = currentPhase ? `φ:${currentPhase}` : '';
  // Degradation: L4 → "God:disabled", L2/L3 → "↓L2"/"↓L3", L1 → hide
  const degradStr = degradationLevel === 'L4'
    ? 'God:disabled'
    : degradationLevel && degradationLevel !== 'L1'
      ? `↓${degradationLevel}`
      : '';
  const latencyStr = godLatency !== undefined ? `${godLatency}ms` : '';

  // Build segments with priorities (1=must show, 5=nice to have)
  const leftSegments: Segment[] = [
    { text: 'Duo', priority: 1 },
    { text: projectPath, priority: 4 },
    { text: roundStr, priority: 1 },
    { text: agentStr, color: cfg.color, priority: 2 },
  ];
  if (taskTypeStr) leftSegments.push({ text: taskTypeStr, color: 'cyan', priority: 3 });
  if (phaseStr) leftSegments.push({ text: phaseStr, color: 'magenta', priority: 3 });

  const rightSegments: Segment[] = [];
  if (godStr) rightSegments.push({ text: godStr, color: 'magenta', priority: 4 });
  if (degradStr) rightSegments.push({
    text: degradStr,
    color: degradationLevel === 'L4' ? 'red' : 'yellow',
    priority: 3,
  });
  if (latencyStr) rightSegments.push({ text: latencyStr, dimColor: true, priority: 5 });
  rightSegments.push({ text: tokenStr, dimColor: true, priority: 2 });

  // Progressively remove low-priority segments if they don't fit
  const computeWidth = (segs: Segment[]) =>
    segs.reduce((w, s) => w + s.text.length + 2, 0); // +2 for spacing

  const allSegments = [...leftSegments, ...rightSegments];
  let totalWidth = computeWidth(allSegments) + 2; // padding

  // Remove segments by lowest priority (highest number) until it fits
  const removable = allSegments
    .map((s, i) => ({ priority: s.priority, index: i }))
    .sort((a, b) => b.priority - a.priority); // lowest priority first

  const removedIndices = new Set<number>();
  for (const item of removable) {
    if (totalWidth <= columns) break;
    if (item.priority <= 1) break; // never remove priority 1
    removedIndices.add(item.index);
    totalWidth -= allSegments[item.index]!.text.length + 2;
  }

  const visibleLeft = leftSegments.filter((_, i) => !removedIndices.has(i));
  const leftOffset = leftSegments.length;
  const visibleRight = rightSegments.filter((_, i) => !removedIndices.has(i + leftOffset));

  // Determine if L4 degradation — use red background
  const isL4 = degradationLevel === 'L4';

  return (
    <Box height={1} width={columns}>
      <Text inverse={!isL4} bold backgroundColor={isL4 ? 'red' : undefined} color={isL4 ? 'white' : undefined}>
        {' '}
        {visibleLeft.map((seg, i) => (
          <React.Fragment key={i}>
            {seg.color ? (
              <Text color={isL4 ? 'white' : seg.color}>{seg.text}</Text>
            ) : seg.dimColor ? (
              <Text dimColor>{seg.text}</Text>
            ) : (
              <Text>{seg.text}</Text>
            )}
            {'  '}
          </React.Fragment>
        ))}
        {/* Spacer between left and right — use remaining space */}
        {visibleRight.length > 0 && visibleRight.map((seg, i) => (
          <React.Fragment key={`r${i}`}>
            {seg.color ? (
              <Text color={isL4 ? 'white' : seg.color}>{seg.text}</Text>
            ) : seg.dimColor ? (
              <Text dimColor>{seg.text}</Text>
            ) : (
              <Text>{seg.text}</Text>
            )}
            {i < visibleRight.length - 1 ? '  ' : ' '}
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}
