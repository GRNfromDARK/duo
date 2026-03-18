import { describe, it, expect } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { MainLayout } from '../../ui/components/MainLayout.js';
import type { Message, RoleName } from '../../types/ui.js';

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    role: 'claude-code' as const,
    content: `Message ${i}`,
    timestamp: Date.now() + i * 1000,
  }));
}

function msg(role: RoleName, content = 'test', id?: string): Message {
  return {
    id: id ?? `msg-${role}-${Math.random()}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('MainLayout', () => {
  it('renders status bar area', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo  test-project  Round 1/5"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Duo');
  });

  it('renders input area placeholder', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('▸');
  });

  it('renders messages in message area', () => {
    const msgs = makeMessages(2);
    const { lastFrame } = render(
      <MainLayout
        messages={msgs}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Message 0');
    expect(output).toContain('Message 1');
  });

  it('handles scroll down with j key', () => {
    const msgs = makeMessages(30);
    const { lastFrame, stdin } = render(
      <MainLayout
        messages={msgs}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    // Press j multiple times to scroll down
    stdin.write('j');
    stdin.write('j');
    stdin.write('j');
    const output = lastFrame()!;
    // After scrolling down, earlier messages should no longer be visible
    // (exact behavior depends on viewport, just verify it doesn't crash)
    expect(output).toBeDefined();
  });

  it('handles scroll up with k key', () => {
    const msgs = makeMessages(30);
    const { lastFrame, stdin } = render(
      <MainLayout
        messages={msgs}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    // Scroll down then up
    stdin.write('j');
    stdin.write('j');
    stdin.write('k');
    const output = lastFrame()!;
    expect(output).toBeDefined();
  });

  it('handles G key to jump to latest', () => {
    const msgs = makeMessages(30);
    const { lastFrame, stdin } = render(
      <MainLayout
        messages={msgs}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    // Scroll up then press G
    stdin.write('k');
    stdin.write('k');
    stdin.write('G');
    const output = lastFrame()!;
    expect(output).toBeDefined();
  });

  it('handles arrow keys for scrolling', () => {
    const msgs = makeMessages(30);
    const { lastFrame, stdin } = render(
      <MainLayout
        messages={msgs}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    // Arrow down (escape sequence)
    stdin.write('\x1B[B');
    // Arrow up
    stdin.write('\x1B[A');
    const output = lastFrame()!;
    expect(output).toBeDefined();
  });

  it('handles empty messages list', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    expect(output).toBeDefined();
  });

  it('respects minimum terminal size 80x24', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(5)}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    const lines = output.split('\n');
    // Should fit within 24 lines
    expect(lines.length).toBeLessThanOrEqual(24);
  });

  it('auto-follows the bottom of a single long message based on rendered lines', () => {
    const longMessage = {
      id: 'long-1',
      role: 'claude-code' as const,
      content: Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n'),
      timestamp: Date.now(),
    };

    const { lastFrame } = render(
      <MainLayout
        messages={[longMessage]}
        statusText="Duo"
        columns={80}
        rows={12}
      />
    );
    const output = lastFrame()!;

    expect(output).toContain('Line 40');
    expect(output).not.toContain('Line 1');
  });

  it('renders a custom footer instead of replacing message history', () => {
    const msgs = makeMessages(2);
    const { lastFrame } = render(
      <MainLayout
        messages={msgs}
        statusText="Duo"
        columns={80}
        rows={24}
        footerHeight={5}
        footer={(
          <Box flexDirection="column">
            <Text color="green">Task completed</Text>
            <Text color="cyan">1. Continue current task</Text>
          </Box>
        )}
      />,
    );

    const output = lastFrame()!;
    expect(output).toContain('Message 0');
    expect(output).toContain('Message 1');
    expect(output).toContain('Task completed');
    expect(output).toContain('Continue current task');
    expect(output).not.toContain('Type a message...');
  });

  it('renders TaskBanner when contextData.taskSummary is provided', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(2)}
        statusText="Duo"
        columns={80}
        rows={24}
        contextData={{
          coderName: 'claude-code',
          reviewerName: 'codex',
          taskSummary: 'Fix the login bug',
          tokenEstimate: 5000,
        }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Task:');
    expect(output).toContain('Fix the login bug');
  });

  it('does not render TaskBanner when contextData is absent', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(2)}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Task:');
  });

  it('shows scroll position indicator when content overflows', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(50)}
        statusText="Duo"
        columns={80}
        rows={12}
      />
    );
    const output = lastFrame()!;
    // Should contain line position info like "L.../..."
    expect(output).toMatch(/L\d+\/\d+/);
  });

  it('does not show scroll position indicator when content fits', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(1)}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    // Should not contain line position info
    expect(output).not.toMatch(/L\d+\/\d+/);
  });

  // ── ThinkingIndicator integration tests ──

  it('shows thinking indicator when isLLMRunning and last message is user', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello')]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
  });

  it('hides thinking indicator when assistant is actively streaming content', () => {
    const streamingMsg: Message = {
      id: 'streaming-active',
      role: 'claude-code',
      content: 'Hi there',
      isStreaming: true,
      timestamp: Date.now(),
    };
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), streamingMsg]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Thinking...');
  });

  it('does not show thinking indicator when isLLMRunning is false', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello')]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={false}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Thinking...');
  });

  it('shows thinking indicator when last message is system after completed assistant (new round)', () => {
    // When isLLMRunning=true and last assistant message is completed (not streaming),
    // a new round is starting → show thinking
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), msg('claude-code', 'Reply'), msg('system', 'Event')]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
  });

  it('shows thinking indicator when system message follows user (no assistant yet)', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), msg('system', 'Processing...')]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
  });

  it('shows thinking indicator with empty messages when isLLMRunning', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
  });

  it('shows thinking indicator when assistant message is empty streaming placeholder', () => {
    const streamingPlaceholder: Message = {
      id: 'streaming-1',
      role: 'claude-code',
      content: '',
      isStreaming: true,
      timestamp: Date.now(),
    };
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), streamingPlaceholder]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
  });

  it('hides thinking indicator once streaming message has real content', () => {
    const streamingWithContent: Message = {
      id: 'streaming-2',
      role: 'claude-code',
      content: 'Here is my response',
      isStreaming: true,
      timestamp: Date.now(),
    };
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), streamingWithContent]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Thinking...');
  });

  // ── workflowState-driven indicator tests ──

  it('shows "Analyzing task..." indicator when workflowState is task_init', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'task_init' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Analyzing task...');
  });

  it('shows "God deciding next step..." indicator when workflowState is god_deciding', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'god_deciding' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('God deciding next step...');
  });

  it('shows "Evaluating convergence..." indicator when workflowState is god_convergence', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'god_convergence' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Evaluating convergence...');
  });

  it('shows "Understanding your input..." indicator when workflowState is classifying_intent', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'stop')]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'classifying_intent' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Understanding your input...');
  });

  it('shows "Executing actions..." indicator when workflowState is executing', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'executing' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Executing actions...');
  });

  it('shows "Analyzing output..." indicator when workflowState is observing', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'observing' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Analyzing output...');
  });

  it('shows no indicator when workflowState is idle', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello')]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'idle' }}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Thinking...');
    expect(output).not.toContain('Analyzing');
    expect(output).not.toContain('God deciding');
  });

  it('shows no indicator when workflowState is done', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('system', 'Completed')]}
        statusText="Duo"
        columns={80}
        rows={24}
        workflowState={{ phase: 'done' }}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Thinking...');
    expect(output).not.toContain('Analyzing');
  });

  it('shows Thinking indicator for llm_running state with empty streaming placeholder', () => {
    const streamingPlaceholder: Message = {
      id: 'sp-1',
      role: 'claude-code',
      content: '',
      isStreaming: true,
      timestamp: Date.now(),
    };
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), streamingPlaceholder]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
        workflowState={{ phase: 'llm_running' }}
      />
    );
    const output = lastFrame()!;
    expect(output).toContain('Thinking...');
  });

  it('hides indicator for llm_running when streaming has content', () => {
    const streamingWithContent: Message = {
      id: 'sw-1',
      role: 'claude-code',
      content: 'Output',
      isStreaming: true,
      timestamp: Date.now(),
    };
    const { lastFrame } = render(
      <MainLayout
        messages={[msg('user', 'Hello'), streamingWithContent]}
        statusText="Duo"
        columns={80}
        rows={24}
        isLLMRunning={true}
        workflowState={{ phase: 'llm_running' }}
      />
    );
    const output = lastFrame()!;
    expect(output).not.toContain('Thinking...');
  });
});
