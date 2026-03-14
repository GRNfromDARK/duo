/**
 * God Router — output analysis & routing for PostCoder/PostReviewer decisions.
 * Source: FR-004 (AC-016, AC-017, AC-018, AC-018a, AC-018b)
 *
 * God analyzes Coder/Reviewer output and decides next routing action.
 * Maps God actions to XState events.
 * AI-REVIEW: 路由决策仅通过结构化 GodPostCoderDecision/GodPostReviewerDecision 驱动，不从自然语言推断状态变化 (FR-003 AC-009)。
 */

import type { GodAdapter } from '../types/god-adapter.js';
import type { GodPostCoderDecision, GodPostReviewerDecision } from '../types/god-schemas.js';
import { GodPostCoderDecisionSchema, GodPostReviewerDecisionSchema } from '../types/god-schemas.js';
import { extractWithRetry } from '../parsers/god-json-extractor.js';
import { generateGodDecisionPrompt, type GodDecisionContext, type ConvergenceLogEntry } from './god-prompt-generator.js';
import { appendAuditLog, type GodAuditEntry } from './god-audit.js';
import { checkConsistency } from './consistency-checker.js';
// Card D.1: DeprecatedRoutingEvent no longer includes old routing events (ROUTE_TO_REVIEW, etc.)
// This module is deprecated — routing now flows through GodDecisionService + OBSERVING pipeline.
// Using 'any' for backward compatibility with existing tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeprecatedRoutingEvent = any;
import { collectGodAdapterOutput } from './god-call.js';

// ── Types ──

export interface RoutingContext {
  round: number;
  maxRounds: number;
  taskGoal: string;
  sessionDir: string;
  seq: number;
  convergenceLog?: ConvergenceLogEntry[];
  unresolvedIssues?: string[];
  projectDir?: string;
}

export interface PostCoderRoutingResult {
  event: DeprecatedRoutingEvent;
  decision: GodPostCoderDecision;
  rawOutput: string;
}

export interface PostReviewerRoutingResult {
  event: DeprecatedRoutingEvent;
  decision: GodPostReviewerDecision;
  rawOutput: string;
}

// ── Default fallbacks ──

const DEFAULT_POST_CODER: GodPostCoderDecision = {
  action: 'continue_to_review',
  reasoning: 'Fallback: defaulting to review (God extraction failed)',
};

function defaultPostReviewer(reviewerOutput: string): GodPostReviewerDecision {
  return {
    action: 'route_to_coder',
    reasoning: 'Fallback: defaulting to route_to_coder (God extraction failed)',
    unresolvedIssues: ['Review the previous output and address any remaining issues'],
    confidenceScore: 0.5,
    progressTrend: 'stagnant',
  };
}

// ── God action → XState event mapping ──

export function godActionToEvent(
  decision: GodPostCoderDecision | GodPostReviewerDecision,
): DeprecatedRoutingEvent {
  switch (decision.action) {
    case 'continue_to_review':
      return { type: 'ROUTE_TO_REVIEW' };
    case 'retry_coder':
      return { type: 'ROUTE_TO_CODER' };
    case 'route_to_coder':
      return { type: 'ROUTE_TO_CODER' };
    case 'converged':
      return { type: 'CONVERGED' };
    case 'phase_transition': {
      const d = decision as GodPostReviewerDecision;
      return {
        type: 'PHASE_TRANSITION',
        nextPhaseId: d.nextPhaseId ?? 'next',
        summary: d.reasoning ?? '',
      };
    }
    case 'loop_detected':
      return { type: 'LOOP_DETECTED' };
    default:
      throw new Error(`Unknown God action: ${(decision as Record<string, unknown>).action}`);
  }
}

const GOD_TIMEOUT_MS = 30_000;
// ── ROUTING_POST_CODE ──

/**
 * Route after Coder output. God analyzes Coder output and decides next step.
 * AC-018a: converged is impossible here (enforced by schema).
 * Falls back to continue_to_review if extraction fails.
 */
export async function routePostCoder(
  godAdapter: GodAdapter,
  coderOutput: string,
  context: RoutingContext,
): Promise<PostCoderRoutingResult> {
  const godPrompt = generateGodDecisionPrompt({
    decisionPoint: 'POST_CODER',
    round: context.round,
    maxRounds: context.maxRounds,
    taskGoal: context.taskGoal,
    lastCoderOutput: coderOutput,
    convergenceLog: context.convergenceLog,
  });

  const systemPrompt = buildRoutingSystemPrompt('POST_CODER');
  const rawOutput = await collectGodAdapterOutput({
    adapter: godAdapter,
    prompt: godPrompt,
    systemPrompt,
    projectDir: context.projectDir,
    timeoutMs: GOD_TIMEOUT_MS,
    logging: {
      sessionDir: context.sessionDir,
      round: context.round,
      kind: 'god_post_coder',
      meta: { attempt: 1 },
    },
  });

  const result = await extractWithRetry(
    rawOutput,
    GodPostCoderDecisionSchema,
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
          kind: 'god_post_coder',
          meta: { attempt: 2, retryReason: 'schema_validation' },
        },
      });
    },
  );

  let decision: GodPostCoderDecision;
  if (!result || !result.success) {
    decision = DEFAULT_POST_CODER;
  } else {
    decision = result.data;
  }

  const effectiveRawOutput = (result && result.success && result.sourceOutput) ? result.sourceOutput : rawOutput;
  const event = godActionToEvent(decision);

  // AC-6: Write audit log
  writeRoutingAudit(context, 'ROUTING_POST_CODE', decision, effectiveRawOutput, coderOutput);

  return { event, decision, rawOutput: effectiveRawOutput };
}

// ── ROUTING_POST_REVIEW ──

