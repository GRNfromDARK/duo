/**
 * Tests for Card B.4: God dynamic prompt generation.
 * Source: FR-003 (AC-013, AC-014, AC-015), FR-003a, FR-003b, FR-003c
 *
 * Tests that generateCoderPrompt/generateReviewerPrompt produce correct prompts
 * for different task types and contexts.
 *
 * Note: v1 ContextManager fallback was removed in Task 6. Prompt generation
 * now goes directly through God prompt generator with no fallback.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  generateCoderPrompt,
  generateReviewerPrompt,
} from '../../god/god-prompt-generator.js';
import type { PromptContext } from '../../god/god-prompt-generator.js';

// Mock audit log to avoid filesystem writes
vi.mock('../../god/god-audit.js', () => ({
  appendAuditLog: vi.fn(),
  GodAuditLogger: vi.fn().mockImplementation(() => ({
    log: vi.fn(),
    flush: vi.fn(),
  })),
}));

import { appendAuditLog } from '../../god/god-audit.js';
const mockAppendAuditLog = vi.mocked(appendAuditLog);

// ══════════════════════════════════════════════════════════════════
// AC-1: God dynamically generates Coder prompt
// ══════════════════════════════════════════════════════════════════

describe('AC-1: God dynamically generates Coder prompt', () => {
  beforeEach(() => {
    mockAppendAuditLog.mockClear();
  });

  test('generates Coder prompt with task goal and round info', () => {
    const prompt = generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Implement login',
      unresolvedIssues: [],
    }, {
      sessionDir: '/tmp/test',
      seq: 1,
    });

    expect(prompt).toContain('Implement login');
    expect(prompt).toContain('## Instructions');
  });

  test('includes unresolvedIssues as required fixes in Coder prompt (FR-003b)', () => {
    const prompt = generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Implement login',
      lastReviewerOutput: 'Missing validation',
      unresolvedIssues: ['Add input validation', 'Fix SQL injection'],
    }, {
      sessionDir: '/tmp/test',
      seq: 2,
    });

    expect(prompt).toContain('## Required Fixes (MUST address each item)');
    expect(prompt).toContain('1. Add input validation');
    expect(prompt).toContain('2. Fix SQL injection');
  });

  test('writes audit log entry for Coder prompt (AC-015)', () => {
    generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Implement login',
      unresolvedIssues: [],
    }, {
      sessionDir: '/tmp/test-session',
      seq: 42,
    });

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      '/tmp/test-session',
      expect.objectContaining({
        seq: 42,
        decisionType: 'PROMPT_GENERATION',
        decision: expect.objectContaining({ promptType: 'coder' }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-2: God dynamically generates Reviewer prompt
// ══════════════════════════════════════════════════════════════════

describe('AC-2: God dynamically generates Reviewer prompt', () => {
  test('generates Reviewer prompt with task goal and coder output', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      taskGoal: 'Implement login',
      lastCoderOutput: 'Added login endpoint',
    });

    expect(prompt).toContain('Implement login');
    expect(prompt).toContain('## Review Instructions');
    expect(prompt).toContain('## Coder Output');
    expect(prompt).toContain('Added login endpoint');
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-3: explore prompt has no execution verbs (AC-013)
// ══════════════════════════════════════════════════════════════════

describe('AC-3: explore prompt has no execution verbs (AC-013)', () => {
  test('explore Coder prompt does not contain implement/create/write code', () => {
    const prompt = generateCoderPrompt({
      taskType: 'explore',
      taskGoal: 'Understand the auth flow',
      unresolvedIssues: [],
    }, {
      sessionDir: '/tmp/test',
      seq: 1,
    });

    const lower = prompt.toLowerCase();
    expect(lower).not.toContain('implement');
    expect(lower).not.toContain('create');
    expect(lower).not.toContain('write code');
    // Should contain explore-type verbs
    expect(lower).toContain('analyze');
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-4: unresolvedIssues as Coder must-do list
// ══════════════════════════════════════════════════════════════════

describe('AC-4: unresolvedIssues as Coder must-do list', () => {
  test('unresolvedIssues appear as numbered required fixes', () => {
    const issues = ['Fix null pointer in auth.ts:42', 'Add rate limiting', 'Handle timeout errors'];
    const prompt = generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Fix auth bugs',
      lastReviewerOutput: 'Still failing',
      unresolvedIssues: issues,
    }, {
      sessionDir: '/tmp/test',
      seq: 3,
    });

    expect(prompt).toContain('## Required Fixes (MUST address each item)');
    expect(prompt).toContain('1. Fix null pointer in auth.ts:42');
    expect(prompt).toContain('2. Add rate limiting');
    expect(prompt).toContain('3. Handle timeout errors');
  });

  test('empty unresolvedIssues does not add required fixes section', () => {
    const prompt = generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Build feature',
      unresolvedIssues: [],
    }, {
      sessionDir: '/tmp/test',
      seq: 1,
    });

    expect(prompt).not.toContain('## Required Fixes');
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-5: prompt summary written to audit log
// ══════════════════════════════════════════════════════════════════

describe('AC-5: prompt summary written to audit log', () => {
  beforeEach(() => {
    mockAppendAuditLog.mockClear();
  });

  test('audit log entry contains full prompt summary without truncation', () => {
    const longGoal = 'A'.repeat(1000);
    generateCoderPrompt({
      taskType: 'code',
      taskGoal: longGoal,
      unresolvedIssues: [],
    }, {
      sessionDir: '/tmp/test',
      seq: 10,
    });

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAppendAuditLog.mock.calls[0][1];
    expect(entry.outputSummary).toContain(longGoal);
  });
});

// Convergence log trend tests removed (round removal).
