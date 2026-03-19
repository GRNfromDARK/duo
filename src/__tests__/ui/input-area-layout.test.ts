import { describe, expect, it } from 'vitest';
import { buildInputAreaLayout } from '../../ui/input-area-layout.js';

describe('buildInputAreaLayout', () => {
  it('keeps placeholder and running states compact', () => {
    const idle = buildInputAreaLayout({
      value: '',
      cursorPos: 0,
      isLLMRunning: false,
      maxLines: 5,
    });
    const running = buildInputAreaLayout({
      value: '',
      cursorPos: 0,
      isLLMRunning: true,
      maxLines: 5,
    });

    expect(idle.height).toBe(2);
    expect(idle.promptIcon).toBe('▸');
    expect(idle.statusText).toBe('READY');
    expect(idle.cursorChar).toBe('█');
    expect(running.promptIcon).toBe('◆');
    expect(running.statusText).toBe('RUNNING');
    expect(running.placeholderText).toContain('interrupt');
  });

  it('preserves prompt alignment for multi-line input', () => {
    const layout = buildInputAreaLayout({
      value: 'first line\nsecond line',
      cursorPos: 'first line\nsecond'.length,
      isLLMRunning: false,
      maxLines: 5,
    });

    expect(layout.lines.map((line) => line.prefix)).toEqual(['▸ ', '  ']);
    expect(layout.height).toBe(2);
  });

  it('marks the region as a composer footer', () => {
    const layout = buildInputAreaLayout({
      value: '',
      cursorPos: 0,
      isLLMRunning: false,
      maxLines: 5,
    });

    expect(layout.region).toBe('composer');
  });

  it('keeps helper guidance visible when a single-line input is active', () => {
    const layout = buildInputAreaLayout({
      value: 'hello',
      cursorPos: 5,
      isLLMRunning: false,
      maxLines: 5,
    });

    expect(layout.height).toBe(2);
    expect(layout.helperText).toContain('Enter sends');
  });
});
