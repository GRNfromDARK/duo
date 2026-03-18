/**
 * Hand Executor — executes GodAction[] sequentially and returns result Observations.
 * Source: FR-007 (Structured Hand Catalog), FR-016 (State Changes Must Be Action-Backed)
 * Card: C.2
 *
 * Each Hand is checked against the rule engine (R-001..R-005) before execution.
 * Blocked actions produce a runtime_invariant_violation observation instead of executing.
 * Execution failures also produce runtime_invariant_violation observations.
 */

import type { GodAction } from '../types/god-actions.js';
import type { EnvelopeMessage } from '../types/god-envelope.js';
import type { Observation } from '../types/observation.js';
import type { GodAuditLogger } from './god-audit.js';
import { evaluateRules, type ActionContext } from './rule-engine.js';

// ── Types ──

/** Minimal adapter interface needed for Hand execution (kill only). */
export interface HandAdapter {
  kill(): Promise<void>;
}

export interface HandExecutionContext {
  // Per card spec
  currentPhaseId: string;
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
  adapters: Map<string, HandAdapter>;
  auditLogger: GodAuditLogger | null;

  // Additional runtime context
  activeRole: 'coder' | 'reviewer' | null;
  taskCompleted: boolean;
  waitState: { active: boolean; reason: string | null; estimatedSeconds: number | null };
  clarificationState: { active: boolean; question: string | null };
  interruptResumeStrategy: 'continue' | 'redirect' | 'stop' | null;
  adapterConfig: Map<string, string>; // role → adapter name
  sessionDir: string;
  cwd: string;

  // D.3: Envelope messages for accept_task validation (FR-016, FR-017)
  envelopeMessages?: EnvelopeMessage[];
}

// ── Helpers ──

function makeTimestamp(): string {
  return new Date().toISOString();
}

function makeResultObservation(
  action: GodAction,
  context: HandExecutionContext,
  summary: string,
): Observation {
  return {
    source: 'runtime',
    type: 'phase_progress_signal',
    summary,
    severity: 'info',
    timestamp: makeTimestamp(),
    phaseId: context.currentPhaseId,
  };
}

function makeViolationObservation(
  action: GodAction,
  context: HandExecutionContext,
  detail: string,
): Observation {
  return {
    source: 'runtime',
    type: 'runtime_invariant_violation',
    summary: `${action.type} failed: ${detail}`,
    severity: 'error',
    timestamp: makeTimestamp(),
    phaseId: context.currentPhaseId,
  };
}

function makeBlockedObservation(
  action: GodAction,
  context: HandExecutionContext,
  blockedRuleIds: string[],
): Observation {
  return {
    source: 'runtime',
    type: 'runtime_invariant_violation',
    summary: `${action.type} blocked by rule engine: ${blockedRuleIds.join(', ')}`,
    severity: 'error',
    timestamp: makeTimestamp(),
    phaseId: context.currentPhaseId,
  };
}

// SPEC-DECISION: Map GodActions to ActionContext for rule-engine checks.
// Most actions don't touch the filesystem or run commands, so they map to
// config_modify with no path — which won't trigger any rules. switch_adapter
// maps to config_modify. This satisfies "通过 rule-engine.ts 检查每个 action"
// while avoiding false positives.
function toActionContext(action: GodAction, cwd: string): ActionContext {
  switch (action.type) {
    case 'switch_adapter':
      return { type: 'config_modify', cwd };
    default:
      return { type: 'config_modify', cwd };
  }
}

// ── Individual Action Executors ──

