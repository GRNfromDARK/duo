/**
 * StatusBar unit tests — Card D.2: God info display
 * Tests God adapter, taskType, currentPhase, and godLatency rendering.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar, type StatusBarProps } from '../../ui/components/StatusBar.js';

function renderBar(overrides: Partial<StatusBarProps> = {}): string {
  const defaults: StatusBarProps = {
    projectPath: '/test/project',
    status: 'active',
    activeAgent: 'claude',
    tokenCount: 1200,
    columns: 120,
  };
  const { lastFrame } = render(<StatusBar {...defaults} {...overrides} />);
  return lastFrame() ?? '';
}

describe('StatusBar — God info display (Card D.2)', () => {
  // AC-1: Show God adapter name when different from reviewer
  it('shows God adapter name when different from reviewer', () => {
    const output = renderBar({
      godAdapter: 'o3',
      reviewerAdapter: 'claude',
    });
    expect(output).toContain('God:o3');
  });

  it('hides God adapter name when same as reviewer', () => {
    const output = renderBar({
      godAdapter: 'claude',
      reviewerAdapter: 'claude',
    });
    expect(output).not.toContain('God:');
  });

  it('hides God adapter name when not provided', () => {
    const output = renderBar({});
    expect(output).not.toContain('God:');
  });

  // AC-2: Show current task type
  it('shows task type label', () => {
    const output = renderBar({ taskType: 'code' });
    expect(output).toContain('[code]');
  });

  it('shows explore task type', () => {
    const output = renderBar({ taskType: 'explore' });
    expect(output).toContain('[explore]');
  });

  it('hides task type when not provided', () => {
    const output = renderBar({});
    // Should not contain brackets with a type
    expect(output).not.toMatch(/\[\w+\]/);
  });

  // AC-3: Show current phase for compound tasks
  it('shows current phase for compound tasks', () => {
    const output = renderBar({ currentPhase: 'design' });
    expect(output).toContain('φ:design');
  });

  it('hides phase when not provided', () => {
    const output = renderBar({});
    expect(output).not.toContain('φ:');
  });

  // God latency display
  it('shows God latency when provided', () => {
    const output = renderBar({ godLatency: 1500 });
    expect(output).toContain('1500ms');
  });

  it('hides latency when not provided', () => {
    const output = renderBar({});
    expect(output).not.toContain('ms');
  });

  // Combined display
  it('shows all God info together', () => {
    const output = renderBar({
      godAdapter: 'o3',
      reviewerAdapter: 'claude',
      taskType: 'compound',
      currentPhase: 'implement',
      godLatency: 800,
    });
    expect(output).toContain('God:o3');
    expect(output).toContain('[compound]');
    expect(output).toContain('φ:implement');
    expect(output).toContain('800ms');
    // L1 should not show degradation
    expect(output).not.toContain('↓');
  });

  // Basic status bar elements still work
  it('still shows token count', () => {
    const output = renderBar({ tokenCount: 5000 });
    expect(output).toContain('5.0k');
  });

  it('still shows active agent and status', () => {
    const output = renderBar({ activeAgent: 'claude', status: 'active' });
    expect(output).toContain('claude');
    expect(output).toContain('Active');
  });
});
