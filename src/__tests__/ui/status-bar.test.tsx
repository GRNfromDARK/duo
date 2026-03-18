import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../ui/components/StatusBar.js';
import type { StatusBarProps, WorkflowStatus } from '../../ui/components/StatusBar.js';

function renderBar(overrides: Partial<StatusBarProps> = {}) {
  const defaults: StatusBarProps = {
    projectPath: 'my-app',
    status: 'idle',
    activeAgent: null,
    tokenCount: 0,
    columns: 80,
  };
  return render(<StatusBar {...defaults} {...overrides} />);
}

describe('StatusBar', () => {
  // AC-061: Status bar always visible, 1 line height
  it('renders exactly 1 line', () => {
    const { lastFrame } = renderBar();
    const output = lastFrame()!;
    const lines = output.split('\n');
    expect(lines.length).toBe(1);
  });

  it('shows app name "Duo"', () => {
    const { lastFrame } = renderBar();
    expect(lastFrame()!).toContain('Duo');
  });

  it('shows project path', () => {
    const { lastFrame } = renderBar({ projectPath: 'test-project' });
    expect(lastFrame()!).toContain('test-project');
  });

  // Round info test removed (round removal).

  // AC-062: Spinner animation continuously displays when LLM is working
  it('shows ◆ icon when status is active', () => {
    const { lastFrame } = renderBar({ status: 'active', activeAgent: 'Claude' });
    expect(lastFrame()!).toContain('◆');
  });

  it('shows ◇ icon when status is idle', () => {
    const { lastFrame } = renderBar({ status: 'idle' });
    expect(lastFrame()!).toContain('◇');
  });

  it('shows ⚠ icon when status is error', () => {
    const { lastFrame } = renderBar({ status: 'error' });
    expect(lastFrame()!).toContain('⚠');
  });

  it('shows ◈ icon when status is routing', () => {
    const { lastFrame } = renderBar({ status: 'routing' });
    expect(lastFrame()!).toContain('◈');
  });

  it('shows ⏸ icon when status is interrupted', () => {
    const { lastFrame } = renderBar({ status: 'interrupted' });
    expect(lastFrame()!).toContain('⏸');
  });

  it('shows active agent name when active', () => {
    const { lastFrame } = renderBar({ status: 'active', activeAgent: 'Claude:Coder' });
    expect(lastFrame()!).toContain('Claude:Coder');
  });

  // AC-064: Display cumulative token estimation
  it('shows token count', () => {
    const { lastFrame } = renderBar({ tokenCount: 1500 });
    expect(lastFrame()!).toContain('1.5k');
  });

  it('shows token count in k format for large numbers', () => {
    const { lastFrame } = renderBar({ tokenCount: 25000 });
    expect(lastFrame()!).toContain('25.0k');
  });

  it('shows raw number for small token counts', () => {
    const { lastFrame } = renderBar({ tokenCount: 500 });
    expect(lastFrame()!).toContain('500');
  });

  it('shows zero tokens as 0', () => {
    const { lastFrame } = renderBar({ tokenCount: 0 });
    expect(lastFrame()!).toContain('0');
  });

  // AC-061: does not overflow column width
  it('does not exceed column width', () => {
    const cols = 80;
    const { lastFrame } = renderBar({
      columns: cols,
      projectPath: 'a-very-long-project-path-name',
      status: 'active',
      activeAgent: 'Claude:Coder',
      tokenCount: 99999,
    });
    const output = lastFrame()!;
    const lines = output.split('\n');
    for (const line of lines) {
      // Strip ANSI escape codes for length check
      const stripped = line.replace(/\x1B\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThanOrEqual(cols);
    }
  });

  it('shows "Done" label when status is done', () => {
    const { lastFrame } = renderBar({ status: 'done' });
    expect(lastFrame()!).toContain('Done');
  });

  // Card D.2: God latency display
  describe('God latency display', () => {
    it('shows god latency in ms', () => {
      const { lastFrame } = renderBar({
        columns: 120,
        godLatency: 1234,
      });
      expect(lastFrame()!).toContain('1234ms');
    });

    it('does not show latency when not provided', () => {
      const { lastFrame } = renderBar({ columns: 120 });
      expect(lastFrame()!).not.toContain('ms');
    });
  });

  // Card A.1: God adapter display
  describe('God adapter display', () => {
    it('shows God adapter name when different from reviewer', () => {
      const { lastFrame } = renderBar({
        columns: 120,
        godAdapter: 'Copilot',
        reviewerAdapter: 'Gemini',
      });
      expect(lastFrame()!).toContain('God:Copilot');
    });

    it('does not show God adapter when same as reviewer', () => {
      const { lastFrame } = renderBar({
        columns: 120,
        godAdapter: 'Gemini',
        reviewerAdapter: 'Gemini',
      });
      expect(lastFrame()!).not.toContain('God:');
    });

    it('does not show God adapter when godAdapter is not provided', () => {
      const { lastFrame } = renderBar({ columns: 120 });
      expect(lastFrame()!).not.toContain('God:');
    });
  });
});
