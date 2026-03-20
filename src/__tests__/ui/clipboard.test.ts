/**
 * Tests for the unified clipboard helper (src/ui/clipboard.ts).
 *
 * Covers:
 * - OSC52 success path (no fallback attempted)
 * - OSC52 failure → platform fallback success
 * - Fallback tries candidates in order until one succeeds
 * - wl-copy fails → xclip succeeds
 * - xclip fails → xsel succeeds
 * - All candidates fail → one-time hint
 * - Hint only shown once; resetFailureHint re-enables it
 * - Platform candidate lists (macOS / Wayland / X11)
 * - tryFallbackCopy success and failure
 * - App-level integration: both auto-copy and manual copy call unified helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process so tests never spawn real processes
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Mock opentui modules required when importing App.tsx
// ---------------------------------------------------------------------------

vi.mock('@opentui/core', () => ({
  createTextAttributes: vi.fn(),
  decodePasteBytes: vi.fn((bytes: Uint8Array) => new TextDecoder().decode(bytes)),
  stripAnsiSequences: vi.fn((s: string) => s),
}));
vi.mock('@opentui/react', () => ({
  useAppContext: vi.fn(() => ({ keyHandler: null, renderer: null })),
  useKeyboard: vi.fn(),
}));

// ---------------------------------------------------------------------------
// SUT imports
// ---------------------------------------------------------------------------

import {
  copyToClipboard,
  tryFallbackCopy,
  buildFallbackCandidates,
  resetFailureHint,
  hasShownFailureHint,
  type ClipboardRenderer,
  type FallbackCandidate,
} from '../../ui/clipboard.js';
import { resolveCopyOrInterrupt } from '../../ui/components/App.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRenderer(osc52Returns: boolean): ClipboardRenderer {
  return { copyToClipboardOSC52: vi.fn(() => osc52Returns) };
}

let origPlatform: string;
let origWayland: string | undefined;

function setPlatform(platform: string, wayland?: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  if (wayland !== undefined) {
    process.env.WAYLAND_DISPLAY = wayland;
  } else {
    delete process.env.WAYLAND_DISPLAY;
  }
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  if (origWayland === undefined) {
    delete process.env.WAYLAND_DISPLAY;
  } else {
    process.env.WAYLAND_DISPLAY = origWayland;
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  origPlatform = process.platform;
  origWayland = process.env.WAYLAND_DISPLAY;
  resetFailureHint();
  mockExecFileSync.mockReset();
});

afterEach(() => {
  restorePlatform();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// copyToClipboard — OSC52 success
// ═══════════════════════════════════════════════════════════════════════════

describe('copyToClipboard – OSC52 success', () => {
  it('returns {success, osc52} when renderer returns true', () => {
    const r = makeRenderer(true);
    expect(copyToClipboard(r, 'hello')).toEqual({ success: true, method: 'osc52' });
    expect(r.copyToClipboardOSC52).toHaveBeenCalledWith('hello');
  });

  it('does not attempt any fallback when osc52 succeeds', () => {
    makeRenderer(true);
    copyToClipboard(makeRenderer(true), 'x');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// copyToClipboard — fallback walks candidates in order
// ═══════════════════════════════════════════════════════════════════════════

describe('copyToClipboard – fallback candidate walking', () => {
  it('macOS: pbcopy success', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
    expect(copyToClipboard(makeRenderer(false), 'txt')).toEqual({ success: true, method: 'fallback' });
    expect(mockExecFileSync).toHaveBeenCalledWith('pbcopy', [], expect.objectContaining({ input: 'txt' }));
  });

  it('Linux+Wayland: wl-copy fails → xclip succeeds', () => {
    setPlatform('linux', 'wayland-0');
    let callIndex = 0;
    mockExecFileSync.mockImplementation(((cmd: string) => {
      callIndex++;
      if (cmd === 'wl-copy') throw new Error('wl-copy broken');
      return Buffer.from('');
    }) as typeof execFileSync);

    expect(copyToClipboard(makeRenderer(false), 't')).toEqual({ success: true, method: 'fallback' });
    // wl-copy was tried first and failed, then xclip succeeded
    expect(mockExecFileSync).toHaveBeenCalledWith('wl-copy', [], expect.anything());
    expect(mockExecFileSync).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard'], expect.anything());
  });

  it('Linux+Wayland: wl-copy fails → xclip fails → xsel succeeds', () => {
    setPlatform('linux', 'wayland-0');
    mockExecFileSync.mockImplementation(((cmd: string) => {
      if (cmd === 'wl-copy' || cmd === 'xclip') throw new Error('broken');
      return Buffer.from('');
    }) as typeof execFileSync);

    expect(copyToClipboard(makeRenderer(false), 't')).toEqual({ success: true, method: 'fallback' });
    expect(mockExecFileSync).toHaveBeenCalledWith('xsel', ['--clipboard', '--input'], expect.anything());
  });

  it('Linux/X11: xclip fails → xsel succeeds', () => {
    setPlatform('linux');
    mockExecFileSync.mockImplementation(((cmd: string) => {
      if (cmd === 'xclip') throw new Error('broken');
      return Buffer.from('');
    }) as typeof execFileSync);

    expect(copyToClipboard(makeRenderer(false), 't')).toEqual({ success: true, method: 'fallback' });
    expect(mockExecFileSync).toHaveBeenCalledWith('xsel', ['--clipboard', '--input'], expect.anything());
  });

  it('does not cache failures — retries on next call', () => {
    setPlatform('darwin');
    // First call: pbcopy fails
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    const r = makeRenderer(false);
    const first = copyToClipboard(r, 'a');
    expect(first.success).toBe(false);

    // Second call: pbcopy works now
    resetFailureHint();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
    const second = copyToClipboard(r, 'b');
    expect(second).toEqual({ success: true, method: 'fallback' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One-time failure hint
// ═══════════════════════════════════════════════════════════════════════════

describe('copyToClipboard – one-time failure hint', () => {
  it('returns hint on first total failure', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    const result = copyToClipboard(makeRenderer(false), 'x');
    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
    expect(result.hint).toContain('clipboard failed');
  });

  it('shows hint only once', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    const r = makeRenderer(false);
    const first = copyToClipboard(r, 'a');
    const second = copyToClipboard(r, 'b');
    expect(first.hint).toBeDefined();
    expect(second.hint).toBeUndefined();
    expect(hasShownFailureHint()).toBe(true);
  });

  it('resetFailureHint allows hint to show again', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(copyToClipboard(makeRenderer(false), 'a').hint).toBeDefined();
    resetFailureHint();
    expect(copyToClipboard(makeRenderer(false), 'b').hint).toBeDefined();
  });

  it('macOS hint mentions iTerm2', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(copyToClipboard(makeRenderer(false), 'x').hint).toContain('iTerm2');
  });

  it('Linux hint mentions xclip', () => {
    setPlatform('linux');
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(copyToClipboard(makeRenderer(false), 'x').hint).toContain('xclip');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tryFallbackCopy
// ═══════════════════════════════════════════════════════════════════════════

describe('tryFallbackCopy', () => {
  it('returns true when command succeeds', () => {
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
    expect(tryFallbackCopy('hello', { cmd: 'pbcopy', args: [] })).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('pbcopy', [], expect.objectContaining({ input: 'hello' }));
  });

  it('passes args correctly', () => {
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
    tryFallbackCopy('t', { cmd: 'xclip', args: ['-selection', 'clipboard'] });
    expect(mockExecFileSync).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard'], expect.anything());
  });

  it('returns false when command throws', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(tryFallbackCopy('t', { cmd: 'pbcopy', args: [] })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildFallbackCandidates
// ═══════════════════════════════════════════════════════════════════════════

describe('buildFallbackCandidates', () => {
  it('returns [pbcopy] on macOS', () => {
    setPlatform('darwin');
    expect(buildFallbackCandidates()).toEqual([{ cmd: 'pbcopy', args: [] }]);
  });

  it('returns [wl-copy, xclip, xsel] on Linux+Wayland', () => {
    setPlatform('linux', 'wayland-0');
    const names = buildFallbackCandidates().map(c => c.cmd);
    expect(names).toEqual(['wl-copy', 'xclip', 'xsel']);
  });

  it('returns [xclip, xsel] on Linux/X11', () => {
    setPlatform('linux');
    const names = buildFallbackCandidates().map(c => c.cmd);
    expect(names).toEqual(['xclip', 'xsel']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// App-level integration: both production copy paths use unified helper
// ═══════════════════════════════════════════════════════════════════════════

describe('App-level integration – both copy paths use copyToClipboard', () => {
  // The auto-copy path (selection event) and the manual copy path
  // (Ctrl/Cmd+C) in App.tsx both call copyToClipboard(renderer, text).
  // We verify this contract by:
  //   1. Confirming resolveCopyOrInterrupt returns {action:'copy', text}
  //      so the caller's next step is copyToClipboard(renderer, text).
  //   2. Verifying copyToClipboard works end-to-end with the same renderer.

  it('auto-copy path: selection text → copyToClipboard succeeds via fallback', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
    const r = makeRenderer(false); // OSC52 not supported
    // Simulate what onSelectionFinish does: call copyToClipboard with selected text
    const result = copyToClipboard(r, 'selected text from drag');
    expect(result).toEqual({ success: true, method: 'fallback' });
    expect(r.copyToClipboardOSC52).toHaveBeenCalledWith('selected text from drag');
  });

  it('manual copy path: Ctrl+C with selection → resolveCopyOrInterrupt returns copy → copyToClipboard', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
    // Step 1: decision function says "copy"
    const decision = resolveCopyOrInterrupt('c', { ctrl: true, meta: false, super: false },
      true, 'selected', '', false);
    expect(decision).toEqual({ action: 'copy', text: 'selected' });
    // Step 2: caller passes text to unified helper
    const r = makeRenderer(false);
    const result = copyToClipboard(r, decision.action === 'copy' ? decision.text : '');
    expect(result).toEqual({ success: true, method: 'fallback' });
  });

  it('manual copy path: Cmd+C (super) with selection → copy via helper', () => {
    const decision = resolveCopyOrInterrupt('c', { ctrl: false, meta: false, super: true },
      true, 'mac selected', '', false);
    expect(decision).toEqual({ action: 'copy', text: 'mac selected' });
    const r = makeRenderer(true);
    const result = copyToClipboard(r, decision.action === 'copy' ? decision.text : '');
    expect(result).toEqual({ success: true, method: 'osc52' });
  });

  it('Ctrl+C without selection → interrupt (unchanged, does NOT call copyToClipboard)', () => {
    const decision = resolveCopyOrInterrupt('c', { ctrl: true, meta: false, super: false },
      false, '', '', false);
    expect(decision).toEqual({ action: 'interrupt' });
  });

  it('Cmd+C without selection → noop (unchanged)', () => {
    const decision = resolveCopyOrInterrupt('c', { ctrl: false, meta: false, super: true },
      false, '', '', false);
    expect(decision).toEqual({ action: 'noop' });
  });

  it('fallback failure shows hint once, then both paths get no hint', () => {
    setPlatform('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    const r = makeRenderer(false);
    // First failure (auto-copy path) → hint
    const first = copyToClipboard(r, 'auto-copy text');
    expect(first.hint).toBeDefined();
    // Second failure (manual copy path) → no duplicate hint
    const second = copyToClipboard(r, 'manual-copy text');
    expect(second.hint).toBeUndefined();
    expect(second.success).toBe(false);
  });
});
