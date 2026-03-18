/**
 * Tests for directory picker pure logic functions.
 * Source: FR-019 (AC-065, AC-066, AC-067)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

// Mock node:fs at module level for ESM compatibility
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import {
  completePath,
  isGitRepo,
  discoverGitRepos,
  loadMRU,
  saveMRU,
  addToMRU,
  processPickerInput,
  type PickerState,
  DEFAULT_SCAN_DIRS,
  MRU_MAX_ITEMS,
} from '../../ui/directory-picker-state.js';
import type { Key } from '../../tui/primitives.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// Helper: create a Key object with all false defaults
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

function makeState(overrides: Partial<PickerState> = {}): PickerState {
  return {
    inputValue: '',
    selectedIndex: 0,
    items: [],
    mru: [],
    discovered: [],
    completions: [],
    warning: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── completePath tests ──

describe('completePath', () => {
  it('returns empty array for empty input', () => {
    const result = completePath('');
    expect(result).toEqual([]);
  });

  it('returns matching directories for a valid parent path', () => {
    mockReaddirSync.mockReturnValue(
      ['src', 'docs', 'node_modules', 'package.json'] as unknown as any[],
    );
    mockStatSync.mockImplementation((p: any) => {
      const name = path.basename(p.toString());
      return { isDirectory: () => name !== 'package.json' } as any;
    });

    const result = completePath('/project/');
    expect(result).toContain('/project/src');
    expect(result).toContain('/project/docs');
    expect(result).toContain('/project/node_modules');
    expect(result).not.toContain('/project/package.json');
  });

  it('filters by prefix', () => {
    mockReaddirSync.mockReturnValue(
      ['src', 'scripts', 'docs'] as unknown as any[],
    );
    mockStatSync.mockImplementation(() => {
      return { isDirectory: () => true } as any;
    });

    const result = completePath('/project/s');
    expect(result).toContain('/project/src');
    expect(result).toContain('/project/scripts');
    expect(result).not.toContain('/project/docs');
  });

  it('returns empty array when directory does not exist', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = completePath('/nonexistent/path');
    expect(result).toEqual([]);
  });

  it('expands ~ to home directory', () => {
    const home = process.env.HOME ?? '/home/user';
    mockReaddirSync.mockReturnValue(['Projects'] as unknown as any[]);
    mockStatSync.mockImplementation(() => {
      return { isDirectory: () => true } as any;
    });

    const result = completePath('~/P');
    expect(result).toContain(`${home}/Projects`);
  });
});

// ── isGitRepo tests ──

describe('isGitRepo', () => {
  it('returns true when .git directory exists', () => {
    mockExistsSync.mockReturnValue(true);
    expect(isGitRepo('/some/project')).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith('/some/project/.git');
  });

  it('returns false when .git directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(isGitRepo('/some/folder')).toBe(false);
  });
});

// ── discoverGitRepos tests ──

describe('discoverGitRepos', () => {
  it('finds git repos in scan directories', () => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = p.toString();
      if (s === '/home/user/Projects') return true;
      if (s === '/home/user/code') return true;
      if (s === '/home/user/Developer') return false;
      if (s === '/home/user/Projects/app1/.git') return true;
      if (s === '/home/user/Projects/app2/.git') return true;
      if (s === '/home/user/code/lib1/.git') return false;
      return false;
    });

    mockReaddirSync.mockImplementation((p: any) => {
      const s = p.toString();
      if (s === '/home/user/Projects') return ['app1', 'app2'] as unknown as any[];
      if (s === '/home/user/code') return ['lib1'] as unknown as any[];
      return [];
    });

    mockStatSync.mockImplementation(() => {
      return { isDirectory: () => true } as any;
    });

    const repos = discoverGitRepos([
      '/home/user/Projects',
      '/home/user/Developer',
      '/home/user/code',
    ]);

    expect(repos).toContain('/home/user/Projects/app1');
    expect(repos).toContain('/home/user/Projects/app2');
    expect(repos).not.toContain('/home/user/code/lib1');
  });

  it('skips non-existent scan directories', () => {
    mockExistsSync.mockReturnValue(false);
    const repos = discoverGitRepos(['/nonexistent']);
    expect(repos).toEqual([]);
  });

  it('handles errors gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const repos = discoverGitRepos(['/restricted']);
    expect(repos).toEqual([]);
  });

  it('uses DEFAULT_SCAN_DIRS which include ~/Projects, ~/Developer, ~/code', () => {
    const home = process.env.HOME ?? '/home/user';
    expect(DEFAULT_SCAN_DIRS).toContain(`${home}/Projects`);
    expect(DEFAULT_SCAN_DIRS).toContain(`${home}/Developer`);
    expect(DEFAULT_SCAN_DIRS).toContain(`${home}/code`);
  });
});

// ── MRU persistence tests ──

describe('loadMRU', () => {
  it('returns empty array when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadMRU('/fake/.duo/recent.json')).toEqual([]);
  });

  it('loads and parses valid JSON array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(['/path/a', '/path/b']));
    expect(loadMRU('/fake/.duo/recent.json')).toEqual(['/path/a', '/path/b']);
  });

  it('returns empty array on invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');
    expect(loadMRU('/fake/.duo/recent.json')).toEqual([]);
  });
});

describe('saveMRU', () => {
  it('writes JSON to file and creates parent dir', () => {
    saveMRU('/home/user/.duo/recent.json', ['/a', '/b']);

    expect(mockMkdirSync).toHaveBeenCalledWith('/home/user/.duo', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/home/user/.duo/recent.json',
      JSON.stringify(['/a', '/b'], null, 2),
    );
  });
});

describe('addToMRU', () => {
  it('adds new dir to front of list', () => {
    const result = addToMRU(['/old'], '/new');
    expect(result[0]).toBe('/new');
    expect(result[1]).toBe('/old');
  });

  it('moves existing dir to front (deduplication)', () => {
    const result = addToMRU(['/a', '/b', '/c'], '/b');
    expect(result).toEqual(['/b', '/a', '/c']);
  });

  it('caps at MRU_MAX_ITEMS', () => {
    const dirs = Array.from({ length: MRU_MAX_ITEMS }, (_, i) => `/dir${i}`);
    const result = addToMRU(dirs, '/new');
    expect(result).toHaveLength(MRU_MAX_ITEMS);
    expect(result[0]).toBe('/new');
  });
});

// ── processPickerInput tests ──

describe('processPickerInput', () => {
  it('appends regular character input', () => {
    const state = makeState({ inputValue: '/pro' });
    const action = processPickerInput(state, 'j', key());
    expect(action).toEqual({ type: 'update_input', value: '/proj' });
  });

  it('handles backspace', () => {
    const state = makeState({ inputValue: '/proj' });
    const action = processPickerInput(state, '', key({ backspace: true }));
    expect(action).toEqual({ type: 'update_input', value: '/pro' });
  });

  // AC-065: Tab 路径补全
  it('triggers tab completion', () => {
    const state = makeState({ inputValue: '/project/s' });
    const action = processPickerInput(state, '', key({ tab: true }));
    expect(action).toEqual({ type: 'tab_complete' });
  });

  // Enter to select/confirm
  it('submits on Enter with non-empty input', () => {
    const state = makeState({ inputValue: '/project/app' });
    const action = processPickerInput(state, '', key({ return: true }));
    expect(action).toEqual({ type: 'submit', value: '/project/app' });
  });

  it('selects highlighted item on Enter with empty input', () => {
    const state = makeState({
      inputValue: '',
      items: ['/a', '/b'],
      selectedIndex: 1,
    });
    const action = processPickerInput(state, '', key({ return: true }));
    expect(action).toEqual({ type: 'submit', value: '/b' });
  });

  it('returns noop on Enter with no input and no items', () => {
    const state = makeState();
    const action = processPickerInput(state, '', key({ return: true }));
    expect(action).toEqual({ type: 'noop' });
  });

  // Arrow keys navigate list
  it('moves selection down with downArrow', () => {
    const state = makeState({ items: ['/a', '/b', '/c'], selectedIndex: 0 });
    const action = processPickerInput(state, '', key({ downArrow: true }));
    expect(action).toEqual({ type: 'select', index: 1 });
  });

  it('moves selection up with upArrow', () => {
    const state = makeState({ items: ['/a', '/b', '/c'], selectedIndex: 2 });
    const action = processPickerInput(state, '', key({ upArrow: true }));
    expect(action).toEqual({ type: 'select', index: 1 });
  });

  it('clamps selection at bottom', () => {
    const state = makeState({ items: ['/a', '/b'], selectedIndex: 1 });
    const action = processPickerInput(state, '', key({ downArrow: true }));
    expect(action).toEqual({ type: 'select', index: 1 });
  });

  it('clamps selection at top', () => {
    const state = makeState({ items: ['/a', '/b'], selectedIndex: 0 });
    const action = processPickerInput(state, '', key({ upArrow: true }));
    expect(action).toEqual({ type: 'select', index: 0 });
  });

  // Escape cancels
  it('cancels on escape', () => {
    const state = makeState({ inputValue: '/something' });
    const action = processPickerInput(state, '', key({ escape: true }));
    expect(action).toEqual({ type: 'cancel' });
  });

  it('returns noop for empty input with no special keys', () => {
    const state = makeState();
    const action = processPickerInput(state, '', key());
    expect(action).toEqual({ type: 'noop' });
  });
});

// ── AC-067: non-git directory warning ──

describe('non-git directory warning', () => {
  it('isGitRepo returns false for non-git directories', () => {
    mockExistsSync.mockReturnValue(false);
    expect(isGitRepo('/some/non-git-dir')).toBe(false);
  });
});
