/**
 * WorkflowMachine — xstate v5 state machine for Duo's Observe → Decide → Act loop.
 * Source: FR-003 (Runtime Core Loop), FR-004
 * Card: D.1 — State machine refactor
 *
 * Topology:
 *   IDLE → TASK_INIT → CODING → OBSERVING → GOD_DECIDING → EXECUTING → ...
 *   REVIEWING → OBSERVING → GOD_DECIDING → EXECUTING → ...
 *
 * Removed states (Card D.1):
 *   ROUTING_POST_CODE, ROUTING_POST_REVIEW, EVALUATING
 *
 * New states:
 *   OBSERVING — collects observations after coder/reviewer output or incident
 *   EXECUTING — Hand executor runs GodActions, produces result observations
 *
 * Strict serial execution (1 LLM process at a time).
 * Supports serialization/deserialization for session recovery.
 */

import { setup, assign } from 'xstate';
import type { Observation } from '../types/observation.js';
import type { GodDecisionEnvelope } from '../types/god-envelope.js';

export interface WorkflowContext {
  consecutiveRouteToCoder: number;
  taskPrompt: string | null;
  activeProcess: 'coder' | 'reviewer' | null;
  lastError: string | null;
  lastCoderOutput: string | null;
  lastReviewerOutput: string | null;
  sessionId: string | null;
  pendingPhaseId: string | null;
  pendingPhaseSummary: string | null;
  // Card D.1: new fields for Observe → Decide → Act loop
  currentObservations: Observation[];
  lastDecision: GodDecisionEnvelope | null;
  incidentCount: number;
  // Card E.2: clarification state
  frozenActiveProcess: 'coder' | 'reviewer' | null;
  clarificationRound: number;
  clarificationObservations: Observation[];
}

// ── Event types ──

type StartTaskEvent = { type: 'START_TASK'; prompt: string };
type CodeCompleteEvent = { type: 'CODE_COMPLETE'; output: string };
type ReviewCompleteEvent = { type: 'REVIEW_COMPLETE'; output: string };
type UserInterruptEvent = { type: 'USER_INTERRUPT' };
type UserInputEvent = { type: 'USER_INPUT'; input: string; resumeAs: 'coder' | 'reviewer' | 'decision' };
type UserConfirmEvent = { type: 'USER_CONFIRM'; action: 'continue' | 'accept' };
type ProcessErrorEvent = { type: 'PROCESS_ERROR'; error: string };
type TimeoutEvent = { type: 'TIMEOUT' };
type TaskInitCompleteEvent = { type: 'TASK_INIT_COMPLETE' };
// TASK_INIT_SKIP removed — God is always required in v2 architecture
type ResumeSessionEvent = { type: 'RESUME_SESSION'; sessionId: string };
type RecoveryEvent = { type: 'RECOVERY' };
type RestoredToCodingEvent = { type: 'RESTORED_TO_CODING' };
type RestoredToReviewingEvent = { type: 'RESTORED_TO_REVIEWING' };
type RestoredToWaitingEvent = { type: 'RESTORED_TO_WAITING' };
type RestoredToInterruptedEvent = { type: 'RESTORED_TO_INTERRUPTED' };
// Card E.2: resume into CLARIFYING state
type RestoredToClarifyingEvent = { type: 'RESTORED_TO_CLARIFYING' };
type ClearPendingPhaseEvent = { type: 'CLEAR_PENDING_PHASE' };
type PauseRequiredEvent = { type: 'PAUSE_REQUIRED' };
// Card D.1: new events for Observe → Decide → Act loop
type ObservationsReadyEvent = { type: 'OBSERVATIONS_READY'; observations: Observation[] };
type DecisionReadyEvent = { type: 'DECISION_READY'; envelope: GodDecisionEnvelope };
type ExecutionCompleteEvent = { type: 'EXECUTION_COMPLETE'; results: Observation[] };
type IncidentDetectedEvent = { type: 'INCIDENT_DETECTED'; observation: Observation };

export type WorkflowEvent =
  | StartTaskEvent
  | TaskInitCompleteEvent
  | CodeCompleteEvent
  | ReviewCompleteEvent
  | UserInterruptEvent
  | UserInputEvent
  | UserConfirmEvent
  | ProcessErrorEvent
  | TimeoutEvent
  | ResumeSessionEvent
  | RecoveryEvent
  | RestoredToCodingEvent
  | RestoredToReviewingEvent
  | RestoredToWaitingEvent
  | RestoredToInterruptedEvent
  | RestoredToClarifyingEvent
  | ClearPendingPhaseEvent
  | PauseRequiredEvent
  | ObservationsReadyEvent
  | DecisionReadyEvent
  | ExecutionCompleteEvent
  | IncidentDetectedEvent;

