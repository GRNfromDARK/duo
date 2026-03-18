/**
 * WorkflowMachine tests — adapted for Card D.1 Observe → Decide → Act topology.
 *
 * Old states removed: ROUTING_POST_CODE, ROUTING_POST_REVIEW, EVALUATING
 * New flow: CODING → OBSERVING → GOD_DECIDING → EXECUTING → CODING/REVIEWING/DONE
 */
import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import {
  workflowMachine,
  type WorkflowContext,
} from '../../engine/workflow-machine.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';

/** Helper: create an actor and start it */
function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
}

/** Helper: send START_TASK and skip TASK_INIT */
function sendStartAndSkipInit(actor: ReturnType<typeof startActor>, prompt: string) {
  actor.send({ type: 'START_TASK', prompt });
  actor.send({ type: 'TASK_INIT_COMPLETE' });
}

function makeObs(type: Observation['type'] = 'work_output', source: Observation['source'] = 'coder'): Observation {
  return { source, type, summary: `test ${type}`, severity: 'info', timestamp: new Date().toISOString()};
}

function makeEnvelope(actions: GodDecisionEnvelope['actions'] = []): GodDecisionEnvelope {
  return {
    diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions,
    messages: [{ target: 'system_log', content: 'log' }],
  };
}

/** Helper: advance from CODING through full Observe→Decide→Act cycle */
function advanceFromCoding(
  actor: ReturnType<typeof startActor>,
  actions: GodDecisionEnvelope['actions'],
) {
  actor.send({ type: 'CODE_COMPLETE', output: 'done' });
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
  actor.send({ type: 'DECISION_READY', envelope: makeEnvelope(actions) });
  actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
}

