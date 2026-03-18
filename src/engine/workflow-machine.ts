/**
 * WorkflowMachine — xstate v5 state machine for Duo's Observe → Decide → Act loop.
 * Simplified: no TASK_INIT, no INTERRUPTED, no circuit breaker, no phases.
 *
 * Topology:
 *   IDLE → GOD_DECIDING → EXECUTING → CODING/REVIEWING/CLARIFYING/DONE
 *   CODING → OBSERVING → GOD_DECIDING → ...
 *   REVIEWING → OBSERVING → GOD_DECIDING → ...
 */

import { setup, assign } from 'xstate';
import type { Observation } from '../types/observation.js';
import type { GodDecisionEnvelope } from '../types/god-envelope.js';

export interface WorkflowContext {
  taskPrompt: string | null;
  activeProcess: 'coder' | 'reviewer' | null;
  lastError: string | null;
  lastCoderOutput: string | null;
  lastReviewerOutput: string | null;
  sessionId: string | null;
  currentObservations: Observation[];
  lastDecision: GodDecisionEnvelope | null;
}

// ── Event types ──

type StartTaskEvent = { type: 'START_TASK'; prompt: string };
type CodeCompleteEvent = { type: 'CODE_COMPLETE'; output: string };
type ReviewCompleteEvent = { type: 'REVIEW_COMPLETE'; output: string };
type UserConfirmEvent = { type: 'USER_CONFIRM'; action: 'continue' | 'accept' };
type ProcessErrorEvent = { type: 'PROCESS_ERROR'; error: string };
type TimeoutEvent = { type: 'TIMEOUT' };
type ResumeSessionEvent = { type: 'RESUME_SESSION'; sessionId: string };
type RecoveryEvent = { type: 'RECOVERY' };
type RestoredToCodingEvent = { type: 'RESTORED_TO_CODING' };
type RestoredToReviewingEvent = { type: 'RESTORED_TO_REVIEWING' };
type RestoredToWaitingEvent = { type: 'RESTORED_TO_WAITING' };
type RestoredToClarifyingEvent = { type: 'RESTORED_TO_CLARIFYING' };
type PauseRequiredEvent = { type: 'PAUSE_REQUIRED' };
type ObservationsReadyEvent = { type: 'OBSERVATIONS_READY'; observations: Observation[] };
type DecisionReadyEvent = { type: 'DECISION_READY'; envelope: GodDecisionEnvelope };
type ExecutionCompleteEvent = { type: 'EXECUTION_COMPLETE'; results: Observation[] };

export type WorkflowEvent =
  | StartTaskEvent
  | CodeCompleteEvent
  | ReviewCompleteEvent
  | UserConfirmEvent
  | ProcessErrorEvent
  | TimeoutEvent
  | ResumeSessionEvent
  | RecoveryEvent
  | RestoredToCodingEvent
  | RestoredToReviewingEvent
  | RestoredToWaitingEvent
  | RestoredToClarifyingEvent
  | PauseRequiredEvent
  | ObservationsReadyEvent
  | DecisionReadyEvent
  | ExecutionCompleteEvent;

// ── Helper: determine next state after EXECUTING ──

function resolvePostExecutionTarget(
  envelope: GodDecisionEnvelope | null,
): string {
  if (!envelope || envelope.actions.length === 0) return 'GOD_DECIDING';

  for (const action of envelope.actions) {
    if (action.type === 'accept_task') return 'DONE';
    if (action.type === 'request_user_input') return 'CLARIFYING';
    if (action.type === 'send_to_coder') return 'CODING';
    if (action.type === 'send_to_reviewer') return 'REVIEWING';
  }

  // wait → re-enter GOD_DECIDING
  return 'GOD_DECIDING';
}

// ── Routing conflict detection ──

const ROUTING_ACTION_TYPES = new Set([
  'accept_task',
  'request_user_input',
  'send_to_coder',
  'send_to_reviewer',
]);

export function detectRoutingConflicts(
  envelope: GodDecisionEnvelope | null,
): string[] {
  if (!envelope || envelope.actions.length === 0) return [];

  const routingActions = envelope.actions
    .filter(a => ROUTING_ACTION_TYPES.has(a.type))
    .map(a => a.type);

  return routingActions.length > 1 ? routingActions : [];
}

// ── State Machine ──

export const workflowMachine = setup({
  types: {
    context: {} as WorkflowContext,
    events: {} as WorkflowEvent,
    input: {} as Partial<WorkflowContext> | undefined,
  },
  guards: {
    confirmContinue: ({ event }) =>
      (event as UserConfirmEvent).action === 'continue',
    confirmAccept: ({ event }) =>
      (event as UserConfirmEvent).action === 'accept',
    executionTargetCoding: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision) === 'CODING',
    executionTargetReviewing: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision) === 'REVIEWING',
    executionTargetDone: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision) === 'DONE',
    executionTargetClarifying: ({ context }) =>
      resolvePostExecutionTarget(context.lastDecision) === 'CLARIFYING',
  },
}).createMachine({
  id: 'workflow',
  initial: 'IDLE',
  context: ({ input }) => ({
    taskPrompt: input?.taskPrompt ?? null,
    activeProcess: input?.activeProcess ?? null,
    lastError: input?.lastError ?? null,
    lastCoderOutput: input?.lastCoderOutput ?? null,
    lastReviewerOutput: input?.lastReviewerOutput ?? null,
    sessionId: input?.sessionId ?? null,
    currentObservations: input?.currentObservations ?? [],
    lastDecision: input?.lastDecision ?? null,
  }),
  states: {
    IDLE: {
      on: {
        START_TASK: {
          target: 'GOD_DECIDING',
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

    CODING: {
      on: {
        CODE_COMPLETE: {
          target: 'OBSERVING',
          actions: assign({
            lastCoderOutput: ({ event }) => (event as CodeCompleteEvent).output,
            activeProcess: () => null,
            currentObservations: () => [] as Observation[],
          }),
        },
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
      },
    },

    REVIEWING: {
      on: {
        REVIEW_COMPLETE: {
          target: 'OBSERVING',
          actions: assign({
            lastReviewerOutput: ({ event }) => (event as ReviewCompleteEvent).output,
            activeProcess: () => null,
            currentObservations: () => [] as Observation[],
          }),
        },
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
      },
    },

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

    GOD_DECIDING: {
      on: {
        DECISION_READY: {
          target: 'EXECUTING',
          actions: assign({
            lastDecision: ({ event }) => (event as DecisionReadyEvent).envelope,
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

    EXECUTING: {
      on: {
        EXECUTION_COMPLETE: [
          {
            guard: 'executionTargetCoding',
            target: 'CODING',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => 'coder' as const,
            }),
          },
          {
            guard: 'executionTargetReviewing',
            target: 'REVIEWING',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => 'reviewer' as const,
            }),
          },
          {
            guard: 'executionTargetDone',
            target: 'DONE',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
            }),
          },
          {
            guard: 'executionTargetClarifying',
            target: 'CLARIFYING',
            actions: assign({
              currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,
              activeProcess: () => null,
            }),
          },
          {
            // Default: re-enter GOD_DECIDING (wait action, etc.)
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

    CLARIFYING: {
      on: {
        OBSERVATIONS_READY: {
          target: 'GOD_DECIDING',
          actions: assign({
            currentObservations: ({ event }) => (event as ObservationsReadyEvent).observations,
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
          },
          {
            guard: 'confirmAccept',
            target: 'DONE',
          },
          {
            target: 'DONE',
          },
        ],
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
        },
      },
    },
  },
});
