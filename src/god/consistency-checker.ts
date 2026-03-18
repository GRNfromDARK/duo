/**
 * ConsistencyChecker — pure-rule God output consistency validation.
 * Source: FR-G02 (AC-058, AC-059)
 *
 * Detects logical contradictions (hallucinations) in God's JSON output.
 * All checks are pure rules (< 1ms, no LLM).
 *
 * Three violation types:
 * - structural: missing required fields for given state
 * - semantic: countable fields contradict categorical fields
 * - low_confidence: low confidence on critical decisions
 *
 * Processing strategy:
 * - Structural contradictions → trigger retry → fallback
 * - Semantic contradictions → auto-correct (countable fields as authority)
 * - Low confidence termination → bias conservative (don't terminate)
 */

import type { GodConvergenceJudgment, GodPostReviewerDecision } from '../types/god-schemas.js';

// ── Types ──

export interface ConsistencyViolation {
  type: 'structural' | 'semantic' | 'low_confidence';
  description: string;
  autoFix?: unknown;
}

export interface ConsistencyResult {
  valid: boolean;
  violations: ConsistencyViolation[];
  corrected?: unknown;
}

// ── Type guards ──

function isConvergenceJudgment(decision: unknown): decision is GodConvergenceJudgment {
  const d = decision as Record<string, unknown>;
  return d != null
    && typeof d === 'object'
    && 'classification' in d
    && 'shouldTerminate' in d
    && 'blockingIssueCount' in d;
}

function isPostReviewerDecision(decision: unknown): decision is GodPostReviewerDecision {
  const d = decision as Record<string, unknown>;
  return d != null
    && typeof d === 'object'
    && 'action' in d
    && 'confidenceScore' in d
    && 'progressTrend' in d;
}

// ── Low confidence threshold ──

const LOW_CONFIDENCE_THRESHOLD = 0.5;

// ── Main entry point ──

/**
 * Check consistency of a God decision (ConvergenceJudgment or PostReviewerDecision).
 * Pure rules, < 1ms, no LLM calls.
 */
export function checkConsistency(decision: GodConvergenceJudgment | GodPostReviewerDecision): ConsistencyResult {
  const violations: ConsistencyViolation[] = [];
  let corrected: unknown | undefined;

  if (isConvergenceJudgment(decision)) {
    checkConvergenceConsistency(decision, violations);
    if (violations.length > 0) {
      corrected = applyConvergenceCorrections(decision, violations);
    }
  }

  else if (isPostReviewerDecision(decision)) {
    checkPostReviewerConsistency(decision, violations);
    if (violations.length > 0) {
      corrected = applyPostReviewerCorrections(decision, violations);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    corrected: violations.length > 0 ? corrected : undefined,
  };
}

// ── Convergence Judgment checks ──

function checkConvergenceConsistency(
  judgment: GodConvergenceJudgment,
  violations: ConsistencyViolation[],
): void {
  // Rule 1: classification: approved + blockingIssueCount > 0 → semantic contradiction
  // Authority: blockingIssueCount (countable) overrides classification (categorical)
  if (judgment.classification === 'approved' && judgment.blockingIssueCount > 0) {
    violations.push({
      type: 'semantic',
      description: `classification is approved but blockingIssueCount is ${judgment.blockingIssueCount} (contradiction)`,
      autoFix: { classification: 'changes_requested' },
    });
  }

  // Rule 4: classification: needs_discussion + shouldTerminate: true → semantic contradiction
  if (judgment.classification === 'needs_discussion' && judgment.shouldTerminate) {
    violations.push({
      type: 'semantic',
      description: 'classification is needs_discussion but shouldTerminate is true (contradiction)',
      autoFix: { shouldTerminate: false },
    });
  }

  // Rule 2: shouldTerminate: true + reason: null → structural (missing required field)
  if (judgment.shouldTerminate && judgment.reason === null) {
    violations.push({
      type: 'structural',
      description: 'shouldTerminate is true but reason is null (missing termination reason)',
    });
  }
}

// ── PostReviewer Decision checks ──

function checkPostReviewerConsistency(
  decision: GodPostReviewerDecision,
  violations: ConsistencyViolation[],
): void {
  // Rule 3: confidenceScore < 0.5 + terminal action (converged) → low confidence termination
  if (decision.confidenceScore < LOW_CONFIDENCE_THRESHOLD && decision.action === 'converged') {
    violations.push({
      type: 'low_confidence',
      description: `confidenceScore is ${decision.confidenceScore} (< ${LOW_CONFIDENCE_THRESHOLD}) but action is converged (low confidence termination)`,
      autoFix: { action: 'route_to_coder' },
    });
  }
}

// ── Auto-corrections ──

function applyConvergenceCorrections(
  judgment: GodConvergenceJudgment,
  violations: ConsistencyViolation[],
): GodConvergenceJudgment {
  let corrected = { ...judgment };

  for (const v of violations) {
    if (v.autoFix && typeof v.autoFix === 'object') {
      corrected = { ...corrected, ...(v.autoFix as Partial<GodConvergenceJudgment>) };
    }
    // Structural: shouldTerminate true without reason → bias conservative
    if (v.type === 'structural' && v.description.includes('shouldTerminate')) {
      corrected = { ...corrected, shouldTerminate: false };
    }
  }

  return corrected;
}

function applyPostReviewerCorrections(
  decision: GodPostReviewerDecision,
  violations: ConsistencyViolation[],
): GodPostReviewerDecision {
  let corrected = { ...decision };

  for (const v of violations) {
    if (v.autoFix && typeof v.autoFix === 'object') {
      corrected = { ...corrected, ...(v.autoFix as Partial<GodPostReviewerDecision>) };
    }
  }

  return corrected;
}

// ── Cross-validation (audit-only) ──

/**
 * Cross-validate God's classification against a local heuristic.
 * Audit-only: logs disagreement but God is authoritative.
 *
 * Mapping: soft_approved (local-only) is treated as equivalent to approved for comparison.
 */
export function crossValidate(
  godClassification: string,
  localClassification: string,
): { agree: boolean; source: 'god' } {
  const normalizedGod = normalize(godClassification);
  const normalizedLocal = normalize(localClassification);

  return {
    agree: normalizedGod === normalizedLocal,
    source: 'god',  // God always authoritative — local is audit-only
  };
}

/**
 * Normalize classification for comparison.
 * soft_approved → approved (local-only variant of approved).
 */
function normalize(classification: string): string {
  if (classification === 'soft_approved') return 'approved';
  return classification;
}
