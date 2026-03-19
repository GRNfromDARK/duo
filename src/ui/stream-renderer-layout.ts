import type { DisplayMode } from './display-mode.js';
import type { InlineSpan, MarkdownSegment } from './markdown-parser.js';

export type StreamTone = 'accent' | 'muted' | 'warning' | 'neutral';
export type ParagraphSpanKind = 'text' | 'inline_code' | 'bold' | 'italic' | 'link';

export interface ParagraphSpan {
  kind: ParagraphSpanKind;
  text: string;
  url?: string;
}

export type StreamRenderEntry =
  | { kind: 'paragraph'; spans: ParagraphSpan[]; spacingAfter: number }
  | { kind: 'list_item'; marker: string; spans: ParagraphSpan[]; spacingAfter: number }
  | { kind: 'heading'; level: number; spans: ParagraphSpan[]; spacingAfter: number }
  | { kind: 'blockquote'; spans: ParagraphSpan[]; spacingAfter: number }
  | { kind: 'table'; headers: string[]; rows: string[][]; spacingAfter: number }
  | { kind: 'code_block'; content: string; language?: string; spacingAfter: number }
  | { kind: 'activity_block'; title: string; content: string; tone: StreamTone; spacingAfter: number }
  | {
    kind: 'activity_summary';
    summary: string;
    badgeText: string;
    detailText?: string;
    tone: StreamTone;
    spacingAfter: number;
  };

export interface SystemMessageAppearance {
  tone: StreamTone;
  color: string;
  prefix: string;
}

function inlineSpansToParagraphSpans(spans: InlineSpan[]): ParagraphSpan[] {
  const result: ParagraphSpan[] = [];
  for (const span of spans) {
    switch (span.type) {
      case 'text':
        appendParagraphSpan(result, { kind: 'text', text: span.content });
        break;
      case 'bold':
        appendParagraphSpan(result, { kind: 'bold', text: span.content });
        break;
      case 'italic':
        appendParagraphSpan(result, { kind: 'italic', text: span.content });
        break;
      case 'inline_code':
        appendParagraphSpan(result, { kind: 'inline_code', text: span.content });
        break;
      case 'link':
        appendParagraphSpan(result, { kind: 'link', text: span.text, url: span.url });
        break;
    }
  }
  return result;
}

function toneForActivity(kind: 'activity' | 'result' | 'error'): StreamTone {
  if (kind === 'error') return 'warning';
  if (kind === 'result') return 'muted';
  return 'accent';
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/g);
}

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function appendParagraphSpan(spans: ParagraphSpan[], nextSpan: ParagraphSpan): void {
  if (nextSpan.text.length === 0) return;

  const previous = spans[spans.length - 1];
  if (previous?.kind === 'text' && nextSpan.kind === 'text') {
    previous.text += nextSpan.text;
    return;
  }

  spans.push(nextSpan);
}

function flushParagraph(
  entries: StreamRenderEntry[],
  spans: ParagraphSpan[],
  spacingAfter: number,
): void {
  if (spans.length === 0) {
    return;
  }

  entries.push({
    kind: 'paragraph',
    spans: [...spans],
    spacingAfter,
  });
  spans.length = 0;
}

function appendTextContent(
  entries: StreamRenderEntry[],
  spans: ParagraphSpan[],
  text: string,
): void {
  const paragraphs = splitParagraphs(text);

  paragraphs.forEach((paragraph, index) => {
    appendParagraphSpan(spans, { kind: 'text', text: paragraph });
    if (index < paragraphs.length - 1) {
      flushParagraph(entries, spans, 1);
    }
  });
}

function extractToolUpdateSummary(
  text: string,
): { badgeText: string; detailText?: string; remainingText: string } | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const firstLine = lines[0]?.trim();
  if (!firstLine) return null;

  const match = /^⏺\s+(\d+ tool updates(?: · \d+ warnings?)?)(?: · (latest .+))?$/.exec(firstLine);
  if (!match) {
    return null;
  }

  return {
    badgeText: match[1]!,
    detailText: match[2] ?? undefined,
    remainingText: lines.slice(1).join('\n').replace(/^\n+/, ''),
  };
}

function summarizeActivityRun(
  run: Array<Extract<MarkdownSegment, { type: 'activity_block' }>>,
): StreamRenderEntry {
  const latest = run[run.length - 1]!;
  const latestActivity = [...run].reverse().find((segment) => segment.kind === 'activity') ?? latest;
  const latestSummary = latestActivity.content.split('\n').find((line) => line.trim().length > 0) ?? latestActivity.title;
  const activityCount = run.filter((segment) => segment.kind === 'activity').length;
  const resultCount = run.filter((segment) => segment.kind === 'result').length;
  const errorCount = run.filter((segment) => segment.kind === 'error').length;

  const parts: string[] = [];
  if (activityCount > 0) parts.push(pluralize(activityCount, 'action'));
  if (resultCount > 0) parts.push(pluralize(resultCount, 'result'));
  if (errorCount > 0) parts.push(pluralize(errorCount, 'warning'));

  const badgeText = run.length > 1
    ? parts.join(' · ')
    : latestActivity.title;
  const detailText = latestSummary
    ? `latest ${latestActivity.title}: ${latestSummary}`
    : undefined;
  const summary = [badgeText, detailText].filter(Boolean).join(' · ');

  const tone = errorCount > 0
    ? 'warning'
    : activityCount > 0
      ? 'accent'
      : 'muted';

  return {
    kind: 'activity_summary',
    summary,
    badgeText,
    detailText,
    tone,
    spacingAfter: 1,
  };
}

