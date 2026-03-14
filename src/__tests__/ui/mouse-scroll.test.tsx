import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MainLayout } from '../../ui/components/MainLayout.js';
import {
  scrollUp,
  scrollDown,
  computeScrollView,
  jumpToEnd,
  INITIAL_SCROLL_STATE,
  type ScrollState,
} from '../../ui/scroll-state.js';
import type { Message } from '../../types/ui.js';

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    role: 'claude-code' as const,
    content: `Message ${i}`,
    timestamp: Date.now() + i * 1000,
  }));
}

// ── Pure scroll state tests (same functions used by mouse + keyboard handlers) ──

describe('Mouse scroll — scrollUp by 3 lines (mouse wheel tick)', () => {
  const totalLines = 100;
  const viewportHeight = 20;
  const MOUSE_LINES = 3;

  it('first scrollUp from auto-follow sets offset to maxOffset - 3', () => {
    const state = scrollUp(INITIAL_SCROLL_STATE, MOUSE_LINES, totalLines, viewportHeight);
    const maxOffset = totalLines - viewportHeight; // 80
    expect(state.scrollOffset).toBe(maxOffset - MOUSE_LINES); // 77
    expect(state.autoFollow).toBe(false);
    expect(state.lockedAtCount).toBe(totalLines); // locked at current count
  });

  it('subsequent scrollUp continues decreasing offset', () => {
    let state = scrollUp(INITIAL_SCROLL_STATE, MOUSE_LINES, totalLines, viewportHeight);
    const first = state.scrollOffset; // 77
    state = scrollUp(state, MOUSE_LINES, totalLines, viewportHeight);
    expect(state.scrollOffset).toBe(first - MOUSE_LINES); // 74
    state = scrollUp(state, MOUSE_LINES, totalLines, viewportHeight);
    expect(state.scrollOffset).toBe(first - 2 * MOUSE_LINES); // 71
  });

  it('scrollUp clamps at offset 0 (cannot scroll past top)', () => {
    let state = INITIAL_SCROLL_STATE;
    // Scroll up 100 times × 3 lines = 300 lines, way past the start
    for (let i = 0; i < 100; i++) {
      state = scrollUp(state, MOUSE_LINES, totalLines, viewportHeight);
    }
    expect(state.scrollOffset).toBe(0);
    expect(state.autoFollow).toBe(false);
  });

  it('scrollUp with 0 total lines stays at offset 0', () => {
    const state = scrollUp(INITIAL_SCROLL_STATE, MOUSE_LINES, 0, viewportHeight);
    expect(state.scrollOffset).toBe(0);
  });

  it('scrollUp when content fits in viewport stays at offset 0', () => {
    // totalLines < viewportHeight
    const state = scrollUp(INITIAL_SCROLL_STATE, MOUSE_LINES, 10, viewportHeight);
    expect(state.scrollOffset).toBe(0);
  });
});

describe('Mouse scroll — scrollDown by 3 lines (mouse wheel tick)', () => {
  const totalLines = 100;
  const viewportHeight = 20;
  const MOUSE_LINES = 3;

  it('scrollDown from a scrolled-up position increases offset by 3', () => {
    const scrolledUp: ScrollState = { scrollOffset: 50, autoFollow: false, lockedAtCount: 100 };
    const state = scrollDown(scrolledUp, MOUSE_LINES, totalLines, viewportHeight);
    expect(state.scrollOffset).toBe(53);
    expect(state.autoFollow).toBe(false); // not at bottom yet
  });

  it('scrollDown clamps at maxOffset (cannot scroll past bottom)', () => {
    const maxOffset = totalLines - viewportHeight; // 80
    const nearBottom: ScrollState = { scrollOffset: 79, autoFollow: false, lockedAtCount: 90 };
    const state = scrollDown(nearBottom, MOUSE_LINES, totalLines, viewportHeight);
    expect(state.scrollOffset).toBe(maxOffset); // clamped at 80
    expect(state.autoFollow).toBe(true); // reached bottom, auto-follow re-enabled
    expect(state.lockedAtCount).toBe(-1); // reset
  });

  it('scrollDown re-enables auto-follow when reaching bottom', () => {
    const scrolledUp: ScrollState = { scrollOffset: 50, autoFollow: false, lockedAtCount: 100 };
    // Scroll down enough to reach the bottom
    const state = scrollDown(scrolledUp, 100, totalLines, viewportHeight);
    expect(state.autoFollow).toBe(true);
    expect(state.scrollOffset).toBe(totalLines - viewportHeight);
  });
});

