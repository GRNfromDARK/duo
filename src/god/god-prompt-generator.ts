/**
 * God Prompt Generator — dynamic prompt generation for Coder/Reviewer per round.
 * Replaces ContextManager's prompt building for God-orchestrated sessions.
 * Source: FR-003 (AC-013, AC-014, AC-015), FR-003a, FR-003b, FR-003c
 */

import type { GodAuditEntry } from './god-audit.js';
import { appendAuditLog } from './god-audit.js';
import type { ConvergenceLogEntry } from './god-convergence.js';

// ── Types ──

export type { ConvergenceLogEntry };

export interface PromptContext {
  taskType: 'explore' | 'code' | 'discuss' | 'review' | 'debug' | 'compound';
  round: number;
  maxRounds: number;
  taskGoal: string;
  phaseId?: string;
  /** For compound type: the current phase's effective type */
  phaseType?: 'explore' | 'code' | 'discuss' | 'review' | 'debug';
  lastReviewerOutput?: string;
  unresolvedIssues?: string[];
  suggestions?: string[];
  convergenceLog?: ConvergenceLogEntry[];
  lastCoderOutput?: string;
  /** God auto-decision instruction (highest priority) */
  instruction?: string;
}

export interface GodDecisionContext {
  decisionPoint: 'POST_CODER' | 'POST_REVIEWER' | 'CONVERGENCE';
  round: number;
  maxRounds: number;
  taskGoal: string;
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  unresolvedIssues?: string[];
  convergenceLog?: ConvergenceLogEntry[];
  currentPhaseId?: string;
  currentPhaseType?: 'explore' | 'code' | 'discuss' | 'review' | 'debug';
  phases?: {
    id: string;
    name: string;
    type: 'explore' | 'code' | 'discuss' | 'review' | 'debug' | 'compound';
    description: string;
  }[];
}

export interface AuditOptions {
  sessionDir: string;
  seq: number;
}

// ── Constants ──

/** Maximum prompt length in characters (AC-014) */
export const MAX_PROMPT_LENGTH = 100_000;

const MAX_AUDIT_SUMMARY = 500;

// ── Task-type strategy templates (FR-003a) ──

const EXPLORE_INSTRUCTIONS = `## Instructions
- Analyze the codebase and provide findings, recommendations, and suggestions.
- Investigate the relevant files and explore possible approaches.
- Examine the current state and suggest improvements.
- Do NOT modify any files. Do NOT execute any code changes.
- Recommend solutions but do not apply them.`;

const CODE_INSTRUCTIONS = `## Instructions
- Implement the required changes following clean code principles.
- Write robust, correct code with appropriate error handling.
- Ensure quality by considering edge cases and writing testable code.
- Build working solutions, not explanations.
- Do not ask questions. Decide autonomously and develop directly.`;

const REVIEW_INSTRUCTIONS = `## Instructions
- Review the code changes against the task requirements.
- Check for bugs, logic errors, security issues, and missing requirements.
- Examine each file methodically and audit for correctness.
- Inspect edge cases and error handling.`;

const DEBUG_INSTRUCTIONS = `## Instructions
- Diagnose the reported issue by tracing through the code path.
- Identify the root cause of the bug or failure.
- Fix the issue with a minimal, targeted change.
- Verify the fix addresses the problem without side effects.`;

const DISCUSS_INSTRUCTIONS = `## Instructions
- Consider the tradeoffs of each approach carefully.
- Discuss the pros and cons of different solutions.
- Evaluate the options and weigh their implications.
- Provide a well-reasoned recommendation.`;

const IMPLEMENTATION_KEYWORDS = /实现|开发|编写|修改|implement|build|write|code|create|fix|develop|modify/i;

function getStrategyInstructions(taskType: string): string {
  switch (taskType) {
    case 'explore': return EXPLORE_INSTRUCTIONS;
    case 'code': return CODE_INSTRUCTIONS;
    case 'review': return REVIEW_INSTRUCTIONS;
    case 'debug': return DEBUG_INSTRUCTIONS;
    case 'discuss': return DISCUSS_INSTRUCTIONS;
    default: return CODE_INSTRUCTIONS;
  }
}

function resolveEffectiveType(
  phaseType: string | undefined,
  instruction: string | undefined,
): string {
  if (!instruction || !phaseType) return phaseType ?? 'code';

  if ((phaseType === 'explore' || phaseType === 'discuss') && IMPLEMENTATION_KEYWORDS.test(instruction)) {
    return 'code';
  }

  return phaseType;
}

// ── Prompt generators ──

/**
 * Generate a Coder prompt based on task type and reviewer feedback (FR-003b priority order).
 * Optionally writes a summary to audit log (FR-003c / AC-015).
 */
