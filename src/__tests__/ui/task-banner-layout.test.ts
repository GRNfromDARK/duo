import { describe, expect, it } from 'vitest';
import { computeStringWidth } from '../../ui/message-lines.js';
import { buildTaskBannerLayout } from '../../ui/task-banner-layout.js';

describe('buildTaskBannerLayout', () => {
  it('keeps single-line truncation CJK-safe', () => {
    const layout = buildTaskBannerLayout({
      taskSummary: '当前项目有多少个文件以及 node_modules 是否也计算在内',
      columns: 24,
    });

    expect(layout.displayText.endsWith('…')).toBe(true);
    expect(computeStringWidth(layout.displayText)).toBeLessThanOrEqual(layout.availableWidth);
  });

  it('balances prefix and body width in narrow terminals', () => {
    const layout = buildTaskBannerLayout({
      taskSummary: 'fix status bar spacing',
      columns: 18,
    });

    expect(layout.prefixText).toBe('▸ Task');
    expect(layout.availableWidth).toBeGreaterThan(0);
    expect(computeStringWidth(layout.prefixText)).toBeLessThan(layout.columns);
  });
});
