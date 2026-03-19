const PLACEHOLDER_RUNNING = 'Type to interrupt, or wait for completion...';
const PLACEHOLDER_IDLE = 'Type a message...';
const HELPER_IDLE = 'Enter sends · Shift+Enter newline · ? help · / search · Paste supported';
const HELPER_RUNNING = 'Waiting for completion · Shift+Enter newline · Paste supported';

export interface BuildInputAreaLayoutOptions {
  value: string;
  cursorPos: number;
  isLLMRunning: boolean;
  maxLines: number;
}

export interface InputAreaRenderLine {
  prefix: string;
  beforeCursor: string;
  cursorChar: string;
  afterCursor: string;
  isCursorLine: boolean;
}

export interface InputAreaLayout {
  region: 'composer';
  height: number;
  showPlaceholder: boolean;
  showHelperRow: boolean;
  promptIcon: string;
  promptColor: 'cyan' | 'yellow';
  statusText: 'READY' | 'RUNNING';
  statusColor: 'cyan' | 'yellow';
  placeholderText: string;
  helperText: string;
  cursorChar: string;
  lines: InputAreaRenderLine[];
}

/**
 * Strip bare \r characters from a value string.
 * The paste pipeline normalises \r\n → \n, but this guard handles any value
 * that arrives through a legacy or unexpected path so that \r never reaches
 * column-counting or rendering logic (a lone \r causes terminal output to
 * jump to column 0, placing the cursor at a completely wrong position).
 */
function stripCR(value: string): string {
  return value.includes('\r') ? value.replace(/\r/g, '') : value;
}

export function getDisplayLines(value: string, maxLines: number): string[] {
  const lines = stripCR(value).split('\n');
  return lines.slice(0, maxLines);
}

export function getCursorLineCol(value: string, cursorPos: number): { line: number; col: number } {
  const before = stripCR(value.slice(0, cursorPos));
  const lines = before.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

export function buildInputAreaLayout({
  value: rawValue,
  cursorPos,
  isLLMRunning,
  maxLines,
}: BuildInputAreaLayoutOptions): InputAreaLayout {
  // Normalise away any stray \r characters before layout calculations so that
  // column widths, cursor positions, and rendered text are all consistent.
  const value = stripCR(rawValue);
  const promptIcon = isLLMRunning ? '◆' : '▸';
  const promptColor = isLLMRunning ? 'yellow' : 'cyan';
  const statusText = isLLMRunning ? 'RUNNING' : 'READY';
  const statusColor = promptColor;
  const placeholderText = isLLMRunning ? PLACEHOLDER_RUNNING : PLACEHOLDER_IDLE;
  const helperText = isLLMRunning ? HELPER_RUNNING : HELPER_IDLE;
  const cursorChar = '█';
  const showPlaceholder = value.length === 0;

  if (showPlaceholder) {
    return {
      region: 'composer',
      height: 2,
      showPlaceholder: true,
      showHelperRow: true,
      promptIcon,
      promptColor,
      statusText,
      statusColor,
      placeholderText,
      helperText,
      cursorChar,
      lines: [],
    };
  }

  const displayLines = getDisplayLines(value, maxLines);
  // Pass rawValue (before stripCR) so that getCursorLineCol can strip \r
  // from only the prefix slice and keep the cursorPos byte-offset correct.
  // If the value had no \r the two are identical; when it does, stripping
  // the full value first would shift all positions after the first \r and
  // make cursorPos point at the wrong character in the stripped string.
  const { line: cursorLine, col: cursorCol } = getCursorLineCol(rawValue, cursorPos);
  const lines = displayLines.map((line, lineIdx) => {
    const isCursorLine = lineIdx === cursorLine;
    const prefix = lineIdx === 0 ? `${promptIcon} ` : '  ';

    if (!isCursorLine) {
      return {
        prefix,
        beforeCursor: line,
        cursorChar: '',
        afterCursor: '',
        isCursorLine: false,
      };
    }

    // Extract the full code point at cursorCol so that emoji / surrogate-pair
    // characters are treated as a single glyph and not split across
    // beforeCursor / cursorChar / afterCursor.
    const hiCode = cursorCol < line.length ? line.charCodeAt(cursorCol) : NaN;
    const isSurrogatePair =
      !isNaN(hiCode) &&
      hiCode >= 0xD800 && hiCode <= 0xDBFF &&
      cursorCol + 1 < line.length &&
      line.charCodeAt(cursorCol + 1) >= 0xDC00 &&
      line.charCodeAt(cursorCol + 1) <= 0xDFFF;
    const cursorChar =
      cursorCol >= line.length
        ? ' '
        : isSurrogatePair
          ? line.slice(cursorCol, cursorCol + 2)
          : line[cursorCol]!;
    const afterStart =
      cursorCol >= line.length
        ? cursorCol
        : isSurrogatePair
          ? cursorCol + 2
          : cursorCol + 1;

    return {
      prefix,
      beforeCursor: line.slice(0, cursorCol),
      cursorChar,
      afterCursor: line.slice(afterStart),
      isCursorLine: true,
    };
  });

  return {
    region: 'composer',
    height: displayLines.length + (displayLines.length <= 1 ? 1 : 0),
    showPlaceholder: false,
    showHelperRow: displayLines.length <= 1,
    promptIcon,
    promptColor,
    statusText,
    statusColor,
    placeholderText,
    helperText,
    cursorChar,
    lines,
  };
}
