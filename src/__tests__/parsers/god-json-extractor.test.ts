import { describe, it, expect, vi } from 'vitest';
import { extractGodJson, extractWithRetry } from '../../parsers/god-json-extractor.js';
import {
  GodTaskAnalysisSchema,
  GodPostCoderDecisionSchema,
  GodPostReviewerDecisionSchema,
  GodConvergenceJudgmentSchema,
  GodAutoDecisionSchema,
} from '../../types/god-schemas.js';

// ── Valid mock data ──────────────────────────────────────────────

const validTaskAnalysis = {
  taskType: 'code',
  reasoning: 'User wants to implement a feature',
  confidence: 0.85,
  suggestedMaxRounds: 5,
  terminationCriteria: ['All tests pass', 'No linting errors'],
};

const validPostCoderDecision = {
  action: 'continue_to_review',
  reasoning: 'Coder completed the implementation',
};

const validPostReviewerDecision = {
  action: 'converged',
  reasoning: 'All issues resolved',
  confidenceScore: 0.95,
  progressTrend: 'improving',
};

const validConvergenceJudgment = {
  classification: 'approved',
  shouldTerminate: true,
  reason: null,
  blockingIssueCount: 0,
  criteriaProgress: [{ criterion: 'Tests pass', satisfied: true }],
  reviewerVerdict: 'All good',
};

const validAutoDecision = {
  action: 'accept',
  reasoning: 'The output looks correct',
};

// ── Helper ───────────────────────────────────────────────────────

function wrapInJsonBlock(obj: unknown): string {
  return `Some thinking text...\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\nMore text after.`;
}

// ── extractGodJson tests ─────────────────────────────────────────

describe('extractGodJson', () => {
  it('extracts JSON from mock CLI output', () => {
    const output = wrapInJsonBlock(validTaskAnalysis);
    const result = extractGodJson(output, GodTaskAnalysisSchema);
    expect(result).toEqual({ success: true, data: validTaskAnalysis });
  });

  it('returns null for pure text output (no JSON block)', () => {
    const output = 'Just some plain text without any JSON blocks.';
    const result = extractGodJson(output, GodTaskAnalysisSchema);
    expect(result).toBeNull();
  });

  it('extracts the LAST JSON block when multiple are present', () => {
    const first = { taskType: 'explore', reasoning: 'wrong', confidence: 0.5, suggestedMaxRounds: 2, terminationCriteria: [] };
    const last = validTaskAnalysis;
    const output = `Here is attempt 1:\n\`\`\`json\n${JSON.stringify(first)}\n\`\`\`\nRevised:\n\`\`\`json\n${JSON.stringify(last)}\n\`\`\`\nDone.`;
    const result = extractGodJson(output, GodTaskAnalysisSchema);
    expect(result).toEqual({ success: true, data: last });
  });

  it('returns structured error on JSON parse failure', () => {
    const output = '```json\n{ invalid json }\n```';
    const result = extractGodJson(output, GodTaskAnalysisSchema);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    if (!result!.success) {
      expect(result!.error).toContain('JSON parse error');
    }
  });

  it('returns structured error with path on schema validation failure', () => {
    const badData = { taskType: 'invalid_type', reasoning: 123 };
    const output = wrapInJsonBlock(badData);
    const result = extractGodJson(output, GodTaskAnalysisSchema);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    if (!result!.success) {
      expect(result!.error).toContain('Schema validation failed');
      expect(result!.error).toContain('taskType');
    }
  });
});

// ── Schema compilation + validation tests ────────────────────────

