import { describe, it, expect } from 'vitest';
import {
  parseMarkdown,
  parseInlineSpans,
  type MarkdownSegment,
  type InlineSpan,
} from '../../ui/markdown-parser.js';

describe('parseInlineSpans', () => {
  it('returns plain text for simple input', () => {
    expect(parseInlineSpans('hello')).toEqual([{ type: 'text', content: 'hello' }]);
  });

  it('returns empty array for empty string', () => {
    expect(parseInlineSpans('')).toEqual([]);
  });

  it('parses bold, italic, inline code', () => {
    const spans = parseInlineSpans('Use **bold** and *italic* and `code`');
    expect(spans).toEqual([
      { type: 'text', content: 'Use ' },
      { type: 'bold', content: 'bold' },
      { type: 'text', content: ' and ' },
      { type: 'italic', content: 'italic' },
      { type: 'text', content: ' and ' },
      { type: 'inline_code', content: 'code' },
    ]);
  });

  it('parses links', () => {
    const spans = parseInlineSpans('See [docs](https://example.com) for info');
    expect(spans).toEqual([
      { type: 'text', content: 'See ' },
      { type: 'link', text: 'docs', url: 'https://example.com' },
      { type: 'text', content: ' for info' },
    ]);
  });

  it('handles link with empty URL', () => {
    const spans = parseInlineSpans('[text]()');
    expect(spans).toEqual([
      { type: 'link', text: 'text', url: '' },
    ]);
  });

  it('handles unclosed link bracket as plain text', () => {
    const spans = parseInlineSpans('See [unclosed for details');
    expect(spans).toEqual([
      { type: 'text', content: 'See [unclosed for details' },
    ]);
  });

  it('handles multiple links in one line', () => {
    const spans = parseInlineSpans('[a](url1) and [b](url2)');
    expect(spans).toEqual([
      { type: 'link', text: 'a', url: 'url1' },
      { type: 'text', content: ' and ' },
      { type: 'link', text: 'b', url: 'url2' },
    ]);
  });
});

