/**
 * Tests for display mode (Minimal/Verbose) state management.
 * Source: FR-021 (AC-070, AC-071)
 */

import { describe, it, expect } from 'vitest';
import {
  type DisplayMode,
  toggleDisplayMode,
  filterMessages,
} from '../../ui/display-mode.js';
import type { Message } from '../../types/ui.js';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'claude-code',
    content: 'Hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('toggleDisplayMode', () => {
  it('toggles minimal to verbose', () => {
    expect(toggleDisplayMode('minimal')).toBe('verbose');
  });

  it('toggles verbose to minimal', () => {
    expect(toggleDisplayMode('verbose')).toBe('minimal');
  });
});

describe('filterMessages', () => {
  it('in minimal mode, hides routing events', () => {
    const messages: Message[] = [
      makeMessage({ id: '1', content: 'Code output' }),
      makeMessage({ id: '2', content: 'Routing to reviewer', metadata: { isRoutingEvent: true } }),
      makeMessage({ id: '3', content: 'Review output' }),
    ];
    const filtered = filterMessages(messages, 'minimal');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m) => m.id)).toEqual(['1', '3']);
  });

  it('in verbose mode, shows all messages including routing events', () => {
    const messages: Message[] = [
      makeMessage({ id: '1', content: 'Code output' }),
      makeMessage({ id: '2', content: 'Routing to reviewer', metadata: { isRoutingEvent: true } }),
      makeMessage({ id: '3', content: 'Review output' }),
    ];
    const filtered = filterMessages(messages, 'verbose');
    expect(filtered).toHaveLength(3);
  });

  it('in minimal mode, keeps round summary messages', () => {
    const messages: Message[] = [
      makeMessage({ id: '1', content: 'Code output' }),
      makeMessage({ id: '2', role: 'system', content: '═══ Phase transition ═══', metadata: {} }),
      makeMessage({ id: '3', content: 'Review output' }),
    ];
    const filtered = filterMessages(messages, 'minimal');
    expect(filtered).toHaveLength(3);
  });

  it('in minimal mode, keeps user and LLM messages', () => {
    const messages: Message[] = [
      makeMessage({ id: '1', role: 'user', content: 'fix the bug' }),
      makeMessage({ id: '2', role: 'claude-code', content: 'Done' }),
      makeMessage({ id: '3', role: 'codex', content: 'LGTM' }),
      makeMessage({ id: '4', role: 'gemini', content: 'Agreed' }),
    ];
    const filtered = filterMessages(messages, 'minimal');
    expect(filtered).toHaveLength(4);
  });

  it('in minimal mode, keeps system messages that are not routing events', () => {
    const messages: Message[] = [
      makeMessage({ id: '1', role: 'system', content: 'Session started' }),
      makeMessage({ id: '2', role: 'system', content: 'Routing...', metadata: { isRoutingEvent: true } }),
    ];
    const filtered = filterMessages(messages, 'minimal');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('1');
  });
});