describe('Zod schemas', () => {
  it('GodTaskAnalysisSchema validates correct data', () => {
    const result = GodTaskAnalysisSchema.safeParse(validTaskAnalysis);
    expect(result.success).toBe(true);
  });

  it('GodTaskAnalysisSchema validates compound with phases', () => {
    const compound = {
      ...validTaskAnalysis,
      taskType: 'compound',
      phases: [{ id: 'p1', name: 'Phase 1', type: 'code', description: 'Implement' }],
    };
    const result = GodTaskAnalysisSchema.safeParse(compound);
    expect(result.success).toBe(true);
  });

  it('GodTaskAnalysisSchema rejects invalid taskType', () => {
    const result = GodTaskAnalysisSchema.safeParse({ ...validTaskAnalysis, taskType: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('GodPostCoderDecisionSchema validates correct data', () => {
    const result = GodPostCoderDecisionSchema.safeParse(validPostCoderDecision);
    expect(result.success).toBe(true);
  });

  it('GodPostCoderDecisionSchema validates retry_coder with retryHint', () => {
    const data = { action: 'retry_coder', reasoning: 'Failed', retryHint: 'Try again with X' };
    const result = GodPostCoderDecisionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('GodPostCoderDecisionSchema rejects invalid action', () => {
    const result = GodPostCoderDecisionSchema.safeParse({ action: 'invalid', reasoning: 'test' });
    expect(result.success).toBe(false);
  });

  it('GodPostReviewerDecisionSchema validates correct data', () => {
    const result = GodPostReviewerDecisionSchema.safeParse(validPostReviewerDecision);
    expect(result.success).toBe(true);
  });

  it('GodPostReviewerDecisionSchema validates with unresolvedIssues', () => {
    const data = {
      action: 'route_to_coder',
      reasoning: 'Issues found',
      unresolvedIssues: ['Fix bug #1'],
      confidenceScore: 0.6,
      progressTrend: 'stagnant',
    };
    const result = GodPostReviewerDecisionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('GodConvergenceJudgmentSchema validates correct data', () => {
    const result = GodConvergenceJudgmentSchema.safeParse(validConvergenceJudgment);
    expect(result.success).toBe(true);
  });

  it('GodConvergenceJudgmentSchema rejects missing required fields', () => {
    const result = GodConvergenceJudgmentSchema.safeParse({ classification: 'approved' });
    expect(result.success).toBe(false);
  });

  it('GodAutoDecisionSchema validates correct data', () => {
    const result = GodAutoDecisionSchema.safeParse(validAutoDecision);
    expect(result.success).toBe(true);
  });

  it('GodAutoDecisionSchema validates continue_with_instruction', () => {
    const data = {
      action: 'continue_with_instruction',
      reasoning: 'Need to adjust',
      instruction: 'Focus on error handling',
    };
    const result = GodAutoDecisionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('GodAutoDecisionSchema rejects invalid action', () => {
    const result = GodAutoDecisionSchema.safeParse({ action: 'invalid', reasoning: 'test' });
    expect(result.success).toBe(false);
  });
});

// ── extractWithRetry tests ───────────────────────────────────────

describe('extractWithRetry', () => {
  it('returns data on first success without calling retryFn', async () => {
    const output = wrapInJsonBlock(validTaskAnalysis);
    const retryFn = vi.fn();

    const result = await extractWithRetry(output, GodTaskAnalysisSchema, retryFn);

    expect(result).toEqual({ success: true, data: validTaskAnalysis, sourceOutput: output });
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('retries once on schema validation failure and succeeds', async () => {
    const badOutput = wrapInJsonBlock({ taskType: 'invalid' });
    const goodOutput = wrapInJsonBlock(validTaskAnalysis);
    const retryFn = vi.fn().mockResolvedValueOnce(goodOutput);

    const result = await extractWithRetry(badOutput, GodTaskAnalysisSchema, retryFn);

    expect(result).toEqual({ success: true, data: validTaskAnalysis, sourceOutput: goodOutput });
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(retryFn.mock.calls[0][0]).toContain('Schema validation failed');
  });

  it('returns error result after retry also fails (BUG-23: was returning null)', async () => {
    const badOutput = wrapInJsonBlock({ taskType: 'invalid' });
    const stillBadOutput = wrapInJsonBlock({ taskType: 'still_invalid' });
    const retryFn = vi.fn().mockResolvedValueOnce(stillBadOutput);

    const result = await extractWithRetry(badOutput, GodTaskAnalysisSchema, retryFn);

    // BUG-23 fix: returns error details instead of null
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(retryFn).toHaveBeenCalledTimes(1);
  });

  it('returns error result for pure text without retrying (BUG-23: was returning null)', async () => {
    const output = 'No JSON here.';
    const retryFn = vi.fn();

    const result = await extractWithRetry(output, GodTaskAnalysisSchema, retryFn);

    // BUG-23 fix: returns error details instead of null
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('retries on JSON parse error', async () => {
    const badOutput = '```json\n{broken}\n```';
    const goodOutput = wrapInJsonBlock(validTaskAnalysis);
    const retryFn = vi.fn().mockResolvedValueOnce(goodOutput);

    const result = await extractWithRetry(badOutput, GodTaskAnalysisSchema, retryFn);

    expect(result).toEqual({ success: true, data: validTaskAnalysis, sourceOutput: goodOutput });
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(retryFn.mock.calls[0][0]).toContain('JSON parse error');
  });

  // ── BUG-1 R15 regression: sourceOutput must match the call that produced valid data ──

  it('test_regression_bug1_r15: sourceOutput is first output when first attempt succeeds', async () => {
    const firstOutput = wrapInJsonBlock(validTaskAnalysis);
    const retryFn = vi.fn();

    const result = await extractWithRetry(firstOutput, GodTaskAnalysisSchema, retryFn);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    if (result!.success) {
      expect(result!.sourceOutput).toBe(firstOutput);
    }
    expect(retryFn).not.toHaveBeenCalled();
  });

  it('test_regression_bug1_r15: sourceOutput is retry output when first attempt fails and retry succeeds', async () => {
    const badOutput = wrapInJsonBlock({ taskType: 'invalid' });
    const goodOutput = wrapInJsonBlock(validTaskAnalysis);
    const retryFn = vi.fn().mockResolvedValueOnce(goodOutput);

    const result = await extractWithRetry(badOutput, GodTaskAnalysisSchema, retryFn);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    if (result!.success) {
      // sourceOutput must be the retry output, NOT the original bad output
      expect(result!.sourceOutput).toBe(goodOutput);
      expect(result!.sourceOutput).not.toBe(badOutput);
    }
    expect(retryFn).toHaveBeenCalledTimes(1);
  });
});
