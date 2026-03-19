import { describe, expect, it } from 'vitest';
import { buildRenderedMessageLines } from '../../ui/message-lines.js';
import type { Message, RoleName } from '../../types/ui.js';
import { getRoleStyle, ROLE_STYLES } from '../../types/ui.js';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'claude-code',
    content: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('message-lines', () => {
  it('builds multiple rendered lines for a long single message', () => {
    const lines = buildRenderedMessageLines(
      [
        makeMessage({
          content: '这是一个非常长的单条消息，用来验证消息区滚动基于渲染行而不是消息条数进行处理。'.repeat(3),
        }),
      ],
      'minimal',
      40,
    );

    expect(lines.length).toBeGreaterThan(3);
  });

  // BUG-1 regression: all adapters should render without crashing
  it('test_regression_bug1_all_adapters_have_role_styles', () => {
    const adapterNames: RoleName[] = [
      'claude-code', 'codex', 'gemini',
    ];

    for (const name of adapterNames) {
      const style = ROLE_STYLES[name];
      expect(style, `ROLE_STYLES missing entry for '${name}'`).toBeDefined();
      expect(style.displayName).toBeTruthy();
      expect(style.color).toBeTruthy();
      expect(style.border).toBeTruthy();
    }
  });

  it('test_regression_bug1_getRoleStyle_fallback_for_unknown', () => {
    const style = getRoleStyle('unknown-adapter' as any);
    expect(style).toBeDefined();
    expect(style.displayName).toBe('Agent');
    expect(style.color).toBe('gray');
  });

  it('renders heading as bold text', () => {
    const lines = buildRenderedMessageLines(
      [makeMessage({ content: '## My Title' })],
      'minimal',
      80,
    );

    const bodyLines = lines.filter((l) => l.key.includes('-body-'));
    expect(bodyLines.some((l) => l.spans.some((s) => s.text === 'My Title' && s.bold === true))).toBe(true);
  });

  it('renders blockquote with │ prefix on every line', () => {
    const lines = buildRenderedMessageLines(
      [makeMessage({ content: '> Line 1\n> Line 2' })],
      'minimal',
      80,
    );

    const bodyLines = lines.filter((l) => l.key.includes('-body-'));
    const bqLines = bodyLines.filter((l) => l.spans.some((s) => s.text.startsWith('│ ')));
    expect(bqLines.length).toBe(2);
  });

  it('renders link as text with URL in parentheses', () => {
    const lines = buildRenderedMessageLines(
      [makeMessage({ content: 'See [docs](https://example.com)' })],
      'minimal',
      80,
    );

    const bodyLines = lines.filter((l) => l.key.includes('-body-'));
    const allText = bodyLines.map((l) => l.spans.map((s) => s.text).join('')).join('');
    expect(allText).toContain('docs (https://example.com)');
  });

  it('renders list item with inline bold', () => {
    const lines = buildRenderedMessageLines(
      [makeMessage({ content: '- **Bold** item' })],
      'minimal',
      80,
    );

    const bodyLines = lines.filter((l) => l.key.includes('-body-'));
    const allText = bodyLines.map((l) => l.spans.map((s) => s.text).join('')).join('');
    expect(allText).toContain('Bold item');
  });

  it('keeps activity summary compact in minimal mode', () => {
    const lines = buildRenderedMessageLines(
      [
        makeMessage({
          content: '⏺ 12 tool updates · latest Read: Read package.json\n本项目使用 TypeScript 编写。',
        }),
      ],
      'minimal',
      80,
    );

    expect(lines.some((line) => line.spans.some((span) => span.text.includes('12 tool updates')))).toBe(true);
    expect(lines.some((line) => line.spans.some((span) => span.text.includes('TypeScript')))).toBe(true);
  });
});