export function generateCoderPrompt(ctx: PromptContext, audit?: AuditOptions): string {
  const rawPhaseType = ctx.taskType === 'compound' && ctx.phaseType
    ? ctx.phaseType
    : ctx.taskType;
  const effectiveType = ctx.taskType === 'compound'
    ? resolveEffectiveType(rawPhaseType, ctx.instruction)
    : rawPhaseType;

  const sections: string[] = [];

  // Card D.2: Worker role declaration (FR-009 — Coder as pure executor)
  sections.push(`## Your Role
You are an executor. You carry out work as instructed.
You do NOT have accept authority — you cannot accept or complete the task.
You do NOT decide phase switches — phase transitions are managed by God.
Focus on producing high-quality work output. Do not make management decisions.`);

  // Task goal (priority 3)
  sections.push(`## Task\n${ctx.taskGoal}`);

  // Phase info for compound type
  if (ctx.taskType === 'compound' && ctx.phaseId) {
    sections.push(`## Current Phase\nPhase: ${ctx.phaseId} (type: ${ctx.phaseType ?? 'unknown'})`);
  }

  // Priority 0: God auto-decision instruction (highest priority)
  if (ctx.instruction) {
    sections.push(`## God Instruction (HIGHEST PRIORITY)\n${ctx.instruction}`);
  }

  // Priority 1: unresolvedIssues (highest - Reviewer-Driven)
  if (ctx.unresolvedIssues && ctx.unresolvedIssues.length > 0) {
    const issueList = ctx.unresolvedIssues
      .map((issue, i) => `${i + 1}. ${issue}`)
      .join('\n');
    sections.push(`## Required Fixes (MUST address each item)\n${issueList}`);
  }

  // Priority 2: suggestions (non-blocking)
  if (ctx.suggestions && ctx.suggestions.length > 0) {
    const suggestionList = ctx.suggestions
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n');
    sections.push(`## Suggestions (non-blocking, consider but not required)\n${suggestionList}`);
  }

  // Priority 3: convergenceLog trend
  if (ctx.convergenceLog && ctx.convergenceLog.length > 0) {
    const latest = ctx.convergenceLog[ctx.convergenceLog.length - 1];
    const trendDesc = latest.classification === 'approved'
      ? 'Progress is improving — reviewer approved.'
      : latest.shouldTerminate
        ? 'Progress is converging — termination recommended.'
        : 'Progress is ongoing — unresolved issues remain.';
    sections.push(`## Convergence Trend\n${trendDesc} (${latest.blockingIssueCount} blocking in round ${latest.round})`);
  }

  // Strategy instructions based on task type (FR-003a)
  sections.push(getStrategyInstructions(effectiveType));

  // Priority 4: round info
  sections.push(`## Round Info\nRound ${ctx.round} of ${ctx.maxRounds}`);

  let prompt = sections.join('\n\n');

  // Enforce length limit (AC-014)
  prompt = enforceMaxLength(prompt);

  // Write audit log (AC-015 / FR-003c)
  if (audit) {
    const summary = prompt.length > MAX_AUDIT_SUMMARY
      ? prompt.slice(0, MAX_AUDIT_SUMMARY)
      : prompt;
    const entry: GodAuditEntry = {
      seq: audit.seq,
      timestamp: new Date().toISOString(),
      round: ctx.round,
      decisionType: 'PROMPT_GENERATION',
      inputSummary: `taskType=${ctx.taskType}, round=${ctx.round}/${ctx.maxRounds}`,
      outputSummary: summary,
      decision: { promptType: 'coder', taskType: ctx.taskType, effectiveType },
    };
    appendAuditLog(audit.sessionDir, entry);
  }

  return prompt;
}

/**
 * Generate a Reviewer prompt for the current round.
 */
