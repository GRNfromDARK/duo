import { describe, expect, it } from 'vitest';
import { buildCodeBlockLayout } from '../../ui/code-block-layout.js';

describe('buildCodeBlockLayout', () => {
  const longContent = [
    'const a = 1;',
    'const b = 2;',
    'const c = 3;',
    'const d = 4;',
    'const e = 5;',
    'const f = 6;',
    'const g = 7;',
    'const h = 8;',
    'const i = 9;',
    'const j = 10;',
    'const k = 11;',
  ].join('\n');

  it('keeps folded and expanded states intact', () => {
    const folded = buildCodeBlockLayout({ content: longContent, language: 'ts', expanded: false });
    const expanded = buildCodeBlockLayout({ content: longContent, language: 'ts', expanded: true });

    expect(folded.shouldFold).toBe(true);
    expect(folded.displayLines).toHaveLength(5);
    expect(expanded.displayLines).toHaveLength(11);
  });

  it('uses a grouped surface model instead of per-line stripe mode', () => {
    const layout = buildCodeBlockLayout({ content: 'echo hello', language: 'bash' });

    expect(layout.surfaceMode).toBe('container');
  });

  it('keeps the language label optional and compact', () => {
    const withLabel = buildCodeBlockLayout({ content: 'echo hello', language: 'bash' });
    const withoutLabel = buildCodeBlockLayout({ content: 'echo hello' });

    expect(withLabel.languageLabel).toBe('bash');
    expect(withoutLabel.languageLabel).toBeUndefined();
  });
});
