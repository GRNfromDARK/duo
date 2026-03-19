/**
 * Markdown parser for TUI rendering.
 * Source: FR-023 (AC-076, AC-077)
 *
 * Parses markdown text into typed segments for rendering.
 * Supports: code blocks (fenced, unclosed for streaming), inline code,
 * bold, italic, links, headings, blockquotes, lists (ordered/unordered),
 * and tables.
 */

export type InlineSpan =
  | { type: 'text'; content: string }
  | { type: 'inline_code'; content: string }
  | { type: 'bold'; content: string }
  | { type: 'italic'; content: string }
  | { type: 'link'; text: string; url: string };

export type MarkdownSegment =
  | { type: 'text'; content: string }
  | { type: 'code_block'; content: string; language?: string }
  | { type: 'activity_block'; kind: 'activity' | 'result' | 'error'; title: string; content: string }
  | { type: 'inline_code'; content: string }
  | { type: 'bold'; content: string }
  | { type: 'italic'; content: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'list_item'; spans: InlineSpan[]; marker: string }
  | { type: 'heading'; level: number; spans: InlineSpan[] }
  | { type: 'blockquote'; spans: InlineSpan[] }
  | { type: 'table'; headers: string[]; rows: string[][] };

const FENCE_OPEN = /^```(\w*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const UNORDERED_LIST = /^([*-]) (.+)$/;
const ORDERED_LIST = /^(\d+)\. (.+)$/;
const TABLE_ROW = /^\|(.+)\|$/;
const TABLE_SEP = /^\|[\s-:|]+\|$/;
const ACTIVITY_OPEN = /^:::(activity|result|error)\s*(.*)$/;
const ACTIVITY_CLOSE = /^:::\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const BLOCKQUOTE = /^>\s?(.*)$/;

/**
 * Parse inline markdown into an array of InlineSpan.
 * Supports: **bold**, *italic*, `code`, [text](url)
 */
export function parseInlineSpans(text: string): InlineSpan[] {
  if (text.length === 0) return [];

  const spans: InlineSpan[] = [];
  // Match: **bold**, *italic*, `code`, [text](url)
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`|\[([^\]]*?)\]\(([^)]*?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    if (match[2] !== undefined) {
      spans.push({ type: 'bold', content: match[2] });
    } else if (match[3] !== undefined) {
      spans.push({ type: 'italic', content: match[3] });
    } else if (match[4] !== undefined) {
      spans.push({ type: 'inline_code', content: match[4] });
    } else if (match[5] !== undefined) {
      spans.push({ type: 'link', text: match[5], url: match[6] ?? '' });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    spans.push({ type: 'text', content: text.slice(lastIndex) });
  } else if (lastIndex === 0 && text.length > 0) {
    spans.push({ type: 'text', content: text });
  }

  return spans;
}

/**
 * Parse markdown text into an array of typed segments.
 * Unclosed code blocks are treated as open (for streaming).
 */
export function parseMarkdown(text: string): MarkdownSegment[] {
  if (text === '') return [];

  const lines = text.split('\n');
  const segments: MarkdownSegment[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const activityMatch = line.match(ACTIVITY_OPEN);
    if (activityMatch) {
      const kind = activityMatch[1] as 'activity' | 'result' | 'error';
      const title = activityMatch[2] ?? '';
      const blockLines: string[] = [];
      i++;

      while (i < lines.length && !ACTIVITY_CLOSE.test(lines[i])) {
        blockLines.push(lines[i]);
        i++;
      }

      if (i < lines.length && ACTIVITY_CLOSE.test(lines[i])) {
        i++;
      }

      segments.push({
        type: 'activity_block',
        kind,
        title,
        content: blockLines.join('\n'),
      });
      continue;
    }

    // Check for fenced code block opening
    const fenceMatch = line.match(FENCE_OPEN);
    if (fenceMatch && (line === '```' || line.startsWith('```'))) {
      const language = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;

      while (i < lines.length) {
        if (FENCE_CLOSE.test(lines[i])) {
          i++;
          break;
        }
        // Also check if this is a new fence open (edge case for unclosed + new block)
        codeLines.push(lines[i]);
        i++;
      }

      segments.push({
        type: 'code_block',
        content: codeLines.join('\n'),
        language,
      });
      continue;
    }

    // Check for heading
    const headingMatch = line.match(HEADING);
    if (headingMatch) {
      segments.push({
        type: 'heading',
        level: headingMatch[1].length,
        spans: parseInlineSpans(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Check for blockquote (collect consecutive > lines)
    const bqMatch = line.match(BLOCKQUOTE);
    if (bqMatch) {
      const bqLines: string[] = [];
      while (i < lines.length) {
        const bqLineMatch = lines[i].match(BLOCKQUOTE);
        if (bqLineMatch) {
          bqLines.push(bqLineMatch[1]);
          i++;
        } else {
          break;
        }
      }
      segments.push({
        type: 'blockquote',
        spans: parseInlineSpans(bqLines.join('\n')),
      });
      continue;
    }

    // Check for table (starts with |)
    if (TABLE_ROW.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      if (tableLines.length >= 2 && TABLE_SEP.test(tableLines[1])) {
        const headers = parseCells(tableLines[0]);
        const rows = tableLines.slice(2).map(parseCells);
        segments.push({ type: 'table', headers, rows });
      } else {
        // Not a valid table, treat as text
        addText(segments, tableLines.join('\n'));
      }
      continue;
    }

    // Check for unordered list item
    const ulMatch = line.match(UNORDERED_LIST);
    if (ulMatch) {
      segments.push({ type: 'list_item', spans: parseInlineSpans(ulMatch[2]), marker: ulMatch[1] });
      i++;
      continue;
    }

    // Check for ordered list item
    const olMatch = line.match(ORDERED_LIST);
    if (olMatch) {
      segments.push({ type: 'list_item', spans: parseInlineSpans(olMatch[2]), marker: `${olMatch[1]}.` });
      i++;
      continue;
    }

    // Plain text line — collect consecutive text lines
    const textLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        ACTIVITY_OPEN.test(l) ||
        l.match(FENCE_OPEN) ||
        l.match(HEADING) ||
        l.match(BLOCKQUOTE) ||
        TABLE_ROW.test(l) ||
        UNORDERED_LIST.test(l) ||
        ORDERED_LIST.test(l)
      ) {
        break;
      }
      textLines.push(l);
      i++;
    }

    const joined = textLines.join('\n');
    if (joined.length > 0) {
      parseInline(joined, segments);
    }
  }

  return segments;
}

function parseCells(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function addText(segments: MarkdownSegment[], content: string): void {
  if (content.length > 0) {
    segments.push({ type: 'text', content });
  }
}

/**
 * Parse inline markdown: **bold**, *italic*, `code`, [text](url)
 * Appends flat MarkdownSegment entries (legacy top-level inline segments).
 */
function parseInline(text: string, segments: MarkdownSegment[]): void {
  const spans = parseInlineSpans(text);
  for (const span of spans) {
    switch (span.type) {
      case 'text':
        segments.push({ type: 'text', content: span.content });
        break;
      case 'bold':
        segments.push({ type: 'bold', content: span.content });
        break;
      case 'italic':
        segments.push({ type: 'italic', content: span.content });
        break;
      case 'inline_code':
        segments.push({ type: 'inline_code', content: span.content });
        break;
      case 'link':
        segments.push({ type: 'link', text: span.text, url: span.url });
        break;
    }
  }
}
