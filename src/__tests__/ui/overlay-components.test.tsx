/**
 * Tests for overlay components: HelpOverlay, ContextOverlay, TimelineOverlay, SearchOverlay.
 * Source: FR-022 (AC-072, AC-073, AC-074)
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { HelpOverlay } from '../../ui/components/HelpOverlay.js';
import { ContextOverlay } from '../../ui/components/ContextOverlay.js';
import { TimelineOverlay } from '../../ui/components/TimelineOverlay.js';
import { SearchOverlay } from '../../ui/components/SearchOverlay.js';
import type { Message } from '../../types/ui.js';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'claude-code',
    content: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('HelpOverlay', () => {
  it('renders keybinding list title', () => {
    const { lastFrame } = render(
      <HelpOverlay columns={80} rows={24} />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Keybindings');
  });

  // AC-073: ? key displays complete keybinding list
  it('shows all keybindings', () => {
    const { lastFrame } = render(
      <HelpOverlay columns={80} rows={24} />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Ctrl+C');
    expect(output).toContain('Ctrl+N');
    expect(output).toContain('Ctrl+I');
    expect(output).toContain('Ctrl+V');
    expect(output).toContain('Ctrl+T');
    expect(output).toContain('Ctrl+L');
    expect(output).toContain('j/k');
    expect(output).toContain('Esc');
  });

  it('shows Esc to close hint', () => {
    const { lastFrame } = render(
      <HelpOverlay columns={80} rows={24} />,
    );
    expect(lastFrame()!).toContain('Esc');
  });
});

describe('ContextOverlay', () => {
  it('renders context summary title', () => {
    const { lastFrame } = render(
      <ContextOverlay
        columns={80}
        rows={24}
        coderName="Claude"
        reviewerName="Codex"
        taskSummary="Fix auth bug"
        tokenEstimate={2500}
      />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Context');
  });

  it('shows coder and reviewer names', () => {
    const { lastFrame } = render(
      <ContextOverlay
        columns={80}
        rows={24}
        coderName="Claude"
        reviewerName="Gemini"
        taskSummary="Test"
        tokenEstimate={500}
      />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Claude');
    expect(output).toContain('Gemini');
  });

  it('shows token estimate', () => {
    const { lastFrame } = render(
      <ContextOverlay
        columns={80}
        rows={24}
        coderName="Claude"
        reviewerName="Codex"
        taskSummary="Test"
        tokenEstimate={3200}
      />,
    );
    expect(lastFrame()!).toContain('3200');
  });
});

describe('TimelineOverlay', () => {
  const events = [
    { timestamp: 1000, type: 'task_start' as const, description: 'Task started' },
    { timestamp: 2000, type: 'coding' as const, description: 'Coder round 1' },
    { timestamp: 3000, type: 'reviewing' as const, description: 'Reviewer round 1' },
  ];

  it('renders timeline title', () => {
    const { lastFrame } = render(
      <TimelineOverlay columns={80} rows={24} events={events} />,
    );
    expect(lastFrame()!).toContain('Timeline');
  });

  it('shows event descriptions', () => {
    const { lastFrame } = render(
      <TimelineOverlay columns={80} rows={24} events={events} />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Task started');
    expect(output).toContain('Coder round 1');
    expect(output).toContain('Reviewer round 1');
  });

  it('handles empty event list', () => {
    const { lastFrame } = render(
      <TimelineOverlay columns={80} rows={24} events={[]} />,
    );
    expect(lastFrame()!).toContain('No events');
  });
});

describe('SearchOverlay', () => {
  const messages: Message[] = [
    makeMessage({ id: '1', content: 'Hello world' }),
    makeMessage({ id: '2', content: 'Goodbye world' }),
    makeMessage({ id: '3', content: 'Hello again' }),
  ];

  it('renders search input area', () => {
    const { lastFrame } = render(
      <SearchOverlay
        columns={80}
        rows={24}
        query=""
        results={[]}
      />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Search');
  });

  it('shows current query', () => {
    const { lastFrame } = render(
      <SearchOverlay
        columns={80}
        rows={24}
        query="hello"
        results={[messages[0], messages[2]]}
      />,
    );
    expect(lastFrame()!).toContain('hello');
  });

  it('shows matching results', () => {
    const { lastFrame } = render(
      <SearchOverlay
        columns={80}
        rows={24}
        query="hello"
        results={[messages[0], messages[2]]}
      />,
    );
    const output = lastFrame()!;
    expect(output).toContain('Hello world');
    expect(output).toContain('Hello again');
  });

  it('shows no results message for empty results', () => {
    const { lastFrame } = render(
      <SearchOverlay
        columns={80}
        rows={24}
        query="xyz"
        results={[]}
      />,
    );
    expect(lastFrame()!).toContain('No results');
  });

  it('shows placeholder when query is empty', () => {
    const { lastFrame } = render(
      <SearchOverlay
        columns={80}
        rows={24}
        query=""
        results={[]}
      />,
    );
    const output = lastFrame()!;
    // Should show search prompt/placeholder
    expect(output).toContain('Search');
  });
});
