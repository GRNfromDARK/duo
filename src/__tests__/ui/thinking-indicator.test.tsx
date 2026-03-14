import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ThinkingIndicator, shouldShowThinking } from '../../ui/components/ThinkingIndicator.js';
import type { Message, RoleName } from '../../types/ui.js';

// ── Pure function tests: shouldShowThinking ──

function msg(role: RoleName, id?: string, overrides?: Partial<Message>): Message {
  return {
    id: id ?? `msg-${role}-${Math.random()}`,
    role,
    content: `Content from ${role}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

function streamingPlaceholder(role: RoleName = 'claude-code'): Message {
  return msg(role, undefined, { content: '', isStreaming: true });
}

describe('shouldShowThinking', () => {
  it('returns false when isLLMRunning is false', () => {
    expect(shouldShowThinking(false, [])).toBe(false);
    expect(shouldShowThinking(false, [msg('user')])).toBe(false);
    expect(shouldShowThinking(false, [msg('claude-code')])).toBe(false);
  });

  it('returns true when isLLMRunning and messages is empty', () => {
    expect(shouldShowThinking(true, [])).toBe(true);
  });

  it('returns true when isLLMRunning and last message is user', () => {
    expect(shouldShowThinking(true, [msg('user')])).toBe(true);
  });

  it('returns false when last message is an assistant role', () => {
    expect(shouldShowThinking(true, [msg('user'), msg('claude-code')])).toBe(false);
    expect(shouldShowThinking(true, [msg('user'), msg('codex')])).toBe(false);
    expect(shouldShowThinking(true, [msg('user'), msg('gemini')])).toBe(false);
  });

  it('returns true when last message is system after user (no assistant yet)', () => {
    expect(shouldShowThinking(true, [msg('user'), msg('system')])).toBe(true);
  });

  it('returns false when assistant message exists after user, even with system in between', () => {
    expect(shouldShowThinking(true, [msg('user'), msg('system'), msg('claude-code')])).toBe(false);
  });

  it('returns true when only system messages exist', () => {
    expect(shouldShowThinking(true, [msg('system')])).toBe(true);
    expect(shouldShowThinking(true, [msg('system'), msg('system')])).toBe(true);
  });

  it('handles multi-turn correctly: new user message after assistant', () => {
    const messages = [msg('user'), msg('claude-code'), msg('user')];
    expect(shouldShowThinking(true, messages)).toBe(true);
  });

  it('handles multi-turn correctly: assistant responded to latest user', () => {
    const messages = [msg('user'), msg('claude-code'), msg('user'), msg('codex')];
    expect(shouldShowThinking(true, messages)).toBe(false);
  });

  it('handles all adapter roles as assistant', () => {
    const adapterRoles: RoleName[] = [
      'claude-code', 'codex', 'gemini', 'copilot', 'aider',
      'amazon-q', 'cursor', 'cline', 'continue', 'goose', 'amp', 'qwen',
    ];
    for (const role of adapterRoles) {
      expect(shouldShowThinking(true, [msg('user'), msg(role)])).toBe(false);
    }
  });

  // ── Empty streaming placeholder tests (App.tsx real-world flow) ──

  it('returns true when assistant message is an empty streaming placeholder', () => {
    // App.tsx creates { role: 'claude-code', content: '', isStreaming: true }
    // before any tokens arrive — indicator should remain visible
    const messages = [msg('user'), streamingPlaceholder('claude-code')];
    expect(shouldShowThinking(true, messages)).toBe(true);
  });

  it('returns false once streaming message has real content', () => {
    const messages = [
      msg('user'),
      msg('claude-code', undefined, { content: 'Hello', isStreaming: true }),
    ];
    expect(shouldShowThinking(true, messages)).toBe(false);
  });

  it('returns false for non-streaming assistant with empty content', () => {
    // Edge case: empty content but not streaming → treat as real output
    const messages = [
      msg('user'),
      msg('claude-code', undefined, { content: '' }),
    ];
    expect(shouldShowThinking(true, messages)).toBe(false);
  });

  it('returns true with streaming placeholder after system message', () => {
    const messages = [
      msg('user'),
      msg('system'),
      streamingPlaceholder('codex'),
    ];
    expect(shouldShowThinking(true, messages)).toBe(true);
  });

  it('returns true with whitespace-only streaming content', () => {
    const messages = [
      msg('user'),
      msg('claude-code', undefined, { content: '   \n  ', isStreaming: true }),
    ];
    expect(shouldShowThinking(true, messages)).toBe(true);
  });
});

// ── Component render tests ──

describe('ThinkingIndicator component', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders spinner and Thinking text', () => {
    const { lastFrame } = render(<ThinkingIndicator columns={80} />);
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
    // Should contain one of the spinner characters
    expect(output).toMatch(/[⣾⣽⣻⢿⡿⣟⣯⣷]/);
  });

  it('cleans up interval on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ThinkingIndicator columns={80} />);

    // Advance time to verify interval is running
    vi.advanceTimersByTime(200);

    // Unmount and verify no errors from dangling intervals
    unmount();

    // Advancing after unmount should not cause errors
    vi.advanceTimersByTime(500);
  });

  it('starts animation from frame 0 on fresh mount', () => {
    const { lastFrame } = render(<ThinkingIndicator columns={80} />);
    const output = lastFrame()!;
    // First frame should be ⣾ (index 0)
    expect(output).toContain('⣾');
  });
});
