import { describe, expect, it } from 'vitest';

import {
  buildOpenTuiLaunchSpec,
  getBundledBunBinaryPath,
  resolveBunBinary,
} from '../../tui/runtime/bun-launcher.js';

describe('bun-launcher', () => {
  it('prefers DUO_BUN_BINARY when provided', () => {
    const resolved = resolveBunBinary({
      cwd: '/tmp/project',
      env: { DUO_BUN_BINARY: '/custom/bin/bun' },
      exists: () => false,
      which: () => null,
    });

    expect(resolved).toBe('/custom/bin/bun');
  });

  it('falls back to bundled worktree-local bun when present', () => {
    const cwd = '/tmp/project';
    const bundled = getBundledBunBinaryPath(cwd);

    const resolved = resolveBunBinary({
      cwd,
      env: {},
      exists: (candidate) => candidate === bundled,
      which: () => null,
    });

    expect(resolved).toBe(bundled);
  });

  it('falls back to bun on PATH when no override or bundled binary exists', () => {
    const resolved = resolveBunBinary({
      cwd: '/tmp/project',
      env: {},
      exists: () => false,
      which: (command) => (command === 'bun' ? '/usr/local/bin/bun' : null),
    });

    expect(resolved).toBe('/usr/local/bin/bun');
  });

  it('returns null when bun cannot be found', () => {
    const resolved = resolveBunBinary({
      cwd: '/tmp/project',
      env: {},
      exists: () => false,
      which: () => null,
    });

    expect(resolved).toBeNull();
  });

  it('builds a bun launch spec for the OpenTUI cli entry', () => {
    const spec = buildOpenTuiLaunchSpec({
      bunBinary: '/usr/local/bin/bun',
      cwd: '/repo',
      argv: ['start', '--task', 'Fix scroll'],
    });

    expect(spec.command).toBe('/usr/local/bin/bun');
    expect(spec.args).toEqual([
      'run',
      '/repo/src/tui/cli.tsx',
      'start',
      '--task',
      'Fix scroll',
    ]);
  });
});
