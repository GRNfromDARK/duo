import { computeStringWidth } from './message-lines.js';

export interface StatusBarLayoutSegment {
  kind: 'brand' | 'path' | 'status' | 'agent' | 'task' | 'phase' | 'latency' | 'tokens';
  text: string;
  color?: string;
  dimColor?: boolean;
  priority: number;
}

export interface BuildStatusBarLayoutOptions {
  projectPath: string;
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

const GROUP_GAP = 2;
const SEGMENT_GAP = 2;
const MIN_PATH_WIDTH = 10;

function buildWidth(segments: StatusBarLayoutSegment[]): number {
  if (segments.length === 0) return 0;
  return segments.reduce((total, segment, index) => {
    const gap = index === 0 ? 0 : SEGMENT_GAP;
    return total + gap + computeStringWidth(segment.text);
  }, 0);
}

function totalWidth(left: StatusBarLayoutSegment[], right: StatusBarLayoutSegment[]): number {
  const leftWidth = buildWidth(left);
  const rightWidth = buildWidth(right);

  if (leftWidth === 0) return rightWidth;
  if (rightWidth === 0) return leftWidth;

  return leftWidth + GROUP_GAP + rightWidth;
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
    { kind: 'status', text: statusLabel, priority: 1, color: statusColor },
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
    if (totalWidth(left, right) <= columns) break;
    if (findSegment(left, kind)) {
      left = withoutKind(left, kind);
      continue;
    }
    if (findSegment(right, kind)) {
      right = withoutKind(right, kind);
    }
  }

  const pathSegment = findSegment(left, 'path');
  if (pathSegment && totalWidth(left, right) > columns) {
    const nonPathWidth = totalWidth(withoutKind(left, 'path'), right);
    const availablePathWidth = Math.max(
      MIN_PATH_WIDTH,
      columns - nonPathWidth - GROUP_GAP - SEGMENT_GAP,
    );

    pathSegment.text = truncateMiddle(pathSegment.text, availablePathWidth);
  }

  if (totalWidth(left, right) > columns) {
    left = withoutKind(left, 'path');
  }

  return { left, right };
}

export function computeStatusBarWidth(layout: StatusBarLayout): number {
  return totalWidth(layout.left, layout.right);
}
