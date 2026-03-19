import { describe, expect, it } from 'vitest';
import {
  buildDividerContent,
  buildPanelTone,
  buildRowProps,
  buildSelectionRowModel,
} from '../../ui/tui-layout-model.js';

describe('tui-layout helpers', () => {
  it('enforces horizontal row metadata', () => {
    expect(buildRowProps()).toMatchObject({ flexDirection: 'row' });
  });

  it('exposes stable panel and divider theme tokens', () => {
    expect(buildPanelTone('hero')).toEqual({
      borderColor: 'cyan',
      titleColor: 'cyan',
    });
    expect(buildDividerContent(8)).toBe(' ───────');
  });

  it('distinguishes selected and inactive selection rows', () => {
    expect(buildSelectionRowModel({ label: 'Use default', selected: true })).toEqual({
      chevron: '▸',
      chevronColor: 'cyan',
      textColor: 'cyan',
      emphasis: true,
      label: 'Use default',
      suffix: undefined,
    });
    expect(buildSelectionRowModel({ label: 'Opus', selected: false, suffix: '(opus)' })).toEqual({
      chevron: '·',
      chevronColor: 'gray',
      textColor: 'white',
      emphasis: false,
      label: 'Opus',
      suffix: '(opus)',
    });
  });
});
