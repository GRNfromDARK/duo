import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const spawnSyncMock = vi.fn(() => ({ status: 0 }));
const resolveBunBinaryMock = vi.fn(() => '/tmp/bun');
const buildOpenTuiLaunchSpecMock = vi.fn(() => ({
  command: '/tmp/bun',
  args: ['run', '/repo/src/tui/cli.tsx', 'resume', 'session-123'],
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('../tui/runtime/bun-launcher.js', () => ({
  resolveBunBinary: resolveBunBinaryMock,
  buildOpenTuiLaunchSpec: buildOpenTuiLaunchSpecMock,
}));

describe('cli OpenTUI handoff', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ['node', 'src/cli.ts', 'resume', 'session-123'];
    process.env = { ...originalEnv };
    process.exit = vi.fn() as never;
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  });

  it('re-execs through Bun by default for the TUI runtime', async () => {
    await import('../cli.js');
    await Promise.resolve();

    expect(resolveBunBinaryMock).toHaveBeenCalled();
    expect(buildOpenTuiLaunchSpecMock).toHaveBeenCalledWith({
      bunBinary: '/tmp/bun',
      cwd: process.cwd(),
      argv: ['resume', 'session-123'],
    });
    expect(spawnSyncMock).toHaveBeenCalledWith('/tmp/bun', [
      'run',
      '/repo/src/tui/cli.tsx',
      'resume',
      'session-123',
    ], expect.objectContaining({
      stdio: 'inherit',
      cwd: process.cwd(),
    }));
  });

  it('does not import the legacy CLI renderer in the Node entry', () => {
    const cliSource = fs.readFileSync(
      path.resolve(__dirname, '../cli.ts'),
      'utf-8',
    );

    expect(cliSource).not.toContain("from 'ink'");
    expect(cliSource).not.toContain('runInkApp');
  });
});
