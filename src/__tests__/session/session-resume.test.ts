/**
 * Tests for duo resume command — Card C.3
 * Source: FR-002 (AC-005, AC-006, AC-007, AC-008)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleResume, handleResumeList } from '../../cli-commands.js';
import { SessionManager } from '../../session/session-manager.js';
import type { SessionConfig } from '../../types/session.js';

let tmpDir: string;
let sessionsDir: string;

function makeConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    projectDir: tmpDir,
    coder: 'claude-code',
    reviewer: 'codex',
    god: 'codex',
    task: 'implement login',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-resume-'));
  sessionsDir = path.join(tmpDir, '.duo', 'sessions');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── AC-4: duo resume 列出历史会话并正确排序 ───

describe('handleResumeList', () => {
  test('lists sessions with project, task, round, status, time', () => {
    const mgr = new SessionManager(sessionsDir);
    const s1 = mgr.createSession(makeConfig({ task: 'fix auth bug' }));
    mgr.saveState(s1.id, { status: 'reviewing', currentRole: 'reviewer' });

    const output: string[] = [];
    const result = handleResumeList(sessionsDir, (msg: string) => output.push(msg));

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(1);
    // Output should contain session info
    expect(output.some(line => line.includes('fix auth bug'))).toBe(true);
  });

  test('shows message when no sessions exist', () => {
    const output: string[] = [];
    const result = handleResumeList(sessionsDir, (msg: string) => output.push(msg));

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
    expect(output.some(line => line.toLowerCase().includes('no sessions'))).toBe(true);
  });

  test('lists multiple sessions sorted by most recent first', () => {
    const mgr = new SessionManager(sessionsDir);
    const s1 = mgr.createSession(makeConfig({ task: 'task A' }));
    const s2 = mgr.createSession(makeConfig({ task: 'task B' }));
    // Update s1 to make it most recent (saveState updates updatedAt)
    mgr.saveState(s1.id, { status: 'coding', currentRole: 'coder' });

    const output: string[] = [];
    const result = handleResumeList(sessionsDir, (msg: string) => output.push(msg));

    expect(result.sessions).toHaveLength(2);
    // s1 was updated last via saveState, so it should be first
    expect(result.sessions![0].task).toBe('task A');
  });
});

// ─── AC-2 & AC-3: duo resume <session-id> ───

describe('handleResume', () => {
  test('resumes a valid session and returns loaded data', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });
    mgr.addHistoryEntry(session.id, { role: 'coder', content: 'v1', timestamp: 1000 });

    const output: string[] = [];
    const result = handleResume(session.id, sessionsDir, (msg: string) => output.push(msg));

    expect(result.success).toBe(true);
    expect(result.session?.metadata.task).toBe('implement login');
    expect(result.session?.history).toHaveLength(1);
  });

  test('fails when session ID does not exist', () => {
    const output: string[] = [];
    const result = handleResume('nonexistent-id', sessionsDir, (msg: string) => output.push(msg));

    expect(result.success).toBe(false);
    expect(output.some(line => line.toLowerCase().includes('not found'))).toBe(true);
  });

  test('fails when project directory no longer exists', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig({ projectDir: '/nonexistent/deleted/project' }));

    const output: string[] = [];
    const result = handleResume(session.id, sessionsDir, (msg: string) => output.push(msg));

    expect(result.success).toBe(false);
    expect(output.some(line => line.includes('/nonexistent/deleted/project'))).toBe(true);
  });
});
