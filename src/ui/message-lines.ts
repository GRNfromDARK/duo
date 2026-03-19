import { parseMarkdown, type MarkdownSegment, type InlineSpan } from './markdown-parser.js';
import type { DisplayMode } from './display-mode.js';
import { getRoleStyle } from '../types/ui.js';
import type { Message, RoleName } from '../types/ui.js';

export interface LineSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

export interface RenderedMessageLine {
  key: string;
  spans: LineSpan[];
}

const MIN_BODY_WIDTH = 16;

export function buildRenderedMessageLines(
  messages: Message[],
  displayMode: DisplayMode,
  columns: number,
): RenderedMessageLine[] {
  const bodyWidth = Math.max(MIN_BODY_WIDTH, columns - 2);
  const lines: RenderedMessageLine[] = [];

  for (const message of messages) {
    lines.push(buildHeaderLine(message, displayMode));

    if (displayMode === 'verbose' && message.metadata?.cliCommand) {
      for (const line of wrapText(message.metadata.cliCommand, bodyWidth)) {
        lines.push(buildBodyLine(message.role, `${'$ '}${line}`, { dimColor: true }, message.id, lines.length));
      }
    }

    for (const line of renderMessageBody(message.content, displayMode, bodyWidth)) {
      lines.push(buildBodyLine(message.role, line.text, line.style, message.id, lines.length));
    }

    lines.push({
      key: `${message.id}-spacer`,
      spans: [{ text: '' }],
    });
  }

  return lines;
}

function buildHeaderLine(
  message: Message,
  displayMode: DisplayMode,
): RenderedMessageLine {
  const style = getRoleStyle(message.role);
  const label = message.roleLabel
    ? `${style.displayName} · ${message.roleLabel}`
    : style.displayName;
  const time = formatTime(message.timestamp, displayMode === 'verbose');

  const spans: LineSpan[] = [
    { text: `${style.border} `, color: style.color },
    { text: `[${label}]`, color: style.color, bold: true },
    { text: ` ${time}`, color: 'gray' },
  ];

  if (displayMode === 'verbose' && message.metadata?.tokenCount != null) {
    spans.push({ text: ` [${formatTokenCount(message.metadata.tokenCount)} tokens]`, color: 'gray' });
  }

  return {
    key: `${message.id}-header`,
    spans,
  };
}

function buildBodyLine(
  role: RoleName,
  text: string,
  style: Pick<LineSpan, 'color' | 'bold' | 'dimColor'>,
  messageId: string,
  lineIndex: number,
): RenderedMessageLine {
  const roleStyle = getRoleStyle(role);

  return {
    key: `${messageId}-body-${lineIndex}`,
    spans: [
      { text: `${roleStyle.border} `, color: roleStyle.color },
      { text, ...style },
    ],
  };
}

function renderMessageBody(
  content: string,
  displayMode: DisplayMode,
  width: number,
): Array<{ text: string; style: Pick<LineSpan, 'color' | 'bold' | 'dimColor'> }> {
  const segments = parseMarkdown(content);
  const blocks = segmentsToBlocks(segments, displayMode);
  const lines: Array<{ text: string; style: Pick<LineSpan, 'color' | 'bold' | 'dimColor'> }> = [];

  for (const block of blocks) {
    for (const line of block.lines) {
      for (const wrapped of wrapText(line, width)) {
        lines.push({
          text: wrapped,
          style: block.style,
        });
      }
    }
  }

  if (lines.length === 0) {
    lines.push({ text: '', style: {} });
  }

  return lines;
}

function flattenSpans(spans: InlineSpan[]): string {
  return spans.map((span) => {
    switch (span.type) {
      case 'text':
      case 'bold':
      case 'italic':
      case 'inline_code':
        return span.content;
      case 'link':
        return span.url ? `${span.text} (${span.url})` : span.text;
    }
  }).join('');
}

