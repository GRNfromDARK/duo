import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { buildOpenTuiLaunchSpec, resolveBunBinary } from '../../tui/runtime/bun-launcher.js';

describe('OpenTUI bootstrap', () => {
  it('boots the Bun/OpenTUI cli smoke test', () => {
    const cwd = process.cwd();
    const bunBinary = resolveBunBinary({ cwd, env: process.env });

    expect(bunBinary).toBeTruthy();

    const spec = buildOpenTuiLaunchSpec({
      bunBinary: bunBinary!,
      cwd,
      argv: ['--smoke-test'],
    });

    const output = execFileSync(spec.command, spec.args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
      timeout: 10_000,
    });

    expect(output).toContain('Duo OpenTUI bootstrap ready');
  });
});
