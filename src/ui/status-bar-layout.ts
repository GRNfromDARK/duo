import { computeStringWidth } from './message-lines.js';

export interface StatusBarLayoutSegment {
  kind: 'brand' | 'path' | 'status' | 'agent' | 'task' | 'phase' | 'latency' | 'tokens';
  text: string;
  color?: string;
  dimColor?: boolean;
  priority: number;
  icon?: string;
}

export interface BuildStatusBarLayoutOptions {
  projectPath: string;
  statusIcon: string;
  statusLabel: string;
  statusColor: string;
  activeAgent: string | null;
  tokenText: string;
  taskType?: string;
  currentPhase?: string;
  godLatencyText?: string;
  columns: number;
}

export interface StatusBarLayout {
  left: StatusBarLayoutSegment[];
  right: StatusBarLayoutSegment[];
}

const SEGMENT_GAP = 2;
const MIN_PATH_WIDTH = 10;
const MIN_SPACER_WIDTH = 1;

function renderSegmentText(segment: StatusBarLayoutSegment): string {
  if (segment.kind === 'status' && segment.icon) {
    return `${segment.icon} ${segment.text}`;
  }

  return segment.text;
}

function buildLeftWidth(segments: StatusBarLayoutSegment[]): number {
  if (segments.length === 0) return 0;

  return segments.reduce((total, segment, index) => {
    const prefixWidth = index === 0 ? 1 : SEGMENT_GAP;
    return total + prefixWidth + computeStringWidth(renderSegmentText(segment));
  }, 0);
}

function buildRightWidth(segments: StatusBarLayoutSegment[]): number {
  if (segments.length === 0) return 0;

  return segments.reduce((total, segment, index) => {
    const prefixWidth = index === 0 ? 0 : SEGMENT_GAP;
    const suffixWidth = index === segments.length - 1 ? 1 : 0;
    return total + prefixWidth + computeStringWidth(renderSegmentText(segment)) + suffixWidth;
  }, 0);
}

function totalContentWidth(left: StatusBarLayoutSegment[], right: StatusBarLayoutSegment[]): number {
  return buildLeftWidth(left) + buildRightWidth(right);
}

function totalRenderedWidth(left: StatusBarLayoutSegment[], right: StatusBarLayoutSegment[]): number {
  const contentWidth = totalContentWidth(left, right);
  if (left.length === 0 || right.length === 0) {
    return contentWidth;
  }

  return contentWidth + MIN_SPACER_WIDTH;
}

function truncateMiddle(text: string, maxWidth: number): string {
  if (computeStringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return '…';

  const chars = [...text];
  const leftBudget = Math.max(1, Math.floor((maxWidth - 1) / 2));
  const rightBudget = Math.max(1, maxWidth - 1 - leftBudget);

  let left = '';
  let leftWidth = 0;
  for (const char of chars) {
    const charWidth = computeStringWidth(char);
    if (leftWidth + charWidth > leftBudget) break;
    left += char;
    leftWidth += charWidth;
  }

  let right = '';
  let rightWidth = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const charWidth = computeStringWidth(char);
    if (rightWidth + charWidth > rightBudget) break;
    right = char + right;
    rightWidth += charWidth;
  }

  return `${left}…${right}`;
}

function findSegment(
  segments: StatusBarLayoutSegment[],
  kind: StatusBarLayoutSegment['kind'],
): StatusBarLayoutSegment | undefined {
  return segments.find((segment) => segment.kind === kind);
}

function withoutKind(
  segments: StatusBarLayoutSegment[],
  kind: StatusBarLayoutSegment['kind'],
): StatusBarLayoutSegment[] {
  return segments.filter((segment) => segment.kind !== kind);
}

export function buildStatusBarLayout({
  projectPath,
  statusIcon,
  statusLabel,
  statusColor,
  activeAgent,
  tokenText,
  taskType,
  currentPhase,
  godLatencyText,
  columns,
}: BuildStatusBarLayoutOptions): StatusBarLayout {
  let left: StatusBarLayoutSegment[] = [
    { kind: 'brand', text: 'Duo', priority: 1 },
    { kind: 'path', text: projectPath, priority: 5, dimColor: true },
    { kind: 'status', text: statusLabel, priority: 1, color: statusColor, icon: statusIcon },
  ];

  if (activeAgent) {
    left.push({ kind: 'agent', text: activeAgent, priority: 2 });
  }
  if (taskType) {
    left.push({ kind: 'task', text: `[${taskType}]`, priority: 4, color: 'cyan' });
  }
  if (currentPhase) {
    left.push({ kind: 'phase', text: `φ:${currentPhase}`, priority: 5, color: 'magenta' });
  }

  let right: StatusBarLayoutSegment[] = [];
  if (godLatencyText) {
    right.push({ kind: 'latency', text: godLatencyText, priority: 4, dimColor: true });
  }
  right.push({ kind: 'tokens', text: tokenText, priority: 1, dimColor: true });

  const removalOrder: Array<StatusBarLayoutSegment['kind']> = ['phase', 'task', 'latency', 'agent'];

  for (const kind of removalOrder) {
    if (totalRenderedWidth(left, right) <= columns) break;
    if (findSegment(left, kind)) {
      left = withoutKind(left, kind);
      continue;
    }
    if (findSegment(right, kind)) {
      right = withoutKind(right, kind);
    }
  }

  const pathSegment = findSegment(left, 'path');
  if (pathSegment && totalRenderedWidth(left, right) > columns) {
    const nonPathLeft = withoutKind(left, 'path');
    const nonPathWidth = totalContentWidth(nonPathLeft, right);
    const pathIndex = left.findIndex((segment) => segment.kind === 'path');
    const pathPrefixWidth = pathIndex <= 0 ? 1 : SEGMENT_GAP;
    const spacerWidth = nonPathLeft.length > 0 && right.length > 0 ? MIN_SPACER_WIDTH : 0;
    const availablePathWidth = Math.max(
      MIN_PATH_WIDTH,
      columns - nonPathWidth - spacerWidth - pathPrefixWidth,
    );

    pathSegment.text = truncateMiddle(pathSegment.text, availablePathWidth);
  }

  if (totalRenderedWidth(left, right) > columns) {
    left = withoutKind(left, 'path');
  }

  return { left, right };
}

export function computeStatusBarWidth(layout: StatusBarLayout): number {
  return totalContentWidth(layout.left, layout.right);
}

export function computeRenderedStatusBarWidth(layout: StatusBarLayout): number {
  return totalRenderedWidth(layout.left, layout.right);
}