describe('WorkflowMachine', () => {
  describe('AC-1: definition correctness', () => {
    it('should start in IDLE state', () => {
      const actor = startActor();
      expect(actor.getSnapshot().value).toBe('IDLE');
      actor.stop();
    });

    it('should have correct initial context', () => {
      const actor = startActor();
      const ctx = actor.getSnapshot().context;
      expect(ctx.consecutiveRouteToCoder).toBe(0);
      expect(ctx.activeProcess).toBeNull();
      expect(ctx.lastError).toBeNull();
      expect(ctx.currentObservations).toEqual([]);
      expect(ctx.lastDecision).toBeNull();
      expect(ctx.incidentCount).toBe(0);
      actor.stop();
    });

    // maxRounds test removed (round removal).
  });

  describe('AC-2: normal flow (Observe → Decide → Act)', () => {
    it('IDLE → TASK_INIT → CODING on START_TASK + TASK_INIT_COMPLETE', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'build feature X' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');
      actor.send({ type: 'TASK_INIT_COMPLETE' });
      expect(actor.getSnapshot().value).toBe('CODING');
      expect(actor.getSnapshot().context.taskPrompt).toBe('build feature X');
      actor.stop();
    });

    it('CODING → OBSERVING on CODE_COMPLETE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'CODE_COMPLETE', output: 'done coding' });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      actor.stop();
    });

    it('OBSERVING → GOD_DECIDING on OBSERVATIONS_READY', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });

    it('GOD_DECIDING → EXECUTING on DECISION_READY', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'review' }]) });
      expect(actor.getSnapshot().value).toBe('EXECUTING');
      actor.stop();
    });

    it('EXECUTING → REVIEWING on send_to_reviewer', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      expect(actor.getSnapshot().value).toBe('REVIEWING');
      actor.stop();
    });

    it('REVIEWING → OBSERVING on REVIEW_COMPLETE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({ type: 'REVIEW_COMPLETE', output: 'looks good' });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      actor.stop();
    });

    it('GOD_DECIDING → DONE via accept_task', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done' }]);
      expect(actor.getSnapshot().value).toBe('DONE');
      actor.stop();
    });

    it('full loop: code → review → iterate → accept', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'build it' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });

      // Round 0: code → review
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      expect(actor.getSnapshot().value).toBe('REVIEWING');

      // Review → iterate back to coder
      actor.send({ type: 'REVIEW_COMPLETE', output: 'needs fix' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'fix' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('CODING');

      // Round 1: accept
      advanceFromCoding(actor, [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done' }]);
      expect(actor.getSnapshot().value).toBe('DONE');
      actor.stop();
    });

    it('GOD_DECIDING → PAUSED on PAUSE_REQUIRED', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      actor.send({ type: 'PAUSE_REQUIRED' });
      expect(actor.getSnapshot().value).toBe('PAUSED');
      actor.stop();
    });
  });

  describe('AC-3: serialization roundtrip', () => {
    it('should serialize and restore state correctly', () => {
      const actor1 = startActor();
      sendStartAndSkipInit(actor1, 'serialize test');
      actor1.send({ type: 'CODE_COMPLETE', output: 'v1' });

      const snapshot = actor1.getPersistedSnapshot();
      actor1.stop();

      const actor2 = createActor(workflowMachine, { snapshot, input: {} });
      actor2.start();

      expect(actor2.getSnapshot().value).toBe('OBSERVING');
      expect(actor2.getSnapshot().context.taskPrompt).toBe('serialize test');

      actor2.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      expect(actor2.getSnapshot().value).toBe('GOD_DECIDING');
      actor2.stop();
    });

    it('should preserve context through serialization', () => {
      const actor1 = startActor({});
      sendStartAndSkipInit(actor1, 'ctx test');
      // Go through one full cycle
      advanceFromCoding(actor1, [{ type: 'send_to_coder', message: 'iterate' }]);

      const snapshot = actor1.getPersistedSnapshot();
      actor1.stop();

      const actor2 = createActor(workflowMachine, { snapshot, input: {} });
      actor2.start();

      expect(actor2.getSnapshot().context.taskPrompt).toBe('ctx test');
      expect(actor2.getSnapshot().value).toBe('CODING');
      actor2.stop();
    });
  });

  describe('AC-4: concurrency safety', () => {
    it('should track active process: set in CODING, clear on CODE_COMPLETE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      expect(actor.getSnapshot().context.activeProcess).toBe('coder');

      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      actor.stop();
    });

    it('should track active process: set in REVIEWING, clear on REVIEW_COMPLETE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      expect(actor.getSnapshot().context.activeProcess).toBe('reviewer');

      actor.send({ type: 'REVIEW_COMPLETE', output: 'ok' });
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      actor.stop();
    });

    it('should not allow START_TASK when already in CODING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'first');
      actor.send({ type: 'START_TASK', prompt: 'second' });
      expect(actor.getSnapshot().value).toBe('CODING');
      expect(actor.getSnapshot().context.taskPrompt).toBe('first');
      actor.stop();
    });

    it('activeProcess is null in OBSERVING/GOD_DECIDING/EXECUTING states', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      expect(actor.getSnapshot().value).toBe('OBSERVING');

      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });
  });

  describe('AC-5: exception paths', () => {
    it('CODING → ERROR on PROCESS_ERROR', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'PROCESS_ERROR', error: 'crash' });
      expect(actor.getSnapshot().value).toBe('ERROR');
      expect(actor.getSnapshot().context.lastError).toBe('crash');
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      actor.stop();
    });

    it('CODING → ERROR on TIMEOUT', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'TIMEOUT' });
      expect(actor.getSnapshot().value).toBe('ERROR');
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      actor.stop();
    });

    it('REVIEWING → ERROR on PROCESS_ERROR', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({ type: 'PROCESS_ERROR', error: 'reviewer crash' });
      expect(actor.getSnapshot().value).toBe('ERROR');
      expect(actor.getSnapshot().context.lastError).toBe('reviewer crash');
      actor.stop();
    });

    it('REVIEWING → ERROR on TIMEOUT', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({ type: 'TIMEOUT' });
      expect(actor.getSnapshot().value).toBe('ERROR');
      actor.stop();
    });

    it('ERROR → GOD_DECIDING on RECOVERY', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'PROCESS_ERROR', error: 'crash' });
      actor.send({ type: 'RECOVERY' });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });

    // Card E.1: adapted — interrupts go through INCIDENT_DETECTED → OBSERVING, not USER_INTERRUPT → INTERRUPTED
    it('CODING + INCIDENT_DETECTED → OBSERVING (replaces USER_INTERRUPT → INTERRUPTED)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      actor.stop();
    });

    it('REVIEWING + INCIDENT_DETECTED → OBSERVING (replaces USER_INTERRUPT → INTERRUPTED)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      actor.stop();
    });

    // Card E.2: adapted — request_user_input now routes to CLARIFYING, user input via OBSERVATIONS_READY
    it('CLARIFYING + OBSERVATIONS_READY → GOD_DECIDING (replaces USER_INPUT direct resume)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      // Get to CLARIFYING via God request_user_input
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'what?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });
  });

  describe('session resumption', () => {
    it('IDLE → RESUMING on RESUME_SESSION', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      expect(actor.getSnapshot().value).toBe('RESUMING');
      actor.stop();
    });

    it('RESUMING → CODING on RESTORED_TO_CODING', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      actor.send({ type: 'RESTORED_TO_CODING' });
      expect(actor.getSnapshot().value).toBe('CODING');
      actor.stop();
    });

    it('RESUMING → REVIEWING on RESTORED_TO_REVIEWING', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      actor.send({ type: 'RESTORED_TO_REVIEWING' });
      expect(actor.getSnapshot().value).toBe('REVIEWING');
      actor.stop();
    });

    it('RESUMING → GOD_DECIDING on RESTORED_TO_WAITING', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      actor.send({ type: 'RESTORED_TO_WAITING' });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });
  });

  describe('AC-A2: TASK_INIT state', () => {
    it('IDLE → TASK_INIT on START_TASK', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'build feature X' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');
      expect(actor.getSnapshot().context.taskPrompt).toBe('build feature X');
      actor.stop();
    });

    it('TASK_INIT → CODING on TASK_INIT_COMPLETE', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });
      expect(actor.getSnapshot().value).toBe('CODING');
      expect(actor.getSnapshot().context.activeProcess).toBe('coder');
      actor.stop();
    });

    it('TASK_INIT → CODING on TASK_INIT_COMPLETE', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });
      expect(actor.getSnapshot().value).toBe('CODING');
      expect(actor.getSnapshot().context.activeProcess).toBe('coder');
      actor.stop();
    });

    // maxRounds tests removed (round removal).

    it('full flow through TASK_INIT: IDLE → TASK_INIT → CODING → OBSERVING', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'build it' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');

      actor.send({ type: 'TASK_INIT_COMPLETE'});
      expect(actor.getSnapshot().value).toBe('CODING');

      actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      actor.stop();
    });

    it('TASK_INIT ignores invalid events', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');

      actor.send({ type: 'CODE_COMPLETE', output: 'bogus' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');

      actor.send({ type: 'REVIEW_COMPLETE', output: 'bogus' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');
      actor.stop();
    });
  });

  // ──────────────────────────────────────────────
  // Card E.1: Interrupt → Observation normalization (state machine)
  // ──────────────────────────────────────────────
  describe('E.1: interrupt observation normalization', () => {
    it('CODING should NOT transition on USER_INTERRUPT (stays in CODING)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'USER_INTERRUPT' });
      // E.1: USER_INTERRUPT removed from CODING — interrupts go through INCIDENT_DETECTED
      expect(actor.getSnapshot().value).toBe('CODING');
      actor.stop();
    });

    it('REVIEWING should NOT transition on USER_INTERRUPT (stays in REVIEWING)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({ type: 'USER_INTERRUPT' });
      // E.1: USER_INTERRUPT removed from REVIEWING
      expect(actor.getSnapshot().value).toBe('REVIEWING');
      actor.stop();
    });

    it('CODING + INCIDENT_DETECTED with human_interrupt → OBSERVING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({
        type: 'INCIDENT_DETECTED',
        observation: makeObs('human_interrupt', 'human'),
      });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      actor.stop();
    });

    it('REVIEWING + INCIDENT_DETECTED with human_message → OBSERVING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({
        type: 'INCIDENT_DETECTED',
        observation: makeObs('human_message', 'human'),
      });
      expect(actor.getSnapshot().value).toBe('OBSERVING');
      actor.stop();
    });

    // Card E.2: request_user_input now routes to CLARIFYING
    it('CLARIFYING + OBSERVATIONS_READY → GOD_DECIDING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      // Get to CLARIFYING via God request_user_input
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'what should I do?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');

      // User input as observation routes to GOD_DECIDING
      actor.send({
        type: 'OBSERVATIONS_READY',
        observations: [makeObs('clarification_answer', 'human')],
      });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });

    it('CLARIFYING + OBSERVATIONS_READY should store observations in context', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'details?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');

      const obs = makeObs('clarification_answer', 'human');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [obs] });

      expect(actor.getSnapshot().context.currentObservations).toHaveLength(1);
      expect(actor.getSnapshot().context.currentObservations[0].type).toBe('clarification_answer');
      actor.stop();
    });

    it('CLARIFYING should NOT handle USER_INPUT (no direct resume)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'what?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');

      // USER_INPUT should be ignored — user input goes through observation pipeline
      actor.send({ type: 'USER_INPUT', input: 'continue', resumeAs: 'coder' });
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      actor.stop();
    });
  });

  describe('invalid transitions', () => {
    it('should ignore CODE_COMPLETE when not in CODING', () => {
      const actor = startActor();
      actor.send({ type: 'CODE_COMPLETE', output: 'bogus' });
      expect(actor.getSnapshot().value).toBe('IDLE');
      actor.stop();
    });

    it('should ignore REVIEW_COMPLETE when not in REVIEWING', () => {
      const actor = startActor();
      actor.send({ type: 'REVIEW_COMPLETE', output: 'bogus' });
      expect(actor.getSnapshot().value).toBe('IDLE');
      actor.stop();
    });

    it('should ignore OBSERVATIONS_READY when not in OBSERVING', () => {
      const actor = startActor();
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      expect(actor.getSnapshot().value).toBe('IDLE');
      actor.stop();
    });

    it('should ignore DECISION_READY when not in GOD_DECIDING', () => {
      const actor = startActor();
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope() });
      expect(actor.getSnapshot().value).toBe('IDLE');
      actor.stop();
    });
  });

  // ── Regression: INTERRUPTED state deadlock (P1 bug) ──
  describe('regression: INTERRUPTED state accepts OBSERVATIONS_READY', () => {
    it('INTERRUPTED + OBSERVATIONS_READY → GOD_DECIDING (not deadlocked)', () => {
      const actor = startActor();
      // Get to INTERRUPTED via RESUMING → RESTORED_TO_INTERRUPTED
      actor.send({ type: 'RESUME_SESSION', sessionId: 'sess-1' });
      actor.send({ type: 'RESTORED_TO_INTERRUPTED' });
      expect(actor.getSnapshot().value).toBe('INTERRUPTED');

      // User input as observation should transition to GOD_DECIDING
      actor.send({
        type: 'OBSERVATIONS_READY',
        observations: [makeObs('clarification_answer', 'human')],
      });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });

    it('INTERRUPTED stores observations in context on OBSERVATIONS_READY', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'sess-1' });
      actor.send({ type: 'RESTORED_TO_INTERRUPTED' });

      const obs = makeObs('clarification_answer', 'human');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [obs] });

      expect(actor.getSnapshot().context.currentObservations).toEqual([obs]);
      actor.stop();
    });

    it('USER_INPUT is silently dropped in INTERRUPTED (no transition)', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'sess-1' });
      actor.send({ type: 'RESTORED_TO_INTERRUPTED' });

      // USER_INPUT should NOT cause a transition — this confirms the bug existed
      actor.send({ type: 'USER_INPUT', input: 'hello', resumeAs: 'coder' });
      expect(actor.getSnapshot().value).toBe('INTERRUPTED');
      actor.stop();
    });
  });
});