function segmentsToBlocks(
  segments: MarkdownSegment[],
  displayMode: DisplayMode,
): Array<{ lines: string[]; style: Pick<LineSpan, 'color' | 'bold' | 'dimColor'> }> {
  const blocks: Array<{ lines: string[]; style: Pick<LineSpan, 'color' | 'bold' | 'dimColor'> }> = [];
  let paragraph = '';

  const flushParagraph = () => {
    if (!paragraph) {
      return;
    }
    blocks.push({
      lines: paragraph.split('\n'),
      style: {},
    });
    paragraph = '';
  };

  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        paragraph += segment.content;
        break;

      case 'bold':
        paragraph += segment.content;
        break;

      case 'italic':
        paragraph += segment.content;
        break;

      case 'inline_code':
        paragraph += `\`${segment.content}\``;
        break;

      case 'link':
        paragraph += segment.url ? `${segment.text} (${segment.url})` : segment.text;
        break;

      case 'heading':
        flushParagraph();
        blocks.push({
          lines: [flattenSpans(segment.spans)],
          style: { bold: true },
        });
        break;

      case 'blockquote': {
        flushParagraph();
        const bqText = flattenSpans(segment.spans);
        blocks.push({
          lines: bqText.split('\n').map((line) => `│ ${line}`),
          style: { dimColor: true },
        });
        break;
      }

      case 'list_item':
        flushParagraph();
        blocks.push({
          lines: [`${segment.marker === '-' || segment.marker === '*' ? '•' : segment.marker} ${flattenSpans(segment.spans)}`],
          style: {},
        });
        break;

      case 'code_block':
        flushParagraph();
        blocks.push({
          lines: [
            ...(segment.language ? [`[${segment.language}]`] : []),
            ...segment.content.split('\n'),
          ],
          style: { color: 'cyan' },
        });
        break;

      case 'table':
        flushParagraph();
        blocks.push({
          lines: [
            segment.headers.join(' | '),
            ...segment.rows.map((row) => row.join(' | ')),
          ],
          style: { dimColor: true },
        });
        break;

      case 'activity_block': {
        flushParagraph();
        const summary = segment.content.split('\n').find((line) => line.trim().length > 0) ?? segment.title;
        const icon =
          segment.kind === 'error' ? '⚠' :
          segment.kind === 'result' ? '⎿' :
          '⏺';
        const color =
          segment.kind === 'error' ? 'red' :
          segment.kind === 'result' ? 'gray' :
          'cyan';

        const lines = [`${icon} ${segment.title}: ${summary}`];
        if (displayMode === 'verbose') {
          lines.push(...segment.content.split('\n').slice(1));
        }

        blocks.push({
          lines,
          style: { color },
        });
        break;
      }
    }
  }

  flushParagraph();
  return blocks;
}

export function wrapText(text: string, width: number): string[] {
  if (text === '') {
    return [''];
  }

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  // Track the last safe break point (after a space or before a CJK char)
  let lastBreakPos = -1;    // index in `current` where we can break
  let lastBreakWidth = 0;   // width at that break point

  const chars = [...text];

  for (const char of chars) {
    const charWidth = getCharWidth(char);
    const isCJK = charWidth > 1;

    if (currentWidth + charWidth > width && current.length > 0) {
      // Need to break. Try word boundary first.
      if (lastBreakPos > 0) {
        // Break at the last word boundary
        lines.push(current.slice(0, lastBreakPos).trimEnd());
        const remainder = current.slice(lastBreakPos).trimStart();
        current = remainder + char;
        currentWidth = computeStringWidth(remainder) + charWidth;
      } else {
        // No word boundary found — hard break
        lines.push(current);
        current = char;
        currentWidth = charWidth;
      }
      lastBreakPos = -1;
      lastBreakWidth = 0;
    } else {
      current += char;
      currentWidth += charWidth;
    }

    // Update break point: space is a break opportunity (break after space),
    // CJK characters can break between any two chars
    if (char === ' ') {
      lastBreakPos = current.length;
      lastBreakWidth = currentWidth;
    } else if (isCJK) {
      lastBreakPos = current.length;
      lastBreakWidth = currentWidth;
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

export function computeStringWidth(s: string): number {
  let w = 0;
  for (const ch of [...s]) {
    w += getCharWidth(ch);
  }
  return w;
}

export function getCharWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;

  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  ) {
    return 2;
  }

  return 1;
}

function formatTime(timestamp: number, verbose: boolean): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  if (!verbose) return `${h}:${m}`;
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}
