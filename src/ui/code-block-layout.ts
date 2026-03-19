const FOLD_THRESHOLD = 10;
const PREVIEW_LINES = 5;

export interface BuildCodeBlockLayoutOptions {
  content: string;
  language?: string;
  expanded?: boolean;
}

export interface CodeBlockLayout {
  languageLabel?: string;
  displayLines: string[];
  lineCount: number;
  shouldFold: boolean;
  isExpanded: boolean;
  surfaceMode: 'container';
}

export function buildCodeBlockLayout({
  content,
  language,
  expanded,
}: BuildCodeBlockLayoutOptions): CodeBlockLayout {
  const lines = content.length === 0 ? [] : content.split('\n');
  const lineCount = lines.length;
  const shouldFold = lineCount > FOLD_THRESHOLD;
  const isExpanded = shouldFold ? (expanded ?? false) : true;
  const displayLines = isExpanded ? lines : lines.slice(0, PREVIEW_LINES);

  return {
    languageLabel: language,
    displayLines,
    lineCount,
    shouldFold,
    isExpanded,
    surfaceMode: 'container',
  };
}
