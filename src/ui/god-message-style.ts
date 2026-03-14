/**
 * God message visual styling — distinct from Coder/Reviewer.
 * Card F.4: FR-014 God 视觉层级区分 (AC-041)
 *
 * God messages use ╔═╗ double border + Cyan/Magenta colors,
 * only shown at critical decision points to avoid visual noise.
 */

export interface GodMessageStyle {
  borderChar: string;     // ║ side border
  topBorder: string;      // ╔═...═╗
  bottomBorder: string;   // ╚═...═╝
  borderColor: string;    // cyan
  textColor: string;      // magenta
}

export type GodMessageType =
  | 'task_analysis'       // 任务分析
  | 'phase_transition'    // 阶段切换
  | 'auto_decision'       // 代理决策
  | 'anomaly_detection'   // 异常检测
  | 'clarification';      // Card E.2: God 澄清提问

const BOX_WIDTH = 50;

export const GOD_STYLE: GodMessageStyle = {
  borderChar: '║',
  topBorder: `╔${'═'.repeat(BOX_WIDTH - 2)}╗`,
  bottomBorder: `╚${'═'.repeat(BOX_WIDTH - 2)}╝`,
  borderColor: 'cyan',
  textColor: 'magenta',
};

const TYPE_LABELS: Record<GodMessageType, string> = {
  task_analysis: 'God · Task Analysis',
  phase_transition: 'God · Phase Transition',
  auto_decision: 'God · Auto Decision',
  anomaly_detection: 'God · Anomaly Detection',
  clarification: 'God · Clarification',
};

/** Critical decision types that warrant visual display. */
const VISIBLE_TYPES: Set<string> = new Set<string>([
  'task_analysis',
  'phase_transition',
  'auto_decision',
  'anomaly_detection',
  'clarification',
]);

/**
 * Whether a God message type should be displayed to the user.
 * Only critical decision points are shown; routing decisions are hidden.
 */
export function shouldShowGodMessage(type: GodMessageType): boolean {
  return VISIBLE_TYPES.has(type);
}

/**
 * Format a God message with ╔═╗ double border box.
 * Returns an array of strings representing each line.
 */
export function formatGodMessage(
  content: string,
  type: GodMessageType,
): string[] {
  const innerWidth = BOX_WIDTH - 2; // minus ║ on each side
  const lines: string[] = [];

  lines.push(GOD_STYLE.topBorder);

  // Header line with type label
  const label = TYPE_LABELS[type] ?? 'God';
  lines.push(padLine(` ${label}`, innerWidth));

  // Content lines
  if (content.length > 0) {
    for (const contentLine of content.split('\n')) {
      lines.push(padLine(` ${contentLine}`, innerWidth));
    }
  }

  lines.push(GOD_STYLE.bottomBorder);

  return lines;
}

/** Get visual width of a string, accounting for CJK double-width characters. */
function getVisualWidth(text: string): number {
  let width = 0;
  for (const char of [...text]) {
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
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Truncate text to fit within a visual width limit. */
function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  const chars = [...text];
  for (; i < chars.length; i++) {
    const codePoint = chars[i].codePointAt(0) ?? 0;
    const charWidth = (
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
    ) ? 2 : 1;
    if (width + charWidth > maxWidth) break;
    width += charWidth;
  }
  return chars.slice(0, i).join('');
}

/** Pad a line to fit within ║...║ borders. */
function padLine(text: string, innerWidth: number): string {
  const visualWidth = getVisualWidth(text);
  const truncated = visualWidth > innerWidth ? truncateToWidth(text, innerWidth) : text;
  const truncatedWidth = visualWidth > innerWidth ? getVisualWidth(truncated) : visualWidth;
  const padded = truncated + ' '.repeat(Math.max(0, innerWidth - truncatedWidth));
  return `║${padded}║`;
}
