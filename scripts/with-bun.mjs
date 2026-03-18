#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function which(command) {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function resolveBunBinary(cwd) {
  if (process.env.DUO_BUN_BINARY) {
    return process.env.DUO_BUN_BINARY;
  }

  const bundled = path.join(cwd, '.local', 'bun', 'bin', 'bun');
  if (existsSync(bundled)) {
    return bundled;
  }

  return which('bun');
}

const cwd = process.cwd();
const bunBinary = resolveBunBinary(cwd);

if (!bunBinary) {
  console.error('Bun is required. Set DUO_BUN_BINARY or install Bun.');
  process.exit(1);
}

const result = spawnSync(bunBinary, process.argv.slice(2), {
  cwd,
  env: process.env,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
