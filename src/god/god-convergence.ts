/**
 * God Convergence Service — Reviewer-Authority convergence evaluation.
 * Source: FR-005 (AC-019, AC-019a, AC-019b, AC-020)
 *
 * Core principle: Reviewer is the sole authority on convergence.
 * - Termination requires Reviewer review (AC-019b)
 * - blockingIssueCount must be 0 for shouldTerminate: true (AC-019)
 * - All criteriaProgress must be satisfied for shouldTerminate: true (AC-019a)
 * - Exceptions: max_rounds and loop_detected can force termination
 */

import type { GodAdapter } from '../types/god-adapter.js';
import type { GodConvergenceJudgment } from '../types/god-schemas.js';
import { GodConvergenceJudgmentSchema } from '../types/god-schemas.js';
import { extractWithRetry } from '../parsers/god-json-extractor.js';
import { appendAuditLog, type GodAuditEntry } from './god-audit.js';
import { checkConsistency } from './consistency-checker.js';
import { collectGodAdapterOutput } from './god-call.js';

// ── Types ──

export interface ConvergenceLogEntry {
  round: number;
  timestamp: string;
  classification: string;
  shouldTerminate: boolean;
  blockingIssueCount: number;
  criteriaProgress: { criterion: string; satisfied: boolean }[];
  summary: string; // ≤ 200 chars
}

export interface ConvergenceContext {
  round: number;
  maxRounds: number;
  taskGoal: string;
  terminationCriteria: string[];
  convergenceLog: ConvergenceLogEntry[];
  sessionDir: string;
  seq: number;
  projectDir?: string;
}

export interface ConvergenceResult {
  judgment: GodConvergenceJudgment;
  shouldTerminate: boolean;
  terminationReason?: string;
}

// ── Exception reasons that bypass normal consistency checks ──

const EXCEPTION_REASONS = new Set(['max_rounds', 'loop_detected']);
const GOD_TIMEOUT_MS = 30_000;

// ── Default fallback judgment ──

const DEFAULT_JUDGMENT: GodConvergenceJudgment = {
  classification: 'changes_requested',
  shouldTerminate: false,
  reason: null,
  blockingIssueCount: 0,
  criteriaProgress: [],
  reviewerVerdict: 'Fallback: God extraction failed, defaulting to changes_requested',
};

// ── Consistency Validation (FR-G02) ──

/**
 * Validate internal consistency of a GodConvergenceJudgment.
 * Detects logical contradictions (hallucinations).
 *
 * Exception reasons (max_rounds, loop_detected) bypass criteria checks.
 */
export function validateConvergenceConsistency(
  judgment: GodConvergenceJudgment,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const isException = judgment.reason !== null && EXCEPTION_REASONS.has(judgment.reason);

  // Rule 1: classification: approved with blockingIssueCount > 0 → contradiction
  if (judgment.classification === 'approved' && judgment.blockingIssueCount > 0) {
    violations.push(
      `classification is approved but blockingIssueCount is ${judgment.blockingIssueCount} (must be 0)`,
    );
  }

  if (judgment.shouldTerminate && !isException) {
    // Rule 2: shouldTerminate: true with blockingIssueCount > 0 → contradiction
    if (judgment.blockingIssueCount > 0) {
      violations.push(
        `shouldTerminate is true but blockingIssueCount is ${judgment.blockingIssueCount} (must be 0)`,
      );
    }

    // Rule 3: shouldTerminate: true with unsatisfied criteria → contradiction
    const unsatisfied = judgment.criteriaProgress.filter(c => !c.satisfied);
    if (unsatisfied.length > 0) {
      const names = unsatisfied.map(c => c.criterion).join(', ');
      violations.push(
        `shouldTerminate is true but criteriaProgress has unsatisfied criteria: ${names}`,
      );
    }
  }

  return { valid: violations.length === 0, violations };
}

// ── Main Convergence Evaluation ──

/**
 * Evaluate convergence by calling God adapter and applying consistency checks.
 *
 * Decision tree:
 * 1. If no reviewerOutput → cannot terminate (AC-019b)
 * 2. If max_rounds reached → force terminate
 * 3. If loop_detected + 3 rounds no improvement → force terminate
 * 4. If blockingIssueCount > 0 → do not terminate
 * 5. If all criteriaProgress satisfied → terminate
 * 6. Otherwise → do not terminate
 */
