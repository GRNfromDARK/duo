/**
 * Tests for Card B.4: God 动态 Prompt 生成替代 ContextManager
 * Source: FR-003 (AC-013, AC-014, AC-015), FR-003a, FR-003b, FR-003c
 *
 * Tests the integration logic: when God is available, generateCoderPrompt/generateReviewerPrompt
 * are used; when God is unavailable, v1 ContextManager is used as fallback.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  generateCoderPrompt,
  generateReviewerPrompt,
} from '../../god/god-prompt-generator.js';
import type { PromptContext } from '../../god/god-prompt-generator.js';
import type { ConvergenceLogEntry } from '../../god/god-convergence.js';
import { ContextManager } from '../../session/context-manager.js';

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

// ── Helpers ──

function makeContextManager() {
  return new ContextManager({ contextWindowSize: 200000 });
}

/**
 * Simulates the prompt selection logic from App.tsx CODING useEffect.
 * This mirrors the code path in B.4 implementation.
 * godAvailable replaces the old DegradationManager.isGodAvailable() check.
 */
function selectCoderPrompt(opts: {
  godAvailable: boolean;
  contextManager: ContextManager;
  taskAnalysis: { taskType: string } | null;
  config: { task: string };
  ctx: { round: number; maxRounds: number; lastReviewerOutput?: string | null };
  lastUnresolvedIssues: string[];
  convergenceLog: ConvergenceLogEntry[];
  sessionDir: string;
  auditSeq: number;
  choiceRoute?: { target: string; prompt: string } | null;
  rounds: Array<{ index: number; coderOutput: string; reviewerOutput: string; timestamp: number }>;
}): string {
  // If there's a choice route for coder, use it directly (interrupt/choice)
  if (opts.choiceRoute?.target === 'coder') {
    return opts.choiceRoute.prompt;
  }

  // God prompt path: available + taskAnalysis exists
  if (opts.godAvailable && opts.taskAnalysis) {
    return generateCoderPrompt({
      taskType: opts.taskAnalysis.taskType as PromptContext['taskType'],
      round: opts.ctx.round,
      maxRounds: opts.ctx.maxRounds,
      taskGoal: opts.config.task,
      lastReviewerOutput: opts.ctx.lastReviewerOutput ?? undefined,
      unresolvedIssues: opts.lastUnresolvedIssues,
      convergenceLog: opts.convergenceLog,
    }, {
      sessionDir: opts.sessionDir,
      seq: opts.auditSeq,
    });
  }

  // Fallback to v1 ContextManager
  return opts.contextManager.buildCoderPrompt(
    opts.config.task,
    opts.rounds,
    {
      ...(opts.ctx.lastReviewerOutput ? { reviewerFeedback: opts.ctx.lastReviewerOutput } : {}),
    },
  );
}

/**
 * Simulates the prompt selection logic from App.tsx REVIEWING useEffect.
 */
function selectReviewerPrompt(opts: {
  godAvailable: boolean;
  contextManager: ContextManager;
  taskAnalysis: { taskType: string } | null;
  config: { task: string };
  ctx: { round: number; maxRounds: number; lastCoderOutput?: string | null };
  rounds: Array<{ index: number; coderOutput: string; reviewerOutput: string; timestamp: number }>;
  choiceRoute?: { target: string; prompt: string } | null;
  lastReviewerOutput?: string;
}): string {
  if (opts.choiceRoute?.target === 'reviewer') {
    return opts.choiceRoute.prompt;
  }

  if (opts.godAvailable && opts.taskAnalysis) {
    return generateReviewerPrompt({
      taskType: opts.taskAnalysis.taskType,
      round: opts.ctx.round,
      maxRounds: opts.ctx.maxRounds,
      taskGoal: opts.config.task,
      lastCoderOutput: opts.ctx.lastCoderOutput ?? undefined,
    });
  }

  return opts.contextManager.buildReviewerPrompt(
    opts.config.task,
    opts.rounds,
    opts.ctx.lastCoderOutput ?? '',
    {
      roundNumber: opts.ctx.round + 1,
      ...(opts.lastReviewerOutput ? { previousReviewerOutput: opts.lastReviewerOutput } : {}),
    },
  );
}