export function buildStreamRenderModel(
  segments: MarkdownSegment[],
  displayMode: DisplayMode,
): StreamRenderEntry[] {
  const entries: StreamRenderEntry[] = [];
  const paragraphSpans: ParagraphSpan[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;

    if (segment.type === 'activity_block' && displayMode === 'minimal') {
      flushParagraph(entries, paragraphSpans, 1);
      const activityRun = [segment];
      while (index + 1 < segments.length && segments[index + 1]?.type === 'activity_block') {
        activityRun.push(segments[index + 1] as Extract<MarkdownSegment, { type: 'activity_block' }>);
        index += 1;
      }
      entries.push(summarizeActivityRun(activityRun));
      continue;
    }

    switch (segment.type) {
      case 'text': {
        const toolSummary = extractToolUpdateSummary(segment.content);
        if (toolSummary) {
          flushParagraph(entries, paragraphSpans, 1);
          entries.push({
            kind: 'activity_summary',
            summary: [toolSummary.badgeText, toolSummary.detailText].filter(Boolean).join(' · '),
            badgeText: toolSummary.badgeText,
            detailText: toolSummary.detailText,
            tone: toolSummary.badgeText.includes('warning') ? 'warning' : 'accent',
            spacingAfter: toolSummary.remainingText.trim().length > 0 ? 1 : 0,
          });
          if (toolSummary.remainingText.trim().length > 0) {
            appendTextContent(entries, paragraphSpans, toolSummary.remainingText);
          }
          break;
        }

        appendTextContent(entries, paragraphSpans, segment.content);
        break;
      }

      case 'inline_code':
        appendParagraphSpan(paragraphSpans, { kind: 'inline_code', text: segment.content });
        break;

      case 'bold':
        appendParagraphSpan(paragraphSpans, { kind: 'bold', text: segment.content });
        break;

      case 'italic':
        appendParagraphSpan(paragraphSpans, { kind: 'italic', text: segment.content });
        break;

      case 'link':
        appendParagraphSpan(paragraphSpans, { kind: 'link', text: segment.text, url: segment.url });
        break;

      case 'heading':
        flushParagraph(entries, paragraphSpans, 1);
        entries.push({
          kind: 'heading',
          level: segment.level,
          spans: inlineSpansToParagraphSpans(segment.spans),
          spacingAfter: 1,
        });
        break;

      case 'blockquote':
        flushParagraph(entries, paragraphSpans, 1);
        entries.push({
          kind: 'blockquote',
          spans: inlineSpansToParagraphSpans(segment.spans),
          spacingAfter: 1,
        });
        break;

      case 'list_item':
        flushParagraph(entries, paragraphSpans, 1);
        entries.push({
          kind: 'list_item',
          marker: segment.marker,
          spans: inlineSpansToParagraphSpans(segment.spans),
          spacingAfter: 0,
        });
        break;

      case 'table':
        flushParagraph(entries, paragraphSpans, 1);
        entries.push({
          kind: 'table',
          headers: segment.headers,
          rows: segment.rows,
          spacingAfter: 1,
        });
        break;

      case 'code_block':
        flushParagraph(entries, paragraphSpans, 1);
        entries.push({
          kind: 'code_block',
          content: segment.content,
          language: segment.language,
          spacingAfter: 1,
        });
        break;

      case 'activity_block':
        flushParagraph(entries, paragraphSpans, 1);
        entries.push({
          kind: 'activity_block',
          title: segment.title,
          content: segment.content,
          tone: toneForActivity(segment.kind),
          spacingAfter: 1,
        });
        break;
    }
  }

  flushParagraph(entries, paragraphSpans, 0);
  return entries;
}

export function getSystemMessageAppearance(
  type: 'routing' | 'interrupt' | 'waiting',
): SystemMessageAppearance {
  switch (type) {
    case 'interrupt':
      return { tone: 'warning', color: 'yellow', prefix: '⚠' };
    case 'routing':
      return { tone: 'muted', color: 'gray', prefix: '·' };
    case 'waiting':
      return { tone: 'muted', color: 'gray', prefix: '›' };
  }
}

export function toneToColor(tone: StreamTone): string {
  switch (tone) {
    case 'warning':
      return 'red';
    case 'muted':
      return 'gray';
    case 'accent':
      return 'cyan';
    default:
      return 'white';
  }
}
