/**
 * Tests for the Ctrl+C / Cmd+C copy-on-selection behavior.
 *
 * Unlike the previous version that replicated App.tsx decision logic,
 * this file imports and tests the REAL exported `resolveCopyOrInterrupt`
 * from App.tsx, plus verifies that `processInput` in InputArea correctly
 * filters super/meta modifier keys so they don't produce character input.
 *
 * Key behaviors:
 * 1. Selection with text → copy via OSC52, no interrupt
 * 2. Selection with empty text but valid cached text → copy cached via OSC52
 * 3. Selection with empty text, stale cache → silent no-op
 * 4. No selection, Ctrl+C → interrupt
 * 5. No selection, Cmd+C (super) → no-op (macOS copy without selection)
 * 6. Stale cache from old selection does NOT leak to new selection
 * 7. Command+C (key.super) with selection → copy, no interrupt
 * 8. Cmd+C / Option+C do NOT insert characters into InputArea
 */

import { describe, it, expect, vi } from 'vitest';

// Mock OpenTUI modules required by App.tsx and InputArea.tsx imports
vi.mock('@opentui/core', () => ({
  createTextAttributes: vi.fn(),
  decodePasteBytes: vi.fn((bytes: Uint8Array) => new TextDecoder().decode(bytes)),
  stripAnsiSequences: vi.fn((s: string) => s),
}));
vi.mock('@opentui/react', () => ({
  useAppContext: vi.fn(() => ({ keyHandler: null, renderer: null })),
  useKeyboard: vi.fn(),
}));

// Import the REAL decision function from App.tsx
import { resolveCopyOrInterrupt } from '../../ui/components/App.js';
// Import the REAL input processor from InputArea.tsx
import { processInput } from '../../ui/components/InputArea.js';
import type { Key } from '../../tui/primitives.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CopyKey = Pick<Key, 'ctrl' | 'meta' | 'super'>;

function baseKey(overrides: Partial<CopyKey> = {}): CopyKey {
  return { ctrl: false, meta: false, super: false, ...overrides };
}

function fullKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false, super: false,
    hyper: false, capsLock: false, numLock: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests for resolveCopyOrInterrupt (real App.tsx export)
// ---------------------------------------------------------------------------

describe('resolveCopyOrInterrupt (real App.tsx export)', () => {
  describe('Ctrl+C with active text selection', () => {
    it('returns copy action with selected text', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        true, 'hello world', '', false);
      expect(result).toEqual({ action: 'copy', text: 'hello world' });
    });

    it('does NOT return interrupt when selection exists', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        true, 'text', '', false);
      expect(result.action).not.toBe('interrupt');
    });
  });

  describe('Command+C (key.super — macOS Command key via kitty protocol)', () => {
    it('returns copy action with selected text', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ super: true }),
        true, 'mac copy', '', false);
      expect(result).toEqual({ action: 'copy', text: 'mac copy' });
    });

    it('does NOT return interrupt for Command+C with selection', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ super: true }),
        true, 'text', '', false);
      expect(result.action).not.toBe('interrupt');
    });

    it('does NOT return interrupt for Command+C without selection', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ super: true }),
        false, '', '', false);
      expect(result).toEqual({ action: 'noop' });
    });

    it('does NOT return copy for Command+C without selection', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ super: true }),
        false, '', '', false);
      expect(result.action).not.toBe('copy');
    });
  });

  describe('Option+C (key.meta — macOS Option key)', () => {
    it('returns copy action with selected text', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ meta: true }),
        true, 'option copy', '', false);
      expect(result).toEqual({ action: 'copy', text: 'option copy' });
    });

    it('does NOT return interrupt for Option+C without selection', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ meta: true }),
        false, '', '', false);
      expect(result).toEqual({ action: 'noop' });
    });
  });

  describe('Ctrl+C without selection', () => {
    it('returns interrupt', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        false, '', '', false);
      expect(result).toEqual({ action: 'interrupt' });
    });
  });

  describe('selection with empty live text but valid cached text', () => {
    it('copies cached text when live extraction returns empty (Ctrl+C)', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        true, '', 'cached hello', true);
      expect(result).toEqual({ action: 'copy', text: 'cached hello' });
    });

    it('copies cached text when live extraction returns empty (Command+C)', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ super: true }),
        true, '', 'cached mac', true);
      expect(result).toEqual({ action: 'copy', text: 'cached mac' });
    });

    it('prefers live text over cached text when both available', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        true, 'live text', 'stale cached', true);
      expect(result).toEqual({ action: 'copy', text: 'live text' });
    });
  });

  describe('stale cache from different selection does NOT leak', () => {
    it('does NOT copy stale cache when cacheValid is false (Ctrl+C)', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        true, '', 'old text A', false);
      expect(result).toEqual({ action: 'noop' });
    });
  });

  describe('selection with empty text AND no cached text', () => {
    it('does NOT trigger interrupt (Ctrl+C) — user intended copy, not interrupt', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        true, '', '', false);
      expect(result).toEqual({ action: 'noop' });
    });
  });

  describe('cached text does not leak to no-selection path', () => {
    it('Ctrl+C without selection still interrupts even if cache has text', () => {
      const result = resolveCopyOrInterrupt('c', baseKey({ ctrl: true }),
        false, '', 'stale cached', true);
      expect(result).toEqual({ action: 'interrupt' });
    });
  });

  describe('unrelated keys', () => {
    it('does nothing for Ctrl+D', () => {
      const result = resolveCopyOrInterrupt('d', baseKey({ ctrl: true }),
        true, 'text', '', false);
      expect(result).toEqual({ action: 'noop' });
    });

    it('does nothing for plain "c" (no modifier)', () => {
      const result = resolveCopyOrInterrupt('c', baseKey(),
        true, 'text', '', false);
      expect(result).toEqual({ action: 'noop' });
    });
  });
});

// ---------------------------------------------------------------------------
// Tests for processInput: super/meta modifier keys must NOT insert characters
// (Blocker fix: Cmd+C / Option+C must not type 'c' into InputArea)
// ---------------------------------------------------------------------------

describe('processInput – super/meta modifier keys do NOT insert characters', () => {
  it('Cmd+C (key.super) returns noop, not character insertion', () => {
    const result = processInput('hello', 3, 'c', fullKey({ super: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('Option+C (key.meta) returns noop, not character insertion', () => {
    const result = processInput('hello', 3, 'c', fullKey({ meta: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('Cmd+V (key.super) returns noop', () => {
    const result = processInput('hello', 3, 'v', fullKey({ super: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('Option+A (key.meta) returns noop', () => {
    const result = processInput('hello', 3, 'a', fullKey({ meta: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('Ctrl+C still returns noop (existing behavior preserved)', () => {
    const result = processInput('hello', 3, 'c', fullKey({ ctrl: true }), 5);
    expect(result).toEqual({ type: 'noop' });
  });

  it('plain "c" (no modifier) still inserts character normally', () => {
    const result = processInput('hello', 3, 'c', fullKey(), 5);
    expect(result).toEqual({ type: 'update', value: 'helclo', cursorPos: 4 });
  });
});
