/**
 * Tests for ConsistencyChecker — God output consistency validation.
 * Source: FR-G02 (AC-058, AC-059)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  checkConsistency,
  crossValidate,
  type ConsistencyViolation,
  type ConsistencyResult,
} from '../../god/consistency-checker.js';
import type { GodConvergenceJudgment, GodPostReviewerDecision } from '../../types/god-schemas.js';

// ── Helpers ──

function makeJudgment(overrides: Partial<GodConvergenceJudgment> = {}): GodConvergenceJudgment {
  return {
    classification: 'changes_requested',
    shouldTerminate: false,
    reason: null,
    blockingIssueCount: 0,
    criteriaProgress: [],
    reviewerVerdict: 'needs work',
    ...overrides,
  };
}

function makePostReviewerDecision(overrides: Partial<GodPostReviewerDecision> = {}): GodPostReviewerDecision {
  return {
    action: 'route_to_coder',
    reasoning: 'issues remain',
    confidenceScore: 0.8,
    progressTrend: 'improving',
    ...overrides,
  };
}

// ── AC-1: Performance < 1ms ──

describe('ConsistencyChecker performance', () => {
  test('checkConsistency completes in < 1ms', () => {
    const judgment = makeJudgment({
      classification: 'approved',
      blockingIssueCount: 3,
      shouldTerminate: true,
      reason: null,
    });

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      checkConsistency(judgment);
    }
    const elapsed = (performance.now() - start) / 1000; // average per call
    expect(elapsed).toBeLessThan(1);
  });

  test('crossValidate completes in < 1ms', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      crossValidate('approved', 'changes_requested');
    }
    const elapsed = (performance.now() - start) / 1000;
    expect(elapsed).toBeLessThan(1);
  });
});

// ── AC-2: Detect approved + blockingIssueCount > 0 contradiction ──

describe('checkConsistency — structural contradictions', () => {
  test('detects approved + blockingIssueCount > 0', () => {
    const judgment = makeJudgment({
      classification: 'approved',
      blockingIssueCount: 2,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe('semantic');
    expect(result.violations[0].description).toContain('approved');
    expect(result.violations[0].description).toContain('blockingIssueCount');
    // Auto-fix: classification should be corrected based on countable field
    expect(result.corrected).toBeDefined();
    const corrected = result.corrected as GodConvergenceJudgment;
    expect(corrected.classification).toBe('changes_requested');
  });

  test('detects shouldTerminate: true + reason: null', () => {
    const judgment = makeJudgment({
      shouldTerminate: true,
      reason: null,
      blockingIssueCount: 0,
      criteriaProgress: [{ criterion: 'all tests pass', satisfied: true }],
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.type === 'structural')).toBe(true);
    expect(result.violations.some(v => v.description.includes('reason'))).toBe(true);
  });

  test('valid judgment passes all checks', () => {
    const judgment = makeJudgment({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [{ criterion: 'tests pass', satisfied: true }],
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.corrected).toBeUndefined();
  });
});

// ── AC-3: Low confidence terminate corrected to not terminate ──

describe('checkConsistency — low confidence', () => {
  test('low confidence + shouldTerminate corrected to not terminate', () => {
    const decision = makePostReviewerDecision({
      action: 'converged',
      confidenceScore: 0.3,
    });

    const result = checkConsistency(decision);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.type === 'low_confidence')).toBe(true);
    // Auto-fix: should correct action away from converged
    expect(result.corrected).toBeDefined();
    const corrected = result.corrected as GodPostReviewerDecision;
    expect(corrected.action).not.toBe('converged');
  });

  test('high confidence + converged passes', () => {
    const decision = makePostReviewerDecision({
      action: 'converged',
      confidenceScore: 0.9,
    });

    const result = checkConsistency(decision);
    // No low_confidence violation for high confidence
    expect(result.violations.filter(v => v.type === 'low_confidence')).toHaveLength(0);
  });

  test('low confidence + non-terminal action passes', () => {
    const decision = makePostReviewerDecision({
      action: 'route_to_coder',
      confidenceScore: 0.2,
    });

    const result = checkConsistency(decision);
    // Low confidence on non-terminal is fine
    expect(result.violations.filter(v => v.type === 'low_confidence')).toHaveLength(0);
  });
});

// ── AC-4: Hallucination events written to audit log ──

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  };
});

import { appendFileSync } from 'fs';
import { evaluateConvergence } from '../../god/god-convergence.js';

describe('checkConsistency — audit log integration', () => {
  beforeEach(() => {
    vi.mocked(appendFileSync).mockClear();
  });

  test('violations include description for audit logging', () => {
    const judgment = makeJudgment({
      classification: 'approved',
      blockingIssueCount: 5,
      shouldTerminate: true,
      reason: null,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    // Each violation has type and description suitable for audit
    for (const v of result.violations) {
      expect(v.type).toBeTruthy();
      expect(v.description).toBeTruthy();
      expect(typeof v.description).toBe('string');
    }
  });

  test('evaluateConvergence writes HALLUCINATION_DETECTED to audit log on violations', async () => {
    // Create a mock adapter that returns an inconsistent judgment
    const inconsistentJson = JSON.stringify({
      classification: 'approved',
      shouldTerminate: false,
      reason: null,
      blockingIssueCount: 3,
      criteriaProgress: [],
      reviewerVerdict: 'looks good',
    });
    const mockAdapter = {
      execute: async function* () {
        yield { type: 'text' as const, content: '```json\n' + inconsistentJson + '\n```' };
      },
    };

    const context = {
      round: 1,
      maxRounds: 5,
      taskGoal: 'test',
      terminationCriteria: [],
      convergenceLog: [],
      sessionDir: '/tmp/test-session',
      seq: 1,
    };

    await evaluateConvergence(mockAdapter as any, 'reviewer output', context);

    // Find the HALLUCINATION_DETECTED audit entry
    const calls = vi.mocked(appendFileSync).mock.calls;
    const hallucinationEntry = calls.find(call => {
      const content = call[1] as string;
      return content.includes('HALLUCINATION_DETECTED');
    });

    expect(hallucinationEntry).toBeDefined();
    const parsed = JSON.parse(hallucinationEntry![1] as string);
    expect(parsed.decisionType).toBe('HALLUCINATION_DETECTED');
    expect(parsed.decision.violations.length).toBeGreaterThan(0);
  });

});

// ── AC-5: Cross-validation, audit-only (God always authoritative) ──

describe('crossValidate', () => {
  test('agreement returns god as source', () => {
    const result = crossValidate('approved', 'approved');
    expect(result.agree).toBe(true);
    expect(result.source).toBe('god');
  });

  test('disagreement returns god as source (God authoritative)', () => {
    const result = crossValidate('approved', 'changes_requested');
    expect(result.agree).toBe(false);
    expect(result.source).toBe('god');
  });

  test('god changes_requested vs local approved → disagree, god authoritative', () => {
    const result = crossValidate('changes_requested', 'approved');
    expect(result.agree).toBe(false);
    expect(result.source).toBe('god');
  });

  test('both changes_requested → agree', () => {
    const result = crossValidate('changes_requested', 'changes_requested');
    expect(result.agree).toBe(true);
    expect(result.source).toBe('god');
  });

  test('soft_approved mapped correctly for comparison', () => {
    // soft_approved is a local-only classification, treated as approved-ish
    const result = crossValidate('approved', 'soft_approved');
    expect(result.agree).toBe(true);
    expect(result.source).toBe('god');
  });
});

// ── test_regression_bug3_r11: needs_discussion + shouldTerminate contradiction ──

describe('test_regression_bug3_r11: needs_discussion + shouldTerminate contradiction', () => {
  test('detects needs_discussion + shouldTerminate: true as semantic violation', () => {
    const judgment = makeJudgment({
      classification: 'needs_discussion',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [{ criterion: 'tests pass', satisfied: true }],
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v =>
      v.type === 'semantic' && v.description.includes('needs_discussion'),
    )).toBe(true);
    // Auto-fix: shouldTerminate should be corrected to false
    expect(result.corrected).toBeDefined();
    const corrected = result.corrected as GodConvergenceJudgment;
    expect(corrected.shouldTerminate).toBe(false);
  });

  test('needs_discussion + shouldTerminate: false is valid', () => {
    const judgment = makeJudgment({
      classification: 'needs_discussion',
      shouldTerminate: false,
      reason: null,
      blockingIssueCount: 0,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(true);
  });

  test('approved + shouldTerminate: true + reason provided is valid', () => {
    const judgment = makeJudgment({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'all good',
      blockingIssueCount: 0,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(true);
  });
});

// ── Edge cases ──

describe('checkConsistency — edge cases', () => {
  test('convergence judgment with all contradictions at once', () => {
    const judgment = makeJudgment({
      classification: 'approved',
      blockingIssueCount: 3,
      shouldTerminate: true,
      reason: null,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(false);
    // Should detect multiple violations
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  test('changes_requested with blockingIssueCount 0 is valid', () => {
    const judgment = makeJudgment({
      classification: 'changes_requested',
      blockingIssueCount: 0,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(true);
  });

  test('shouldTerminate false with reason null is valid', () => {
    const judgment = makeJudgment({
      shouldTerminate: false,
      reason: null,
    });

    const result = checkConsistency(judgment);
    expect(result.valid).toBe(true);
  });
});