// ══════════════════════════════════════════════════════════════════
// AC-1: God 动态生成 Coder prompt
// ══════════════════════════════════════════════════════════════════

describe('AC-1: God dynamically generates Coder prompt', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = makeContextManager();
    mockAppendAuditLog.mockClear();
  });

  test('uses generateCoderPrompt when God is available and taskAnalysis exists', () => {
    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement login' },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 1,
      rounds: [],
    });

    // God prompt includes task goal and strategy instructions
    expect(prompt).toContain('Implement login');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('Round 1 of 5');
  });

  test('includes unresolvedIssues as required fixes in Coder prompt (FR-003b)', () => {
    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement login' },
      ctx: { round: 2, maxRounds: 5, lastReviewerOutput: 'Missing validation' },
      lastUnresolvedIssues: ['Add input validation', 'Fix SQL injection'],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 2,
      rounds: [],
    });

    expect(prompt).toContain('## Required Fixes (MUST address each item)');
    expect(prompt).toContain('1. Add input validation');
    expect(prompt).toContain('2. Fix SQL injection');
  });

  test('writes audit log entry for Coder prompt (AC-015)', () => {
    selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement login' },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test-session',
      auditSeq: 42,
      rounds: [],
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
// AC-2: God 动态生成 Reviewer prompt
// ══════════════════════════════════════════════════════════════════

describe('AC-2: God dynamically generates Reviewer prompt', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = makeContextManager();
  });

  test('uses generateReviewerPrompt when God is available and taskAnalysis exists', () => {
    const prompt = selectReviewerPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement login' },
      ctx: { round: 1, maxRounds: 5, lastCoderOutput: 'Added login endpoint' },
      rounds: [],
    });

    expect(prompt).toContain('Implement login');
    expect(prompt).toContain('## Review Instructions');
    expect(prompt).toContain('Coder Output (Round 1)');
    expect(prompt).toContain('Added login endpoint');
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-3: explore 型 prompt 不含执行动词 (AC-013)
// ══════════════════════════════════════════════════════════════════

describe('AC-3: explore prompt has no execution verbs (AC-013)', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = makeContextManager();
  });

  test('explore Coder prompt does not contain implement/create/write code', () => {
    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'explore' },
      config: { task: 'Understand the auth flow' },
      ctx: { round: 1, maxRounds: 3 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 1,
      rounds: [],
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
// AC-4: Reviewer unresolvedIssues 作为 Coder prompt 必做清单
// ══════════════════════════════════════════════════════════════════

describe('AC-4: unresolvedIssues as Coder must-do list', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = makeContextManager();
  });

  test('unresolvedIssues appear as numbered required fixes', () => {
    const issues = ['Fix null pointer in auth.ts:42', 'Add rate limiting', 'Handle timeout errors'];
    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Fix auth bugs' },
      ctx: { round: 3, maxRounds: 5, lastReviewerOutput: 'Still failing' },
      lastUnresolvedIssues: issues,
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 3,
      rounds: [],
    });

    expect(prompt).toContain('## Required Fixes (MUST address each item)');
    expect(prompt).toContain('1. Fix null pointer in auth.ts:42');
    expect(prompt).toContain('2. Add rate limiting');
    expect(prompt).toContain('3. Handle timeout errors');
  });

  test('empty unresolvedIssues does not add required fixes section', () => {
    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Build feature' },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 1,
      rounds: [],
    });

    expect(prompt).not.toContain('## Required Fixes');
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-5: prompt 摘要写入 audit log
// ══════════════════════════════════════════════════════════════════

