/**
 * Integration tests for the StreamRenderer data pipeline.
 * Tests parseMarkdown → buildStreamRenderModel to verify the exact
 * render entries that reach SegmentView in the dashboard.
 */
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../ui/markdown-parser.js';
import { buildStreamRenderModel, type ParagraphSpan, type StreamRenderEntry } from '../../ui/stream-renderer-layout.js';

function render(content: string, displayMode: 'minimal' | 'verbose' = 'minimal'): StreamRenderEntry[] {
  return buildStreamRenderModel(parseMarkdown(content), displayMode);
}

function getSpans(entry: StreamRenderEntry): ParagraphSpan[] {
  if ('spans' in entry) return entry.spans;
  return [];
}

describe('StreamRenderer integration: paragraph links', () => {
  it('preserves link span with url in paragraph', () => {
    const model = render('See [docs](https://example.com) for details');
    expect(model).toHaveLength(1);
    expect(model[0]!.kind).toBe('paragraph');
    const spans = getSpans(model[0]!);
    const linkSpan = spans.find((s) => s.kind === 'link');
    expect(linkSpan).toBeDefined();
    expect(linkSpan!.text).toBe('docs');
    expect(linkSpan!.url).toBe('https://example.com');
  });

  it('preserves multiple links in a paragraph', () => {
    const model = render('Check [a](url1) and [b](url2)');
    const spans = getSpans(model[0]!);
    const links = spans.filter((s) => s.kind === 'link');
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toBe('url1');
    expect(links[1]!.url).toBe('url2');
  });
});

describe('StreamRenderer integration: blockquote inline spans', () => {
  it('preserves bold in blockquote spans', () => {
    const model = render('> This is **important**');
    expect(model).toHaveLength(1);
    expect(model[0]!.kind).toBe('blockquote');
    const spans = getSpans(model[0]!);
    const boldSpan = spans.find((s) => s.kind === 'bold');
    expect(boldSpan).toBeDefined();
    expect(boldSpan!.text).toBe('important');
  });

  it('preserves inline_code in blockquote spans', () => {
    const model = render('> Run `npm test` now');
    const spans = getSpans(model[0]!);
    const codeSpan = spans.find((s) => s.kind === 'inline_code');
    expect(codeSpan).toBeDefined();
    expect(codeSpan!.text).toBe('npm test');
  });

  it('preserves link with url in blockquote spans', () => {
    const model = render('> See [docs](https://example.com)');
    const spans = getSpans(model[0]!);
    const linkSpan = spans.find((s) => s.kind === 'link');
    expect(linkSpan).toBeDefined();
    expect(linkSpan!.text).toBe('docs');
    expect(linkSpan!.url).toBe('https://example.com');
  });

  it('preserves mixed inline formatting in blockquote', () => {
    const model = render('> **bold** and `code` and [link](url)');
    const spans = getSpans(model[0]!);
    expect(spans.find((s) => s.kind === 'bold')).toBeDefined();
    expect(spans.find((s) => s.kind === 'inline_code')).toBeDefined();
    expect(spans.find((s) => s.kind === 'link')).toBeDefined();
  });

  it('preserves inline formatting in multi-line blockquote', () => {
    const model = render('> **bold** line\n> *italic* line');
    const spans = getSpans(model[0]!);
    expect(spans.find((s) => s.kind === 'bold')!.text).toBe('bold');
    expect(spans.find((s) => s.kind === 'italic')!.text).toBe('italic');
  });
});

describe('StreamRenderer integration: heading with links', () => {
  it('preserves link with url in heading spans', () => {
    const model = render('## [Getting Started](https://docs.example.com)');
    expect(model[0]!.kind).toBe('heading');
    const spans = getSpans(model[0]!);
    const linkSpan = spans.find((s) => s.kind === 'link');
    expect(linkSpan).toBeDefined();
    expect(linkSpan!.text).toBe('Getting Started');
    expect(linkSpan!.url).toBe('https://docs.example.com');
  });

  it('preserves multiple links in heading', () => {
    const model = render('# [A](url1) and [B](url2)');
    const spans = getSpans(model[0]!);
    const links = spans.filter((s) => s.kind === 'link');
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toBe('url1');
    expect(links[1]!.url).toBe('url2');
  });
});

describe('StreamRenderer integration: list_item with links', () => {
  it('preserves link with url in list_item spans', () => {
    const model = render('- See [docs](https://example.com)');
    expect(model[0]!.kind).toBe('list_item');
    const spans = getSpans(model[0]!);
    const linkSpan = spans.find((s) => s.kind === 'link');
    expect(linkSpan).toBeDefined();
    expect(linkSpan!.text).toBe('docs');
    expect(linkSpan!.url).toBe('https://example.com');
  });

  it('preserves multiple links in list_item', () => {
    const model = render('- [a](url1) and [b](url2)');
    const spans = getSpans(model[0]!);
    const links = spans.filter((s) => s.kind === 'link');
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toBe('url1');
    expect(links[1]!.url).toBe('url2');
  });

  it('preserves bold and link together in list_item', () => {
    const model = render('- **Important**: [docs](url)');
    const spans = getSpans(model[0]!);
    expect(spans.find((s) => s.kind === 'bold')!.text).toBe('Important');
    expect(spans.find((s) => s.kind === 'link')!.url).toBe('url');
  });
});

describe('StreamRenderer integration: link URL consistency', () => {
  it('all block types preserve link url in spans (not flattened or lost)', () => {
    const cases = [
      { md: 'See [docs](url)', expectedKind: 'paragraph' },
      { md: '## [Title](url)', expectedKind: 'heading' },
      { md: '> [Quote](url)', expectedKind: 'blockquote' },
      { md: '- [Item](url)', expectedKind: 'list_item' },
    ];

    for (const { md, expectedKind } of cases) {
      const model = render(md);
      expect(model[0]!.kind).toBe(expectedKind);
      const spans = getSpans(model[0]!);
      const linkSpan = spans.find((s) => s.kind === 'link');
      expect(linkSpan, `Link span missing in ${expectedKind} for: ${md}`).toBeDefined();
      expect(linkSpan!.url, `URL missing in ${expectedKind} for: ${md}`).toBe('url');
    }
  });
});
