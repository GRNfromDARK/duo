import type { DisplayMode } from './display-mode.js';
import type { MarkdownSegment } from './markdown-parser.js';

export type StreamTone = 'accent' | 'muted' | 'warning' | 'neutral';

export type StreamRenderEntry =
  | { kind: 'paragraph'; text: string; spacingAfter: number }
  | { kind: 'inline_code'; content: string; spacingAfter: number }
  | { kind: 'bold'; text: string; spacingAfter: number }
  | { kind: 'italic'; text: string; spacingAfter: number }
  | { kind: 'list_item'; marker: string; text: string; spacingAfter: number }
  | { kind: 'table'; headers: string[]; rows: string[][]; spacingAfter: number }
  | { kind: 'code_block'; content: string; language?: string; spacingAfter: number }
  | { kind: 'activity_block'; title: string; content: string; tone: StreamTone; spacingAfter: number }
  | { kind: 'activity_summary'; summary: string; tone: StreamTone; spacingAfter: number };

export interface SystemMessageAppearance {
  tone: StreamTone;
  color: string;
  prefix: string;
}

function toneForActivity(kind: 'activity' | 'result' | 'error'): StreamTone {
  if (kind === 'error') return 'warning';
  if (kind === 'result') return 'muted';
  return 'accent';
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
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
  if (activityCount > 0) parts.push(`${activityCount} actions`);
  if (resultCount > 0) parts.push(`${resultCount} results`);
  if (errorCount > 0) parts.push(`${errorCount} errors`);

  const summary = run.length > 1
    ? `${parts.join(' · ')} · latest ${latestActivity.title}: ${latestSummary}`
    : `${latestActivity.title}: ${latestSummary}`;

  const tone = errorCount > 0
    ? 'warning'
    : activityCount > 0
      ? 'accent'
      : 'muted';

  return {
    kind: 'activity_summary',
    summary,
    tone,
    spacingAfter: 1,
  };
}

export function buildStreamRenderModel(
  segments: MarkdownSegment[],
  displayMode: DisplayMode,
): StreamRenderEntry[] {
  const entries: StreamRenderEntry[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;

    if (segment.type === 'activity_block' && displayMode === 'minimal') {
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
        const paragraphs = splitParagraphs(segment.content);
        if (paragraphs.length === 0) {
          entries.push({ kind: 'paragraph', text: '', spacingAfter: 0 });
          break;
        }

        paragraphs.forEach((paragraph, paragraphIndex) => {
          entries.push({
            kind: 'paragraph',
            text: paragraph,
            spacingAfter: paragraphIndex < paragraphs.length - 1 ? 1 : 0,
          });
        });
        break;
      }

      case 'inline_code':
        entries.push({ kind: 'inline_code', content: segment.content, spacingAfter: 0 });
        break;

      case 'bold':
        entries.push({ kind: 'bold', text: segment.content, spacingAfter: 0 });
        break;

      case 'italic':
        entries.push({ kind: 'italic', text: segment.content, spacingAfter: 0 });
        break;

      case 'list_item':
        entries.push({
          kind: 'list_item',
          marker: segment.marker,
          text: segment.content,
          spacingAfter: 0,
        });
        break;

      case 'table':
        entries.push({
          kind: 'table',
          headers: segment.headers,
          rows: segment.rows,
          spacingAfter: 1,
        });
        break;

      case 'code_block':
        entries.push({
          kind: 'code_block',
          content: segment.content,
          language: segment.language,
          spacingAfter: 1,
        });
        break;

      case 'activity_block':
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