export async function evaluateConvergence(
  godAdapter: GodAdapter,
  reviewerOutput: string,
  context: ConvergenceContext,
): Promise<ConvergenceResult> {
  // AC-019b: Cannot terminate without Reviewer review
  if (!reviewerOutput || reviewerOutput.trim().length === 0) {
    const fallback: ConvergenceResult = {
      judgment: { ...DEFAULT_JUDGMENT },
      shouldTerminate: false,
    };
    appendConvergenceLog(context, fallback.judgment, false);
    writeConvergenceAudit(context, fallback.judgment, '', reviewerOutput);
    return fallback;
  }

  // Call God adapter for convergence judgment
  const godPrompt = buildConvergencePrompt(reviewerOutput, context);
  const systemPrompt = buildConvergenceSystemPrompt();
  const rawOutput = await collectGodAdapterOutput({
    adapter: godAdapter,
    prompt: godPrompt,
    systemPrompt,
    projectDir: context.projectDir,
    timeoutMs: GOD_TIMEOUT_MS,
    logging: {
      sessionDir: context.sessionDir,
      round: context.round,
      kind: 'god_convergence',
      meta: { attempt: 1 },
    },
  });

  // Extract and validate God output
  const result = await extractWithRetry(
    rawOutput,
    GodConvergenceJudgmentSchema,
    async (errorHint: string) => {
      const retryPrompt = `${godPrompt}\n\n[FORMAT ERROR] ${errorHint}\n\nPlease output a corrected JSON block.`;
      return collectGodAdapterOutput({
        adapter: godAdapter,
        prompt: retryPrompt,
        systemPrompt,
        projectDir: context.projectDir,
        timeoutMs: GOD_TIMEOUT_MS,
        logging: {
          sessionDir: context.sessionDir,
          round: context.round,
          kind: 'god_convergence',
          meta: { attempt: 2, retryReason: 'schema_validation' },
        },
      });
    },
  );

  const effectiveRawOutput = (result && result.success && result.sourceOutput) ? result.sourceOutput : rawOutput;

  let judgment: GodConvergenceJudgment;
  if (!result || !result.success) {
    judgment = { ...DEFAULT_JUDGMENT };
  } else {
    judgment = result.data;
  }

  // FR-G02: Run consistency check on God's judgment
  const consistency = checkConsistency(judgment);
  if (!consistency.valid) {
    writeHallucinationAudit(context, judgment, consistency.violations);
    context.seq++;
    // Use auto-corrected judgment if available
    if (consistency.corrected) {
      judgment = consistency.corrected as GodConvergenceJudgment;
    }
  }

  // Enforce shouldTerminate invariants on corrected judgment (covers rules
  // not checked by checkConsistency: shouldTerminate + blockingIssues/unsatisfied criteria)
  const isException = judgment.reason !== null && EXCEPTION_REASONS.has(judgment.reason);
  if (judgment.shouldTerminate && !isException) {
    if (judgment.blockingIssueCount > 0 ||
        judgment.criteriaProgress.some(c => !c.satisfied)) {
      judgment = { ...judgment, shouldTerminate: false };
    }
  }

  // Apply decision tree (skip redundant consistency check — already fully validated above)
  const convergenceResult = applyDecisionTree(judgment, reviewerOutput, context, true);

  // AC-020: Write to convergenceLog
  appendConvergenceLog(context, convergenceResult.judgment, convergenceResult.shouldTerminate);

  // Write audit log
  writeConvergenceAudit(context, convergenceResult.judgment, effectiveRawOutput, reviewerOutput);

  return convergenceResult;
}

// ── Decision Tree ──

function applyDecisionTree(
  judgment: GodConvergenceJudgment,
  _reviewerOutput: string,
  context: ConvergenceContext,
  consistencyAlreadyChecked = false,
): ConvergenceResult {
  // Exception 1: max_rounds reached → force terminate
  if (context.round >= context.maxRounds) {
    return {
      judgment: { ...judgment, shouldTerminate: true, reason: 'max_rounds' },
      shouldTerminate: true,
      terminationReason: 'max_rounds',
    };
  }

  // Exception 2: loop_detected + 3 rounds no improvement → force terminate
  if (judgment.reason === 'loop_detected' && hasNoImprovement(context.convergenceLog, 3)) {
    return {
      judgment: { ...judgment, shouldTerminate: true, reason: 'loop_detected' },
      shouldTerminate: true,
      terminationReason: 'loop_detected',
    };
  }

  // Consistency check: skip if already validated by checkConsistency upstream
  if (!consistencyAlreadyChecked) {
    const consistency = validateConvergenceConsistency(judgment);

    if (!consistency.valid) {
      // Override: do not terminate on inconsistent judgment
      return {
        judgment: { ...judgment, shouldTerminate: false },
        shouldTerminate: false,
      };
    }
  }

  // Normal path: trust God's judgment if consistent
  return {
    judgment,
    shouldTerminate: judgment.shouldTerminate,
    terminationReason: judgment.shouldTerminate && judgment.reason
      ? judgment.reason
      : undefined,
  };
}

/**
 * Check if the last N rounds show no improvement (stagnant blocking issue count).
 */