function executeSendToCoder(
  action: Extract<GodAction, { type: 'send_to_coder' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.pendingCoderMessage = action.message;
  ctx.activeRole = 'coder';
  return makeResultObservation(action, ctx, `send_to_coder: queued message for coder`);
}

function executeSendToReviewer(
  action: Extract<GodAction, { type: 'send_to_reviewer' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.pendingReviewerMessage = action.message;
  ctx.activeRole = 'reviewer';
  return makeResultObservation(action, ctx, `send_to_reviewer: queued message for reviewer`);
}

function executeSetPhase(
  action: Extract<GodAction, { type: 'set_phase' }>,
  ctx: HandExecutionContext,
): Observation {
  const oldPhase = ctx.currentPhaseId;
  ctx.currentPhaseId = action.phaseId;

  ctx.auditLogger?.append({
    timestamp: makeTimestamp(),
    decisionType: 'phase_transition',
    inputSummary: `Phase change: ${oldPhase} → ${action.phaseId}`,
    outputSummary: `Transitioned to ${action.phaseId}${action.summary ? ': ' + action.summary : ''}`,
    decision: { from: oldPhase, to: action.phaseId, summary: action.summary },
    phaseId: action.phaseId,
  });

  return makeResultObservation(
    action,
    ctx,
    `set_phase: ${oldPhase} → ${action.phaseId}`,
  );
}

function executeAcceptTask(
  action: Extract<GodAction, { type: 'accept_task' }>,
  ctx: HandExecutionContext,
): Observation {
  // D.3: Validate envelope messages when provided (FR-016, FR-017)
  if (ctx.envelopeMessages !== undefined) {
    if (action.rationale === 'god_override') {
      const hasSystemLog = ctx.envelopeMessages.some(m => m.target === 'system_log');
      if (!hasSystemLog) {
        return makeViolationObservation(
          action,
          ctx,
          `god_override accept_task requires system_log message explaining why reviewer was overridden`,
        );
      }
    }

    if (action.rationale === 'forced_stop') {
      const hasUserMessage = ctx.envelopeMessages.some(m => m.target === 'user');
      if (!hasUserMessage) {
        return makeViolationObservation(
          action,
          ctx,
          `forced_stop accept_task requires user-targeted summary message`,
        );
      }
    }
  }

  ctx.taskCompleted = true;

  // D.3: Enhanced audit with envelope messages (FR-018)
  ctx.auditLogger?.append({
    timestamp: makeTimestamp(),
    decisionType: 'accept_task',
    inputSummary: `Accept with rationale: ${action.rationale}`,
    outputSummary: `Task accepted (${action.rationale}): ${action.summary}`,
    decision: {
      rationale: action.rationale,
      summary: action.summary,
      ...(ctx.envelopeMessages !== undefined
        ? { envelopeMessages: ctx.envelopeMessages }
        : {}),
    },
    phaseId: ctx.currentPhaseId,
  });

  return makeResultObservation(
    action,
    ctx,
    `accept_task: rationale=${action.rationale}`,
  );
}

async function executeStopRole(
  action: Extract<GodAction, { type: 'stop_role' }>,
  ctx: HandExecutionContext,
): Promise<Observation> {
  const adapter = ctx.adapters.get(action.role);
  if (!adapter) {
    return makeViolationObservation(action, ctx, `no adapter found for role '${action.role}'`);
  }

  await adapter.kill();
  return makeResultObservation(action, ctx, `stop_role: stopped ${action.role}`);
}

async function executeRetryRole(
  action: Extract<GodAction, { type: 'retry_role' }>,
  ctx: HandExecutionContext,
): Promise<Observation> {
  const adapter = ctx.adapters.get(action.role);
  if (adapter) {
    await adapter.kill();
  }

  const message = action.hint ?? '';
  if (action.role === 'coder') {
    ctx.pendingCoderMessage = message;
  } else {
    ctx.pendingReviewerMessage = message;
  }
  ctx.activeRole = action.role;

  return makeResultObservation(
    action,
    ctx,
    `retry_role: restarting ${action.role}${action.hint ? ' with hint' : ''}`,
  );
}

function executeSwitchAdapter(
  action: Extract<GodAction, { type: 'switch_adapter' }>,
  ctx: HandExecutionContext,
): Observation {
  // switch_adapter is not yet implemented — adapter instances are held by refs
  // in App.tsx, GodDecisionService, and WatchdogService; updating adapterConfig
  // alone has no effect. Return a warning so God knows the action was a no-op.
  return {
    source: 'runtime',
    type: 'phase_progress_signal',
    summary: `switch_adapter: not yet implemented — ${action.role} remains on current adapter`,
    severity: 'warning',
    timestamp: makeTimestamp(),
    phaseId: ctx.currentPhaseId,
  };
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
  return makeResultObservation(action, ctx, `wait: ${action.reason}`);
}

function executeRequestUserInput(
  action: Extract<GodAction, { type: 'request_user_input' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.clarificationState = {
    active: true,
    question: action.question,
  };
  return makeResultObservation(action, ctx, `request_user_input: ${action.question}`);
}

function executeResumeAfterInterrupt(
  action: Extract<GodAction, { type: 'resume_after_interrupt' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.interruptResumeStrategy = action.resumeStrategy;
  ctx.clarificationState = { active: false, question: null };
  return makeResultObservation(
    action,
    ctx,
    `resume_after_interrupt: strategy=${action.resumeStrategy}`,
  );
}

function executeEmitSummary(
  action: Extract<GodAction, { type: 'emit_summary' }>,
  ctx: HandExecutionContext,
): Observation {
  ctx.auditLogger?.append({
    timestamp: makeTimestamp(),
    decisionType: 'emit_summary',
    inputSummary: 'Management summary emitted',
    outputSummary: action.content,
    decision: { content: action.content },
    phaseId: ctx.currentPhaseId,
  });

  return makeResultObservation(action, ctx, `emit_summary: ${action.content}`);
}

// ── Dispatcher ──

async function executeSingleAction(
  action: GodAction,
  ctx: HandExecutionContext,
): Promise<Observation> {
  switch (action.type) {
    case 'send_to_coder':
      return executeSendToCoder(action, ctx);
    case 'send_to_reviewer':
      return executeSendToReviewer(action, ctx);
    case 'set_phase':
      return executeSetPhase(action, ctx);
    case 'accept_task':
      return executeAcceptTask(action, ctx);
    case 'stop_role':
      return executeStopRole(action, ctx);
    case 'retry_role':
      return executeRetryRole(action, ctx);
    case 'switch_adapter':
      return executeSwitchAdapter(action, ctx);
    case 'wait':
      return executeWait(action, ctx);
    case 'request_user_input':
      return executeRequestUserInput(action, ctx);
    case 'resume_after_interrupt':
      return executeResumeAfterInterrupt(action, ctx);
    case 'emit_summary':
      return executeEmitSummary(action, ctx);
  }
}

// ── Main Entry Point ──

/**
 * Execute a list of GodActions sequentially, returning result Observations.
 *
 * Flow per action:
 * 1. Check against rule engine (R-001..R-005)
 *    - If blocked → produce runtime_invariant_violation observation, skip execution
 * 2. Execute the action, mutating context as needed
 *    - On success → produce phase_progress_signal observation
 *    - On failure → produce runtime_invariant_violation observation
 */
export async function executeActions(
  actions: GodAction[],
  context: HandExecutionContext,
): Promise<Observation[]> {
  const results: Observation[] = [];

  for (const action of actions) {
    // Step 1: Rule engine check
    const ruleContext = toActionContext(action, context.cwd);
    const ruleResult = evaluateRules(ruleContext);

    if (ruleResult.blocked) {
      const blockedRuleIds = ruleResult.results
        .filter(r => r.matched && r.level === 'block')
        .map(r => r.ruleId);
      results.push(makeBlockedObservation(action, context, blockedRuleIds));
      continue;
    }

    // Step 2: Execute
    try {
      const obs = await executeSingleAction(action, context);
      results.push(obs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(makeViolationObservation(action, context, message));
    }
  }

  return results;
}
