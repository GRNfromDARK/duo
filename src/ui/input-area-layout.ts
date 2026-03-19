const PLACEHOLDER_RUNNING = 'Type to interrupt, or wait for completion...';
const PLACEHOLDER_IDLE = 'Type a message...';

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
  promptIcon: string;
  promptColor: 'cyan' | 'yellow';
  placeholderText: string;
  lines: InputAreaRenderLine[];
}

export function getDisplayLines(value: string, maxLines: number): string[] {
  const lines = value.split('\n');
  return lines.slice(0, maxLines);
}

export function getCursorLineCol(value: string, cursorPos: number): { line: number; col: number } {
  const before = value.slice(0, cursorPos);
  const lines = before.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

export function buildInputAreaLayout({
  value,
  cursorPos,
  isLLMRunning,
  maxLines,
}: BuildInputAreaLayoutOptions): InputAreaLayout {
  const promptIcon = isLLMRunning ? '◆' : '▸';
  const promptColor = isLLMRunning ? 'yellow' : 'cyan';
  const placeholderText = isLLMRunning ? PLACEHOLDER_RUNNING : PLACEHOLDER_IDLE;
  const showPlaceholder = value.length === 0;

  if (showPlaceholder) {
    return {
      region: 'composer',
      height: 1,
      showPlaceholder: true,
      promptIcon,
      promptColor,
      placeholderText,
      lines: [],
    };
  }

  const displayLines = getDisplayLines(value, maxLines);
  const { line: cursorLine, col: cursorCol } = getCursorLineCol(value, cursorPos);
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

    const cursorChar = line[cursorCol] ?? ' ';
    const afterStart = cursorCol < line.length ? cursorCol + 1 : cursorCol;

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
    height: Math.max(1, displayLines.length),
    showPlaceholder: false,
    promptIcon,
    promptColor,
    placeholderText,
    lines,
  };
}
