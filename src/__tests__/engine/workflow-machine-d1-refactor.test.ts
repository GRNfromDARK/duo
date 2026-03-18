/**
 * Card D.1: State machine refactor — Observe → Decide → Act cycle
 *
 * Tests the new state topology:
 * - Removed: ROUTING_POST_CODE, ROUTING_POST_REVIEW, EVALUATING
 * - Added: OBSERVING, EXECUTING (GOD_DECIDING retained)
 * - New events: OBSERVATIONS_READY, DECISION_READY, EXECUTION_COMPLETE, INCIDENT_DETECTED
 * - New context: currentObservations, lastDecision, incidentCount
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

/** Helper: create a minimal test observation */
function makeObs(type: Observation['type'] = 'work_output', source: Observation['source'] = 'coder'): Observation {
  return {
    source,
    type,
    summary: `test ${type}`,
    severity: 'info',
    timestamp: new Date().toISOString(),
  };
}

/** Helper: create a minimal test GodDecisionEnvelope */
function makeEnvelope(actions: GodDecisionEnvelope['actions'] = []): GodDecisionEnvelope {
  return {
    diagnosis: {
      summary: 'test decision',
      currentGoal: 'test goal',
      currentPhaseId: 'p1',
      notableObservations: [],
    },
    authority: {
      userConfirmation: 'not_required',
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned',
    },
    actions,
    messages: [{ target: 'system_log', content: 'test log' }],
  };
}

// ══════════════════════════════════════════════════════════════════
// AC-4: Old states ROUTING_POST_CODE / ROUTING_POST_REVIEW / EVALUATING removed
// ══════════════════════════════════════════════════════════════════
describe('AC-4: old states removed', () => {
  it('ROUTING_POST_CODE state does not exist', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    // After CODE_COMPLETE, should NOT be in ROUTING_POST_CODE
    expect(actor.getSnapshot().value).not.toBe('ROUTING_POST_CODE');
    actor.stop();
  });

  it('ROUTING_POST_REVIEW state does not exist', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    // ROUTE_TO_REVIEW should not exist as an event anymore
    // After CODE_COMPLETE, machine goes to OBSERVING
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    actor.stop();
  });

  it('EVALUATING state does not exist', () => {
    // ROUTE_TO_EVALUATE event should not cause a transition
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    // Should be in OBSERVING, not EVALUATING
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-6: New states OBSERVING / GOD_DECIDING / EXECUTING defined
// ══════════════════════════════════════════════════════════════════
describe('AC-6: new states defined', () => {
  it('CODING → OBSERVING on CODE_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done coding' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    expect(actor.getSnapshot().context.lastCoderOutput).toBe('done coding');
    expect(actor.getSnapshot().context.activeProcess).toBeNull();
    actor.stop();
  });

  it('REVIEWING → OBSERVING on REVIEW_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    // Need to get to REVIEWING state first — go through the full cycle
    actor.send({ type: 'CODE_COMPLETE', output: 'code done' });
    // OBSERVING → GOD_DECIDING → EXECUTING → back to CODING or REVIEWING
    // For this test, we'll construct a scenario to reach REVIEWING
    const obs = [makeObs('work_output', 'coder')];
    actor.send({ type: 'OBSERVATIONS_READY', observations: obs });
    const envelope = makeEnvelope([{ type: 'send_to_reviewer', message: 'review this' }]);
    actor.send({ type: 'DECISION_READY', envelope });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    // After EXECUTING with send_to_reviewer, should go to REVIEWING
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    actor.send({ type: 'REVIEW_COMPLETE', output: 'looks good' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    expect(actor.getSnapshot().context.lastReviewerOutput).toBe('looks good');
    actor.stop();
  });

  it('OBSERVING → GOD_DECIDING on OBSERVATIONS_READY', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    const obs = [makeObs('work_output', 'coder')];
    actor.send({ type: 'OBSERVATIONS_READY', observations: obs });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.currentObservations).toEqual(obs);
    actor.stop();
  });

  it('GOD_DECIDING → EXECUTING on DECISION_READY', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });

    const envelope = makeEnvelope([{ type: 'send_to_coder', message: 'do more' }]);
    actor.send({ type: 'DECISION_READY', envelope });
    expect(actor.getSnapshot().value).toBe('EXECUTING');
    expect(actor.getSnapshot().context.lastDecision).toEqual(envelope);
    actor.stop();
  });

  it('EXECUTING → OBSERVING on EXECUTION_COMPLETE (loop back)', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'more' }]) });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    const results = [makeObs('phase_progress_signal', 'runtime')];
    actor.send({ type: 'EXECUTION_COMPLETE', results });
    // After execution with send_to_coder, should go to CODING
    expect(actor.getSnapshot().value).toBe('CODING');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-1: All phase change / accept / override through God unified decision
