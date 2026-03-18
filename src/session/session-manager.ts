/**
 * SessionManager — session persistence and restoration.
 * Source: FR-002 (AC-005, AC-006, AC-007, AC-008)
 *
 * Responsibilities:
 * - Store session data in .duo/sessions/<id>/
 * - Files: snapshot.json (metadata+state), history.jsonl (dialog history)
 * - Legacy files: session.json, state.json, history.json (read-only fallback)
 * - Auto-persist on state transitions
 * - List and restore sessions
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SessionConfig } from '../types/session.js';
import type { GodTaskAnalysis } from '../types/god-schemas.js';
import type { ConvergenceLogEntry } from '../god/god-convergence.js';
import { PROMPT_LOG_FILENAME } from './prompt-log.js';

export interface SessionMetadata {
  id: string;
  projectDir: string;
  coder: string;
  reviewer: string;
  god?: string;
  task: string;
  coderModel?: string;
  reviewerModel?: string;
  godModel?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionState {
  round: number;
  status: string;
  currentRole: string;
  /** CLI session ID for the coder adapter (e.g. Claude Code session_id, Codex thread_id) */
  coderSessionId?: string;
  /** CLI session ID for the reviewer adapter */
  reviewerSessionId?: string;
  /** Legacy persisted God session ID. Runtime restore is intentionally disabled. */
  godSessionId?: string;
  /** Legacy persisted God adapter name from older sessions. */
  godAdapter?: string;
  /** God task analysis — written on first round only (FR-011) */
  godTaskAnalysis?: GodTaskAnalysis;
  /** God convergence log — appended each round (FR-011, NFR-007: summary ≤ 200 chars) */
  godConvergenceLog?: ConvergenceLogEntry[];
  /** Current phase ID for compound tasks — persisted for duo resume */
  currentPhaseId?: string | null;
  /** Card E.2: Clarification context — persisted for duo resume when in CLARIFYING state */
  clarification?: {
    frozenActiveProcess: 'coder' | 'reviewer' | null;
    clarificationRound: number;
  };
}

export interface HistoryEntry {
  round: number;
  role: string;
  content: string;
  timestamp: number;
}

export interface SessionSnapshot {
  metadata: SessionMetadata;
  state: SessionState;
}

export interface LoadedSession {
  metadata: SessionMetadata;
  state: SessionState;
  history: HistoryEntry[];
}

export interface SessionSummary {
  id: string;
  projectDir: string;
  task: string;
  round: number;
  status: string;
  coder: string;
  reviewer: string;
  updatedAt: number;
}

export interface RestoreValidation {
  valid: boolean;
  error?: string;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionCorruptedError extends Error {
  constructor(id: string, cause: unknown) {
    super(`Session data corrupted: ${id}`);
    this.name = 'SessionCorruptedError';
    this.cause = cause;
  }
}

/**
 * Atomic write: write to .tmp then rename.
 * On Windows, rename fails if target exists, so unlink first.
 */
function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // Fallback for Windows: unlink target then retry rename
    try { fs.unlinkSync(filePath); } catch { /* target may not exist */ }
    fs.renameSync(tmp, filePath);
  }
}

/** Type guard: validate that a parsed object has the shape of a HistoryEntry. */
function isValidHistoryEntry(obj: unknown): obj is HistoryEntry {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.round === 'number'
    && typeof o.role === 'string'
    && typeof o.content === 'string'
    && typeof o.timestamp === 'number';
}

/** Type guard: validate that a parsed object has the shape of a SessionSnapshot. */
function isValidSnapshot(obj: unknown): obj is SessionSnapshot {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.metadata !== 'object' || o.metadata === null) return false;
  if (typeof o.state !== 'object' || o.state === null) return false;
  const m = o.metadata as Record<string, unknown>;
  const s = o.state as Record<string, unknown>;
  return typeof m.id === 'string'
    && typeof m.projectDir === 'string'
    && typeof m.task === 'string'
    && typeof m.coder === 'string'
    && typeof m.reviewer === 'string'
    && typeof m.createdAt === 'number'
    && typeof m.updatedAt === 'number'
    && typeof s.round === 'number'
    && typeof s.status === 'string'
    && typeof s.currentRole === 'string';
}

