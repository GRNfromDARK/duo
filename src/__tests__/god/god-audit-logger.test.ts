/**
 * Tests for GodAuditLogger — Card E.1
 * Source: FR-020 (AC-051, AC-052), NFR-008
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GodAuditLogger, cleanupOldDecisions } from '../../god/god-audit.js';
import type { GodAuditEntry } from '../../god/god-audit.js';
import { handleLog } from '../../cli-commands.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'god-audit-test-'));
}

function makeEntry(overrides: Partial<Omit<GodAuditEntry, 'seq'>> = {}): Omit<GodAuditEntry, 'seq'> {
  return {
    timestamp: new Date().toISOString(),
    decisionType: 'post_coder',
    inputSummary: 'test input',
    outputSummary: 'test output',
    latencyMs: 100,
    decision: { action: 'continue_to_review' },
    ...overrides,
  };
}

describe('GodAuditLogger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create audit log file on first append', () => {
    const logger = new GodAuditLogger(tmpDir);
    logger.append(makeEntry());

    const logPath = path.join(tmpDir, 'god-audit.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('should auto-increment seq starting from 1', () => {
    const logger = new GodAuditLogger(tmpDir);
    logger.append(makeEntry({ decisionType: 'task_init' }));
    logger.append(makeEntry({ decisionType: 'post_coder' }));
    logger.append(makeEntry({ decisionType: 'convergence' }));

    const entries = logger.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].seq).toBe(1);
    expect(entries[1].seq).toBe(2);
    expect(entries[2].seq).toBe(3);
  });

  it('should preserve full inputSummary and outputSummary', () => {
    const logger = new GodAuditLogger(tmpDir);
    const longStr = 'x'.repeat(600);
    logger.append(makeEntry({ inputSummary: longStr, outputSummary: longStr }));

    const entries = logger.getEntries();
    expect(entries[0].inputSummary.length).toBe(600);
    expect(entries[0].outputSummary.length).toBe(600);
  });

  it('should store complete God output in god-decisions/ with outputRef (AC-052)', () => {
    const logger = new GodAuditLogger(tmpDir);
    const fullOutput = { result: 'detailed analysis', tokens: 1500 };
    logger.append(makeEntry({ decisionType: 'task_init' }), fullOutput);

    const entries = logger.getEntries();
    expect(entries[0].outputRef).toBeDefined();
    expect(entries[0].outputRef).toMatch(/^god-decisions\/001-task_init\.json$/);

    // Verify file exists and contains the full output
    const refPath = path.join(tmpDir, entries[0].outputRef!);
    expect(fs.existsSync(refPath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(refPath, 'utf-8'));
    expect(stored).toEqual(fullOutput);
  });

  it('should filter entries by decisionType', () => {
    const logger = new GodAuditLogger(tmpDir);
    logger.append(makeEntry({ decisionType: 'task_init' }));
    logger.append(makeEntry({ decisionType: 'post_coder' }));
    logger.append(makeEntry({ decisionType: 'convergence' }));
    logger.append(makeEntry({ decisionType: 'post_coder' }));

    const filtered = logger.getEntries({ type: 'post_coder' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every(e => e.decisionType === 'post_coder')).toBe(true);
  });

  it('should return current sequence number', () => {
    const logger = new GodAuditLogger(tmpDir);
    expect(logger.getSequence()).toBe(0);

    logger.append(makeEntry());
    expect(logger.getSequence()).toBe(1);

    logger.append(makeEntry());
    expect(logger.getSequence()).toBe(2);
  });

  it('should preserve optional fields (inputTokens, outputTokens, model, phaseId)', () => {
    const logger = new GodAuditLogger(tmpDir);
    logger.append(makeEntry({
      inputTokens: 500,
      outputTokens: 200,
      model: 'gemini-2.5-pro',
      phaseId: 'phase-1',
    }));

    const entries = logger.getEntries();
    expect(entries[0].inputTokens).toBe(500);
    expect(entries[0].outputTokens).toBe(200);
    expect(entries[0].model).toBe('gemini-2.5-pro');
    expect(entries[0].phaseId).toBe('phase-1');
  });

  it('should resume seq from existing log file', () => {
    // First logger writes 2 entries
    const logger1 = new GodAuditLogger(tmpDir);
    logger1.append(makeEntry());
    logger1.append(makeEntry());

    // Second logger instance should continue from seq 3
    const logger2 = new GodAuditLogger(tmpDir);
    logger2.append(makeEntry());
    const entries = logger2.getEntries();
    expect(entries[2].seq).toBe(3);
  });

  it('test_regression_bug4_seq_not_overridden_by_entry_spread', () => {
    const logger = new GodAuditLogger(tmpDir);
    // Simulate an entry object that happens to carry a stale seq property at runtime
    // (TypeScript Omit only removes at compile time, not at runtime)
    const entryWithSeq = {
      ...makeEntry({ decisionType: 'convergence' }),
      seq: 999, // stale/bogus seq that should NOT override logger's seq
    } as unknown as Omit<GodAuditEntry, 'seq'>;

    logger.append(entryWithSeq);
    logger.append(makeEntry({ decisionType: 'post_coder' }));

    const entries = logger.getEntries();
    expect(entries[0].seq).toBe(1); // Logger's seq, not 999
    expect(entries[1].seq).toBe(2); // Continues from logger's seq
  });

  it('should produce one audit record per God CLI call (AC-051)', () => {
    const logger = new GodAuditLogger(tmpDir);
    // Simulate 3 God CLI calls
    logger.append(makeEntry({ decisionType: 'task_init'}));
    logger.append(makeEntry({ decisionType: 'post_coder'}));
    logger.append(makeEntry({ decisionType: 'post_reviewer'}));

    const entries = logger.getEntries();
    expect(entries).toHaveLength(3);
    // Each has unique seq
    const seqs = entries.map(e => e.seq);
    expect(new Set(seqs).size).toBe(3);
  });
});

describe('cleanupOldDecisions', () => {
  let tmpDir: string;
  let decisionsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    decisionsDir = path.join(tmpDir, 'god-decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should not clean up when under size limit', () => {
    // Write a small file
    fs.writeFileSync(path.join(decisionsDir, '001-task_init.json'), '{"small": true}');
    const removed = cleanupOldDecisions(decisionsDir, 50);
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(decisionsDir, '001-task_init.json'))).toBe(true);
  });

  it('should remove oldest files when over size limit', () => {
    // Create files that exceed a tiny limit (1 byte = ~0.000001 MB)
    // Use 0.0001 MB limit = 100 bytes
    const smallLimit = 0.0001; // ~100 bytes
    fs.writeFileSync(path.join(decisionsDir, '001-task_init.json'), 'A'.repeat(50));
    fs.writeFileSync(path.join(decisionsDir, '002-post_coder.json'), 'B'.repeat(50));
    fs.writeFileSync(path.join(decisionsDir, '003-convergence.json'), 'C'.repeat(50));

    const removed = cleanupOldDecisions(decisionsDir, smallLimit);
    expect(removed).toBeGreaterThan(0);

    // At least the oldest file should be removed
    const remaining = fs.readdirSync(decisionsDir);
    expect(remaining.length).toBeLessThan(3);
  });

  it('should handle non-existent directory gracefully', () => {
    const removed = cleanupOldDecisions('/tmp/nonexistent-dir-xxx', 50);
    expect(removed).toBe(0);
  });
});

describe('test_bug_r14_3: cleanupOldDecisions leaves dangling outputRef', () => {
  let tmpDir: string;
  let decisionsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    decisionsDir = path.join(tmpDir, 'god-decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handleLog should show [deleted] for outputRef pointing to cleaned-up file', () => {
    const logger = new GodAuditLogger(tmpDir);
    const fullOutput = { result: 'big analysis' };
    logger.append(makeEntry({ decisionType: 'task_init' }), fullOutput);

    // Verify the ref file exists
    const entries = logger.getEntries();
    expect(entries[0].outputRef).toBeDefined();
    const refPath = path.join(tmpDir, entries[0].outputRef!);
    expect(fs.existsSync(refPath)).toBe(true);

    // Now clean up with a tiny limit to force deletion
    cleanupOldDecisions(decisionsDir, 0.000001);

    // The ref file should be deleted
    expect(fs.existsSync(refPath)).toBe(false);

    // handleLog should show [deleted] for the dangling ref
    const sessionId = path.basename(tmpDir);
    const parentDir = path.dirname(tmpDir);
    const output: string[] = [];
    handleLog(sessionId, {}, parentDir, (msg) => output.push(msg));

    const joined = output.join('\n');
    expect(joined).toContain('[deleted]');
  });

  it('handleLog should show ref normally when file still exists', () => {
    const logger = new GodAuditLogger(tmpDir);
    const fullOutput = { result: 'analysis' };
    logger.append(makeEntry({ decisionType: 'task_init' }), fullOutput);

    // Do NOT clean up — file still exists
    const sessionId = path.basename(tmpDir);
    const parentDir = path.dirname(tmpDir);
    const output: string[] = [];
    handleLog(sessionId, {}, parentDir, (msg) => output.push(msg));

    const joined = output.join('\n');
    expect(joined).toContain('Ref:');
    expect(joined).not.toContain('[deleted]');
  });
});

describe('handleLog', () => {
  let tmpDir: string;
  let sessionId: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sessionId = 'test-session-001';
    sessionDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should display all audit entries for a session', () => {
    const logger = new GodAuditLogger(sessionDir);
    logger.append(makeEntry({ decisionType: 'task_init'}));
    logger.append(makeEntry({ decisionType: 'post_coder'}));

    const output: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => output.push(msg));

    const joined = output.join('\n');
    expect(joined).toContain('task_init');
    expect(joined).toContain('post_coder');
  });

  it('should filter entries by --type', () => {
    const logger = new GodAuditLogger(sessionDir);
    logger.append(makeEntry({ decisionType: 'task_init'}));
    logger.append(makeEntry({ decisionType: 'post_coder'}));
    logger.append(makeEntry({ decisionType: 'convergence'}));

    const output: string[] = [];
    handleLog(sessionId, { type: 'post_coder' }, tmpDir, (msg) => output.push(msg));

    const joined = output.join('\n');
    expect(joined).toContain('post_coder');
    expect(joined).not.toContain('task_init');
    expect(joined).not.toContain('convergence');
  });

  it('should handle session with no audit log', () => {
    const output: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => output.push(msg));

    const joined = output.join('\n');
    expect(joined).toContain('No audit entries');
  });
});