describe('parseMarkdown', () => {
  describe('plain text', () => {
    it('returns plain text segment for simple text', () => {
      const result = parseMarkdown('Hello world');
      expect(result).toEqual([{ type: 'text', content: 'Hello world' }]);
    });

    it('handles empty string', () => {
      const result = parseMarkdown('');
      expect(result).toEqual([]);
    });

    it('handles multi-line plain text', () => {
      const result = parseMarkdown('Line 1\nLine 2');
      expect(result).toEqual([{ type: 'text', content: 'Line 1\nLine 2' }]);
    });
  });

  describe('code blocks', () => {
    it('parses a complete fenced code block with language', () => {
      const input = '```typescript\nconst x = 1;\n```';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        { type: 'code_block', content: 'const x = 1;', language: 'typescript' },
      ]);
    });

    it('parses a code block without language', () => {
      const input = '```\nsome code\n```';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        { type: 'code_block', content: 'some code', language: undefined },
      ]);
    });

    it('parses an unclosed code block (streaming scenario)', () => {
      const input = '```python\ndef hello():\n  print("hi")';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        { type: 'code_block', content: 'def hello():\n  print("hi")', language: 'python' },
      ]);
    });

    it('parses text before and after a code block', () => {
      const input = 'Before\n```js\ncode\n```\nAfter';
      const result = parseMarkdown(input);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'text', content: 'Before' });
      expect(result[1]).toEqual({ type: 'code_block', content: 'code', language: 'js' });
      expect(result[2]).toEqual({ type: 'text', content: 'After' });
    });

    it('handles multiple code blocks', () => {
      const input = '```ts\na\n```\nMiddle\n```py\nb\n```';
      const result = parseMarkdown(input);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'code_block', content: 'a', language: 'ts' });
      expect(result[1]).toEqual({ type: 'text', content: 'Middle' });
      expect(result[2]).toEqual({ type: 'code_block', content: 'b', language: 'py' });
    });
  });

  describe('inline code', () => {
    it('parses inline code within text', () => {
      const result = parseMarkdown('Use `npm install` to install');
      expect(result).toEqual([
        { type: 'text', content: 'Use ' },
        { type: 'inline_code', content: 'npm install' },
        { type: 'text', content: ' to install' },
      ]);
    });
  });

  describe('bold and italic', () => {
    it('parses bold text (**)', () => {
      const result = parseMarkdown('This is **bold** text');
      expect(result).toEqual([
        { type: 'text', content: 'This is ' },
        { type: 'bold', content: 'bold' },
        { type: 'text', content: ' text' },
      ]);
    });

    it('parses italic text (*)', () => {
      const result = parseMarkdown('This is *italic* text');
      expect(result).toEqual([
        { type: 'text', content: 'This is ' },
        { type: 'italic', content: 'italic' },
        { type: 'text', content: ' text' },
      ]);
    });
  });

  describe('links', () => {
    it('parses inline link in plain text', () => {
      const result = parseMarkdown('Check [docs](https://example.com) here');
      expect(result).toEqual([
        { type: 'text', content: 'Check ' },
        { type: 'link', text: 'docs', url: 'https://example.com' },
        { type: 'text', content: ' here' },
      ]);
    });

    it('handles unclosed link as plain text', () => {
      const result = parseMarkdown('Check [broken link here');
      expect(result).toEqual([
        { type: 'text', content: 'Check [broken link here' },
      ]);
    });
  });

  describe('headings', () => {
    it('parses h1 through h6', () => {
      for (let level = 1; level <= 6; level++) {
        const hashes = '#'.repeat(level);
        const result = parseMarkdown(`${hashes} Heading ${level}`);
        expect(result).toEqual([
          {
            type: 'heading',
            level,
            spans: [{ type: 'text', content: `Heading ${level}` }],
          },
        ]);
      }
    });

    it('parses heading with inline formatting', () => {
      const result = parseMarkdown('## **Bold** heading with `code`');
      expect(result).toEqual([
        {
          type: 'heading',
          level: 2,
          spans: [
            { type: 'bold', content: 'Bold' },
            { type: 'text', content: ' heading with ' },
            { type: 'inline_code', content: 'code' },
          ],
        },
      ]);
    });

    it('does not parse # without space as heading', () => {
      const result = parseMarkdown('#noHeading');
      expect(result).toEqual([{ type: 'text', content: '#noHeading' }]);
    });

    it('handles heading followed by code block', () => {
      const input = '## Title\n```js\ncode\n```';
      const result = parseMarkdown(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: 'heading', level: 2 });
      expect(result[1]).toMatchObject({ type: 'code_block', language: 'js' });
    });

    it('handles half-finished heading (streaming) as plain text', () => {
      // `## ` with no text after does not match heading regex (requires content)
      const result = parseMarkdown('## ');
      expect(result).toEqual([
        { type: 'text', content: '## ' },
      ]);
    });

    it('handles heading with link', () => {
      const result = parseMarkdown('# [Title](url)');
      expect(result).toEqual([
        {
          type: 'heading',
          level: 1,
          spans: [{ type: 'link', text: 'Title', url: 'url' }],
        },
      ]);
    });
  });

  describe('blockquotes', () => {
    it('parses single-line blockquote', () => {
      const result = parseMarkdown('> Hello world');
      expect(result).toEqual([
        {
          type: 'blockquote',
          spans: [{ type: 'text', content: 'Hello world' }],
        },
      ]);
    });

    it('parses multi-line consecutive blockquote', () => {
      const result = parseMarkdown('> Line 1\n> Line 2\n> Line 3');
      expect(result).toEqual([
        {
          type: 'blockquote',
          spans: [{ type: 'text', content: 'Line 1\nLine 2\nLine 3' }],
        },
      ]);
    });

    it('parses blockquote with inline formatting', () => {
      const result = parseMarkdown('> This is **important** and `code`');
      expect(result).toEqual([
        {
          type: 'blockquote',
          spans: [
            { type: 'text', content: 'This is ' },
            { type: 'bold', content: 'important' },
            { type: 'text', content: ' and ' },
            { type: 'inline_code', content: 'code' },
          ],
        },
      ]);
    });

    it('handles standalone > as empty blockquote', () => {
      const result = parseMarkdown('>');
      expect(result).toEqual([
        {
          type: 'blockquote',
          spans: [],
        },
      ]);
    });

    it('handles > with space only', () => {
      const result = parseMarkdown('> ');
      expect(result).toEqual([
        {
          type: 'blockquote',
          spans: [],
        },
      ]);
    });

    it('separates blockquote from following text', () => {
      const result = parseMarkdown('> Quote\nNormal text');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: 'blockquote' });
      expect(result[1]).toMatchObject({ type: 'text', content: 'Normal text' });
    });

    it('handles blockquote adjacent to code block', () => {
      const input = '> Note\n```js\ncode\n```';
      const result = parseMarkdown(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: 'blockquote' });
      expect(result[1]).toMatchObject({ type: 'code_block' });
    });

    it('handles consecutive blockquotes separated by blank line', () => {
      const input = '> First\n\n> Second';
      const result = parseMarkdown(input);
      // Blank line breaks the blockquote
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0]).toMatchObject({ type: 'blockquote' });
    });

    it('parses blockquote with link', () => {
      const result = parseMarkdown('> See [docs](url) for more');
      expect(result).toEqual([
        {
          type: 'blockquote',
          spans: [
            { type: 'text', content: 'See ' },
            { type: 'link', text: 'docs', url: 'url' },
            { type: 'text', content: ' for more' },
          ],
        },
      ]);
    });
  });

  describe('lists', () => {
    it('parses unordered list with -', () => {
      const input = '- Item 1\n- Item 2\n- Item 3';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        { type: 'list_item', spans: [{ type: 'text', content: 'Item 1' }], marker: '-' },
        { type: 'list_item', spans: [{ type: 'text', content: 'Item 2' }], marker: '-' },
        { type: 'list_item', spans: [{ type: 'text', content: 'Item 3' }], marker: '-' },
      ]);
    });

    it('parses unordered list with *', () => {
      const input = '* Item A\n* Item B';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        { type: 'list_item', spans: [{ type: 'text', content: 'Item A' }], marker: '*' },
        { type: 'list_item', spans: [{ type: 'text', content: 'Item B' }], marker: '*' },
      ]);
    });

    it('parses ordered list', () => {
      const input = '1. First\n2. Second\n3. Third';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        { type: 'list_item', spans: [{ type: 'text', content: 'First' }], marker: '1.' },
        { type: 'list_item', spans: [{ type: 'text', content: 'Second' }], marker: '2.' },
        { type: 'list_item', spans: [{ type: 'text', content: 'Third' }], marker: '3.' },
      ]);
    });

    it('parses text mixed with list', () => {
      const input = 'Intro:\n- Item 1\n- Item 2\nOutro';
      const result = parseMarkdown(input);
      expect(result[0]).toEqual({ type: 'text', content: 'Intro:' });
      expect(result[1]).toEqual({ type: 'list_item', spans: [{ type: 'text', content: 'Item 1' }], marker: '-' });
      expect(result[2]).toEqual({ type: 'list_item', spans: [{ type: 'text', content: 'Item 2' }], marker: '-' });
      expect(result[3]).toEqual({ type: 'text', content: 'Outro' });
    });

    it('parses list items with inline markdown', () => {
      const result = parseMarkdown('- **Bold** item\n- Item with `code`');
      expect(result).toEqual([
        {
          type: 'list_item',
          marker: '-',
          spans: [
            { type: 'bold', content: 'Bold' },
            { type: 'text', content: ' item' },
          ],
        },
        {
          type: 'list_item',
          marker: '-',
          spans: [
            { type: 'text', content: 'Item with ' },
            { type: 'inline_code', content: 'code' },
          ],
        },
      ]);
    });

    it('parses list item with link', () => {
      const result = parseMarkdown('- See [docs](url)');
      expect(result).toEqual([
        {
          type: 'list_item',
          marker: '-',
          spans: [
            { type: 'text', content: 'See ' },
            { type: 'link', text: 'docs', url: 'url' },
          ],
        },
      ]);
    });
  });

  describe('tables', () => {
    it('parses a simple table', () => {
      const input = '| Col A | Col B |\n|-------|-------|\n| val1  | val2  |';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        {
          type: 'table',
          headers: ['Col A', 'Col B'],
          rows: [['val1', 'val2']],
        },
      ]);
    });

    it('parses table with multiple rows', () => {
      const input = '| H1 | H2 |\n|---|---|\n| a | b |\n| c | d |';
      const result = parseMarkdown(input);
      expect(result).toEqual([
        {
          type: 'table',
          headers: ['H1', 'H2'],
          rows: [['a', 'b'], ['c', 'd']],
        },
      ]);
    });
  });

  describe('mixed content', () => {
    it('parses complex markdown with multiple element types', () => {
      const input = 'Here is a list:\n- Item **one**\n- Item *two*\n\n```js\nconsole.log("hi");\n```\nDone.';
      const result = parseMarkdown(input);
      // Should contain text, list items, code block, and final text
      expect(result.length).toBeGreaterThanOrEqual(4);
      const codeBlock = result.find(s => s.type === 'code_block');
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.content).toBe('console.log("hi");');
    });

    it('parses heading + blockquote + list + code block', () => {
      const input = '## Summary\n> Important note\n- Step 1\n- Step 2\n```bash\necho hi\n```';
      const result = parseMarkdown(input);
      expect(result[0]).toMatchObject({ type: 'heading', level: 2 });
      expect(result[1]).toMatchObject({ type: 'blockquote' });
      expect(result[2]).toMatchObject({ type: 'list_item', marker: '-' });
      expect(result[3]).toMatchObject({ type: 'list_item', marker: '-' });
      expect(result[4]).toMatchObject({ type: 'code_block', language: 'bash' });
    });
  });

  describe('activity blocks', () => {
    it('parses custom activity blocks', () => {
      const input = ':::activity Bash\nList files\n$ ls\n:::\nDone';
      const result = parseMarkdown(input);

      expect(result).toEqual([
        { type: 'activity_block', kind: 'activity', title: 'Bash', content: 'List files\n$ ls' },
        { type: 'text', content: 'Done' },
      ]);
    });

    it('parses custom error blocks', () => {
      const input = ':::error Read\nFile does not exist.\n:::';
      const result = parseMarkdown(input);

      expect(result).toEqual([
        { type: 'activity_block', kind: 'error', title: 'Read', content: 'File does not exist.' },
      ]);
    });
  });

  describe('edge cases for streaming', () => {
    it('handles heading at end of stream (no trailing newline)', () => {
      const result = parseMarkdown('## Title');
      expect(result).toEqual([
        { type: 'heading', level: 2, spans: [{ type: 'text', content: 'Title' }] },
      ]);
    });

    it('handles blockquote at end of stream', () => {
      const result = parseMarkdown('> Quote');
      expect(result).toEqual([
        { type: 'blockquote', spans: [{ type: 'text', content: 'Quote' }] },
      ]);
    });

    it('handles heading adjacent to blockquote', () => {
      const result = parseMarkdown('## Title\n> Quote');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: 'heading' });
      expect(result[1]).toMatchObject({ type: 'blockquote' });
    });

    it('handles blockquote adjacent to heading', () => {
      const result = parseMarkdown('> Quote\n## Title');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: 'blockquote' });
      expect(result[1]).toMatchObject({ type: 'heading' });
    });
  });
});
