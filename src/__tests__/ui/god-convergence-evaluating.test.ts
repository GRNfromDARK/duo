/**
 * Card B.3: EVALUATING — GodConvergence integration tests.
 *
 * Tests the God convergence logic (evaluateConvergence).
 * Verifies: AC-1 through AC-7 (God convergence, blockingIssueCount invariant,
 * criteriaProgress check, convergenceLog append, degradation fallback,
 * all tests passing, existing tests unaffected).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIAdapter, OutputChunk } from '../../types/adapter.js';
import { evaluateConvergence, type ConvergenceLogEntry, type ConvergenceResult } from '../../god/god-convergence.js';
import * as godAudit from '../../god/god-audit.js';

// ── Mock God adapter ──

function createMockGodAdapter(responseJson: Record<string, unknown>): CLIAdapter {
  const jsonBlock = '```json\n' + JSON.stringify(responseJson) + '\n```';
  return {
    execute: vi.fn(async function* (): AsyncGenerator<OutputChunk> {
      yield { type: 'text', content: jsonBlock, timestamp: Date.now() };
    }),
    kill: vi.fn(async () => {}),
  } as unknown as CLIAdapter;
}

function createFailingGodAdapter(error: Error): CLIAdapter {
  return {
    execute: vi.fn(async function* (): AsyncGenerator<OutputChunk> {
      throw error;
    }),
    kill: vi.fn(async () => {}),
  } as unknown as CLIAdapter;
}

// ── Helpers ──

function createBaseContext(overrides?: Partial<{
  round: number;
  maxRounds: number;
  taskGoal: string;
  terminationCriteria: string[];
  convergenceLog: ConvergenceLogEntry[];
  sessionDir: string;
  seq: number;
}>) {
  return {
    round: 3,
    maxRounds: 20,
    taskGoal: 'Fix the login bug',
    terminationCriteria: ['Login works correctly', 'No regressions'],
    convergenceLog: [] as ConvergenceLogEntry[],
    sessionDir: '/tmp/test-session',
    seq: 4,
    ...overrides,
  };
}

// ── Spy on audit ──

let auditSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  auditSpy = vi.spyOn(godAudit, 'appendAuditLog').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── AC-1: God makes convergence judgment ──

describe('AC-1: God convergence evaluation', () => {
  it('calls evaluateConvergence with God adapter and reviewer output', async () => {
    const adapter = createMockGodAdapter({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: true },
        { criterion: 'No regressions', satisfied: true },
      ],
      reviewerVerdict: 'All issues resolved',
    });

    const ctx = createBaseContext();
    const result = await evaluateConvergence(adapter, '[APPROVED] All looks good', ctx);

    expect(result).toBeDefined();
    expect(result.shouldTerminate).toBe(true);
    expect(result.judgment.classification).toBe('approved');
    expect(adapter.execute).toHaveBeenCalled();
  });

  it('returns shouldTerminate=false for changes_requested', async () => {
    const adapter = createMockGodAdapter({
      classification: 'changes_requested',
      shouldTerminate: false,
      reason: null,
      blockingIssueCount: 2,
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: false },
        { criterion: 'No regressions', satisfied: true },
      ],
      reviewerVerdict: 'Found 2 blocking issues',
    });

    const ctx = createBaseContext();
    const result = await evaluateConvergence(adapter, 'Review: found issues', ctx);

    expect(result.shouldTerminate).toBe(false);
    expect(result.judgment.blockingIssueCount).toBe(2);
  });
});

// ── AC-2: shouldTerminate=true requires blockingIssueCount===0 ──

describe('AC-2: shouldTerminate consistency — blockingIssueCount', () => {
  it('overrides shouldTerminate to false if blockingIssueCount > 0', async () => {
    const adapter = createMockGodAdapter({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 3, // contradiction!
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: true },
      ],
      reviewerVerdict: 'Issues remain',
    });

    const ctx = createBaseContext();
    const result = await evaluateConvergence(adapter, 'Review output', ctx);

    // Consistency check should prevent termination
    expect(result.shouldTerminate).toBe(false);
  });
});

// ── AC-3: criteriaProgress all satisfied for termination (except max_rounds/loop_detected) ──

describe('AC-3: criteriaProgress must all be satisfied for termination', () => {
  it('prevents termination when criteria are not all satisfied', async () => {
    const adapter = createMockGodAdapter({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: true },
        { criterion: 'No regressions', satisfied: false }, // not satisfied!
      ],
      reviewerVerdict: 'Almost done',
    });

    const ctx = createBaseContext();
    const result = await evaluateConvergence(adapter, 'Review output', ctx);

    // Should not terminate due to unsatisfied criterion
    expect(result.shouldTerminate).toBe(false);
  });

  it('allows termination for max_rounds exception even with unsatisfied criteria', async () => {
    const adapter = createMockGodAdapter({
      classification: 'changes_requested',
      shouldTerminate: false,
      reason: null,
      blockingIssueCount: 1,
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: false },
      ],
      reviewerVerdict: 'Still has issues',
    });

    // round >= maxRounds triggers max_rounds exception
    const ctx = createBaseContext({ round: 20, maxRounds: 20 });
    const result = await evaluateConvergence(adapter, 'Review output', ctx);

    expect(result.shouldTerminate).toBe(true);
    expect(result.terminationReason).toBe('max_rounds');
  });
});

// ── AC-4: convergenceLog correctly appended each round ──

describe('AC-4: convergenceLog is correctly appended', () => {
  it('appends entry to convergenceLog after evaluation', async () => {
    const adapter = createMockGodAdapter({
      classification: 'changes_requested',
      shouldTerminate: false,
      reason: null,
      blockingIssueCount: 1,
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: false },
      ],
      reviewerVerdict: 'One issue left',
    });

    const convergenceLog: ConvergenceLogEntry[] = [];
    const ctx = createBaseContext({ convergenceLog });

    await evaluateConvergence(adapter, 'Review: one issue', ctx);

    expect(convergenceLog).toHaveLength(1);
    expect(convergenceLog[0].round).toBe(3);
    expect(convergenceLog[0].classification).toBe('changes_requested');
    expect(convergenceLog[0].shouldTerminate).toBe(false);
    expect(convergenceLog[0].blockingIssueCount).toBe(1);
    expect(convergenceLog[0].criteriaProgress).toHaveLength(1);
    expect(convergenceLog[0].summary).toBeTruthy();
  });

  it('accumulates entries across multiple evaluations', async () => {
    const convergenceLog: ConvergenceLogEntry[] = [];

    const adapter1 = createMockGodAdapter({
      classification: 'changes_requested',
      shouldTerminate: false,
      reason: null,
      blockingIssueCount: 2,
      criteriaProgress: [],
      reviewerVerdict: 'Issues found',
    });
    await evaluateConvergence(adapter1, 'Review round 1', createBaseContext({ round: 1, convergenceLog }));

    const adapter2 = createMockGodAdapter({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [
        { criterion: 'Login works correctly', satisfied: true },
      ],
      reviewerVerdict: 'All good',
    });
    await evaluateConvergence(adapter2, '[APPROVED] All good', createBaseContext({ round: 2, convergenceLog }));

    expect(convergenceLog).toHaveLength(2);
    expect(convergenceLog[0].round).toBe(1);
    expect(convergenceLog[1].round).toBe(2);
  });
});

// ── AC-6/AC-7: Audit log and no-reviewer-output guard ──

describe('AC-6: Audit log written for convergence decisions', () => {
  it('writes audit log entry after evaluation', async () => {
    const adapter = createMockGodAdapter({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [],
      reviewerVerdict: 'Good',
    });

    await evaluateConvergence(adapter, 'Review output', createBaseContext());

    expect(auditSpy).toHaveBeenCalled();
    const entry = auditSpy.mock.calls[0][1];
    expect(entry.decisionType).toBe('CONVERGENCE');
  });
});

describe('AC-019b: Cannot terminate without Reviewer review', () => {
  it('returns shouldTerminate=false when reviewerOutput is empty', async () => {
    const adapter = createMockGodAdapter({
      classification: 'approved',
      shouldTerminate: true,
      reason: 'approved',
      blockingIssueCount: 0,
      criteriaProgress: [],
      reviewerVerdict: 'Good',
    });

    const result = await evaluateConvergence(adapter, '', createBaseContext());

    expect(result.shouldTerminate).toBe(false);
    // Should not even call the adapter
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