/**
 * Route after Reviewer output. God analyzes Reviewer output and decides next step.
 * AC-018b: route_to_coder must carry non-empty unresolvedIssues (runtime enforcement).
 * Falls back to route_to_coder if extraction fails.
 */
export async function routePostReviewer(
  godAdapter: GodAdapter,
  reviewerOutput: string,
  context: RoutingContext,
): Promise<PostReviewerRoutingResult> {
  const godPrompt = generateGodDecisionPrompt({
    decisionPoint: 'POST_REVIEWER',
    round: context.round,
    maxRounds: context.maxRounds,
    taskGoal: context.taskGoal,
    lastReviewerOutput: reviewerOutput,
    unresolvedIssues: context.unresolvedIssues,
    convergenceLog: context.convergenceLog,
  });

  const systemPrompt = buildRoutingSystemPrompt('POST_REVIEWER');
  const rawOutput = await collectGodAdapterOutput({
    adapter: godAdapter,
    prompt: godPrompt,
    systemPrompt,
    projectDir: context.projectDir,
    timeoutMs: GOD_TIMEOUT_MS,
    logging: {
      sessionDir: context.sessionDir,
      round: context.round,
      kind: 'god_post_reviewer',
      meta: { attempt: 1 },
    },
  });

  const result = await extractWithRetry(
    rawOutput,
    GodPostReviewerDecisionSchema,
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
          kind: 'god_post_reviewer',
          meta: { attempt: 2, retryReason: 'schema_validation' },
        },
      });
    },
  );

  let decision: GodPostReviewerDecision;
  if (!result || !result.success) {
    decision = defaultPostReviewer(reviewerOutput);
  } else {
    decision = result.data;
  }

  const effectiveRawOutput = (result && result.success && result.sourceOutput) ? result.sourceOutput : rawOutput;

  // FR-G02: Run consistency check on God's decision
  const consistency = checkConsistency(decision);
  if (!consistency.valid) {
    writeHallucinationAudit(context, decision, consistency.violations);
    context.seq++;
    // Use auto-corrected decision if available
    if (consistency.corrected) {
      decision = consistency.corrected as GodPostReviewerDecision;
    }
  }

  // AC-018b: Enforce non-empty unresolvedIssues for route_to_coder
  if (decision.action === 'route_to_coder') {
    if (!decision.unresolvedIssues || decision.unresolvedIssues.length === 0) {
      decision = {
        ...decision,
        unresolvedIssues: ['Address remaining issues from reviewer feedback'],
      };
    }
  }

  const event = godActionToEvent(decision);

  // AC-6: Write audit log
  writeRoutingAudit(context, 'ROUTING_POST_REVIEW', decision, effectiveRawOutput, reviewerOutput);

  return { event, decision, rawOutput: effectiveRawOutput };
}

// ── Internal helpers ──

function buildRoutingSystemPrompt(decisionPoint: 'POST_CODER' | 'POST_REVIEWER'): string {
  if (decisionPoint === 'POST_CODER') {
    return `You are the God orchestrator. Analyze the Coder's output and decide the next routing action.
You are fully autonomous and never defer to humans.

Output a JSON code block with your decision:
\`\`\`json
{
  "action": "continue_to_review" | "retry_coder",
  "reasoning": "...",
  "retryHint": "..." // only if action is retry_coder
}
\`\`\`

Actions:
- continue_to_review: Default. Coder produced substantive output, send to Reviewer.
- retry_coder: Coder crashed or produced empty or unusable output.

If the Coder asks a question or proposes options, choose the best direction yourself and continue the flow.`;
  }

  return `You are the God orchestrator. Analyze the Reviewer's output and decide the next routing action.
You are fully autonomous and never defer to humans.

Output a JSON code block with your decision:
\`\`\`json
{
  "action": "route_to_coder" | "converged" | "phase_transition" | "loop_detected",
  "reasoning": "...",
  "unresolvedIssues": ["..."],  // required if action is route_to_coder
  "confidenceScore": 0.0-1.0,
  "progressTrend": "improving" | "stagnant" | "declining",
  "nextPhaseId": "..."  // optional, specify target phase for phase_transition
}
\`\`\`

Actions:
- route_to_coder: Reviewer found blocking issues. MUST include non-empty unresolvedIssues.
- converged: Reviewer approved and all termination criteria are met.
- phase_transition: Current phase criteria met, transition to next phase. Use nextPhaseId to specify the target phase.
- loop_detected: Same issues recurring without progress.

If Coder and Reviewer disagree, you arbitrate and decide the next action yourself.`;
}

function writeHallucinationAudit(
  context: RoutingContext,
  decision: GodPostCoderDecision | GodPostReviewerDecision,
  violations: { type: string; description: string }[],
): void {
  const entry: GodAuditEntry = {
    seq: context.seq,
    timestamp: new Date().toISOString(),
    round: context.round,
    decisionType: 'HALLUCINATION_DETECTED',
    inputSummary: violations.map(v => `[${v.type}] ${v.description}`).join('; '),
    outputSummary: JSON.stringify(decision).slice(0, 500),
    decision: { originalDecision: decision, violations },
  };
  appendAuditLog(context.sessionDir, entry);
}

function writeRoutingAudit(
  context: RoutingContext,
  decisionType: string,
  decision: GodPostCoderDecision | GodPostReviewerDecision,
  rawOutput: string,
  input: string,
): void {
  const entry: GodAuditEntry = {
    seq: context.seq,
    timestamp: new Date().toISOString(),
    round: context.round,
    decisionType,
    inputSummary: input.length > 500 ? input.slice(0, 500) : input,
    outputSummary: rawOutput.length > 500 ? rawOutput.slice(0, 500) : rawOutput,
    decision,
  };
  appendAuditLog(context.sessionDir, entry);
}
