/**
 * Regression tests for audited bugs BUG-1 through BUG-4.
 * Adapted for Card D.1 Observe → Decide → Act topology.
 *
 * BUG-1 [P1]: CLEAR_PENDING_PHASE must reset pendingPhaseId in GOD_DECIDING
 * BUG-4 [P2]: CLARIFYING → recovery path on reclassify cancel (USER_INPUT resumeAs)
 *
 * Note: BUG-2 and BUG-3 are React-level bugs tested via state assertions.
 * Phase transition is now handled via God's set_phase action, not PHASE_TRANSITION event.
 * CLEAR_PENDING_PHASE still works in GOD_DECIDING for backward compatibility.
 */
import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import {
  workflowMachine,
  type WorkflowContext,
} from '../../engine/workflow-machine.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';

function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
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

/** Advance to GOD_DECIDING via normal code completion */
function advanceToGodDeciding(actor: ReturnType<typeof startActor>) {
  actor.send({ type: 'START_TASK', prompt: 'compound task' });
  actor.send({ type: 'TASK_INIT_COMPLETE' });
  actor.send({ type: 'CODE_COMPLETE', output: 'done' });
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
}

// ──────────────────────────────────────────────
// BUG-1: CLEAR_PENDING_PHASE clears pendingPhaseId in XState context
// ──────────────────────────────────────────────
describe('BUG-1 regression: CLEAR_PENDING_PHASE event', () => {
  it('CLEAR_PENDING_PHASE resets pendingPhaseId and pendingPhaseSummary to null', () => {
    const actor = startActor({ pendingPhaseId: 'p2', pendingPhaseSummary: 'Implementation phase' });
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });

    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.pendingPhaseId).toBe('p2');

    actor.send({ type: 'CLEAR_PENDING_PHASE' });

    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();
    expect(actor.getSnapshot().context.pendingPhaseSummary).toBeNull();
    actor.stop();
  });

  it('CLEAR_PENDING_PHASE is a no-op when pendingPhaseId is already null', () => {
    const actor = startActor();
    advanceToGodDeciding(actor);

    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();

    actor.send({ type: 'CLEAR_PENDING_PHASE' });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();
    actor.stop();
  });
});

// ──────────────────────────────────────────────
// BUG-2: Phase transition context check in GOD_DECIDING
// ──────────────────────────────────────────────
describe('BUG-2 regression: pendingPhaseId visible in context for guard checks', () => {
  it('context.pendingPhaseId is accessible when set via input', () => {
    const actor = startActor({ pendingPhaseId: 'p2' });
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });

    const ctx = actor.getSnapshot().context;
    expect(ctx.pendingPhaseId).not.toBeNull();
    expect(ctx.pendingPhaseId).toBe('p2');
    actor.stop();
  });

  it('context.pendingPhaseId is null when entering GOD_DECIDING without phase transition', () => {
    const actor = startActor();
    advanceToGodDeciding(actor);

    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();
    actor.stop();
  });
});

// ──────────────────────────────────────────────
// BUG-4 regression: CLARIFYING recovery
// Card E.2: adapted — CLARIFYING reached via request_user_input, recovery via OBSERVATIONS_READY → GOD_DECIDING
// ──────────────────────────────────────────────
describe('BUG-4 regression: CLARIFYING recovery via observation pipeline', () => {
  /** Helper: advance from CODING to CLARIFYING via request_user_input */
  function advanceToClarifying(actor: ReturnType<typeof startActor>) {
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'what?' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
  }

  it('OBSERVATIONS_READY with clarification_answer recovers CLARIFYING to GOD_DECIDING', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    advanceToClarifying(actor);
    expect(actor.getSnapshot().value).toBe('CLARIFYING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });

  it('without OBSERVATIONS_READY, CLARIFYING state persists', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    advanceToClarifying(actor);

    expect(actor.getSnapshot().value).toBe('CLARIFYING');
    // No event sent — should stay CLARIFYING
    expect(actor.getSnapshot().value).toBe('CLARIFYING');
    actor.stop();
  });

  it('interrupt during CODING goes through INCIDENT_DETECTED → OBSERVING (not INTERRUPTED)', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });

    // Card E.1: interrupts go through observation pipeline, not USER_INTERRUPT
    actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    actor.stop();
  });
});