// ── Helper: determine next state after EXECUTING based on decision actions ──
// Card E.2: accepts optional context for resume_after_interrupt(continue) routing

function resolvePostExecutionTarget(
  envelope: GodDecisionEnvelope | null,
  ctx?: { frozenActiveProcess?: 'coder' | 'reviewer' | null },
): string {
  if (!envelope || envelope.actions.length === 0) return 'GOD_DECIDING';

  for (const action of envelope.actions) {
    if (action.type === 'accept_task') return 'DONE';
    // Card E.2: request_user_input → CLARIFYING (was INTERRUPTED)
    if (action.type === 'request_user_input') return 'CLARIFYING';
    if (action.type === 'send_to_coder') return 'CODING';
    if (action.type === 'send_to_reviewer') return 'REVIEWING';
    if (action.type === 'retry_role') {
      return action.role === 'reviewer' ? 'REVIEWING' : 'CODING';
    }
    // Card E.2: resume_after_interrupt with strategy-based routing
    if (action.type === 'resume_after_interrupt') {
      if (action.resumeStrategy === 'stop') return 'DONE';
      if (action.resumeStrategy === 'redirect') return 'GOD_DECIDING';
      if (action.resumeStrategy === 'continue') {
        return ctx?.frozenActiveProcess === 'reviewer' ? 'REVIEWING' : 'CODING';
      }
    }
  }

  // wait, emit_summary, stop_role, switch_adapter, set_phase
  // → re-enter GOD_DECIDING for next evaluation
  return 'GOD_DECIDING';
}

// ── BUG-12 fix: detect conflicting routing actions in an envelope ──

const ROUTING_ACTION_TYPES = new Set([
  'accept_task',
  'request_user_input',
  'send_to_coder',
  'send_to_reviewer',
  'retry_role',
  'resume_after_interrupt',
]);

/**
 * Detect multiple routing actions in an envelope's actions array.
 * Returns the list of conflicting routing action types if more than one is found.
 * Returns empty array if no conflict.
 */
export function detectRoutingConflicts(
  envelope: GodDecisionEnvelope | null,
): string[] {
  if (!envelope || envelope.actions.length === 0) return [];

  const routingActions = envelope.actions
    .filter(a => ROUTING_ACTION_TYPES.has(a.type))
    .map(a => a.type);

  return routingActions.length > 1 ? routingActions : [];
}

