/**
 * Tests for Card A.3: TASK_INIT + Task Classification + Dynamic Rounds + Audit Log
 * Source: FR-001 (AC-001, AC-002, AC-003), FR-002 (AC-008, AC-009), FR-007 (AC-023, AC-024)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { OutputChunk } from '../../types/adapter.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import type { GodTaskAnalysis } from '../../types/god-schemas.js';
import type { GodAuditEntry } from '../../god/god-audit.js';

// ── Helper: create a mock GodAdapter that returns specified output ──

function createMockAdapter(output: string): GodAdapter {
  return {
    name: 'mock-god',
    displayName: 'Mock God',
    version: '1.0.0',
    toolUsePolicy: 'forbid',
    isInstalled: async () => true,
    getVersion: async () => '1.0.0',
    execute(_prompt: string, _opts: GodExecOptions): AsyncIterable<OutputChunk> {
      const chunks: OutputChunk[] = [
        { type: 'text', content: output, timestamp: Date.now() },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < chunks.length) return { value: chunks[i++], done: false };
              return { value: undefined as unknown as OutputChunk, done: true };
            },
          };
        },
      };
    },
    kill: async () => {},
    isRunning: () => false,
  };
}

// ── AC-1: initializeTask extracts GodTaskAnalysis from God CLI output ──

describe('initializeTask', () => {
  test('extracts GodTaskAnalysis from mock adapter output', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const godOutput = `I've analyzed the task. Here's my assessment:

\`\`\`json
{
  "taskType": "code",
  "reasoning": "User wants to implement a login feature, which is a coding task.",
  "confidence": 0.85,
  "suggestedMaxRounds": 5,
  "terminationCriteria": ["Login form renders", "Auth logic works", "Tests pass"]
}
\`\`\``;

    const adapter = createMockAdapter(godOutput);
    const result = await initializeTask(adapter, 'implement login', 'You are the orchestrator.');

    expect(result).not.toBeNull();
    expect(result!.analysis.taskType).toBe('code');
    expect(result!.analysis.suggestedMaxRounds).toBe(5);
    expect(result!.analysis.terminationCriteria).toHaveLength(3);
    expect(result!.rawOutput).toBe(godOutput);
  });

  test('returns null when God output has no JSON block', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const adapter = createMockAdapter('I am not sure what to do. No JSON here.');
    const result = await initializeTask(adapter, 'vague task', 'You are the orchestrator.');

    expect(result).toBeNull();
  });

  test('returns null when schema validation fails (single attempt, no internal retry)', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    // Invalid: missing required fields
    const badOutput = `\`\`\`json
{ "taskType": "code" }
\`\`\``;

    // Adapter returns bad output
    let callCount = 0;
    const adapter = createMockAdapter(badOutput);
    // Override execute to track calls
    adapter.execute = function (_prompt: string, _opts: GodExecOptions): AsyncIterable<OutputChunk> {
      callCount++;
      const chunks: OutputChunk[] = [
        { type: 'text', content: badOutput, timestamp: Date.now() },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < chunks.length) return { value: chunks[i++], done: false };
              return { value: undefined as unknown as OutputChunk, done: true };
            },
          };
        },
      };
    };

    const result = await initializeTask(adapter, 'test', 'system prompt');

    expect(result).toBeNull();
    // Should only be called once (no internal retry — outer withRetry handles retries)
    expect(callCount).toBe(1);
  });

  test('test_regression_bug6_initializeTask_passes_projectDir_to_adapter', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const godOutput = `\`\`\`json
{
  "taskType": "code",
  "reasoning": "Test projectDir pass-through",
  "confidence": 0.8,
  "suggestedMaxRounds": 3,
  "terminationCriteria": ["done"]
}
\`\`\``;

    let capturedCwd: string | undefined;
    let capturedPrompt: string | undefined;
    const adapter: GodAdapter = {
      name: 'mock-god',
      displayName: 'Mock God',
      version: '1.0.0',
      toolUsePolicy: 'forbid',
      isInstalled: async () => true,
      getVersion: async () => '1.0.0',
      execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
        capturedCwd = opts.cwd;
        capturedPrompt = prompt;
        const chunks: OutputChunk[] = [
          { type: 'text', content: godOutput, timestamp: Date.now() },
        ];
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < chunks.length) return { value: chunks[i++], done: false };
                return { value: undefined as unknown as OutputChunk, done: true };
              },
            };
          },
        };
      },
      kill: async () => {},
      isRunning: () => false,
    };

    await initializeTask(adapter, 'test', 'system prompt', '/custom/project/dir');
    expect(capturedCwd).toBe('/custom/project/dir');
    expect(capturedPrompt).toContain('## Decision Point: TASK_INIT');
    expect(capturedPrompt).toContain('Do not answer or solve the task itself.');
  });

  test('accepts phases set to null for non-compound tasks', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const godOutput = `\`\`\`json
{
  "taskType": "explore",
  "reasoning": "Simple exploratory classification.",
  "phases": null,
  "confidence": 0.9,
  "suggestedMaxRounds": 2,
  "terminationCriteria": ["done"]
}
\`\`\``;

    const adapter = createMockAdapter(godOutput);
    const result = await initializeTask(adapter, '当前项目有多少个文件', 'system prompt');

    expect(result).not.toBeNull();
    expect(result!.analysis.taskType).toBe('explore');
    expect(result!.analysis.phases).toBeNull();
  });
});

// ── rawOutput tracking ──

describe('rawOutput tracking', () => {
  test('rawOutput comes from first call when first attempt succeeds', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const goodOutput = `\`\`\`json
{
  "taskType": "code",
  "reasoning": "First attempt succeeded",
  "confidence": 0.8,
  "suggestedMaxRounds": 3,
  "terminationCriteria": ["done"]
}
\`\`\``;

    const adapter = createMockAdapter(goodOutput);
    const result = await initializeTask(adapter, 'test', 'system prompt');

    expect(result).not.toBeNull();
    expect(result!.rawOutput).toBe(goodOutput);
  });
});

// ── Regression: BUG-1 R12 — collectAdapterOutput must include error chunks ──

describe('test_regression_bug_r12_1: collectAdapterOutput includes error chunks', () => {
  test('error type chunks are included in rawOutput', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const godOutput = `Error: the task analysis shows this is a coding task.

\`\`\`json
{
  "taskType": "code",
  "reasoning": "User wants to fix a bug.",
  "confidence": 0.8,
  "suggestedMaxRounds": 4,
  "terminationCriteria": ["Bug is fixed", "Tests pass"]
}
\`\`\``;

    // Adapter that splits output into text, error, and code chunks
    const adapter: GodAdapter = {
      name: 'mock-god',
      displayName: 'Mock God',
      version: '1.0.0',
      toolUsePolicy: 'forbid',
      isInstalled: async () => true,
      getVersion: async () => '1.0.0',
      execute(_prompt: string, _opts: GodExecOptions): AsyncIterable<OutputChunk> {
        const chunks: OutputChunk[] = [
          { type: 'error', content: 'Error: the task analysis shows this is a coding task.\n', timestamp: Date.now() },
          { type: 'code', content: '```json\n{\n  "taskType": "code",\n  "reasoning": "User wants to fix a bug.",\n  "confidence": 0.8,\n  "suggestedMaxRounds": 4,\n  "terminationCriteria": ["Bug is fixed", "Tests pass"]\n}\n```', timestamp: Date.now() },
        ];
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < chunks.length) return { value: chunks[i++], done: false };
                return { value: undefined as unknown as OutputChunk, done: true };
              },
            };
          },
        };
      },
      kill: async () => {},
      isRunning: () => false,
    };

    const result = await initializeTask(adapter, 'fix bug', 'You are the orchestrator.');

    expect(result).not.toBeNull();
    expect(result!.analysis.taskType).toBe('code');
    // The key assertion: rawOutput must contain the error chunk content
    expect(result!.rawOutput).toContain('Error: the task analysis shows');
  });
});

// ── AC-2: 6 task types classification ──

describe('task type classification', () => {
  const taskTypes = ['explore', 'code', 'discuss', 'review', 'debug', 'compound'] as const;

  test.each(taskTypes)('accepts taskType "%s"', async (taskType) => {
    const { initializeTask } = await import('../../god/task-init.js');

    const phases = taskType === 'compound'
      ? `"phases": [{"id": "p1", "name": "Explore", "type": "explore", "description": "Research first"}],`
      : '';

    const godOutput = `\`\`\`json
{
  "taskType": "${taskType}",
  "reasoning": "Test classification for ${taskType}",
  ${phases}
  "confidence": 0.8,
  "suggestedMaxRounds": 3,
  "terminationCriteria": ["done"]
}
\`\`\``;

    const adapter = createMockAdapter(godOutput);
    const result = await initializeTask(adapter, `${taskType} task`, 'system prompt');

    expect(result).not.toBeNull();
    expect(result!.analysis.taskType).toBe(taskType);
  });
});

// ── AC-3: compound type must contain valid phases array ──

describe('compound type phases', () => {
  test('compound with valid phases array is accepted', async () => {
    const { initializeTask } = await import('../../god/task-init.js');

    const godOutput = `\`\`\`json
{
  "taskType": "compound",
  "reasoning": "Multi-phase task",
  "phases": [
    {"id": "p1", "name": "Research", "type": "explore", "description": "Explore the problem"},
    {"id": "p2", "name": "Implement", "type": "code", "description": "Write the code"},
    {"id": "p3", "name": "Review", "type": "review", "description": "Review the implementation"}
  ],
  "confidence": 0.9,
  "suggestedMaxRounds": 8,
  "terminationCriteria": ["All phases complete"]
}
\`\`\``;

    const adapter = createMockAdapter(godOutput);
    const result = await initializeTask(adapter, 'complex task', 'system prompt');

    expect(result).not.toBeNull();
    expect(result!.analysis.taskType).toBe('compound');
    expect(result!.analysis.phases).toHaveLength(3);
    expect(result!.analysis.phases![0].type).toBe('explore');
    expect(result!.analysis.phases![1].type).toBe('code');
  });
});

// ── AC-4: suggestedMaxRounds in valid range per task type ──

describe('suggestedMaxRounds range validation', () => {
  test.each([
    ['explore', 2, 5],
    ['code', 3, 10],
    ['review', 1, 3],
    ['debug', 2, 6],
    ['discuss', 2, 5],
  ] as const)('validateRoundsForType("%s") accepts range [%d, %d]', async (taskType, min, max) => {
    const { validateRoundsForType } = await import('../../god/task-init.js');

    // In range
    expect(validateRoundsForType(taskType, min)).toBe(min);
    expect(validateRoundsForType(taskType, max)).toBe(max);
    expect(validateRoundsForType(taskType, Math.floor((min + max) / 2))).toBe(Math.floor((min + max) / 2));

    // Below range → clamp to min
    expect(validateRoundsForType(taskType, min - 1)).toBe(min);

    // Above range → clamp to max
    expect(validateRoundsForType(taskType, max + 1)).toBe(max);
  });

  test('compound type does not clamp (passes through)', async () => {
    const { validateRoundsForType } = await import('../../god/task-init.js');
    expect(validateRoundsForType('compound', 15)).toBe(15);
  });
});

// ── AC-5: dynamic rounds adjustment ──

describe('applyDynamicRounds', () => {
  test('adjusts maxRounds within type bounds', async () => {
    const { applyDynamicRounds } = await import('../../god/task-init.js');

    // code type: 3-10
    expect(applyDynamicRounds(5, 8, 'code')).toBe(8);
  });

  test('clamps to type max when suggested exceeds bounds', async () => {
    const { applyDynamicRounds } = await import('../../god/task-init.js');

    // explore: max 5
    expect(applyDynamicRounds(3, 10, 'explore')).toBe(5);
  });

  test('clamps to type min when suggested is below bounds', async () => {
    const { applyDynamicRounds } = await import('../../god/task-init.js');

    // debug: min 2
    expect(applyDynamicRounds(4, 1, 'debug')).toBe(2);
  });

  test('compound type passes through without clamping', async () => {
    const { applyDynamicRounds } = await import('../../god/task-init.js');

    expect(applyDynamicRounds(5, 15, 'compound')).toBe(15);
  });
});

// ── AC-6: God audit log ──

describe('God audit log', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `god-audit-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('appendAuditLog creates file and appends entry', async () => {
    const { appendAuditLog } = await import('../../god/god-audit.js');

    const entry: GodAuditEntry = {
      seq: 1,
      timestamp: new Date().toISOString(),
      round: 0,
      decisionType: 'TASK_INIT',
      inputSummary: 'User wants to implement login',
      outputSummary: 'Classified as code task, 5 rounds',
      decision: { taskType: 'code', suggestedMaxRounds: 5 },
    };

    appendAuditLog(tempDir, entry);

    const logPath = join(tempDir, 'god-audit.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.seq).toBe(1);
    expect(parsed.decisionType).toBe('TASK_INIT');
  });

  test('appendAuditLog appends multiple entries', async () => {
    const { appendAuditLog } = await import('../../god/god-audit.js');

    appendAuditLog(tempDir, {
      seq: 1,
      timestamp: new Date().toISOString(),
      round: 0,
      decisionType: 'TASK_INIT',
      inputSummary: 'first',
      outputSummary: 'first output',
      decision: {},
    });

    appendAuditLog(tempDir, {
      seq: 2,
      timestamp: new Date().toISOString(),
      round: 1,
      decisionType: 'DYNAMIC_ROUNDS',
      inputSummary: 'second',
      outputSummary: 'adjusted rounds',
      decision: { newMaxRounds: 8 },
    });

    const logPath = join(tempDir, 'god-audit.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).seq).toBe(1);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });

  test('inputSummary and outputSummary are preserved in full', async () => {
    const { appendAuditLog } = await import('../../god/god-audit.js');

    const longString = 'x'.repeat(1000);
    appendAuditLog(tempDir, {
      seq: 1,
      timestamp: new Date().toISOString(),
      round: 0,
      decisionType: 'TASK_INIT',
      inputSummary: longString,
      outputSummary: longString,
      decision: {},
    });

    const logPath = join(tempDir, 'god-audit.jsonl');
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(parsed.inputSummary.length).toBe(1000);
    expect(parsed.outputSummary.length).toBe(1000);
  });

  test('optional fields (model, phaseId) are included when provided', async () => {
    const { appendAuditLog } = await import('../../god/god-audit.js');

    appendAuditLog(tempDir, {
      seq: 1,
      timestamp: new Date().toISOString(),
      round: 0,
      decisionType: 'TASK_INIT',
      inputSummary: 'test',
      outputSummary: 'test',
      decision: {},
      model: 'claude-code',
      phaseId: 'p1',
    });

    const logPath = join(tempDir, 'god-audit.jsonl');
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(parsed.model).toBe('claude-code');
    expect(parsed.phaseId).toBe('p1');
  });
});