describe('Mouse scroll — computeScrollView integration', () => {
  const totalLines = 100;
  const viewportHeight = 20;

  it('auto-follow shows the last N lines', () => {
    const view = computeScrollView(INITIAL_SCROLL_STATE, totalLines, viewportHeight);
    expect(view.effectiveOffset).toBe(totalLines - viewportHeight); // 80
    expect(view.visibleSlots).toBe(viewportHeight); // 20
    expect(view.showIndicator).toBe(false);
  });

  it('after scrollUp, effectiveOffset changes', () => {
    const state = scrollUp(INITIAL_SCROLL_STATE, 3, totalLines, viewportHeight);
    const view = computeScrollView(state, totalLines, viewportHeight);
    expect(view.effectiveOffset).toBe(totalLines - viewportHeight - 3); // 77
    expect(view.visibleSlots).toBe(viewportHeight); // no indicator yet (no new messages)
  });

  it('indicator appears when new messages arrive after scroll lock', () => {
    const state = scrollUp(INITIAL_SCROLL_STATE, 3, totalLines, viewportHeight);
    // lockedAtCount = 100, simulate 5 new messages arriving
    const view = computeScrollView(state, totalLines + 5, viewportHeight);
    expect(view.showIndicator).toBe(true);
    expect(view.newMessageCount).toBe(5);
    expect(view.visibleSlots).toBe(viewportHeight - 1); // 1 line used by indicator
  });

  it('visible window shows exactly visibleSlots lines starting at effectiveOffset', () => {
    const state = scrollUp(INITIAL_SCROLL_STATE, 30, totalLines, viewportHeight);
    const view = computeScrollView(state, totalLines, viewportHeight);
    // Lines visible: [effectiveOffset, effectiveOffset + visibleSlots)
    expect(view.effectiveOffset).toBe(50); // 80-30
    // No indicator (no new messages since lock), so full viewport
    expect(view.visibleSlots).toBe(viewportHeight); // 20
  });

  it('full cycle: scrollUp then scrollDown returns to auto-follow view', () => {
    let state = INITIAL_SCROLL_STATE;

    // Scroll up 5 mouse ticks (15 lines)
    for (let i = 0; i < 5; i++) {
      state = scrollUp(state, 3, totalLines, viewportHeight);
    }

    const viewUp = computeScrollView(state, totalLines, viewportHeight);
    expect(viewUp.effectiveOffset).toBe(65); // 80-15

    // Scroll down 5 mouse ticks (15 lines) — should reach bottom
    for (let i = 0; i < 5; i++) {
      state = scrollDown(state, 3, totalLines, viewportHeight);
    }

    const viewDown = computeScrollView(state, totalLines, viewportHeight);
    expect(viewDown.effectiveOffset).toBe(80); // back at bottom
    expect(viewDown.showIndicator).toBe(false);
    expect(state.autoFollow).toBe(true);
  });
});

