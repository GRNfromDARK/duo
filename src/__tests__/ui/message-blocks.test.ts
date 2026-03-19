import { describe, expect, it } from 'vitest';
import { buildMessageBlocks } from '../../ui/message-blocks.js';
import type { Message } from '../../types/ui.js';

function createMessage(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? 'msg-1',
    role: overrides.role ?? 'claude-code',
    roleLabel: overrides.roleLabel,
    content: overrides.content ?? 'hello world',
    timestamp: overrides.timestamp ?? new Date('2026-03-19T10:00:00Z').getTime(),
    isStreaming: overrides.isStreaming,
    metadata: overrides.metadata,
  };
}

describe('buildMessageBlocks', () => {
  it('maps one message to one transcript block', () => {
    const blocks = buildMessageBlocks([
      createMessage({
        id: 'coder-1',
        role: 'claude-code',
        roleLabel: 'Coder',
        content: '统计结果如下：',
      }),
    ], 'minimal');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe('coder-1');
  });

  it('keeps header metadata separate from body content', () => {
    const blocks = buildMessageBlocks([
      createMessage({
        role: 'codex',
        roleLabel: 'Reviewer',
        content: 'review notes',
        metadata: { tokenCount: 1300, cliCommand: 'git diff --stat' },
      }),
    ], 'verbose');

    expect(blocks[0]?.header.label).toBe('Codex · Reviewer');
    expect(blocks[0]?.header.tokenText).toBe('1.3k tokens');
    expect(blocks[0]?.body.content).toBe('review notes');
    expect(blocks[0]?.body.cliCommand).toBe('git diff --stat');
  });

  it('gives system messages a lighter tone than assistant messages', () => {
    const [assistantBlock, systemBlock] = buildMessageBlocks([
      createMessage({ id: 'assistant-1', role: 'claude-code', roleLabel: 'Coder' }),
      createMessage({ id: 'system-1', role: 'system', content: 'Task accepted by God' }),
    ], 'minimal');

    expect(assistantBlock?.body.tone).toBe('accent');
    expect(systemBlock?.body.tone).toBe('muted');
  });
});
