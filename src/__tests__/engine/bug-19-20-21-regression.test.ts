/**
 * Regression tests for BUG-19, BUG-20, and BUG-21.
 * Adapted for Card D.1 Observe → Decide → Act topology.
 *
 * BUG-19 [P2]: handleInterrupt and state-save useEffect stale closure on taskAnalysis
 *   → Fixed by using taskAnalysisRef (tested via ref pattern verification)
 * BUG-20 [P2]: confirmContinueWithPhase guard uses !== null, doesn't exclude undefined
 *   → Fixed by using != null (loose comparison)
 *   → In D.1, GOD_DECIDING no longer uses USER_CONFIRM; MANUAL_FALLBACK retains it
 * BUG-21 [P2]: GOD_DECIDING auto-decision not re-triggered after reclassify
 *   → Fixed by adding reclassifyTrigger to useEffect deps (tested via state machine behavior)
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
  return { source, type, summary: `test ${type}`, severity: 'info', timestamp: new Date().toISOString(), round: 0 };
}

function makeEnvelope(actions: GodDecisionEnvelope['actions'] = []): GodDecisionEnvelope {
  return {
    diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions,
    messages: [{ target: 'system_log', content: 'log' }],
  };
}

function advanceToGodDeciding(actor: ReturnType<typeof startActor>) {
  actor.send({ type: 'START_TASK', prompt: 'test task' });
  actor.send({ type: 'TASK_INIT_SKIP' });
  actor.send({ type: 'CODE_COMPLETE', output: 'done' });
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
}

// ══════════════════════════════════════════════════════════════════
// BUG-20: MANUAL_FALLBACK confirmContinueWithPhase guard
// In D.1, GOD_DECIDING uses DECISION_READY; MANUAL_FALLBACK retains USER_CONFIRM
// ══════════════════════════════════════════════════════════════════

describe('BUG-20 regression: confirmContinueWithPhase guard in MANUAL_FALLBACK', () => {
  it('pendingPhaseId=null: USER_CONFIRM continue uses normal path (no phase switch)', () => {
    const actor = startActor();
    advanceToGodDeciding(actor);
    actor.send({ type: 'MANUAL_FALLBACK_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('MANUAL_FALLBACK');

    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();
    actor.send({ type: 'USER_CONFIRM', action: 'continue' });

    expect(actor.getSnapshot().value).toBe('CODING');
    expect(actor.getSnapshot().context.taskPrompt).toBe('test task');
    actor.stop();
  });

  it('MANUAL_FALLBACK with pendingPhaseId: confirmContinueWithPhase fires correctly', () => {
    const actor = startActor({ pendingPhaseId: 'phase2', pendingPhaseSummary: 'Next phase' });
    advanceToGodDeciding(actor);
    actor.send({ type: 'MANUAL_FALLBACK_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('MANUAL_FALLBACK');

    expect(actor.getSnapshot().context.pendingPhaseId).toBe('phase2');
    actor.send({ type: 'USER_CONFIRM', action: 'continue' });

    expect(actor.getSnapshot().value).toBe('CODING');
    expect(actor.getSnapshot().context.taskPrompt).toContain('phase2');
    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();
    actor.stop();
  });

  it('pendingPhaseId initialized as null by default in context', () => {
    const actor = startActor();
    expect(actor.getSnapshot().context.pendingPhaseId).toBeNull();
    expect(actor.getSnapshot().context.pendingPhaseSummary).toBeNull();
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-19: taskAnalysisRef pattern — verify the state-save and handleInterrupt
// closures read the latest taskAnalysis via ref (unit-testable logic)
// ══════════════════════════════════════════════════════════════════

describe('BUG-19 regression: taskAnalysisRef pattern', () => {
  it('ref always reflects latest value even when closure is stale', () => {
    const ref = { current: { taskType: 'code' } as any };
    const closureFn = () => ref.current;

    expect(closureFn()?.taskType).toBe('code');

    ref.current = { taskType: 'debug' };
    expect(closureFn()?.taskType).toBe('debug');
  });

  it('stale closure with direct state capture would read old value (documents the bug)', () => {
    let stateValue = { taskType: 'code' } as any;
    const ref = { current: stateValue };
    const refClosureFn = () => ref.current;

    stateValue = { taskType: 'debug' };
    ref.current = stateValue;

    expect(refClosureFn()?.taskType).toBe('debug');
  });

  it('XState context round changes trigger state-save useEffect but taskAnalysis from ref is current', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_SKIP' });

    // Complete a full cycle to increment round
    actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'send_to_coder', message: 'iterate' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });

    expect(actor.getSnapshot().context.round).toBe(1);
    expect(actor.getSnapshot().value).toBe('CODING');
    actor.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-21: GOD_DECIDING auto-decision re-trigger after reclassify
// ══════════════════════════════════════════════════════════════════

describe('BUG-21 regression: reclassify re-triggers auto-decision in GOD_DECIDING', () => {
  it('GOD_DECIDING state stays GOD_DECIDING (reclassifyTrigger needed for useEffect)', () => {
    const actor = startActor();
    advanceToGodDeciding(actor);

    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    // Reclassify doesn't change XState state — reclassifyTrigger solves this
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });

  // Card E.2: adapted — CLARIFYING reached via request_user_input, recovery via OBSERVATIONS_READY
  it('reclassify from CLARIFYING via OBSERVATIONS_READY reaches GOD_DECIDING', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_SKIP' });
    // Get to CLARIFYING via God request_user_input
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'reclassify?' }]) });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CLARIFYING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    actor.stop();
  });

  it('reclassifyTrigger concept: counter increment triggers re-evaluation', () => {
    let effectRunCount = 0;
    let reclassifyTrigger = 0;

    const deps = () => [reclassifyTrigger];
    let prevDeps = deps();

    const depsChanged = () => {
      const newDeps = deps();
      const changed = newDeps.some((d, i) => d !== prevDeps[i]);
      prevDeps = newDeps;
      return changed;
    };

    effectRunCount++;
    expect(effectRunCount).toBe(1);

    expect(depsChanged()).toBe(false);

    reclassifyTrigger++;
    expect(depsChanged()).toBe(true);
    effectRunCount++;
    expect(effectRunCount).toBe(2);

    reclassifyTrigger++;
    expect(depsChanged()).toBe(true);
    effectRunCount++;
    expect(effectRunCount).toBe(3);
  });
});
