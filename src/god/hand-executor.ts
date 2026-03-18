/**
 * Hand Executor — executes GodAction[] sequentially and returns result Observations.
 * Simplified to 5 actions: send_to_coder, send_to_reviewer, accept_task, wait, request_user_input.
 */

import type { GodAction } from '../types/god-actions.js';
import type { Observation } from '../types/observation.js';
import type { GodAuditLogger } from './god-audit.js';

// ── Types ──

export interface HandExecutionContext {
  pendingCoderMessage: string | null;
  pendingCoderDispatchType: string | null;
  pendingReviewerMessage: string | null;
  auditLogger: GodAuditLogger | null;
  taskCompleted: boolean;
  waitState: { active: boolean; reason: string | null; estimatedSeconds: number | null };
  clarificationState: { active: boolean; question: string | null };
  sessionDir: string;
  cwd: string;
}

// ── Helpers ──

function makeTimestamp(): string {
  return new Date().toISOString();
}

function makeResultObservation(summary: string): Observation {
  return {
    source: 'runtime',
    type: 'phase_progress_signal',
    summary,
    severity: 'info',
    timestamp: makeTimestamp(),
  };
}

// ── Individual Action Executors ──

function executeSendToCoder(
  action: Extract<GodAction, { type: 'send_to_coder' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.pendingCoderMessage = action.message;
  ctx.pendingCoderDispatchType = action.dispatchType;
  return makeResultObservation(`send_to_coder(${action.dispatchType}): queued message for coder`);
}

function executeSendToReviewer(
  action: Extract<GodAction, { type: 'send_to_reviewer' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.pendingReviewerMessage = action.message;
  return makeResultObservation(`send_to_reviewer: queued message for reviewer`);
}

function executeAcceptTask(
  action: Extract<GodAction, { type: 'accept_task' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.taskCompleted = true;

  ctx.auditLogger?.append({
    timestamp: makeTimestamp(),
    decisionType: 'accept_task',
    inputSummary: 'Task accepted',
    outputSummary: `Task accepted: ${action.summary}`,
    decision: { summary: action.summary },
  });

  return makeResultObservation(`accept_task: ${action.summary}`);
}

function executeWait(
  action: Extract<GodAction, { type: 'wait' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.waitState = {
    active: true,
    reason: action.reason,
    estimatedSeconds: action.estimatedSeconds ?? null,
  };
  return makeResultObservation(`wait: ${action.reason}`);
}

function executeRequestUserInput(
  action: Extract<GodAction, { type: 'request_user_input' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.clarificationState = {
    active: true,
    question: action.question,
  };
  return makeResultObservation(`request_user_input: ${action.question}`);
}

// ── Dispatcher ──

function executeSingleAction(
  action: GodAction,
  ctx: HandExecutionContext,
): Observation {
  switch (action.type) {
    case 'send_to_coder':
      return executeSendToCoder(action, ctx);
    case 'send_to_reviewer':
      return executeSendToReviewer(action, ctx);
    case 'accept_task':
      return executeAcceptTask(action, ctx);
    case 'wait':
      return executeWait(action, ctx);
    case 'request_user_input':
      return executeRequestUserInput(action, ctx);
  }
}

// ── Main Entry Point ──

/**
 * Execute a list of GodActions sequentially, returning result Observations.
 * No rule engine — actions execute directly.
 */
export async function executeActions(
  actions: GodAction[],
  context: HandExecutionContext,
): Promise<Observation[]> {
  const results: Observation[] = [];

  for (const action of actions) {
    try {
      const obs = executeSingleAction(action, context);
      results.push(obs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        source: 'runtime',
        type: 'runtime_error',
        summary: `${action.type} failed: ${message}`,
        severity: 'error',
        timestamp: makeTimestamp(),
      });
    }
  }

  return results;
}
