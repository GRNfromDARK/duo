import { describe, expect, it } from 'vitest';
import { buildStatusBarLayout } from '../../ui/status-bar-layout.js';

describe('buildStatusBarLayout', () => {
  it('keeps status and token segments when width is narrow', () => {
    const layout = buildStatusBarLayout({
      projectPath: '/Users/rex/Documents/Program2026/duo',
      statusLabel: 'Done',
      statusColor: 'green',
      activeAgent: 'Claude · Coder',
      tokenText: '1.4ktok',
      taskType: 'code',
      currentPhase: 'done',
      godLatencyText: '24529ms',
      columns: 34,
    });

    expect(layout.left.map((segment) => segment.text)).toContain('Duo');
    expect(layout.left.map((segment) => segment.text)).toContain('Done');
    expect(layout.right.map((segment) => segment.text)).toContain('1.4ktok');
  });

  it('truncates project path before dropping critical status segments', () => {
    const layout = buildStatusBarLayout({
      projectPath: '/Users/rex/Documents/Program2026/duo',
      statusLabel: 'Done',
      statusColor: 'green',
      activeAgent: 'Claude · Coder',
      tokenText: '1.4ktok',
      taskType: 'code',
      currentPhase: 'done',
      godLatencyText: '24529ms',
      columns: 46,
    });

    const pathSegment = layout.left.find((segment) => segment.kind === 'path');
    expect(pathSegment?.text).toContain('…');
    expect(layout.left.map((segment) => segment.text)).toContain('Done');
    expect(layout.right.map((segment) => segment.text)).toContain('1.4ktok');
  });

  it('preserves left and right group ordering', () => {
    const layout = buildStatusBarLayout({
      projectPath: '/Users/rex/Documents/Program2026/duo',
      statusLabel: 'Active',
      statusColor: 'yellow',
      activeAgent: 'Codex · Reviewer',
      tokenText: '987tok',
      taskType: 'review',
      currentPhase: 'phase-2',
      godLatencyText: '812ms',
      columns: 120,
    });

    expect(layout.left.map((segment) => segment.kind)).toEqual([
      'brand',
      'path',
      'status',
      'agent',
      'task',
      'phase',
    ]);
    expect(layout.right.map((segment) => segment.kind)).toEqual([
      'latency',
      'tokens',
    ]);
  });
});
