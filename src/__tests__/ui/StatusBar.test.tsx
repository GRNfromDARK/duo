/**
 * StatusBar unit tests — Card D.2: God info display
 * Tests God adapter, taskType, currentPhase, degradationLevel, and godLatency rendering.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar, type StatusBarProps } from '../../ui/components/StatusBar.js';

function renderBar(overrides: Partial<StatusBarProps> = {}): string {
  const defaults: StatusBarProps = {
    projectPath: '/test/project',
    round: 1,
    maxRounds: 5,
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

  // AC-4: Show degradation status
  it('shows "God:disabled" for L4 degradation', () => {
    const output = renderBar({ degradationLevel: 'L4' });
    expect(output).toContain('God:disabled');
  });

  it('shows downgrade indicator for L2', () => {
    const output = renderBar({ degradationLevel: 'L2' });
    expect(output).toContain('↓L2');
  });

  it('shows downgrade indicator for L3', () => {
    const output = renderBar({ degradationLevel: 'L3' });
    expect(output).toContain('↓L3');
  });

  it('hides degradation for L1 (normal)', () => {
    const output = renderBar({ degradationLevel: 'L1' });
    expect(output).not.toContain('↓L1');
    expect(output).not.toContain('God:disabled');
  });

  it('hides degradation when not provided', () => {
    const output = renderBar({});
    expect(output).not.toContain('↓');
    expect(output).not.toContain('God:disabled');
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
      degradationLevel: 'L1',
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
  it('still shows round and token count', () => {
    const output = renderBar({ round: 3, maxRounds: 10, tokenCount: 5000 });
    expect(output).toContain('3/10');
    expect(output).toMatch(/[█░]/); // progress bar
    expect(output).toContain('5.0ktok');
  });

  it('still shows active agent and status', () => {
    const output = renderBar({ activeAgent: 'claude', status: 'active' });
    expect(output).toContain('claude');
    expect(output).toContain('Active');
  });
});
