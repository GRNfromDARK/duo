import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TaskBanner, truncateText } from '../../ui/components/TaskBanner.js';
import { computeStringWidth } from '../../ui/message-lines.js';

// ── truncateText pure function tests ──

describe('truncateText', () => {
  it('returns text unchanged when it fits within maxWidth', () => {
    expect(truncateText('Hello world', 20)).toBe('Hello world');
  });

  it('truncates ASCII text and adds ellipsis', () => {
    const result = truncateText('Hello world, this is a long task', 15);
    expect(result.endsWith('…')).toBe(true);
    expect(computeStringWidth(result)).toBeLessThanOrEqual(15);
  });

  it('collapses multiline text into a single line', () => {
    expect(truncateText('Line one\nLine two\nLine three', 80))
      .toBe('Line one Line two Line three');
  });

  it('handles maxWidth of 1 by returning just ellipsis', () => {
    expect(truncateText('any text here', 1)).toBe('…');
  });

  it('handles empty string', () => {
    expect(truncateText('', 80)).toBe('');
  });

  // ── CJK-specific tests ──

  it('correctly measures CJK text width (each char = 2 columns)', () => {
    // 5 CJK chars = 10 columns
    const cjk = '请查看本项';
    expect(computeStringWidth(cjk)).toBe(10);
  });

  it('truncates CJK text without breaking mid-character', () => {
    // "请查看本项目，然后提出3项最重要的优化方案" — each CJK char is 2 cols
    const cjk = '请查看本项目，然后提出3项最重要的优化方案';
    const result = truncateText(cjk, 20);
    // 20 cols budget, minus 1 for "…" = 19 cols for text
    // Each CJK char = 2 cols, so 9 CJK chars = 18 cols (fits), 10th would be 20 (exceeds 19)
    // But '3' is 1 col, so we fit: 请查看本项目，然后(9 chars=18cols) + nothing more + …
    expect(result.endsWith('…')).toBe(true);
    expect(computeStringWidth(result)).toBeLessThanOrEqual(20);
    // Must not exceed the width
    expect(computeStringWidth(result)).toBeGreaterThan(0);
  });

  it('never overflows maxWidth with mixed CJK + ASCII', () => {
    const mixed = '请查看本项目 and then do something';
    for (let width = 1; width <= 40; width++) {
      const result = truncateText(mixed, width);
      expect(computeStringWidth(result)).toBeLessThanOrEqual(width);
    }
  });

  it('handles pure CJK string at various widths', () => {
    const cjk = '这是一个纯中文字符串用来测试截断功能';
    for (let width = 1; width <= 40; width++) {
      const result = truncateText(cjk, width);
      expect(computeStringWidth(result)).toBeLessThanOrEqual(width);
    }
  });

  it('does not truncate CJK text that fits exactly', () => {
    const cjk = '你好'; // 4 columns
    expect(truncateText(cjk, 4)).toBe('你好');
    expect(truncateText(cjk, 5)).toBe('你好');
  });

  it('truncates CJK text that exceeds by 1 column', () => {
    const cjk = '你好世'; // 6 columns
    const result = truncateText(cjk, 5);
    // 5 cols - 1 (ellipsis) = 4 available, "你好" = 4 cols
    expect(result).toBe('你好…');
    expect(computeStringWidth(result)).toBe(5);
  });

  it('handles the real user task string', () => {
    const task = '请查看本项目，然后提出3项最重要的对于用户体验的ui dashboard的优化方案。然后完成优化。';
    const result = truncateText(task, 60);
    expect(result.endsWith('…')).toBe(true);
    expect(computeStringWidth(result)).toBeLessThanOrEqual(60);
  });
});

// ── TaskBanner component tests ──

describe('TaskBanner', () => {
  it('renders the task summary text', () => {
    const { lastFrame } = render(
      <TaskBanner taskSummary="Fix the login bug" columns={80} />
    );
    const output = lastFrame()!;
    expect(output).toContain('Task:');
    expect(output).toContain('Fix the login bug');
  });

  it('renders the prompt icon', () => {
    const { lastFrame } = render(
      <TaskBanner taskSummary="some task" columns={80} />
    );
    expect(lastFrame()!).toContain('▸');
  });

  it('truncates long ASCII text with ellipsis in rendered output', () => {
    const longTask = 'A'.repeat(200);
    const { lastFrame } = render(
      <TaskBanner taskSummary={longTask} columns={80} />
    );
    const output = lastFrame()!;
    expect(output).toContain('…');
    expect(output.replace(/[^A]/g, '').length).toBeLessThan(200);
  });

  it('renders CJK task text correctly', () => {
    const { lastFrame } = render(
      <TaskBanner taskSummary="请查看本项目" columns={80} />
    );
    const output = lastFrame()!;
    expect(output).toContain('请查看本项目');
    expect(output).toContain('Task:');
  });

  it('truncates long CJK text without overflowing terminal width', () => {
    const cjkTask = '请查看本项目，然后提出3项最重要的对于用户体验的优化方案';
    const { lastFrame } = render(
      <TaskBanner taskSummary={cjkTask} columns={40} />
    );
    const output = lastFrame()!;
    // Must contain ellipsis (text is too long for 40 cols)
    expect(output).toContain('…');
    // Must contain the prefix
    expect(output).toContain('Task:');
  });

  it('collapses multiline task text into single line', () => {
    const multilineTask = 'Line one\nLine two\nLine three';
    const { lastFrame } = render(
      <TaskBanner taskSummary={multilineTask} columns={80} />
    );
    const output = lastFrame()!;
    expect(output).toContain('Line one Line two Line three');
  });

  it('handles empty string gracefully', () => {
    const { lastFrame } = render(
      <TaskBanner taskSummary="" columns={80} />
    );
    const output = lastFrame()!;
    expect(output).toContain('Task:');
  });

  it('renders within 1 line height', () => {
    const { lastFrame } = render(
      <TaskBanner taskSummary="A task" columns={80} />
    );
    const output = lastFrame()!;
    const lines = output.split('\n');
    expect(lines.length).toBe(1);
  });

  it('displays short text without truncation', () => {
    const { lastFrame } = render(
      <TaskBanner taskSummary="Short" columns={80} />
    );
    const output = lastFrame()!;
    expect(output).toContain('Short');
    expect(output).not.toContain('…');
  });
});
