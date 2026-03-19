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