describe('Mouse scroll — boundary conditions', () => {
  it('scrollUp at offset 0 stays at 0', () => {
    const atTop: ScrollState = { scrollOffset: 0, autoFollow: false, lockedAtCount: 50 };
    const after = scrollUp(atTop, 3, 100, 20);
    expect(after.scrollOffset).toBe(0);
  });

  it('scrollDown at maxOffset stays at maxOffset with auto-follow', () => {
    const maxOffset = 80; // 100-20
    const atBottom: ScrollState = { scrollOffset: maxOffset, autoFollow: false, lockedAtCount: 50 };
    const after = scrollDown(atBottom, 3, 100, 20);
    expect(after.scrollOffset).toBe(maxOffset);
    expect(after.autoFollow).toBe(true);
  });

  it('scrollUp with exactly 1 line of overflow works', () => {
    // 21 total lines, 20 viewport = 1 line overflow
    const state = scrollUp(INITIAL_SCROLL_STATE, 3, 21, 20);
    expect(state.scrollOffset).toBe(0); // max is 1, -3 = 0 (clamped)
    expect(state.autoFollow).toBe(false);
  });

  it('scrollDown with content fitting in viewport is a no-op', () => {
    // 10 lines, 20 viewport — no scrolling needed
    const atStart: ScrollState = { scrollOffset: 0, autoFollow: false, lockedAtCount: 5 };
    const after = scrollDown(atStart, 3, 10, 20);
    expect(after.scrollOffset).toBe(0); // max is 0
    expect(after.autoFollow).toBe(true);
  });

  it('jumpToEnd from any position returns to bottom with auto-follow', () => {
    const state = jumpToEnd(100, 20);
    expect(state.scrollOffset).toBe(80);
    expect(state.autoFollow).toBe(true);
    expect(state.lockedAtCount).toBe(-1);
  });
});

// ── MainLayout integration: verify scrollbar renders correctly ──

describe('Mouse scroll — MainLayout scrollbar rendering', () => {
  it('shows scrollbar track when content overflows viewport', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(50)}
        statusText="Duo"
        columns={80}
        rows={12}
      />
    );
    const output = lastFrame()!;
    // Scrollbar uses █ for thumb and ┃ for track
    expect(output).toContain('█');
    // Line position indicator
    expect(output).toMatch(/L\d+\/\d+/);
  });

  it('does not show scroll position indicator when content fits in viewport', () => {
    const { lastFrame } = render(
      <MainLayout
        messages={makeMessages(1)}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    const output = lastFrame()!;
    // No line position indicator (L.../... only appears when scrollable)
    expect(output).not.toMatch(/L\d+\/\d+/);
    // Message border ┃ will still appear (it's the role border character)
    // But the scrollbar thumb █ should NOT appear in the rightmost column
    // (scrollbar only renders when totalLines > visibleSlots)
  });

  it('renders without crash when receiving mouse escape sequences via stdin', () => {
    const { lastFrame, stdin } = render(
      <MainLayout
        messages={makeMessages(50)}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    // These won't actually trigger scrolling (ink-testing-library processes stdin
    // through Ink's input pipeline, not raw data events), but must not crash
    stdin.write('\x1b[<64;10;5M'); // SGR wheel up
    stdin.write('\x1b[<65;10;5M'); // SGR wheel down
    stdin.write('\x1b[M`\x21\x21'); // Legacy wheel up
    stdin.write('\x1b[Ma\x21\x21'); // Legacy wheel down
    stdin.write('\x1b[<0;10;5M');   // Regular click (should be ignored)
    const output = lastFrame()!;
    expect(output).toContain('Message');
  });

  it('mouse escape sequences do NOT leak into the input area', () => {
    const { lastFrame, stdin } = render(
      <MainLayout
        messages={makeMessages(5)}
        statusText="Duo"
        columns={80}
        rows={24}
      />
    );
    // Send multiple mouse scroll escape sequences
    stdin.write('\x1b[<64;10;5M');  // SGR wheel up
    stdin.write('\x1b[<65;10;5M');  // SGR wheel down
    stdin.write('\x1b[<64;20;10M'); // SGR wheel up at different position
    stdin.write('\x1b[<0;10;5M');   // Mouse click

    const output = lastFrame()!;
    // The input area should still show the placeholder (empty input)
    // If escape sequences leaked, we'd see garbage text instead of the placeholder
    expect(output).toContain('Type a message...');
    // Should NOT contain any raw escape sequence fragments
    expect(output).not.toContain('[<64');
    expect(output).not.toContain('[<65');
    expect(output).not.toContain('[<0');
  });
});
