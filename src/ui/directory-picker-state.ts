/**
 * Pure logic functions for the DirectoryPicker component.
 * Source: FR-019 (AC-065, AC-066, AC-067)
 *
 * Extracted for testability — same pattern as InputArea processInput
 * and scroll-state pure functions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Key } from '../tui/primitives.js';

// ── Constants ──

const home = process.env.HOME ?? '/home/user';

export const DEFAULT_SCAN_DIRS = [
  `${home}/Projects`,
  `${home}/Developer`,
  `${home}/code`,
];

export const MRU_MAX_ITEMS = 10;

// ── Types ──

export interface PickerState {
  inputValue: string;
  selectedIndex: number;
  /** Combined list of items to display (MRU + discovered) */
  items: string[];
  mru: string[];
  discovered: string[];
  completions: string[];
  warning: string | null;
}

export type PickerAction =
  | { type: 'update_input'; value: string }
  | { type: 'tab_complete' }
  | { type: 'submit'; value: string }
  | { type: 'select'; index: number }
  | { type: 'cancel' }
  | { type: 'noop' };

// ── Path completion (AC-065) ──

/**
 * Expand ~ to home directory in a path string.
 */
function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(home, p.slice(2));
  }
  if (p === '~') {
    return home;
  }
  return p;
}

/**
 * Complete a partial path by listing matching subdirectories.
 * Returns absolute paths of matching directories.
 */
export function completePath(partial: string): string[] {
  if (!partial) return [];

  const expanded = expandHome(partial);
  const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
  const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);

  try {
    const entries = fs.readdirSync(dir);
    const results: string[] = [];

    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : (entry as fs.Dirent).name;
      if (prefix && !name.startsWith(prefix)) continue;

      const fullPath = path.join(dir, name);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          results.push(fullPath);
        }
      } catch {
        // Skip entries we can't stat
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ── Git repo detection (AC-067) ──

/**
 * Check if a directory is a git repository by looking for .git.
 */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

// ── Git repo discovery (AC-067) ──

/**
 * Scan directories for immediate subdirectories that are git repos.
 * Only scans one level deep.
 */
export function discoverGitRepos(scanDirs: string[]): string[] {
  const repos: string[] = [];

  for (const scanDir of scanDirs) {
    if (!fs.existsSync(scanDir)) continue;

    try {
      const entries = fs.readdirSync(scanDir);
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : (entry as fs.Dirent).name;
        const fullPath = path.join(scanDir, name);

        try {
          if (fs.statSync(fullPath).isDirectory() && isGitRepo(fullPath)) {
            repos.push(fullPath);
          }
        } catch {
          // Skip entries we can't access
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return repos;
}

// ── MRU persistence (AC-066) ──

/**
 * Load MRU list from a JSON file.
 * Returns empty array if file doesn't exist or is invalid.
 */
export function loadMRU(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Save MRU list to a JSON file, creating parent directory if needed.
 */
export function saveMRU(filePath: string, dirs: string[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(dirs, null, 2));
}

/**
 * Add a directory to MRU list (pure function).
 * Moves to front if already present, caps at MRU_MAX_ITEMS.
 */
export function addToMRU(
  current: string[],
  newDir: string,
  maxItems: number = MRU_MAX_ITEMS,
): string[] {
  const filtered = current.filter((d) => d !== newDir);
  const updated = [newDir, ...filtered];
  return updated.slice(0, maxItems);
}

// ── Input processing ──

/**
 * Pure function: given picker state, input char and key flags, return the action.
 */
export function processPickerInput(
  state: PickerState,
  input: string,
  key: Key,
): PickerAction {
  // Tab → trigger completion
  if (key.tab) {
    return { type: 'tab_complete' };
  }

  // Escape → cancel
  if (key.escape) {
    return { type: 'cancel' };
  }

  // Enter → submit or select
  if (key.return) {
    if (state.inputValue.trim().length > 0) {
      return { type: 'submit', value: state.inputValue };
    }
    if (state.items.length > 0) {
      return { type: 'submit', value: state.items[state.selectedIndex]! };
    }
    return { type: 'noop' };
  }

  // Arrow keys → navigate list
  if (key.downArrow) {
    const next = Math.min(state.selectedIndex + 1, state.items.length - 1);
    return { type: 'select', index: Math.max(0, next) };
  }
  if (key.upArrow) {
    const prev = Math.max(state.selectedIndex - 1, 0);
    return { type: 'select', index: prev };
  }

  // Backspace
  if (key.backspace || key.delete) {
    return { type: 'update_input', value: state.inputValue.slice(0, -1) };
  }

  // Regular character input
  if (input) {
    return { type: 'update_input', value: state.inputValue + input };
  }

  return { type: 'noop' };
}
