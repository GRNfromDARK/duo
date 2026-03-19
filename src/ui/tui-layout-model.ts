export type PanelTone = 'hero' | 'section' | 'overlay' | 'warning';

export interface PanelToneModel {
  borderColor: string;
  titleColor: string;
}

export interface SelectionRowModel {
  chevron: string;
  chevronColor: string;
  textColor: string;
  emphasis: boolean;
  label: string;
  suffix?: string;
}

export function buildRowProps(): { flexDirection: 'row' } {
  return { flexDirection: 'row' };
}

export function buildPanelTone(tone: PanelTone): PanelToneModel {
  switch (tone) {
    case 'hero':
      return { borderColor: 'cyan', titleColor: 'cyan' };
    case 'overlay':
      return { borderColor: 'cyan', titleColor: 'cyan' };
    case 'warning':
      return { borderColor: 'yellow', titleColor: 'yellow' };
    case 'section':
    default:
      return { borderColor: 'gray', titleColor: 'white' };
  }
}

export function buildDividerContent(width: number): string {
  const contentWidth = Math.max(1, width - 1);
  return ` ${'─'.repeat(contentWidth)}`;
}

export function buildSelectionRowModel({
  label,
  selected,
  suffix,
}: {
  label: string;
  selected: boolean;
  suffix?: string;
}): SelectionRowModel {
  return {
    chevron: selected ? '▸' : '·',
    chevronColor: selected ? 'cyan' : 'gray',
    textColor: selected ? 'cyan' : 'white',
    emphasis: selected,
    label,
    suffix,
  };
}