export const workflowMachine = setup({
  types: {
    context: {} as WorkflowContext,
    events: {} as WorkflowEvent,
    input: {} as Partial<WorkflowContext> | undefined,
  },
  guards: {
    resumeAsCoder: ({ event }) =>
      (event as UserInputEvent).resumeAs === 'coder',
    resumeAsReviewer: ({ event }) =>
      (event as UserInputEvent).resumeAs === 'reviewer',
    resumeAsDecision: ({ event }) =>
      (event as UserInputEvent).resumeAs === 'decision',
    confirmContinue: ({ event }) =>
      (event as UserConfirmEvent).action === 'continue',
    confirmAccept: ({ event }) =>
      (event as UserConfirmEvent).action === 'accept',
    // Card D.1: post-execution target guards (E.2: pass context for resume routing)
    // Circuit breaker: prevent infinite coder loops (Bug 1 fix)
    circuitBreakerTripped: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision, context) === 'CODING' &&
      context.consecutiveRouteToCoder + 1 >= 3,
    executionTargetCoding: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision, context) === 'CODING',
    executionTargetReviewing: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision, context) === 'REVIEWING',
    executionTargetDone: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision, context) === 'DONE',
    // Card E.2: CLARIFYING replaces INTERRUPTED as target for request_user_input
    executionTargetClarifying: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision, context) === 'CLARIFYING',
  },
}).createMachine({
  id: 'workflow',
  initial: 'IDLE',
  context: ({ input }) => ({
    consecutiveRouteToCoder: input?.consecutiveRouteToCoder ?? 0,
    taskPrompt: input?.taskPrompt ?? null,
    activeProcess: input?.activeProcess ?? null,
    lastError: input?.lastError ?? null,
    lastCoderOutput: input?.lastCoderOutput ?? null,
    lastReviewerOutput: input?.lastReviewerOutput ?? null,
    sessionId: input?.sessionId ?? null,
    pendingPhaseId: input?.pendingPhaseId ?? null,
    pendingPhaseSummary: input?.pendingPhaseSummary ?? null,
    currentObservations: input?.currentObservations ?? [],
    lastDecision: input?.lastDecision ?? null,
    incidentCount: input?.incidentCount ?? 0,
    // Card E.2
    frozenActiveProcess: input?.frozenActiveProcess ?? null,
    clarificationRound: input?.clarificationRound ?? 0,
    clarificationObservations: input?.clarificationObservations ?? [],
  }),
  states: {
    IDLE: {
      on: {
        START_TASK: {
          target: 'TASK_INIT',
          actions: assign({
            taskPrompt: ({ event }) => (event as StartTaskEvent).prompt,
          }),
        },
        RESUME_SESSION: {
          target: 'RESUMING',
          actions: assign({
            sessionId: ({ event }) => (event as ResumeSessionEvent).sessionId,
          }),
        },
      },
    },

    TASK_INIT: {
      on: {
        TASK_INIT_COMPLETE: {
          target: 'CODING',
          actions: assign({
            activeProcess: () => 'coder' as const,
            consecutiveRouteToCoder: () => 0,
          }),
        },
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
          }),
        },
      },
    },

    CODING: {
      on: {
        CODE_COMPLETE: {
          target: 'OBSERVING',
          actions: assign({
            lastCoderOutput: ({ event }) => (event as CodeCompleteEvent).output,
            activeProcess: () => null,
            // Bug 5 fix: clear stale observations so OBSERVING classifies fresh coder output
            currentObservations: () => [] as Observation[],
          }),
        },
        // Card E.1: USER_INTERRUPT removed — interrupts go through INCIDENT_DETECTED → OBSERVING → GOD_DECIDING
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
            activeProcess: () => null,
          }),
        },
        TIMEOUT: {
          target: 'ERROR',
          actions: assign({
            lastError: () => 'Process timed out',
            activeProcess: () => null,
          }),
        },
        INCIDENT_DETECTED: {
          target: 'OBSERVING',
          actions: assign({
            // Card E.2: save active process before clearing for resume after clarification
            frozenActiveProcess: ({ context }) => context.activeProcess,
            activeProcess: () => null,
            incidentCount: ({ context }) => context.incidentCount + 1,
            currentObservations: ({ event }) => [(event as IncidentDetectedEvent).observation],
          }),
        },
      },
    },

    REVIEWING: {
      on: {
        REVIEW_COMPLETE: {
          target: 'OBSERVING',
          actions: assign({
            lastReviewerOutput: ({ event }) => (event as ReviewCompleteEvent).output,
            activeProcess: () => null,
            // Bug 5 fix: clear stale observations so OBSERVING classifies fresh reviewer output
            currentObservations: () => [] as Observation[],
          }),
        },
        // Card E.1: USER_INTERRUPT removed — interrupts go through INCIDENT_DETECTED → OBSERVING → GOD_DECIDING
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
            activeProcess: () => null,
          }),
        },
        TIMEOUT: {
          target: 'ERROR',
          actions: assign({
            lastError: () => 'Process timed out',
            activeProcess: () => null,
          }),
        },
        INCIDENT_DETECTED: {
          target: 'OBSERVING',
          actions: assign({
            // Card E.2: save active process before clearing for resume after clarification
            frozenActiveProcess: ({ context }) => context.activeProcess,
            activeProcess: () => null,
            incidentCount: ({ context }) => context.incidentCount + 1,
            currentObservations: ({ event }) => [(event as IncidentDetectedEvent).observation],
          }),
        },
      },
    },

    // Card D.1: OBSERVING — collects observations, classifies, sends to GOD_DECIDING
    OBSERVING: {
      on: {
        OBSERVATIONS_READY: {
          target: 'GOD_DECIDING',
          actions: assign({
            currentObservations: ({ event }) => (event as ObservationsReadyEvent).observations,
          }),
        },
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
          }),
        },
      },
    },

    // Card D.1: GOD_DECIDING — calls unified God decision service, waits for envelope
    GOD_DECIDING: {
      on: {
        DECISION_READY: {
          target: 'EXECUTING',
          actions: assign({
            lastDecision: ({ event }) => (event as DecisionReadyEvent).envelope,
          }),
        },
        CLEAR_PENDING_PHASE: {
          actions: assign({
            pendingPhaseId: () => null,
            pendingPhaseSummary: () => null,
          }),
        },
        PAUSE_REQUIRED: {
          target: 'PAUSED',
        },
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
          }),
        },
      },
    },

    // Card D.1: EXECUTING — Hand executor runs GodActions, results flow back
    EXECUTING: {
      on: {
        EXECUTION_COMPLETE: [
          {
            // Bug 1 fix: circuit breaker — 3+ consecutive route-to-coder → PAUSED
            guard: 'circuitBreakerTripped',
            target: 'PAUSED',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => null,
              lastError: () => 'Circuit breaker: too many consecutive route-to-coder decisions (3+). Manual intervention required.',
            }),
          },
          {
            guard: 'executionTargetCoding',
            target: 'CODING',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => 'coder' as const,
              // Bug 1 fix: INCREMENT counter instead of resetting
              consecutiveRouteToCoder: ({ context }) => context.consecutiveRouteToCoder + 1,
              // Card E.2: clear clarification state on resume to work
              frozenActiveProcess: () => null,
              clarificationRound: () => 0,
              clarificationObservations: () => [] as Observation[],
            }),
          },
          {
            guard: 'executionTargetReviewing',
            target: 'REVIEWING',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => 'reviewer' as const,
              // Bug 1 fix: reset circuit breaker when routing to reviewer (breaks the coder loop)
              consecutiveRouteToCoder: () => 0,
              // Card E.2: clear clarification state on resume to work
              frozenActiveProcess: () => null,
              clarificationRound: () => 0,
              clarificationObservations: () => [] as Observation[],
            }),
          },
          {
            guard: 'executionTargetDone',
            target: 'DONE',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              // Card E.2: clear clarification state
              frozenActiveProcess: () => null,
              clarificationRound: () => 0,
              clarificationObservations: () => [] as Observation[],
            }),
          },
          {
            // Card E.2: CLARIFYING replaces INTERRUPTED for request_user_input
            guard: 'executionTargetClarifying',
            target: 'CLARIFYING',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => null,
              clarificationRound: ({ context }) => context.clarificationRound + 1,
            }),
          },
          {
            // Default: re-enter GOD_DECIDING (wait, no actions, etc.)
            // BUG-22 fix: preserve existing observations when execution produces no new results,
            // preventing the death spiral where fallback → empty results → lost observations.
            target: 'GOD_DECIDING',
            actions: assign({
              currentObservations: ({ context, event }) => {
                const results = (event as ExecutionCompleteEvent).results;
                return results.length > 0 ? results : context.currentObservations;
              },
            }),
          },
        ],
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
          }),
        },
      },
    },

    PAUSED: {
      on: {
        USER_CONFIRM: [
          {
            guard: 'confirmContinue',
            target: 'GOD_DECIDING',
            actions: assign({
              consecutiveRouteToCoder: () => 0,
            }),
          },
          {
            guard: 'confirmAccept',
            target: 'DONE',
            actions: assign({
              consecutiveRouteToCoder: () => 0,
            }),
          },
          {
            target: 'DONE',
          },
        ],
      },
    },

    // Card E.1: INTERRUPTED kept for backward compat (session resume via RESTORED_TO_INTERRUPTED).
    INTERRUPTED: {
      on: {
        OBSERVATIONS_READY: {
          target: 'GOD_DECIDING',
          actions: assign({
            currentObservations: ({ event }) => (event as ObservationsReadyEvent).observations,
          }),
        },
      },
    },

    // Card E.2: CLARIFYING — God-mediated multi-turn clarification with human.
    // Entry: EXECUTING with request_user_input action.
    // Loop: human answers → OBSERVATIONS_READY → GOD_DECIDING → God asks again or resumes.
    // Exit: God issues resume_after_interrupt → back to CODING/REVIEWING/DONE.
    CLARIFYING: {
      on: {
        OBSERVATIONS_READY: {
          target: 'GOD_DECIDING',
          actions: assign({
            currentObservations: ({ event }) => (event as ObservationsReadyEvent).observations,
            // Accumulate clarification observations for context preservation (AC-6)
            clarificationObservations: ({ context, event }) => [
              ...context.clarificationObservations,
              ...(event as ObservationsReadyEvent).observations,
            ],
          }),
        },
      },
    },

    RESUMING: {
      on: {
        RESTORED_TO_CODING: {
          target: 'CODING',
          actions: assign({
            activeProcess: () => 'coder' as const,
          }),
        },
        RESTORED_TO_REVIEWING: {
          target: 'REVIEWING',
          actions: assign({
            activeProcess: () => 'reviewer' as const,
          }),
        },
        RESTORED_TO_WAITING: {
          target: 'GOD_DECIDING',
        },
        RESTORED_TO_INTERRUPTED: {
          target: 'INTERRUPTED',
        },
        // Card E.2: resume into CLARIFYING state
        RESTORED_TO_CLARIFYING: {
          target: 'CLARIFYING',
        },
        PROCESS_ERROR: {
          target: 'ERROR',
          actions: assign({
            lastError: ({ event }) => (event as ProcessErrorEvent).error,
            activeProcess: () => null,
          }),
        },
      },
    },

    DONE: {
      type: 'final',
    },

    ERROR: {
      on: {
        RECOVERY: {
          target: 'GOD_DECIDING',
          actions: assign({
            consecutiveRouteToCoder: () => 0,
          }),
        },
      },
    },
  },
});