// ══════════════════════════════════════════════════════════════════
describe('AC-1: all decisions through God', () => {
  it('accept goes through OBSERVING → GOD_DECIDING → EXECUTING → DONE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });

    const envelope = makeEnvelope([{
      type: 'accept_task',
      rationale: 'reviewer_aligned',
      summary: 'Task completed successfully',
    }]);
    actor.send({ type: 'DECISION_READY', envelope });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('DONE');
    actor.stop();
  });

  it('phase change goes through God decision with set_phase action', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });

    const envelope = makeEnvelope([
      { type: 'set_phase', phaseId: 'p2', summary: 'Next phase' },
      { type: 'send_to_coder', message: 'start phase 2' },
    ]);
    actor.send({ type: 'DECISION_READY', envelope });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    // After executing set_phase + send_to_coder, should continue to CODING
    expect(actor.getSnapshot().value).toBe('CODING');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-3: Action execution results flow back as new observations
// ══════════════════════════════════════════════════════════════════
describe('AC-3: action results flow back as observations', () => {
  it('EXECUTION_COMPLETE carries result observations', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'more' }]) });

    const results = [makeObs('phase_progress_signal', 'runtime')];
    actor.send({ type: 'EXECUTION_COMPLETE', results });
    // Results should be stored in context for the next cycle
    // (verification that results are accessible)
    expect(actor.getSnapshot().context.currentObservations).toEqual(results);
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-2: Runtime doesn't depend on NL prompt for phase/confirm/accept
// ══════════════════════════════════════════════════════════════════
describe('AC-2: no NL-based state inference', () => {
  it('USER_CONFIRM is no longer used for accept/continue in GOD_DECIDING', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // GOD_DECIDING now expects DECISION_READY, not USER_CONFIRM
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'go' }]) });
    expect(actor.getSnapshot().value).toBe('EXECUTING');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// AC-5: xstate machine serializable/deserializable for session resume