export class SessionManager {
  private readonly sessionsDir: string;
  private _lastTs = 0;

  /**
   * Monotonic timestamp: guarantees strictly increasing values within this manager instance.
   * Prevents ties when multiple sessions are created/updated in the same millisecond.
   */
  private monotonicNow(): number {
    const now = Date.now();
    this._lastTs = Math.max(now, this._lastTs + 1);
    return this._lastTs;
  }

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  createSession(config: SessionConfig): { id: string } {
    const id = crypto.randomUUID();
    const sessionDir = path.join(this.sessionsDir, id);
    fs.mkdirSync(sessionDir, { recursive: true });

    const now = this.monotonicNow();

    const metadata: SessionMetadata = {
      id,
      projectDir: config.projectDir,
      coder: config.coder,
      reviewer: config.reviewer,
      god: config.god,
      task: config.task,
      coderModel: config.coderModel,
      reviewerModel: config.reviewerModel,
      godModel: config.godModel,
      createdAt: now,
      updatedAt: now,
    };

    const initialState: SessionState = {
      round: 0,
      status: 'created',
      currentRole: 'coder',
    };

    const snapshot: SessionSnapshot = { metadata, state: initialState };

    // Write new format (snapshot.json) atomically
    atomicWriteSync(path.join(sessionDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    // Initialize empty history
    fs.writeFileSync(path.join(sessionDir, 'history.jsonl'), '');
    fs.writeFileSync(path.join(sessionDir, PROMPT_LOG_FILENAME), '');

    // Also write legacy files for backward compatibility during transition
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(metadata, null, 2));
    fs.writeFileSync(path.join(sessionDir, 'history.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(initialState, null, 2));

    return { id };
  }

  saveState(sessionId: string, state: Partial<SessionState>): void {
    const sessionDir = path.join(this.sessionsDir, sessionId);

    // Load current snapshot (or build from legacy files)
    const snapshot = this.loadSnapshot(sessionDir);
    snapshot.state = { ...snapshot.state, ...state };
    snapshot.metadata.updatedAt = this.monotonicNow();

    // Single atomic write for both metadata + state
    atomicWriteSync(path.join(sessionDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

    // Also update legacy files during transition period
    atomicWriteSync(path.join(sessionDir, 'state.json'), JSON.stringify(snapshot.state, null, 2));
    atomicWriteSync(path.join(sessionDir, 'session.json'), JSON.stringify(snapshot.metadata, null, 2));
  }

  addHistoryEntry(sessionId: string, entry: HistoryEntry): void {
    const sessionDir = path.join(this.sessionsDir, sessionId);
    const jsonlPath = path.join(sessionDir, 'history.jsonl');
    const legacyPath = path.join(sessionDir, 'history.json');

    // Migrate legacy history.json to history.jsonl on first append if needed
    if (!fs.existsSync(jsonlPath) && fs.existsSync(legacyPath)) {
      try {
        const legacyHistory: HistoryEntry[] = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        const lines = legacyHistory.map(e => JSON.stringify(e)).join('\n');
        fs.writeFileSync(jsonlPath, lines ? lines + '\n' : '');
      } catch {
        // If legacy file is corrupted, start fresh
        fs.writeFileSync(jsonlPath, '');
      }
    }

    // Append-only write (no read-modify-write race)
    fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');

    // Keep legacy history.json in sync for backward compatibility and existing readers/tests.
    let legacyHistory: HistoryEntry[] = [];
    try {
      legacyHistory = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      if (!Array.isArray(legacyHistory)) {
        legacyHistory = [];
      }
    } catch {
      legacyHistory = [];
    }
    legacyHistory.push(entry);
    atomicWriteSync(legacyPath, JSON.stringify(legacyHistory, null, 2));
  }

  loadSession(sessionId: string): LoadedSession {
    const sessionDir = path.join(this.sessionsDir, sessionId);

    if (!fs.existsSync(sessionDir)) {
      throw new SessionNotFoundError(sessionId);
    }

    try {
      const snapshot = this.loadSnapshot(sessionDir);
      const history = this.loadHistory(sessionDir);
      return { metadata: snapshot.metadata, state: snapshot.state, history };
    } catch (e) {
      if (e instanceof SessionNotFoundError) throw e;
      throw new SessionCorruptedError(sessionId, e);
    }
  }

  validateSessionRestore(sessionId: string): RestoreValidation {
    const session = this.loadSession(sessionId);

    if (!fs.existsSync(session.metadata.projectDir)) {
      return {
        valid: false,
        error: `Project directory no longer exists: ${session.metadata.projectDir}`,
      };
    }

    return { valid: true };
  }

  listSessions(): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    const summaries: SessionSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(this.sessionsDir, entry.name);

      try {
        const snapshot = this.loadSnapshot(sessionDir);
        summaries.push({
          id: snapshot.metadata.id,
          projectDir: snapshot.metadata.projectDir,
          task: snapshot.metadata.task,
          round: snapshot.state.round,
          status: snapshot.state.status,
          coder: snapshot.metadata.coder,
          reviewer: snapshot.metadata.reviewer,
          updatedAt: snapshot.metadata.updatedAt,
        });
      } catch {
        // Skip corrupted or incomplete sessions
      }
    }

    // Sort by updatedAt descending (most recent first)
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /**
   * Load snapshot: try snapshot.json first, fall back to legacy session.json + state.json.
   */
  private loadSnapshot(sessionDir: string): SessionSnapshot {
    const snapshotPath = path.join(sessionDir, 'snapshot.json');

    if (fs.existsSync(snapshotPath)) {
      const data = fs.readFileSync(snapshotPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!isValidSnapshot(parsed)) {
        throw new Error('snapshot.json has invalid structure');
      }
      return parsed;
    }

    // Fallback to legacy format
    const metaPath = path.join(sessionDir, 'session.json');
    const statePath = path.join(sessionDir, 'state.json');

    if (!fs.existsSync(metaPath) || !fs.existsSync(statePath)) {
      throw new Error('No snapshot or legacy files found');
    }

    const metadata: SessionMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const state: SessionState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const snapshot = { metadata, state };
    if (!isValidSnapshot(snapshot)) {
      throw new Error('Legacy session/state files have invalid structure');
    }
    return snapshot;
  }

  /**
   * Load history: try history.jsonl first, fall back to legacy history.json.
   * Truncated last lines (crash artifact) are skipped with a warning.
   */
  private loadHistory(sessionDir: string): HistoryEntry[] {
    const jsonlPath = path.join(sessionDir, 'history.jsonl');
    const legacyPath = path.join(sessionDir, 'history.json');

    if (fs.existsSync(jsonlPath)) {
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      if (!content.trim()) return [];

      const entries: HistoryEntry[] = [];
      const nonEmptyLines = content.split('\n').filter(l => l.trim());
      for (let i = 0; i < nonEmptyLines.length; i++) {
        const trimmed = nonEmptyLines[i].trim();
        const isLastLine = i === nonEmptyLines.length - 1;
        try {
          const parsed = JSON.parse(trimmed);
          if (!isValidHistoryEntry(parsed)) {
            if (isLastLine) {
              console.warn(`[SessionManager] Last history line has invalid shape, skipping (likely crash artifact)`);
              break;
            }
            throw new Error(`Invalid history entry shape at line ${i + 1}`);
          }
          entries.push(parsed);
        } catch (e) {
          if (isLastLine) {
            // Only tolerate the last line being truncated (crash artifact)
            console.warn(`[SessionManager] Last history line truncated, skipping (likely crash artifact)`);
          } else {
            // Mid-file corruption is not acceptable — caller will wrap as SessionCorruptedError
            throw new Error(`Corrupted history at line ${i + 1}: ${(e as Error).message}`);
          }
        }
      }
      return entries;
    }

    if (fs.existsSync(legacyPath)) {
      try {
        return JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as HistoryEntry[];
      } catch {
        console.warn(`[SessionManager] Legacy history.json corrupted, returning empty history`);
        return [];
      }
    }

    return [];
  }
}
