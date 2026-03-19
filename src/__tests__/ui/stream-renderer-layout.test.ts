import { describe, expect, it } from 'vitest';
import type { MarkdownSegment } from '../../ui/markdown-parser.js';
import {
  buildStreamRenderModel,
  getSystemMessageAppearance,
} from '../../ui/stream-renderer-layout.js';

describe('buildStreamRenderModel', () => {
  it('compacts activity runs into one summary in minimal mode', () => {
    const segments: MarkdownSegment[] = [
      { type: 'activity_block', kind: 'activity', title: 'Bash', content: 'Count git-tracked files' },
      { type: 'activity_block', kind: 'result', title: 'Result', content: '214 files' },
    ];

    const model = buildStreamRenderModel(segments, 'minimal');

    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({
      kind: 'activity_summary',
      tone: 'accent',
    });
  });

  it('preserves paragraph separation metadata for plain text', () => {
    const segments: MarkdownSegment[] = [
      { type: 'text', content: 'first paragraph\n\nsecond paragraph' },
    ];

    const model = buildStreamRenderModel(segments, 'minimal');

    expect(model.filter((entry) => entry.kind === 'paragraph')).toHaveLength(2);
    expect(model[0]?.spacingAfter).toBe(1);
  });
});

describe('getSystemMessageAppearance', () => {
  it('returns a lighter tone for routing and waiting messages', () => {
    expect(getSystemMessageAppearance('routing').tone).toBe('muted');
    expect(getSystemMessageAppearance('waiting').tone).toBe('muted');
    expect(getSystemMessageAppearance('interrupt').tone).toBe('warning');
  });
});
