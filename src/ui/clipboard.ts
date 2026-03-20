/**
 * Unified clipboard helper with OSC52-first strategy and platform fallback.
 *
 * Priority:
 * 1. renderer.copyToClipboardOSC52() — works in terminals that support OSC52
 * 2. Platform-native commands tried in order until one succeeds:
 *    - macOS: pbcopy
 *    - Wayland: wl-copy → xclip → xsel
 *    - X11: xclip → xsel
 * 3. Silent failure with one-time diagnostic hint
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Platform candidate list (computed fresh each call — no caching)
// ---------------------------------------------------------------------------

export interface FallbackCandidate {
  cmd: string;
  args: string[];
}

/**
 * Build the ordered list of clipboard command candidates for the current
 * platform. Called on every copy attempt so that environment changes
 * (e.g. WAYLAND_DISPLAY appearing mid-session) are picked up.
 */
export function buildFallbackCandidates(): FallbackCandidate[] {
  if (process.platform === 'darwin') {
    return [{ cmd: 'pbcopy', args: [] }];
  }
  const list: FallbackCandidate[] = [];
  if (process.env.WAYLAND_DISPLAY) {
    list.push({ cmd: 'wl-copy', args: [] });
  }
  list.push(
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  );
  return list;
}

// ---------------------------------------------------------------------------
// Try a single candidate
// ---------------------------------------------------------------------------

export function tryFallbackCopy(text: string, candidate: FallbackCandidate): boolean {
  try {
    execFileSync(candidate.cmd, candidate.args, {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Renderer interface (minimal surface needed for clipboard)
// ---------------------------------------------------------------------------

export interface ClipboardRenderer {
  copyToClipboardOSC52(text: string): boolean;
}

// ---------------------------------------------------------------------------
// Unified copy helper
// ---------------------------------------------------------------------------

let _failureHintShown = false;

export function resetFailureHint(): void {
  _failureHintShown = false;
}

export function hasShownFailureHint(): boolean {
  return _failureHintShown;
}

export interface CopyToClipboardResult {
  success: boolean;
  method: 'osc52' | 'fallback' | 'none';
  hint?: string;
}

/**
 * Copy text to system clipboard. Tries OSC52 first, then walks through
 * every platform candidate in priority order until one succeeds.
 * Returns a diagnostic result; emits a one-time hint on total failure.
 */
export function copyToClipboard(
  renderer: ClipboardRenderer,
  text: string,
): CopyToClipboardResult {
  // 1. Try OSC52
  if (renderer.copyToClipboardOSC52(text)) {
    return { success: true, method: 'osc52' };
  }

  // 2. Walk candidates in priority order
  const candidates = buildFallbackCandidates();
  for (const candidate of candidates) {
    if (tryFallbackCopy(text, candidate)) {
      return { success: true, method: 'fallback' };
    }
  }

  // 3. Total failure — emit one-time hint
  let hint: string | undefined;
  if (!_failureHintShown) {
    _failureHintShown = true;
    hint = 'Copy to clipboard failed. '
      + (process.platform === 'darwin'
        ? 'Try a terminal that supports OSC52 (iTerm2, WezTerm, Kitty) or ensure pbcopy is available.'
        : 'Install xclip, xsel, or wl-copy, or use a terminal that supports OSC52.');
  }
  return { success: false, method: 'none', hint };
}
