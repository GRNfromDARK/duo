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
      badgeText: '1 action · 1 result',
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

  it('keeps inline markdown tokens in a single paragraph flow', () => {
    const segments: MarkdownSegment[] = [
      { type: 'text', content: 'Inspect ' },
      { type: 'inline_code', content: 'toRuntimeInput' },
      { type: 'text', content: ' and ' },
      { type: 'inline_code', content: '@opentui/core' },
      { type: 'text', content: ' using ' },
      { type: 'bold', content: 'ParsedKey' },
      { type: 'text', content: '.' },
    ];

    const model = buildStreamRenderModel(segments, 'minimal');

    expect(model).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: 'Inspect ' },
          { kind: 'inline_code', text: 'toRuntimeInput' },
          { kind: 'text', text: ' and ' },
          { kind: 'inline_code', text: '@opentui/core' },
          { kind: 'text', text: ' using ' },
          { kind: 'bold', text: 'ParsedKey' },
          { kind: 'text', text: '.' },
        ],
        spacingAfter: 0,
      },
    ]);
  });

  it('extracts tool update summaries into badge metadata before the prose body', () => {
    const segments: MarkdownSegment[] = [
      {
        type: 'text',
        content: '⏺ 112 tool updates · latest Grep: {\n我来排查项目中所有输入框无法粘贴的问题。',
      },
    ];

    const model = buildStreamRenderModel(segments, 'minimal');

    expect(model[0]).toMatchObject({
      kind: 'activity_summary',
      badgeText: '112 tool updates',
      detailText: 'latest Grep: {',
    });
    expect(model[1]).toEqual({
      kind: 'paragraph',
      spans: [
        { kind: 'text', text: '我来排查项目中所有输入框无法粘贴的问题。' },
      ],
      spacingAfter: 0,
    });
  });

  describe('headings', () => {
    it('converts heading segment to heading render entry', () => {
      const segments: MarkdownSegment[] = [
        { type: 'heading', level: 2, spans: [{ type: 'text', content: 'Title' }] },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model).toEqual([
        {
          kind: 'heading',
          level: 2,
          spans: [{ kind: 'text', text: 'Title' }],
          spacingAfter: 1,
        },
      ]);
    });

    it('preserves inline formatting in heading spans', () => {
      const segments: MarkdownSegment[] = [
        {
          type: 'heading',
          level: 1,
          spans: [
            { type: 'bold', content: 'Bold' },
            { type: 'text', content: ' and ' },
            { type: 'inline_code', content: 'code' },
          ],
        },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model[0]).toMatchObject({
        kind: 'heading',
        level: 1,
        spans: [
          { kind: 'bold', text: 'Bold' },
          { kind: 'text', text: ' and ' },
          { kind: 'inline_code', text: 'code' },
        ],
      });
    });

    it('flushes preceding paragraph before heading', () => {
      const segments: MarkdownSegment[] = [
        { type: 'text', content: 'Intro text' },
        { type: 'heading', level: 2, spans: [{ type: 'text', content: 'Title' }] },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model).toHaveLength(2);
      expect(model[0]).toMatchObject({ kind: 'paragraph' });
      expect(model[1]).toMatchObject({ kind: 'heading' });
    });
  });

  describe('blockquotes', () => {
    it('converts blockquote segment to blockquote render entry', () => {
      const segments: MarkdownSegment[] = [
        { type: 'blockquote', spans: [{ type: 'text', content: 'Quoted text' }] },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model).toEqual([
        {
          kind: 'blockquote',
          spans: [{ kind: 'text', text: 'Quoted text' }],
          spacingAfter: 1,
        },
      ]);
    });

    it('preserves inline formatting in blockquote', () => {
      const segments: MarkdownSegment[] = [
        {
          type: 'blockquote',
          spans: [
            { type: 'text', content: 'This is ' },
            { type: 'bold', content: 'important' },
          ],
        },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model[0]).toMatchObject({
        kind: 'blockquote',
        spans: [
          { kind: 'text', text: 'This is ' },
          { kind: 'bold', text: 'important' },
        ],
      });
    });
  });

  describe('links', () => {
    it('includes link span in paragraph', () => {
      const segments: MarkdownSegment[] = [
        { type: 'text', content: 'See ' },
        { type: 'link', text: 'docs', url: 'https://example.com' },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model).toEqual([
        {
          kind: 'paragraph',
          spans: [
            { kind: 'text', text: 'See ' },
            { kind: 'link', text: 'docs', url: 'https://example.com' },
          ],
          spacingAfter: 0,
        },
      ]);
    });
  });

  describe('list items with inline spans', () => {
    it('converts list item spans to paragraph spans', () => {
      const segments: MarkdownSegment[] = [
        {
          type: 'list_item',
          marker: '-',
          spans: [
            { type: 'bold', content: 'Bold' },
            { type: 'text', content: ' item' },
          ],
        },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model).toEqual([
        {
          kind: 'list_item',
          marker: '-',
          spans: [
            { kind: 'bold', text: 'Bold' },
            { kind: 'text', text: ' item' },
          ],
          spacingAfter: 0,
        },
      ]);
    });

    it('handles list item with link', () => {
      const segments: MarkdownSegment[] = [
        {
          type: 'list_item',
          marker: '-',
          spans: [
            { type: 'text', content: 'See ' },
            { type: 'link', text: 'docs', url: 'https://example.com' },
          ],
        },
      ];

      const model = buildStreamRenderModel(segments, 'minimal');

      expect(model[0]).toMatchObject({
        kind: 'list_item',
        spans: [
          { kind: 'text', text: 'See ' },
          { kind: 'link', text: 'docs', url: 'https://example.com' },
        ],
      });
    });
  });
});

describe('getSystemMessageAppearance', () => {
  it('returns a lighter tone for routing and waiting messages', () => {
    expect(getSystemMessageAppearance('routing').tone).toBe('muted');
    expect(getSystemMessageAppearance('waiting').tone).toBe('muted');
    expect(getSystemMessageAppearance('interrupt').tone).toBe('warning');
  });
});
