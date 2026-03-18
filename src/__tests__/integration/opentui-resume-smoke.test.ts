import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBunBinary, buildOpenTuiLaunchSpec } from '../../tui/runtime/bun-launcher.js';
import { SessionManager } from '../../session/session-manager.js';
import type { SessionConfig } from '../../types/session.js';

describe('OpenTUI resume smoke', () => {
  const sessionDirs: string[] = [];

  afterEach(() => {
    for (const sessionDir of sessionDirs) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    sessionDirs.length = 0;
  });

  it('renders restored session history through the Bun/OpenTUI resume path', () => {
    const cwd = process.cwd();
    const bunBinary = resolveBunBinary({ cwd, env: process.env });
    expect(bunBinary).toBeTruthy();

    const projectDir = path.join(cwd, '.tmp-opentui-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionsDir = path.join(cwd, '.duo', 'sessions');
    const manager = new SessionManager(sessionsDir);
    const config: SessionConfig = {
      projectDir,
      coder: 'claude-code',
      reviewer: 'codex',
      god: 'codex',
      task: 'Verify OpenTUI resume rendering',
    };

    const { id } = manager.createSession(config);
    const sessionDir = path.join(sessionsDir, id);
    sessionDirs.push(sessionDir);

    manager.addHistoryEntry(id, {
      role: 'coder',
      content: 'Coder says hello from the restored session.',
      timestamp: Date.now() - 1000,
    });
    manager.addHistoryEntry(id, {
      role: 'reviewer',
      content: 'Reviewer replies with scrollable feedback.',
      timestamp: Date.now(),
    });

    const spec = buildOpenTuiLaunchSpec({
      bunBinary: bunBinary!,
      cwd,
      argv: ['resume', id, '--smoke-test'],
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

    expect(output).toContain('Verify OpenTUI resume rendering');
    expect(output).toContain('Coder says hello from the restored session.');
    expect(output).toContain('Reviewer replies with scrollable feedback.');
  });
});
