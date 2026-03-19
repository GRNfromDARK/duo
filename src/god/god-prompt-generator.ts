/**
 * God Prompt Generator — dynamic prompt generation for Coder/Reviewer.
 * Simplified: dispatchType replaces taskType/phaseType, no phases, no blocking extraction.
 */

import type { GodAuditEntry } from './god-audit.js';
import { appendAuditLog } from './god-audit.js';

// ── Types ──

export interface PromptContext {
  dispatchType: 'explore' | 'code' | 'debug' | 'discuss';
  taskGoal: string;
  lastReviewerOutput?: string;
  lastCoderOutput?: string;
  /** God's routing instruction (highest priority) */
  instruction?: string;
}

export interface AuditOptions {
  sessionDir: string;
  seq: number;
}

export interface ConvergenceLogEntry {
  timestamp: string;
  classification: string;
  shouldTerminate: boolean;
  blockingIssueCount: number;
  criteriaProgress: { criterion: string; satisfied: boolean }[];
  summary: string;
}

// ── Strategy templates by dispatchType ──

const EXPLORE_INSTRUCTIONS = `## Instructions
- Analyze the codebase and provide findings, recommendations, and suggestions.
- Investigate the relevant files and explore possible approaches.
- Do NOT modify any files. Do NOT execute any code changes.
- Recommend solutions but do not apply them.`;

const CODE_INSTRUCTIONS = `## Instructions
- Implement the required changes following clean code principles.
- Write robust, correct code with appropriate error handling.
- Write tests for new functionality.
- Build working solutions, not explanations.
- Do not ask questions. Decide autonomously and develop directly.`;

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

function getStrategyInstructions(dispatchType: string): string {
  switch (dispatchType) {
    case 'explore': return EXPLORE_INSTRUCTIONS;
    case 'code': return CODE_INSTRUCTIONS;
    case 'debug': return DEBUG_INSTRUCTIONS;
    case 'discuss': return DISCUSS_INSTRUCTIONS;
    default: return CODE_INSTRUCTIONS;
  }
}

// ── Prompt generators ──

export function generateCoderPrompt(ctx: PromptContext, audit?: AuditOptions): string {
  const sections: string[] = [];

  sections.push(`## Your Role
You are an executor. You carry out work as instructed.
You do NOT have accept authority — you cannot accept or complete the task.
Focus on producing high-quality work output. Do not make management decisions.
LANGUAGE: Always respond in the same language as the user's task description.`);

  sections.push(`## Task\n${ctx.taskGoal}`);

  if (ctx.instruction) {
    sections.push(`## God Instruction (HIGHEST PRIORITY)\n${ctx.instruction}`);
  }

  if (ctx.lastReviewerOutput) {
    sections.push(
      `## Reviewer Feedback\n` +
      `The following is the Reviewer's original analysis. ` +
      `Read it carefully — it contains specific findings, code references, and root cause analysis.\n\n` +
      ctx.lastReviewerOutput
    );
  }

  sections.push(getStrategyInstructions(ctx.dispatchType));

  const prompt = sections.join('\n\n');

  if (audit) {
    const entry: GodAuditEntry = {
      seq: audit.seq,
      timestamp: new Date().toISOString(),
      decisionType: 'PROMPT_GENERATION',
      inputSummary: `dispatchType=${ctx.dispatchType}`,
      outputSummary: prompt,
      decision: { promptType: 'coder', dispatchType: ctx.dispatchType },
    };
    appendAuditLog(audit.sessionDir, entry);
  }

  return prompt;
}

export function generateReviewerPrompt(ctx: {
  taskGoal: string;
  lastCoderOutput?: string;
  instruction?: string;
}): string {
  const sections: string[] = [];

  sections.push(`## Your Role
You are a review observation provider. Your verdict ([APPROVED] or [CHANGES_REQUESTED]) is informational.
God decides the final outcome — God may accept, override, or request further work regardless of your verdict.
Focus on thorough, honest review. Your observations help God make the best decision.
LANGUAGE: Always respond in the same language as the user's task description.`);

  sections.push(`## Task\n${ctx.taskGoal}`);

  if (ctx.instruction) {
    sections.push(`## God Instruction (HIGHEST PRIORITY)\n${ctx.instruction}`);
  }

  if (ctx.lastCoderOutput) {
    sections.push(`## Coder Output\n${ctx.lastCoderOutput}`);
  }

  sections.push(`## Review Instructions
- Review the Coder's output against the task requirements.
- Identify blocking issues (bugs, logic errors, missing requirements, security issues).
- Identify non-blocking suggestions (style, naming, minor improvements).
- State Blocking count explicitly.
- End with [APPROVED] or [CHANGES_REQUESTED].`);

  sections.push(`## Verdict Rules
- If there are ZERO blocking issues, you MUST use [APPROVED] — do not withhold approval for non-blocking suggestions.
- Approve when the work meets the task requirements. Do not block on style or preferences.`);

  return sections.join('\n\n');
}
