/**
 * Pure keybinding mapping — maps (input, key, context) to actions.
 * Source: FR-022 (AC-072, AC-073, AC-074)
 *
 * Extracted as pure function for testability, consistent with
 * scroll-state.ts and display-mode.ts patterns.
 */
import type { Key } from '../tui/primitives.js';

export type OverlayType = 'help' | 'context' | 'timeline' | 'search';

export type KeyAction =
  | { type: 'scroll_up'; amount: number }
  | { type: 'scroll_down'; amount: number }
  | { type: 'jump_to_end' }
  | { type: 'toggle_display_mode' }
  | { type: 'open_overlay'; overlay: OverlayType }
  | { type: 'close_overlay' }
  | { type: 'clear_screen' }
  | { type: 'new_session' }
  | { type: 'interrupt' }
  | { type: 'reclassify' }
  | { type: 'toggle_code_block' }
  | { type: 'tab_complete' }
  | { type: 'noop' };

export interface KeyContext {
  overlayOpen: OverlayType | null;
  inputEmpty: boolean;
  pageSize: number;
}

/**
 * Map keyboard input to an action based on context.
 *
 * Priority order:
 * 1. Ctrl key combinations (always active)
 * 2. Escape (close overlay)
 * 3. Overlay-specific: ? and / toggle their overlays
 * 4. Navigation keys (only when no overlay and input empty)
 * 5. Enter / Tab (context-dependent)
 */
export function processKeybinding(
  input: string,
  key: Key,
  ctx: KeyContext,
): KeyAction {
  // === Priority 1: Ctrl combinations — always active ===
  if (key.ctrl) {
    switch (input) {
      case 'c':
        return { type: 'interrupt' };
      case 'n':
        return { type: 'new_session' };
      case 'i':
        return ctx.overlayOpen === 'context'
          ? { type: 'close_overlay' }
          : { type: 'open_overlay', overlay: 'context' };
      case 'v':
        return { type: 'toggle_display_mode' };
      case 't':
        return ctx.overlayOpen === 'timeline'
          ? { type: 'close_overlay' }
          : { type: 'open_overlay', overlay: 'timeline' };
      case 'l':
        return { type: 'clear_screen' };
      case 'r':
        return { type: 'reclassify' };
    }
  }

  // === Priority 2: Escape — close overlay ===
  if (key.escape) {
    return ctx.overlayOpen ? { type: 'close_overlay' } : { type: 'noop' };
  }

  // === Priority 3: ? and / — overlay toggles ===
  if (input === '?') {
    if (ctx.overlayOpen === 'help') return { type: 'close_overlay' };
    if (ctx.inputEmpty) return { type: 'open_overlay', overlay: 'help' };
    return { type: 'noop' };
  }

  if (input === '/') {
    if (ctx.inputEmpty) return { type: 'open_overlay', overlay: 'search' };
    return { type: 'noop' };
  }

  // === Priority 4: Navigation — j/k/G only when no overlay and input empty ===
  if (!ctx.overlayOpen && ctx.inputEmpty) {
    if (input === 'j') {
      return { type: 'scroll_down', amount: 1 };
    }
    if (input === 'k') {
      return { type: 'scroll_up', amount: 1 };
    }
    if (input === 'G') {
      return { type: 'jump_to_end' };
    }
  }

  // Arrow/Page scroll — always active (not in overlay).
  // Mouse wheel is normalized into up/down arrows by the terminal backend.
  // InputArea already ignores upArrow/downArrow, so no conflict.
  if (!ctx.overlayOpen) {
    if (key.downArrow) {
      return { type: 'scroll_down', amount: 1 };
    }
    if (key.upArrow) {
      return { type: 'scroll_up', amount: 1 };
    }
    if (key.pageDown) {
      return { type: 'scroll_down', amount: ctx.pageSize };
    }
    if (key.pageUp) {
      return { type: 'scroll_up', amount: ctx.pageSize };
    }
  }

  // === Priority 5: Enter and Tab ===
  if (key.return && ctx.inputEmpty && !ctx.overlayOpen) {
    return { type: 'toggle_code_block' };
  }

  if (key.tab) {
    return { type: 'tab_complete' };
  }

  return { type: 'noop' };
}

/**
 * Complete keybinding reference for the help overlay.
 * AC-073: ? key displays complete keybinding list.
 */
export interface KeybindingEntry {
  shortcut: string;
  description: string;
}

export const KEYBINDING_LIST: KeybindingEntry[] = [
  { shortcut: 'Ctrl+C', description: 'Interrupt LLM (single) / Exit (double)' },
  { shortcut: 'Ctrl+N', description: 'New session' },
  { shortcut: 'Ctrl+I', description: 'Context summary overlay' },
  { shortcut: 'Ctrl+V', description: 'Toggle Minimal/Verbose mode' },
  { shortcut: 'Ctrl+T', description: 'Event timeline overlay' },
  { shortcut: 'Ctrl+R', description: 'Reclassify task type' },
  { shortcut: 'Ctrl+L', description: 'Clear screen (preserve history)' },
  { shortcut: 'j/k or ↑/↓ or wheel', description: 'Scroll messages' },
  { shortcut: 'Shift+drag', description: 'Select/copy text' },
  { shortcut: 'G', description: 'Jump to latest message' },
  { shortcut: 'Enter', description: 'Expand/collapse code block' },
  { shortcut: 'Tab', description: 'Path autocomplete' },
  { shortcut: '?', description: 'Help / keybinding list' },
  { shortcut: '/', description: 'Search message history' },
  { shortcut: 'Esc', description: 'Close overlay / return' },
];
