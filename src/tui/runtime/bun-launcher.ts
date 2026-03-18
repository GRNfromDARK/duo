import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ResolveBunBinaryOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  which?: (command: string) => string | null;
}

export interface OpenTuiLaunchSpec {
  command: string;
  args: string[];
}

function defaultExists(candidate: string): boolean {
  return existsSync(candidate);
}

function defaultWhich(command: string): string | null {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function getBundledBunBinaryPath(cwd: string): string {
  return path.join(cwd, '.local', 'bun', 'bin', 'bun');
}

export function resolveBunBinary(options: ResolveBunBinaryOptions): string | null {
  const exists = options.exists ?? defaultExists;
  const which = options.which ?? defaultWhich;

  if (options.env.DUO_BUN_BINARY) {
    return options.env.DUO_BUN_BINARY;
  }

  const bundled = getBundledBunBinaryPath(options.cwd);
  if (exists(bundled)) {
    return bundled;
  }

  return which('bun');
}

export function buildOpenTuiLaunchSpec(input: {
  bunBinary: string;
  cwd: string;
  argv: string[];
}): OpenTuiLaunchSpec {
  return {
    command: input.bunBinary,
    args: ['run', path.join(input.cwd, 'src', 'tui', 'cli.tsx'), ...input.argv],
  };
}