function hasNoImprovement(log: ConvergenceLogEntry[], rounds: number): boolean {
  if (log.length < rounds) return false;

  const recent = log.slice(-rounds);
  const counts = recent.map(e => e.blockingIssueCount);

  // All counts the same (no improvement) — but exclude the case where all are 0 (converged)
  return counts.every(c => c === counts[0]) && counts[0] > 0;
}

// ── ConvergenceLog Management (AC-020) ──

function appendConvergenceLog(
  context: ConvergenceContext,
  judgment: GodConvergenceJudgment,
  shouldTerminate: boolean,
): void {
  const summary = buildSummary(judgment, shouldTerminate);

  const entry: ConvergenceLogEntry = {
    round: context.round,
    timestamp: new Date().toISOString(),
    classification: judgment.classification,
    shouldTerminate,
    blockingIssueCount: judgment.blockingIssueCount,
    criteriaProgress: judgment.criteriaProgress.map(c => ({
      criterion: c.criterion,
      satisfied: c.satisfied,
    })),
    summary,
  };

  context.convergenceLog.push(entry);
}

function buildSummary(judgment: GodConvergenceJudgment, shouldTerminate: boolean): string {
  const parts: string[] = [];
  parts.push(`classification=${judgment.classification}`);
  parts.push(`blocking=${judgment.blockingIssueCount}`);
  parts.push(`terminate=${shouldTerminate}`);

  const satisfied = judgment.criteriaProgress.filter(c => c.satisfied).length;
  const total = judgment.criteriaProgress.length;
  parts.push(`criteria=${satisfied}/${total}`);

  if (judgment.reason) {
    parts.push(`reason=${judgment.reason}`);
  }

  const summary = parts.join(', ');
  return summary.length > 200 ? summary.slice(0, 197) + '...' : summary;
}

// ── Prompt Building ──

function buildConvergencePrompt(reviewerOutput: string, context: ConvergenceContext): string {
  const sections: string[] = [];

  sections.push(`## Decision Point: CONVERGENCE`);
  sections.push(`## Task\n${context.taskGoal}`);
  sections.push(`## Round Info\nRound ${context.round} of ${context.maxRounds}`);
  sections.push(`## Reviewer Output\n${reviewerOutput}`);

  if (context.terminationCriteria.length > 0) {
    const criteria = context.terminationCriteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join('\n');
    sections.push(`## Termination Criteria\n${criteria}`);
  }

  if (context.convergenceLog.length > 0) {
    const log = context.convergenceLog
      .map(e => `Round ${e.round}: ${e.summary}`)
      .join('\n');
    sections.push(`## Convergence History\n${log}`);
  }

  return sections.join('\n\n');
}

function buildConvergenceSystemPrompt(): string {
  return `You are the God orchestrator evaluating convergence. Analyze the Reviewer's output and determine if the task has converged.

Output a JSON code block with your judgment:
\`\`\`json
{
  "classification": "approved" | "changes_requested" | "needs_discussion",
  "shouldTerminate": true/false,
  "reason": "approved" | "max_rounds" | "loop_detected" | "diminishing_issues" | null,
  "blockingIssueCount": 0,
  "criteriaProgress": [
    { "criterion": "...", "satisfied": true/false }
  ],
  "reviewerVerdict": "..."
}
\`\`\`

Rules:
- shouldTerminate: true ONLY if blockingIssueCount is 0 AND all criteriaProgress are satisfied.
- classification: approved ONLY if Reviewer has no blocking issues.
- Reviewer is the sole authority — trust Reviewer's assessment of blocking issues.`;
}

// ── Audit Log ──

function writeHallucinationAudit(
  context: ConvergenceContext,
  judgment: GodConvergenceJudgment,
  violations: { type: string; description: string }[],
): void {
  const entry: GodAuditEntry = {
    seq: context.seq,
    timestamp: new Date().toISOString(),
    round: context.round,
    decisionType: 'HALLUCINATION_DETECTED',
    inputSummary: violations.map(v => `[${v.type}] ${v.description}`).join('; '),
    outputSummary: JSON.stringify(judgment).slice(0, 500),
    decision: { originalJudgment: judgment, violations },
  };
  appendAuditLog(context.sessionDir, entry);
}

function writeConvergenceAudit(
  context: ConvergenceContext,
  judgment: GodConvergenceJudgment,
  rawOutput: string,
  reviewerOutput: string,
): void {
  const entry: GodAuditEntry = {
    seq: context.seq,
    timestamp: new Date().toISOString(),
    round: context.round,
    decisionType: 'CONVERGENCE',
    inputSummary: reviewerOutput.length > 500 ? reviewerOutput.slice(0, 500) : reviewerOutput,
    outputSummary: rawOutput.length > 500 ? rawOutput.slice(0, 500) : rawOutput,
    decision: judgment,
  };
  appendAuditLog(context.sessionDir, entry);
}
