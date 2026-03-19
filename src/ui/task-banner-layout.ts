import { computeStringWidth, getCharWidth } from './message-lines.js';

export interface TaskBannerLayout {
  columns: number;
  prefixText: string;
  displayText: string;
  availableWidth: number;
}

export interface BuildTaskBannerLayoutOptions {
  taskSummary: string;
  columns: number;
}

export function truncateTaskSummary(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const totalWidth = computeStringWidth(normalized);
  if (totalWidth <= maxWidth) return normalized;
  if (maxWidth <= 1) return '…';

  const chars = [...normalized];
  let currentWidth = 0;
  const targetWidth = maxWidth - 1;
  let result = '';

  for (const char of chars) {
    const width = getCharWidth(char);
    if (currentWidth + width > targetWidth) break;
    result += char;
    currentWidth += width;
  }

  return `${result}…`;
}

export function buildTaskBannerLayout({
  taskSummary,
  columns,
}: BuildTaskBannerLayoutOptions): TaskBannerLayout {
  const prefixText = '▸ Task';
  const prefixWidth = computeStringWidth(prefixText);
  const availableWidth = Math.max(1, columns - prefixWidth - 3);
  const displayText = truncateTaskSummary(taskSummary, availableWidth);

  return {
    columns,
    prefixText,
    displayText,
    availableWidth,
  };
}