describe('AC-5: prompt summary written to audit log', () => {
  beforeEach(() => {
    mockAppendAuditLog.mockClear();
  });

  test('audit log entry contains full prompt summary without truncation', () => {
    const cm = makeContextManager();

    // Create a long task goal to verify no truncation
    const longGoal = 'A'.repeat(1000);
    selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: longGoal },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 10,
      rounds: [],
    });

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAppendAuditLog.mock.calls[0][1];
    expect(entry.outputSummary).toContain(longGoal);
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-6: God 失败时降级到 v1 ContextManager
// ══════════════════════════════════════════════════════════════════

describe('AC-6: Fallback to v1 ContextManager when God unavailable', () => {
  test('uses ContextManager.buildCoderPrompt when God is unavailable', () => {
    const cm = makeContextManager();

    const prompt = selectCoderPrompt({
      godAvailable: false,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement feature' },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 1,
      rounds: [],
    });

    // v1 ContextManager prompt has different format
    expect(prompt).toContain('You are a Coder');
    expect(prompt).toContain('Implement feature');
  });

  test('uses ContextManager.buildCoderPrompt when taskAnalysis is null', () => {
    const cm = makeContextManager();

    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: null,
      config: { task: 'Implement feature' },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 1,
      rounds: [],
    });

    expect(prompt).toContain('You are a Coder');
  });

  test('uses ContextManager.buildReviewerPrompt when God is unavailable', () => {
    const cm = makeContextManager();

    const prompt = selectReviewerPrompt({
      godAvailable: false,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement feature' },
      ctx: { round: 1, maxRounds: 5, lastCoderOutput: 'some code' },
      rounds: [],
    });

    expect(prompt).toContain('You are a Reviewer');
  });

  test('uses ContextManager.buildReviewerPrompt when taskAnalysis is null', () => {
    const cm = makeContextManager();

    const prompt = selectReviewerPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: null,
      config: { task: 'Implement feature' },
      ctx: { round: 1, maxRounds: 5, lastCoderOutput: 'some code' },
      rounds: [],
    });

    expect(prompt).toContain('You are a Reviewer');
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-8: choiceRoute still takes precedence
// ══════════════════════════════════════════════════════════════════

describe('AC-8: choiceRoute takes precedence over God prompt', () => {
  test('choiceRoute for coder overrides God prompt', () => {
    const cm = makeContextManager();

    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement feature' },
      ctx: { round: 1, maxRounds: 5 },
      lastUnresolvedIssues: [],
      convergenceLog: [],
      sessionDir: '/tmp/test',
      auditSeq: 1,
      choiceRoute: { target: 'coder', prompt: 'Custom choice prompt' },
      rounds: [],
    });

    expect(prompt).toBe('Custom choice prompt');
  });

  test('choiceRoute for reviewer overrides God prompt', () => {
    const cm = makeContextManager();

    const prompt = selectReviewerPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Implement feature' },
      ctx: { round: 1, maxRounds: 5, lastCoderOutput: 'code' },
      rounds: [],
      choiceRoute: { target: 'reviewer', prompt: 'Custom reviewer prompt' },
    });

    expect(prompt).toBe('Custom reviewer prompt');
  });
});

// ══════════════════════════════════════════════════════════════════
// Convergence log trend included in God prompt
// ══════════════════════════════════════════════════════════════════

describe('Convergence log trend in Coder prompt', () => {
  test('includes convergence trend when log entries exist', () => {
    const cm = makeContextManager();

    const prompt = selectCoderPrompt({
      godAvailable: true,
      contextManager: cm,
      taskAnalysis: { taskType: 'code' },
      config: { task: 'Fix bugs' },
      ctx: { round: 3, maxRounds: 5 },
      lastUnresolvedIssues: ['Fix memory leak'],
      convergenceLog: [
        {
          round: 1,
          timestamp: '2026-03-12T00:00:00Z',
          blockingIssueCount: 5,
          classification: 'major_issues',
          shouldTerminate: false,
          criteriaProgress: [],
          summary: 'round 1',
        },
        {
          round: 2,
          timestamp: '2026-03-12T00:01:00Z',
          blockingIssueCount: 2,
          classification: 'minor_issues',
          shouldTerminate: false,
          criteriaProgress: [],
          summary: 'round 2',
        },
      ],
      sessionDir: '/tmp/test',
      auditSeq: 3,
      rounds: [],
    });

    expect(prompt).toContain('## Convergence Trend');
    expect(prompt).toContain('2 blocking in round 2');
  });
});
