/**
 * Tests for the Ctrl+C / Cmd+C copy-on-selection behavior introduced in App.tsx.
 *
 * The logic under test lives inside the useInput handler but the decision tree
 * is pure enough to be validated with simple mock objects without mounting the
 * full React component tree.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Key } from '../../tui/primitives.js';

// ---------------------------------------------------------------------------
// Minimal mock types that mirror the CliRenderer surface we rely on.
// ---------------------------------------------------------------------------

interface MockSelection {
  getSelectedText(): string;
}

interface MockRenderer {
  hasSelection: boolean;
  getSelection(): MockSelection | null;
  copyToClipboardOSC52: ReturnType<typeof vi.fn>;
}

function makeRenderer(opts: {
  hasSelection: boolean;
  selectedText?: string;
}): MockRenderer {
  const selection: MockSelection | null = opts.hasSelection
    ? { getSelectedText: () => opts.selectedText ?? '' }
    : null;

  return {
    hasSelection: opts.hasSelection,
    getSelection: () => selection,
    copyToClipboardOSC52: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Replicate the decision logic from App.tsx so we can test it in isolation.
// ---------------------------------------------------------------------------

function handleCopyOrInterrupt(
  input: string,
  key: Pick<Key, 'ctrl' | 'meta'>,
  renderer: MockRenderer,
  onInterrupt: () => void,
): void {
  const isCopyKey = (key.ctrl || key.meta) && input === 'c';
  if (!isCopyKey) return;

  if (renderer.hasSelection) {
    const text = renderer.getSelection()?.getSelectedText();
    if (text) {
      renderer.copyToClipboardOSC52(text);
      return;
    }
  }

  // Cmd+C (meta only) without a selection: do nothing.
  if (!key.ctrl) return;

  // Ctrl+C without selection: interrupt.
  onInterrupt();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function baseKey(overrides: Partial<Pick<Key, 'ctrl' | 'meta'>> = {}): Pick<Key, 'ctrl' | 'meta'> {
  return { ctrl: false, meta: false, ...overrides };
}

describe('Ctrl+C / Cmd+C copy-on-selection behavior', () => {
  describe('Ctrl+C with active text selection', () => {
    it('calls copyToClipboardOSC52 with selected text', () => {
      const renderer = makeRenderer({ hasSelection: true, selectedText: 'hello world' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ ctrl: true }), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).toHaveBeenCalledOnce();
      expect(renderer.copyToClipboardOSC52).toHaveBeenCalledWith('hello world');
    });

    it('does NOT trigger interrupt when selection exists', () => {
      const renderer = makeRenderer({ hasSelection: true, selectedText: 'text' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ ctrl: true }), renderer, onInterrupt);

      expect(onInterrupt).not.toHaveBeenCalled();
    });
  });

  describe('Cmd+C (meta) with active text selection', () => {
    it('calls copyToClipboardOSC52 with selected text', () => {
      const renderer = makeRenderer({ hasSelection: true, selectedText: 'mac copy' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ meta: true }), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).toHaveBeenCalledOnce();
      expect(renderer.copyToClipboardOSC52).toHaveBeenCalledWith('mac copy');
    });

    it('does NOT trigger interrupt for Cmd+C with selection', () => {
      const renderer = makeRenderer({ hasSelection: true, selectedText: 'text' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ meta: true }), renderer, onInterrupt);

      expect(onInterrupt).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+C without selection', () => {
    it('triggers interrupt', () => {
      const renderer = makeRenderer({ hasSelection: false });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ ctrl: true }), renderer, onInterrupt);

      expect(onInterrupt).toHaveBeenCalledOnce();
    });

    it('does NOT call copyToClipboardOSC52', () => {
      const renderer = makeRenderer({ hasSelection: false });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ ctrl: true }), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
    });
  });

  describe('Cmd+C (meta only) without selection', () => {
    it('does NOT trigger interrupt (Cmd+C is copy-only on Mac)', () => {
      const renderer = makeRenderer({ hasSelection: false });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ meta: true }), renderer, onInterrupt);

      expect(onInterrupt).not.toHaveBeenCalled();
    });

    it('does NOT call copyToClipboardOSC52 when no selection', () => {
      const renderer = makeRenderer({ hasSelection: false });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ meta: true }), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
    });
  });

  describe('selection with empty text', () => {
    it('falls through to interrupt (Ctrl+C) when selected text is empty string', () => {
      // hasSelection true but getSelectedText returns '' — treat as no useful selection
      const renderer = makeRenderer({ hasSelection: true, selectedText: '' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey({ ctrl: true }), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
      expect(onInterrupt).toHaveBeenCalledOnce();
    });
  });

  describe('unrelated keys', () => {
    it('does nothing for Ctrl+D', () => {
      const renderer = makeRenderer({ hasSelection: true, selectedText: 'text' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('d', baseKey({ ctrl: true }), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
      expect(onInterrupt).not.toHaveBeenCalled();
    });

    it('does nothing for plain "c" (no modifier)', () => {
      const renderer = makeRenderer({ hasSelection: true, selectedText: 'text' });
      const onInterrupt = vi.fn();

      handleCopyOrInterrupt('c', baseKey(), renderer, onInterrupt);

      expect(renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
      expect(onInterrupt).not.toHaveBeenCalled();
    });
  });
});
