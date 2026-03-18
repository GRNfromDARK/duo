/**
 * Tests for keybindings.ts — pure keybinding mapping.
 * Source: FR-022 (AC-072, AC-073, AC-074)
 */
import { describe, it, expect } from 'vitest';
import type { Key } from '../../tui/primitives.js';
import {
  processKeybinding,
  KEYBINDING_LIST,
  type KeyAction,
  type KeyContext,
} from '../../ui/keybindings.js';

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    overlayOpen: null,
    inputEmpty: true,
    pageSize: 10,
    ...overrides,
  };
}

describe('processKeybinding', () => {
  // === Ctrl key combinations ===

  describe('Ctrl+C — interrupt', () => {
    it('returns interrupt action', () => {
      const result = processKeybinding('c', key({ ctrl: true }), ctx());
      expect(result).toEqual({ type: 'interrupt' });
    });

    it('works even when overlay is open', () => {
      const result = processKeybinding('c', key({ ctrl: true }), ctx({ overlayOpen: 'help' }));
      expect(result).toEqual({ type: 'interrupt' });
    });
  });

  describe('Ctrl+N — new session', () => {
    it('returns new_session action', () => {
      const result = processKeybinding('n', key({ ctrl: true }), ctx());
      expect(result).toEqual({ type: 'new_session' });
    });
  });

  describe('Ctrl+I — context overlay', () => {
    it('opens context overlay', () => {
      const result = processKeybinding('i', key({ ctrl: true }), ctx());
      expect(result).toEqual({ type: 'open_overlay', overlay: 'context' });
    });

    it('closes context overlay if already open', () => {
      const result = processKeybinding('i', key({ ctrl: true }), ctx({ overlayOpen: 'context' }));
      expect(result).toEqual({ type: 'close_overlay' });
    });
  });

  describe('Ctrl+V — toggle display mode', () => {
    it('returns toggle_display_mode action', () => {
      const result = processKeybinding('v', key({ ctrl: true }), ctx());
      expect(result).toEqual({ type: 'toggle_display_mode' });
    });
  });

  describe('Ctrl+T — timeline overlay', () => {
    it('opens timeline overlay', () => {
      const result = processKeybinding('t', key({ ctrl: true }), ctx());
      expect(result).toEqual({ type: 'open_overlay', overlay: 'timeline' });
    });

    it('closes timeline overlay if already open', () => {
      const result = processKeybinding('t', key({ ctrl: true }), ctx({ overlayOpen: 'timeline' }));
      expect(result).toEqual({ type: 'close_overlay' });
    });
  });

  describe('Ctrl+L — clear screen', () => {
    it('returns clear_screen action', () => {
      const result = processKeybinding('l', key({ ctrl: true }), ctx());
      expect(result).toEqual({ type: 'clear_screen' });
    });
  });

  // === Navigation keys ===

  describe('j/↓ — scroll down', () => {
    it('j scrolls down by 1', () => {
      const result = processKeybinding('j', key(), ctx());
      expect(result).toEqual({ type: 'scroll_down', amount: 1 });
    });

    it('down arrow scrolls down by 1', () => {
      const result = processKeybinding('', key({ downArrow: true }), ctx());
      expect(result).toEqual({ type: 'scroll_down', amount: 1 });
    });

    it('does not scroll j when overlay is open', () => {
      const result = processKeybinding('j', key(), ctx({ overlayOpen: 'help' }));
      expect(result).toEqual({ type: 'noop' });
    });

    it('j does not scroll when input has text', () => {
      const result = processKeybinding('j', key(), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'noop' });
    });

    it('down arrow scrolls even when input has text (mouse wheel support)', () => {
      const result = processKeybinding('', key({ downArrow: true }), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'scroll_down', amount: 1 });
    });

    it('down arrow does not scroll when overlay is open', () => {
      const result = processKeybinding('', key({ downArrow: true }), ctx({ overlayOpen: 'help' }));
      expect(result).toEqual({ type: 'noop' });
    });
  });

  describe('k/↑ — scroll up', () => {
    it('k scrolls up by 1', () => {
      const result = processKeybinding('k', key(), ctx());
      expect(result).toEqual({ type: 'scroll_up', amount: 1 });
    });

    it('up arrow scrolls up by 1', () => {
      const result = processKeybinding('', key({ upArrow: true }), ctx());
      expect(result).toEqual({ type: 'scroll_up', amount: 1 });
    });

    it('up arrow scrolls even when input has text (mouse wheel support)', () => {
      const result = processKeybinding('', key({ upArrow: true }), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'scroll_up', amount: 1 });
    });
  });

  describe('G — jump to end', () => {
    it('jumps to latest message', () => {
      const result = processKeybinding('G', key(), ctx());
      expect(result).toEqual({ type: 'jump_to_end' });
    });

    it('does not jump when input has text', () => {
      const result = processKeybinding('G', key(), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'noop' });
    });
  });

  describe('PgDown/PgUp — page scroll', () => {
    it('PgDown scrolls down by page size', () => {
      const result = processKeybinding('', key({ pageDown: true }), ctx({ pageSize: 15 }));
      expect(result).toEqual({ type: 'scroll_down', amount: 15 });
    });

    it('PgUp scrolls up by page size', () => {
      const result = processKeybinding('', key({ pageUp: true }), ctx({ pageSize: 15 }));
      expect(result).toEqual({ type: 'scroll_up', amount: 15 });
    });
  });

  // === Special keys ===

  describe('? — help overlay', () => {
    it('opens help when input is empty', () => {
      const result = processKeybinding('?', key(), ctx({ inputEmpty: true }));
      expect(result).toEqual({ type: 'open_overlay', overlay: 'help' });
    });

    it('returns noop when input has text (let InputArea handle)', () => {
      const result = processKeybinding('?', key(), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'noop' });
    });

    it('closes help if already open', () => {
      const result = processKeybinding('?', key(), ctx({ overlayOpen: 'help' }));
      expect(result).toEqual({ type: 'close_overlay' });
    });
  });

  describe('/ — search overlay', () => {
    it('opens search when input is empty', () => {
      const result = processKeybinding('/', key(), ctx({ inputEmpty: true }));
      expect(result).toEqual({ type: 'open_overlay', overlay: 'search' });
    });

    it('returns noop when input has text', () => {
      const result = processKeybinding('/', key(), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'noop' });
    });
  });

  describe('Esc — close overlay', () => {
    it('closes overlay when one is open', () => {
      const result = processKeybinding('', key({ escape: true }), ctx({ overlayOpen: 'help' }));
      expect(result).toEqual({ type: 'close_overlay' });
    });

    it('returns noop when no overlay is open', () => {
      const result = processKeybinding('', key({ escape: true }), ctx({ overlayOpen: null }));
      expect(result).toEqual({ type: 'noop' });
    });
  });

  describe('Enter — toggle code block', () => {
    it('returns toggle_code_block when input is empty and no overlay', () => {
      const result = processKeybinding('', key({ return: true }), ctx({ inputEmpty: true }));
      expect(result).toEqual({ type: 'toggle_code_block' });
    });

    it('returns noop when input has text (InputArea handles submit)', () => {
      const result = processKeybinding('', key({ return: true }), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'noop' });
    });
  });

  describe('Tab — path completion', () => {
    it('returns tab_complete action', () => {
      const result = processKeybinding('', key({ tab: true }), ctx());
      expect(result).toEqual({ type: 'tab_complete' });
    });
  });

  // === Priority: Ctrl keys always win ===

  describe('priority', () => {
    it('Ctrl keys work even when input has text', () => {
      const result = processKeybinding('l', key({ ctrl: true }), ctx({ inputEmpty: false }));
      expect(result).toEqual({ type: 'clear_screen' });
    });

    it('Ctrl keys work even when overlay is open (except toggle ones)', () => {
      const result = processKeybinding('n', key({ ctrl: true }), ctx({ overlayOpen: 'help' }));
      expect(result).toEqual({ type: 'new_session' });
    });
  });
});

describe('KEYBINDING_LIST', () => {
  // AC-073: ? key displays complete keybinding list
  it('contains all 15 keybindings', () => {
    expect(KEYBINDING_LIST.length).toBe(15);
  });

  it('each entry has shortcut and description', () => {
    for (const entry of KEYBINDING_LIST) {
      expect(entry).toHaveProperty('shortcut');
      expect(entry).toHaveProperty('description');
      expect(entry.shortcut.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
