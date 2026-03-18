/**
 * Tests for handleLog() — Card D.2: duo log enhancements
 * Verifies latency statistics and decision type categorization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleLog } from '../cli-commands.js';
import type { GodAuditEntry } from '../god/god-audit.js';

function makeEntry(overrides: Partial<GodAuditEntry> = {}): GodAuditEntry {
  return {
    seq: 1,
    timestamp: '2026-03-12T10:00:00.000Z',
    decisionType: 'task_init',
    inputSummary: 'test input',
    outputSummary: 'test output',
    decision: {},
    ...overrides,
  };
}

describe('handleLog — Card D.2', () => {
  let tmpDir: string;
  let sessionDir: string;
  const sessionId = 'test-session-001';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-log-test-'));
    sessionDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAuditEntries(entries: GodAuditEntry[]) {
    const logPath = path.join(sessionDir, 'god-audit.jsonl');
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(logPath, content);
  }

  it('shows latency statistics summary at the end', () => {
    const entries = [
      makeEntry({ seq: 1, decisionType: 'task_init', latencyMs: 500 }),
      makeEntry({ seq: 2, decisionType: 'post_coder', latencyMs: 1200 }),
      makeEntry({ seq: 3, decisionType: 'convergence', latencyMs: 800 }),
    ];
    writeAuditEntries(entries);

    const lines: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => lines.push(msg));
    const output = lines.join('\n');

    // Should show latency stats
    expect(output).toContain('Latency');
    expect(output).toContain('avg');
  });

  it('categorizes decision types correctly', () => {
    const entries = [
      makeEntry({ seq: 1, decisionType: 'task_init', latencyMs: 100 }),
      makeEntry({ seq: 2, decisionType: 'post_coder', latencyMs: 200 }),
      makeEntry({ seq: 3, decisionType: 'post_reviewer', latencyMs: 300 }),
      makeEntry({ seq: 4, decisionType: 'convergence', latencyMs: 150 }),
      makeEntry({ seq: 5, decisionType: 'auto_decision', latencyMs: 250 }),
      makeEntry({ seq: 6, decisionType: 'reclassify', latencyMs: 180 }),
      makeEntry({ seq: 7, decisionType: 'degradation', latencyMs: 50 }),
    ];
    writeAuditEntries(entries);

    const lines: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => lines.push(msg));
    const output = lines.join('\n');

    // Should show type breakdown
    expect(output).toContain('task_init');
    expect(output).toContain('post_coder');
    expect(output).toContain('post_reviewer');
    expect(output).toContain('convergence');
    expect(output).toContain('auto_decision');
    expect(output).toContain('reclassify');
    expect(output).toContain('degradation');
    // Total count
    expect(output).toContain('7');
  });

  it('shows type breakdown summary', () => {
    const entries = [
      makeEntry({ seq: 1, decisionType: 'task_init', latencyMs: 100 }),
      makeEntry({ seq: 2, decisionType: 'post_coder', latencyMs: 200 }),
      makeEntry({ seq: 3, decisionType: 'post_coder', latencyMs: 300 }),
    ];
    writeAuditEntries(entries);

    const lines: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => lines.push(msg));
    const output = lines.join('\n');

    // Should show per-type counts
    expect(output).toContain('task_init: 1');
    expect(output).toContain('post_coder: 2');
  });

  it('handles entries without latency gracefully', () => {
    const entries = [
      makeEntry({ seq: 1, decisionType: 'task_init' }), // no latencyMs
      makeEntry({ seq: 2, decisionType: 'post_coder', latencyMs: 200 }),
    ];
    writeAuditEntries(entries);

    const lines: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => lines.push(msg));
    const output = lines.join('\n');

    // Should still show stats for entries that have latency
    expect(output).toContain('avg');
    expect(output).toContain('200ms');
  });

  it('shows no latency stats when no entries have latency', () => {
    const entries = [
      makeEntry({ seq: 1, decisionType: 'task_init' }),
    ];
    writeAuditEntries(entries);

    const lines: string[] = [];
    handleLog(sessionId, {}, tmpDir, (msg) => lines.push(msg));
    const output = lines.join('\n');

    // Should still work, just no latency summary
    expect(output).toContain('Total: 1');
  });
});
