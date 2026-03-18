/**
 * Tests for God Session Persistence — Card D.1
 * Source: FR-011 (AC-035, AC-036), AR-005, NFR-007
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionManager } from '../../session/session-manager.js';
import type { SessionConfig } from '../../types/session.js';
import type { SessionState } from '../../session/session-manager.js';
import type { GodTaskAnalysis } from '../../types/god-schemas.js';

import { restoreGodSession } from '../../god/god-session-persistence.js';

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

function makeTaskAnalysis(): GodTaskAnalysis {
  return {
    taskType: 'code',
    reasoning: 'User wants to implement login',
    confidence: 0.85,
  };
}


beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-god-persist-'));
  sessionsDir = path.join(tmpDir, '.duo', 'sessions');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── AC-1: GodSessionState correctly written to snapshot.json ──

describe('God session state persistence', () => {
  test('godSessionId and godAdapter persist to snapshot.json', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    const state: SessionState = {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god-session-123',
      godAdapter: 'codex',
    };
    mgr.saveState(session.id, state);

    const sessionDir = path.join(sessionsDir, session.id);
    const snapshot = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    expect(snapshot.state.godSessionId).toBe('god-session-123');
    expect(snapshot.state.godAdapter).toBe('codex');
  });

  test('godTaskAnalysis is written only on first round', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const analysis = makeTaskAnalysis();

    // Round 1: write godTaskAnalysis
    const state1: SessionState = {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god-123',
      godAdapter: 'codex',
      godTaskAnalysis: analysis,
    };
    mgr.saveState(session.id, state1);

    const sessionDir = path.join(sessionsDir, session.id);
    const snap1 = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    expect(snap1.state.godTaskAnalysis).toEqual(analysis);

    // Round 2: godTaskAnalysis preserved even if state update doesn't include it
    // (saveState merges partial state, preserving existing fields)
    const state2: Partial<SessionState> = {
      status: 'reviewing',
      currentRole: 'reviewer',
      godSessionId: 'god-123',
      godAdapter: 'codex',
    };
    mgr.saveState(session.id, state2);

    const snap2 = JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8'));
    // godTaskAnalysis should be preserved since saveState merges (not replaces)
    expect(snap2.state.godTaskAnalysis).toEqual(analysis);
  });

  // godConvergenceLog test removed (round removal).
});

// ── AC-2: Persistence data < 10KB (20-round long task simulation) ──

describe('God session persistence size constraint (NFR-007)', () => {
  test('persisted data < 10KB for god task analysis', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    const state: SessionState = {
      status: 'completed',
      currentRole: 'coder',
      godSessionId: 'god-session-long-task-uuid-1234',
      godAdapter: 'codex',
      godTaskAnalysis: makeTaskAnalysis(),
    };
    mgr.saveState(session.id, state);

    const sessionDir = path.join(sessionsDir, session.id);
    const snapshotStr = fs.readFileSync(path.join(sessionDir, 'snapshot.json'), 'utf-8');
    const snapshot = JSON.parse(snapshotStr);

    // Measure only God-related data size
    const godData = {
      godSessionId: snapshot.state.godSessionId,
      godAdapter: snapshot.state.godAdapter,
      godTaskAnalysis: snapshot.state.godTaskAnalysis,
    };
    const godDataSize = Buffer.byteLength(JSON.stringify(godData), 'utf-8');
    expect(godDataSize).toBeLessThan(10240); // < 10KB
  });
});

// ── AC-1 (resume): duo resume keeps God stateless ──

describe('restoreGodSession', () => {
  test('always returns null because God adapters are stateless', async () => {
    const state: SessionState = {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god-session-abc',
      godAdapter: 'codex',
    };

    const mockFactory = (_name: string) => {
      throw new Error('should not be called');
    };

    const result = await restoreGodSession(state, mockFactory);
    expect(result).toBeNull();
  });

  test('returns null when godSessionId is missing', async () => {
    const state: SessionState = {
      status: 'coding',
      currentRole: 'coder',
    };

    const mockFactory = () => { throw new Error('should not be called'); };
    const result = await restoreGodSession(state, mockFactory);
    expect(result).toBeNull();
  });

  test('returns null when godAdapter is missing', async () => {
    const state: SessionState = {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god-session-abc',
    };

    const mockFactory = () => { throw new Error('should not be called'); };
    const result = await restoreGodSession(state, mockFactory);
    expect(result).toBeNull();
  });

  test('graceful degradation when adapter factory throws', async () => {
    const state: SessionState = {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god-session-abc',
      godAdapter: 'nonexistent-adapter',
    };

    const mockFactory = (_name: string) => {
      throw new Error('Unknown adapter');
    };

    const result = await restoreGodSession(state, mockFactory);
    expect(result).toBeNull();
  });
});

// ── AC-3: godTaskAnalysis correctly written and read ──

describe('godTaskAnalysis round-trip', () => {
  test('godTaskAnalysis survives write and read cycle', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());
    const analysis = makeTaskAnalysis();

    mgr.saveState(session.id, {
      status: 'coding',
      currentRole: 'coder',
      godSessionId: 'god-123',
      godAdapter: 'codex',
      godTaskAnalysis: analysis,
    });

    const loaded = mgr.loadSession(session.id);
    expect(loaded.state.godTaskAnalysis).toEqual(analysis);
  });
});

// ── AC-5: graceful degradation when session lost ──

describe('God session graceful degradation', () => {
  test('sessions without god fields load normally (backward compat)', () => {
    const mgr = new SessionManager(sessionsDir);
    const session = mgr.createSession(makeConfig());

    // State without any god fields (legacy)
    mgr.saveState(session.id, {
      status: 'coding',
      currentRole: 'coder',
    });

    const loaded = mgr.loadSession(session.id);
    expect(loaded.state.godSessionId).toBeUndefined();
    expect(loaded.state.godAdapter).toBeUndefined();
    expect(loaded.state.godTaskAnalysis).toBeUndefined();
    // godConvergenceLog assertion removed (round removal).
  });
});
