/**
 * Tests for SessionManager — Card C.3
 * Source: FR-002 (AC-005, AC-006, AC-007, AC-008)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionManager, SessionNotFoundError, SessionCorruptedError } from '../../session/session-manager.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-test-'));
  sessionsDir = path.join(tmpDir, '.duo', 'sessions');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── AC-1: 状态转换时自动写入 state.json ───

describe('SessionManager — state persistence', () => {
  test('creates session directory with snapshot.json and legacy files', () => {
    const mgr = new SessionManager(sessionsDir);
    const config = makeConfig();
    const session = mgr.createSession(config);

    const sessionDir = path.join(sessionsDir, session.id);
    expect(fs.existsSync(path.join(sessionDir, 'snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'history.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'prompt-log.jsonl'))).toBe(true);
    // Legacy files also created for backward compat
    expect(fs.existsSync(path.join(sessionDir, 'session.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'history.json'))).toBe(true);
  });

  test('snapshot.json contains correct metadata and state', () => {
    const mgr = new SessionManager(sessionsDir);
    const config = makeConfig();
    const session = mgr.createSession(config);

    const sessionDir = path.join(sessionsDir, session.id);
    const snapshot = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    expect(snapshot.metadata.id).toBe(session.id);
    expect(snapshot.metadata.projectDir).toBe(config.projectDir);
    expect(snapshot.metadata.coder).toBe(config.coder);
    expect(snapshot.metadata.reviewer).toBe(config.reviewer);
    expect(snapshot.metadata.task).toBe(config.task);
    expect(snapshot.state.status).toBe('created');
  });

  test('saveState persists to snapshot.json and legacy files', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    mgr.saveState(session.id, { status: 'reviewing', currentRole: 'reviewer' });

    const sessionDir = path.join(sessionsDir, session.id);
    const snapshot = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    expect(snapshot.state.status).toBe('reviewing');

    // Legacy files also updated
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    expect(state.status).toBe('reviewing');
  });

  test('saveState overwrites previous state', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });
    mgr.saveState(session.id, { status: 'reviewing', currentRole: 'reviewer' });

    const sessionDir = path.join(sessionsDir, session.id);
    const snapshot = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    expect(snapshot.state.status).toBe('reviewing');
  });
});

// ─── AC-1 continued: history persistence ───

describe('SessionManager — history persistence', () => {
  test('addHistoryEntry appends to history.jsonl', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    mgr.addHistoryEntry(session.id, {
      role: 'coder',
      content: 'implemented login form',
      timestamp: Date.now(),
    });

    const histFile = path.join(sessionsDir, session.id, 'history.jsonl');
    const lines = fs.readFileSync(histFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).content).toBe('implemented login form');
  });

  test('addHistoryEntry accumulates entries', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    mgr.addHistoryEntry(session.id, { role: 'coder', content: 'code v1', timestamp: 1000 });
    mgr.addHistoryEntry(session.id, { role: 'reviewer', content: 'review v1', timestamp: 2000 });
    mgr.addHistoryEntry(session.id, { role: 'coder', content: 'code v2', timestamp: 3000 });

    const histFile = path.join(sessionsDir, session.id, 'history.jsonl');
    const lines = fs.readFileSync(histFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).role).toBe('coder');
  });

  test('addHistoryEntry migrates legacy history.json on first append', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    // Simulate old format: remove history.jsonl, keep only history.json
    const sessionDir = path.join(sessionsDir, session.id);
    fs.unlinkSync(path.join(sessionDir, 'history.jsonl'));
    fs.writeFileSync(
      path.join(sessionDir, 'history.json'),
      JSON.stringify([
        { role: 'coder', content: 'old entry', timestamp: 1000 },
      ]),
    );

    // Append new entry triggers migration
    mgr.addHistoryEntry(session.id, { role: 'coder', content: 'new entry', timestamp: 2000 });

    const histFile = path.join(sessionDir, 'history.jsonl');
    const lines = fs.readFileSync(histFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).content).toBe('old entry');
    expect(JSON.parse(lines[1]).content).toBe('new entry');
  });
});

// ─── AC-2: 恢复后正确还原轮次、角色分配、对话历史 ───

describe('SessionManager — restore session', () => {
  test('loadSession restores metadata, state, and history', () => {
    const mgr = new SessionManager(sessionsDir);
    const config = makeConfig();
    const session = mgr.createSession(config);

    mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });
    mgr.addHistoryEntry(session.id, { role: 'coder', content: 'code', timestamp: 1000 });
    mgr.addHistoryEntry(session.id, { role: 'reviewer', content: 'review', timestamp: 2000 });

    const loaded = mgr.loadSession(session.id);
    expect(loaded.metadata.task).toBe('implement login');
    expect(loaded.metadata.coder).toBe('claude-code');
    expect(loaded.metadata.reviewer).toBe('codex');
    expect(loaded.state.status).toBe('coding');
    expect(loaded.state.currentRole).toBe('coder');
    expect(loaded.history).toHaveLength(2);
  });

  test('loadSession throws SessionNotFoundError for non-existent session', () => {
    const mgr = new SessionManager(sessionsDir);
    expect(() => mgr.loadSession('non-existent-id')).toThrow(SessionNotFoundError);
  });

  test('loadSession throws SessionCorruptedError for corrupted snapshot', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const sessionDir = path.join(sessionsDir, session.id);

    // Corrupt both snapshot and legacy files
    fs.writeFileSync(path.join(sessionDir, 'snapshot.json'), '{invalid json');
    fs.writeFileSync(path.join(sessionDir, 'session.json'), '{invalid json');

    expect(() => mgr.loadSession(session.id)).toThrow(SessionCorruptedError);
  });

  test('loadSession falls back to legacy files when snapshot.json missing', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const sessionDir = path.join(sessionsDir, session.id);

    // Remove snapshot.json, keep legacy files
    fs.unlinkSync(path.join(sessionDir, 'snapshot.json'));

    const loaded = mgr.loadSession(session.id);
    expect(loaded.metadata.task).toBe('implement login');
    expect(loaded.state.status).toBe('created');
  });
});

// ─── Crash consistency: truncated JSONL ───

describe('SessionManager — crash consistency', () => {
  test('loadSession handles truncated last line in history.jsonl', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    mgr.addHistoryEntry(session.id, { role: 'coder', content: 'complete entry', timestamp: 1000 });

    // Simulate crash: append truncated JSON line
    const histFile = path.join(sessionsDir, session.id, 'history.jsonl');
    fs.appendFileSync(histFile, '{"round":2,"role":"coder","content":"trun');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = mgr.loadSession(session.id);

    expect(loaded.history).toHaveLength(1);
    expect(loaded.history[0].content).toBe('complete entry');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Last history line truncated'));
    warnSpy.mockRestore();
  });

  test('loadSession throws SessionCorruptedError for mid-file corruption in history.jsonl', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    // Write a corrupted line in the middle, followed by a valid line
    const histFile = path.join(sessionsDir, session.id, 'history.jsonl');
    const validEntry = JSON.stringify({ role: 'coder', content: 'ok', timestamp: 1000 });
    const corruptedLine = '{"round":2,"role":"coder","content":"trun';
    const validEntry2 = JSON.stringify({ role: 'reviewer', content: 'also ok', timestamp: 3000 });
    fs.writeFileSync(histFile, `${validEntry}\n${corruptedLine}\n${validEntry2}\n`);

    expect(() => mgr.loadSession(session.id)).toThrow(SessionCorruptedError);
  });

  test('loadSession throws SessionCorruptedError for invalid shape in mid-file history entry', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    // Write a valid JSON but invalid shape entry in the middle
    const histFile = path.join(sessionsDir, session.id, 'history.jsonl');
    const validEntry = JSON.stringify({ role: 'coder', content: 'ok', timestamp: 1000 });
    const invalidShape = JSON.stringify({ foo: 'bar' }); // valid JSON, invalid HistoryEntry
    const validEntry2 = JSON.stringify({ role: 'reviewer', content: 'also ok', timestamp: 3000 });
    fs.writeFileSync(histFile, `${validEntry}\n${invalidShape}\n${validEntry2}\n`);

    expect(() => mgr.loadSession(session.id)).toThrow(SessionCorruptedError);
  });

  test('loadSession throws SessionCorruptedError for invalid snapshot structure', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const sessionDir = path.join(sessionsDir, session.id);

    // Write valid JSON but invalid snapshot shape
    fs.writeFileSync(path.join(sessionDir, 'snapshot.json'), JSON.stringify({ metadata: { id: 'x' }, state: {} }));

    expect(() => mgr.loadSession(session.id)).toThrow(SessionCorruptedError);
  });

  test('loadSession handles corrupted legacy history.json gracefully', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const sessionDir = path.join(sessionsDir, session.id);

    // Remove jsonl, corrupt legacy history.json
    fs.unlinkSync(path.join(sessionDir, 'history.jsonl'));
    fs.writeFileSync(path.join(sessionDir, 'history.json'), 'not valid json');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = mgr.loadSession(session.id);

    expect(loaded.history).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Legacy history.json corrupted'));
    warnSpy.mockRestore();
  });

  test('snapshot.json is written atomically (no .tmp left behind)', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const sessionDir = path.join(sessionsDir, session.id);

    mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });

    expect(fs.existsSync(path.join(sessionDir, 'snapshot.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, 'snapshot.json'))).toBe(true);
  });
});

// ─── AC-3: 项目目录不存在时给出错误提示 ───

describe('SessionManager — project dir validation on restore', () => {
  test('validateSessionRestore returns error when project dir missing', () => {
    const mgr = new SessionManager(sessionsDir);
    const config = makeConfig({ projectDir: '/nonexistent/path/that/does/not/exist' });
    const session = mgr.createSession(config);

    const result = mgr.validateSessionRestore(session.id);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('/nonexistent/path/that/does/not/exist');
  });

  test('validateSessionRestore returns valid when project dir exists', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    const result = mgr.validateSessionRestore(session.id);
    expect(result.valid).toBe(true);
  });
});

// ─── AC-4: duo resume 列出历史会话并正确排序 ───

describe('SessionManager — list sessions', () => {
  test('listSessions returns all sessions sorted by updatedAt descending', () => {
    vi.useFakeTimers();
    try {
      const mgr = new SessionManager(sessionsDir);

      vi.setSystemTime(1000);
      const s1 = mgr.createSession(makeConfig({ task: 'task A' }));
      vi.setSystemTime(2000);
      const s2 = mgr.createSession(makeConfig({ task: 'task B' }));
      vi.setSystemTime(3000);
      const s3 = mgr.createSession(makeConfig({ task: 'task C' }));

      // Update s1 last to make it most recent
      vi.setSystemTime(4000);
      mgr.saveState(s1.id, { status: 'coding', currentRole: 'coder' });

      const sessions = mgr.listSessions();
      expect(sessions).toHaveLength(3);
      // s1 was updated last (t=4000), so should be first
      expect(sessions[0].id).toBe(s1.id);
    } finally {
      vi.useRealTimers();
    }
  });

  test('listSessions returns empty array when no sessions', () => {
    const mgr = new SessionManager(sessionsDir);
    const sessions = mgr.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test('listSessions includes project name, task, round, status, time', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig({ task: 'fix bug #42' }));
    mgr.saveState(session.id, { status: 'reviewing', currentRole: 'reviewer' });

    const sessions = mgr.listSessions();
    expect(sessions[0].task).toBe('fix bug #42');
    expect(sessions[0].projectDir).toBeDefined();
    expect(sessions[0].status).toBe('reviewing');
    expect(sessions[0].updatedAt).toBeDefined();
  });

  test('listSessions works with mixed snapshot and legacy-only sessions', () => {
    const mgr = new SessionManager(sessionsDir);
    const s1 = mgr.createSession(makeConfig({ task: 'new format' }));

    // Create a legacy-only session directory
    const legacyId = 'legacy-test-session';
    const legacyDir = path.join(sessionsDir, legacyId);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'session.json'), JSON.stringify({
      id: legacyId, projectDir: tmpDir, coder: 'c', reviewer: 'r', task: 'legacy task',
      createdAt: 500, updatedAt: 500,
    }));
    fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
      status: 'coding', currentRole: 'coder',
    }));

    const sessions = mgr.listSessions();
    expect(sessions).toHaveLength(2);
    const tasks = sessions.map(s => s.task);
    expect(tasks).toContain('new format');
    expect(tasks).toContain('legacy task');
  });
});

// ─── Session ID uniqueness ───

describe('SessionManager — ID generation', () => {
  test('creates sessions with unique IDs', () => {
    const mgr = new SessionManager(sessionsDir);
    const s1 = mgr.createSession(makeConfig());
    const s2 = mgr.createSession(makeConfig());
    expect(s1.id).not.toBe(s2.id);
  });
});

// ─── updatedAt tracking ───

describe('SessionManager — updatedAt', () => {
  test('snapshot updatedAt is updated on saveState', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    const sessionDir = path.join(sessionsDir, session.id);
    const snapBefore = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    const beforeTime = snapBefore.metadata.updatedAt;

    mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });

    const snapAfter = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    expect(snapAfter.metadata.updatedAt).toBeGreaterThanOrEqual(beforeTime);
  });
});

// ─── Round 6 BUG-4: updatedAt timestamp drift ───

describe('Round6 BUG-4: updatedAt no +1ms drift when now > updatedAt', () => {
  test('test_bug_r6_4_updatedAt_does_not_exceed_real_time', () => {
    vi.useFakeTimers();
    try {
      const mgr = new SessionManager(sessionsDir);
      vi.setSystemTime(1000);
      const session = mgr.createSession(makeConfig());

      // Save at t=2000: now=2000, updatedAt=1000 → should be max(2000, 1001) = 2000
      vi.setSystemTime(2000);
      mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });

      const sessionDir = path.join(sessionsDir, session.id);
      const snap = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));

      // Before fix: Math.max(2000, 1000) + 1 = 2001 (ahead of real time)
      // After fix: Math.max(2000, 1001) = 2000 (correct)
      expect(snap.metadata.updatedAt).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('test_bug_r6_4_updatedAt_monotonic_on_rapid_saves', () => {
    vi.useFakeTimers();
    try {
      const mgr = new SessionManager(sessionsDir);
      vi.setSystemTime(1000);
      const session = mgr.createSession(makeConfig());

      const sessionDir = path.join(sessionsDir, session.id);

      // Rapid saves at the same time — should still be monotonically increasing
      vi.setSystemTime(1000);
      mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });
      const snap1 = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));

      vi.setSystemTime(1000);
      mgr.saveState(session.id, { status: 'reviewing', currentRole: 'reviewer' });
      const snap2 = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));

      // Both at t=1000 but updatedAt should be monotonically increasing
      expect(snap2.metadata.updatedAt).toBeGreaterThan(snap1.metadata.updatedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  test('test_regression_r6_4_no_cumulative_drift_over_many_saves', () => {
    vi.useFakeTimers();
    try {
      const mgr = new SessionManager(sessionsDir);
      vi.setSystemTime(1000);
      const session = mgr.createSession(makeConfig());

      const sessionDir = path.join(sessionsDir, session.id);

      // 100 rapid saves at different times (well-spaced)
      for (let i = 1; i <= 100; i++) {
        vi.setSystemTime(1000 + i * 100); // every 100ms
        mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });
      }

      const snap = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));

      // Before fix: each save adds +1ms drift, after 100 saves updatedAt = 11000 + 100 = 11100
      // After fix: updatedAt should be exactly 11000 (the last Date.now() value)
      expect(snap.metadata.updatedAt).toBe(11000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Card C.4: God session persistence fields ───

describe('SessionManager — God session persistence (C.4)', () => {
  test('saveState persists God fields (godAdapter, godTaskAnalysis, godConvergenceLog)', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig({ god: 'codex' }));

    const godTaskAnalysis = {
      taskType: 'code' as const,
      reasoning: 'Bug fix task',
      confidence: 0.85,
    };
    mgr.saveState(session.id, {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god_ses_abc',
      godAdapter: 'codex',
      godTaskAnalysis,
    });

    const loaded = mgr.loadSession(session.id);
    expect(loaded.state.godSessionId).toBe('god_ses_abc');
    expect(loaded.state.godAdapter).toBe('codex');
    expect(loaded.state.godTaskAnalysis).toEqual(godTaskAnalysis);
  });

  test('loadSession returns undefined God fields when not saved', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    mgr.saveState(session.id, { status: 'coding', currentRole: 'coder' });

    const loaded = mgr.loadSession(session.id);
    expect(loaded.state.godSessionId).toBeUndefined();
    expect(loaded.state.godAdapter).toBeUndefined();
    expect(loaded.state.godTaskAnalysis).toBeUndefined();
  });
});