export function generateReviewerPrompt(ctx: {
  taskType: string;
  round: number;
  maxRounds: number;
  taskGoal: string;
  lastCoderOutput?: string;
  phaseId?: string;
  phaseType?: 'explore' | 'code' | 'discuss' | 'review' | 'debug';
  instruction?: string;
}): string {
  // For compound type, use phaseType to determine effective review focus (FR-003a)
  const effectiveType = ctx.taskType === 'compound' && ctx.phaseType
    ? ctx.phaseType
    : ctx.taskType;

  const sections: string[] = [];

  // Card D.2: Worker role declaration (FR-009, FR-010 — Reviewer as observation provider)
  sections.push(`## Your Role
You are a review observation provider. Your verdict ([APPROVED] or [CHANGES_REQUESTED]) is informational.
God decides the final outcome — God may accept, override, or request further work regardless of your verdict.
Focus on thorough, honest review. Your observations help God make the best decision.`);

  sections.push(`## Task\n${ctx.taskGoal}`);

  // Phase info for compound type
  if (ctx.taskType === 'compound' && ctx.phaseId) {
    sections.push(`## Current Phase\nPhase: ${ctx.phaseId} (type: ${ctx.phaseType ?? 'unknown'})`);
  }

  // Priority 0: God auto-decision / user interrupt instruction (highest priority)
  if (ctx.instruction) {
    sections.push(`## God Instruction (HIGHEST PRIORITY)\n${ctx.instruction}`);
  }

  if (ctx.lastCoderOutput) {
    sections.push(`## Coder Output (Round ${ctx.round})\n${ctx.lastCoderOutput}`);
  }

  // Phase-aware review instructions
  if (effectiveType === 'explore') {
    sections.push(`## Review Instructions
- Review the Coder's exploration output against the task requirements.
- Verify findings are thorough and recommendations are well-supported.
- Check that no files were modified — exploration should be read-only.
- Identify gaps in analysis or missing areas of investigation.
- State Blocking count explicitly.
- End with [APPROVED] or [CHANGES_REQUESTED].`);
  } else if (effectiveType === 'review') {
    // Bug 11 fix: proposal/plan review — validate proposals, not code
    sections.push(`## Review Instructions
- Evaluate whether the Coder's proposals are reasonable and aligned with the task requirements.
- Verify the proposals address the user's stated priorities.
- Consider whether any critical requirement was overlooked — but proposals need not be perfect to be approved.
- APPROVE if the proposals are sound and directionally correct. Minor disagreements about priority ordering or approach details are non-blocking.
- Only mark as Blocking if a proposal fundamentally misunderstands the task, ignores a user-specified requirement, or proposes something technically infeasible.
- State Blocking count explicitly.
- End with [APPROVED] or [CHANGES_REQUESTED].`);
  } else {
    sections.push(`## Review Instructions
- Review the Coder's output against the task requirements.
- Identify blocking issues (bugs, logic errors, missing requirements, security issues).
- Identify non-blocking suggestions (style, naming, minor improvements).
- State Blocking count explicitly.
- End with [APPROVED] or [CHANGES_REQUESTED].`);
  }

  // Anti-nitpick guardrail (aligned with session template)
  sections.push(`## Verdict Rules
- If there are ZERO blocking issues, you MUST use [APPROVED] — do not withhold approval for non-blocking suggestions.
- Approve when the work meets the task requirements. Do not block on style or preferences.`);

  sections.push(`## Round Info\nRound ${ctx.round} of ${ctx.maxRounds}`);

  return enforceMaxLength(sections.join('\n\n'));
}

/**
 * Generate a God decision prompt for routing decisions at POST_CODER/POST_REVIEWER/CONVERGENCE.
 */
export function generateGodDecisionPrompt(ctx: GodDecisionContext): string {
  const sections: string[] = [];

  sections.push(`## Decision Point: ${ctx.decisionPoint}`);
  sections.push(`## Task\n${ctx.taskGoal}`);
  sections.push(`## Round Info\nRound ${ctx.round} of ${ctx.maxRounds}`);

  if (ctx.phases && ctx.phases.length > 0 && ctx.currentPhaseId) {
    const phaseList = ctx.phases
      .map((phase) => `${phase.id === ctx.currentPhaseId ? '->' : '  '} ${phase.id} (${phase.type}): ${phase.name} - ${phase.description}`)
      .join('\n');
    sections.push(
      `## Compound Task Phases\nCurrent: ${ctx.currentPhaseId} (${ctx.currentPhaseType ?? 'unknown'})\n\n${phaseList}`,
    );
  }

  if (ctx.lastCoderOutput) {
    sections.push(`## Last Coder Output\n${ctx.lastCoderOutput}`);
  }

  if (ctx.lastReviewerOutput) {
    sections.push(`## Last Reviewer Output\n${ctx.lastReviewerOutput}`);
  }

  if (ctx.unresolvedIssues && ctx.unresolvedIssues.length > 0) {
    sections.push(`## Unresolved Issues\n${ctx.unresolvedIssues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}`);
  }

  if (ctx.convergenceLog && ctx.convergenceLog.length > 0) {
    const log = ctx.convergenceLog
      .map(e => `Round ${e.round}: ${e.blockingIssueCount} blocking issues (${e.classification})`)
      .join('\n');
    sections.push(`## Convergence Log\n${log}`);
  }

  return enforceMaxLength(sections.join('\n\n'));
}

// ── Internal helpers ──

function enforceMaxLength(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) return prompt;
  return prompt.slice(0, MAX_PROMPT_LENGTH - 3) + '...';
}