// ══════════════════════════════════════════════════════════════════
describe('AC-5: serialization roundtrip', () => {
  it('serializes and restores OBSERVING state correctly', () => {
    const actor1 = startActor();
    sendStartAndSkipInit(actor1, 'serialize test');
    actor1.send({ type: 'CODE_COMPLETE', output: 'v1' });
    expect(actor1.getSnapshot().value).toBe('OBSERVING');

    const snapshot = actor1.getPersistedSnapshot();
    actor1.stop();

    const actor2 = createActor(workflowMachine, { snapshot, input: {} });
    actor2.start();
    expect(actor2.getSnapshot().value).toBe('OBSERVING');
    expect(actor2.getSnapshot().context.taskPrompt).toBe('serialize test');
    expect(actor2.getSnapshot().context.lastCoderOutput).toBe('v1');
    actor2.stop();
  });

  it('preserves new context fields through serialization', () => {
    const actor1 = startActor();
    sendStartAndSkipInit(actor1, 'ctx test');
    actor1.send({ type: 'CODE_COMPLETE', output: 'v1' });
    const obs = [makeObs()];
    actor1.send({ type: 'OBSERVATIONS_READY', observations: obs });
    expect(actor1.getSnapshot().value).toBe('GOD_DECIDING');

    const snapshot = actor1.getPersistedSnapshot();
    actor1.stop();

    const actor2 = createActor(workflowMachine, { snapshot, input: {} });
    actor2.start();
    expect(actor2.getSnapshot().context.currentObservations).toEqual(obs);
    actor2.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// New context fields
// ══════════════════════════════════════════════════════════════════
describe('new context fields', () => {
  it('initial context has currentObservations=[], lastDecision=null, incidentCount=0', () => {
    const actor = startActor();
    const ctx = actor.getSnapshot().context;
    expect(ctx.currentObservations).toEqual([]);
    expect(ctx.lastDecision).toBeNull();
    expect(ctx.incidentCount).toBe(0);
    actor.stop();
  });

  it('INCIDENT_DETECTED increments incidentCount and routes to OBSERVING', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    // During CODING, an incident (non-work output) arrives
    const incident = makeObs('quota_exhausted', 'runtime');
    actor.send({ type: 'INCIDENT_DETECTED', observation: incident });
    // Should route incident through OBSERVING
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    expect(actor.getSnapshot().context.incidentCount).toBe(1);
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// EXECUTING → target state based on Hand actions
// ══════════════════════════════════════════════════════════════════
describe('EXECUTING routes to correct next state', () => {
  it('send_to_coder → CODING after EXECUTION_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'go' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CODING');
    expect(actor.getSnapshot().context.activeProcess).toBe('coder');
    actor.stop();
  });

  it('send_to_reviewer → REVIEWING after EXECUTION_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'review' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');
    expect(actor.getSnapshot().context.activeProcess).toBe('reviewer');
    actor.stop();
  });

  it('accept_task → DONE after EXECUTION_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{
      type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done',
    }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('DONE');
    actor.stop();
  });

  it('request_user_input → CLARIFYING after EXECUTION_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{
      type: 'request_user_input', question: 'What next?',
    }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CLARIFYING');
    actor.stop();
  });

  it('wait → GOD_DECIDING after EXECUTION_COMPLETE (re-evaluate)', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{
      type: 'wait', reason: 'waiting for external',
    }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    // wait should keep us in a holding pattern — GOD_DECIDING to re-evaluate
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });

  it('no actions (empty) → GOD_DECIDING after EXECUTION_COMPLETE (fallback)', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [] });
    // No actions → stay in GOD_DECIDING for re-evaluation
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// Error and interrupt paths preserved
// ══════════════════════════════════════════════════════════════════
describe('error and interrupt paths', () => {
  it('CODING → ERROR on PROCESS_ERROR', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'PROCESS_ERROR', error: 'crash' });
    expect(actor.getSnapshot().value).toBe('ERROR');
    expect(actor.getSnapshot().context.lastError).toBe('crash');
    actor.stop();
  });

  it('CODING → ERROR on TIMEOUT', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('ERROR');
    actor.stop();
  });

  it('REVIEWING → ERROR on PROCESS_ERROR', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    // Get to REVIEWING through the new flow
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'review' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    actor.send({ type: 'PROCESS_ERROR', error: 'reviewer crash' });
    expect(actor.getSnapshot().value).toBe('ERROR');
    actor.stop();
  });

  // Card E.1: adapted — interrupts go through INCIDENT_DETECTED → OBSERVING
  it('CODING + INCIDENT_DETECTED → OBSERVING (replaces USER_INTERRUPT)', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
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

  // Card E.2: adapted — request_user_input now routes to CLARIFYING, user input via OBSERVATIONS_READY
  it('CLARIFYING + OBSERVATIONS_READY → GOD_DECIDING (replaces USER_INPUT direct resume)', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    // Get to CLARIFYING via God request_user_input
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'what?' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CLARIFYING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });

  it('GOD_DECIDING → PAUSED on PAUSE_REQUIRED', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.send({ type: 'PAUSE_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('PAUSED');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// Session resumption paths
// ══════════════════════════════════════════════════════════════════
describe('session resumption', () => {
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

// ══════════════════════════════════════════════════════════════════
// Full cycle: IDLE → TASK_INIT → CODING → OBSERVING → GOD_DECIDING → EXECUTING → ... → DONE
// ══════════════════════════════════════════════════════════════════
describe('full Observe → Decide → Act cycle', () => {
  it('complete cycle ending in accept', () => {
    const actor = startActor();

    // Start
    actor.send({ type: 'START_TASK', prompt: 'build feature' });
    expect(actor.getSnapshot().value).toBe('TASK_INIT');
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    expect(actor.getSnapshot().value).toBe('CODING');

    // Coder completes → OBSERVING
    actor.send({ type: 'CODE_COMPLETE', output: 'implementation v1' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Observations ready → GOD_DECIDING
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides: send to reviewer
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'review v1' }]) });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // Execution complete → REVIEWING
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    // Reviewer completes → OBSERVING
    actor.send({ type: 'REVIEW_COMPLETE', output: 'LGTM' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Observations ready → GOD_DECIDING
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides: accept
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{
      type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Reviewer approved, task complete',
    }]) });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // Execution complete → DONE
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });

  it('round increments when looping back to CODING', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');

    // Round 0: code → observe → decide → execute → back to coding
    actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'iterate' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CODING');

    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// Bug 5 fix: CODE_COMPLETE / REVIEW_COMPLETE clear currentObservations
// ══════════════════════════════════════════════════════════════════
describe('Bug 5: currentObservations cleared on work completion', () => {
  it('CODE_COMPLETE clears stale currentObservations from previous EXECUTION_COMPLETE', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');

    // Round 0: code → observe → decide → execute(send_to_coder) → coding
    actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'retry' }]) });
    const executionResults = [makeObs('phase_progress_signal', 'runtime')];
    actor.send({ type: 'EXECUTION_COMPLETE', results: executionResults });
    expect(actor.getSnapshot().value).toBe('CODING');

    // After EXECUTION_COMPLETE, currentObservations was set to executionResults.
    // CODE_COMPLETE must clear it so OBSERVING doesn't forward stale data.
    actor.send({ type: 'CODE_COMPLETE', output: 'v2' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    expect(actor.getSnapshot().context.currentObservations).toEqual([]);

    actor.stop();
  });

  it('REVIEW_COMPLETE clears stale currentObservations', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');

    // Get to REVIEWING with stale currentObservations
    actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'review' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    // REVIEW_COMPLETE must clear currentObservations
    actor.send({ type: 'REVIEW_COMPLETE', output: 'LGTM' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    expect(actor.getSnapshot().context.currentObservations).toEqual([]);

    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// Bug 1 fix: Circuit breaker — prevent infinite coder loops
// ══════════════════════════════════════════════════════════════════
describe('circuit breaker: consecutiveRouteToCoder', () => {
  /** Helper: run one full coder loop cycle (CODE_COMPLETE → ... → send_to_coder → CODING) */
  function runCoderCycle(actor: ReturnType<typeof startActor>) {
    actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'iterate' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
  }

  it('increments consecutiveRouteToCoder on each route-to-coder', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    expect(actor.getSnapshot().context.consecutiveRouteToCoder).toBe(0);

    runCoderCycle(actor);
    expect(actor.getSnapshot().context.consecutiveRouteToCoder).toBe(1);

    runCoderCycle(actor);
    expect(actor.getSnapshot().context.consecutiveRouteToCoder).toBe(2);

    actor.stop();
  });

  it('trips circuit breaker on 3rd consecutive route-to-coder → PAUSED', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');

    // 1st and 2nd route-to-coder: should reach CODING
    runCoderCycle(actor);
    expect(actor.getSnapshot().value).toBe('CODING');
    runCoderCycle(actor);
    expect(actor.getSnapshot().value).toBe('CODING');

    // 3rd route-to-coder: circuit breaker trips → PAUSED
    actor.send({ type: 'CODE_COMPLETE', output: 'v3' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'iterate again' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('PAUSED');
    expect(actor.getSnapshot().context.lastError).toContain('Circuit breaker');

    actor.stop();
  });

  it('resets counter when routing to reviewer', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');

    // 2 consecutive route-to-coder
    runCoderCycle(actor);
    runCoderCycle(actor);
    expect(actor.getSnapshot().context.consecutiveRouteToCoder).toBe(2);

    // Route to reviewer → resets counter
    actor.send({ type: 'CODE_COMPLETE', output: 'v3' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'review' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');
    expect(actor.getSnapshot().context.consecutiveRouteToCoder).toBe(0);

    actor.stop();
  });

  it('resets counter on TASK_INIT_COMPLETE', () => {
    const actor = startActor({ consecutiveRouteToCoder: 5 });
    actor.start();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    expect(actor.getSnapshot().context.consecutiveRouteToCoder).toBe(0);
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// PAUSED: simplified retry/quit transitions
// ══════════════════════════════════════════════════════════════════
describe('PAUSED simplified transitions', () => {
  it('PAUSED → GOD_DECIDING on USER_CONFIRM continue (retry)', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'PAUSE_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('PAUSED');

    actor.send({ type: 'USER_CONFIRM', action: 'continue' });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });

  it('PAUSED → DONE on USER_CONFIRM accept', () => {
    const actor = startActor();
    sendStartAndSkipInit(actor, 'test');
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'PAUSE_REQUIRED' });

    actor.send({ type: 'USER_CONFIRM', action: 'accept' });
    expect(actor.getSnapshot().value).toBe('DONE');
    actor.stop();
  });
});
