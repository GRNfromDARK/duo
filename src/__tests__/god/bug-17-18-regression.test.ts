/**
 * Regression tests for BUG-17 and BUG-18.
 *
 * BUG-17 [P1]: REVIEWING useEffect God prompt path drops interruptInstruction
 * BUG-18 [P2]: XState taskPrompt accumulates [Phase: ...] prefixes across transitions
 *
 * Adapted for Card D.1 state machine topology:
 *   CODING → OBSERVING → GOD_DECIDING → EXECUTING → CODING/REVIEWING/DONE
 *   Phase transitions via God's set_phase action; pendingPhaseId consumed in MANUAL_FALLBACK.
 *   Removed: ROUTING_POST_CODE, ROUTING_POST_REVIEW, EVALUATING, PHASE_TRANSITION, CONVERGED, ROUTE_TO_REVIEW events.
 */
import { describe, it, expect, vi } from 'vitest';
import { createActor } from 'xstate';
import {
  generateReviewerPrompt,
} from '../../god/god-prompt-generator.js';
import {
  workflowMachine,
  type WorkflowContext,
} from '../../engine/workflow-machine.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';

vi.mock('../../god/god-audit.js', () => ({
  appendAuditLog: vi.fn(),
}));

// ── Helpers ──

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

function startActor(input?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: input ?? {} });
  actor.start();
  return actor;
}

/**
 * Card D.1 replacement for the old advanceToPhaseTransition helper.
 *
 * Drives the machine through a full CODING → OBSERVING → GOD_DECIDING cycle
 * then triggers MANUAL_FALLBACK_REQUIRED → USER_CONFIRM (continue) to
 * consume the pre-set pendingPhaseId and rewrite taskPrompt.
 *
 * Because the D.1 machine only allows pendingPhaseId to be set via input
 * context (the Hand executor sets it externally), each successive phase
 * transition needs a fresh actor that carries forward the previous taskPrompt
 * and the new pendingPhaseId.
 */
function advanceToPhaseTransition(
  actor: ReturnType<typeof startActor>,
) {
  // CODING → OBSERVING
  actor.send({ type: 'CODE_COMPLETE', output: 'done' });
  // OBSERVING → GOD_DECIDING
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
  // GOD_DECIDING → MANUAL_FALLBACK
  actor.send({ type: 'MANUAL_FALLBACK_REQUIRED' });
  // MANUAL_FALLBACK → CODING (consumes pendingPhaseId via confirmContinueWithPhase guard)
  actor.send({ type: 'USER_CONFIRM', action: 'continue' });
}

// ══════════════════════════════════════════════════════════════════
// BUG-17: generateReviewerPrompt must accept and use instruction
// ══════════════════════════════════════════════════════════════════

describe('BUG-17 regression: generateReviewerPrompt instruction support', () => {
  it('includes instruction in reviewer prompt when provided', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      round: 2,
      maxRounds: 5,
      taskGoal: 'Build API',
      lastCoderOutput: 'Added endpoint',
      instruction: 'Focus on error handling in the auth module',
    });

    expect(prompt).toContain('Focus on error handling in the auth module');
    expect(prompt).toContain('God Instruction (HIGHEST PRIORITY)');
  });

  it('omits instruction section when instruction is undefined', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      round: 1,
      maxRounds: 5,
      taskGoal: 'Build API',
      lastCoderOutput: 'code output',
    });

    expect(prompt).not.toContain('God Instruction');
  });

  it('instruction appears before review instructions (high priority)', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      round: 2,
      maxRounds: 5,
      taskGoal: 'Build API',
      lastCoderOutput: 'Added endpoint',
      instruction: 'User wants to skip security checks',
    });

    const instructionIdx = prompt.indexOf('User wants to skip security checks');
    const reviewIdx = prompt.indexOf('Review Instructions');
    expect(instructionIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(instructionIdx).toBeLessThan(reviewIdx);
  });

  it('instruction works with compound task and phaseType', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'compound',
      round: 1,
      maxRounds: 5,
      taskGoal: 'Multi-phase project',
      lastCoderOutput: 'exploration results',
      phaseId: 'explore-phase',
      phaseType: 'explore',
      instruction: 'Pay attention to missing test coverage',
    });

    expect(prompt).toContain('Pay attention to missing test coverage');
    expect(prompt).toContain('Current Phase');
    expect(prompt).toContain('explore-phase');
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-18: taskPrompt must not accumulate [Phase: ...] prefixes
// ══════════════════════════════════════════════════════════════════

describe('BUG-18 regression: taskPrompt phase prefix accumulation', () => {
  it('does not accumulate multiple [Phase: ...] prefixes after repeated transitions', () => {
    const originalTask = 'multi-phase project';

    // ── First phase transition: pendingPhaseId = 'phase-2' ──
    const actor1 = startActor({ pendingPhaseId: 'phase-2', pendingPhaseSummary: 'Phase 1 done' });
    actor1.send({ type: 'START_TASK', prompt: originalTask });
    actor1.send({ type: 'TASK_INIT_SKIP' });
    advanceToPhaseTransition(actor1);
    const after1 = actor1.getSnapshot().context.taskPrompt!;
    expect(after1).toBe('[Phase: phase-2] multi-phase project');
    actor1.stop();

    // ── Second phase transition: carry forward taskPrompt, set pendingPhaseId = 'phase-3' ──
    const actor2 = startActor({
      taskPrompt: after1,
      pendingPhaseId: 'phase-3',
      pendingPhaseSummary: 'Phase 2 done',
    });
    // Already has taskPrompt from input, go straight to CODING via RESUME_SESSION path
    actor2.send({ type: 'RESUME_SESSION', sessionId: 'test' });
    actor2.send({ type: 'RESTORED_TO_CODING' });
    advanceToPhaseTransition(actor2);
    const after2 = actor2.getSnapshot().context.taskPrompt!;
    expect(after2).toBe('[Phase: phase-3] multi-phase project');
    // Must NOT be '[Phase: phase-3] [Phase: phase-2] multi-phase project'
    expect(after2).not.toContain('phase-2');
    actor2.stop();

    // ── Third phase transition: carry forward, set pendingPhaseId = 'phase-4' ──
    const actor3 = startActor({
      taskPrompt: after2,
      pendingPhaseId: 'phase-4',
      pendingPhaseSummary: 'Phase 3 done',
    });
    actor3.send({ type: 'RESUME_SESSION', sessionId: 'test' });
    actor3.send({ type: 'RESTORED_TO_CODING' });
    advanceToPhaseTransition(actor3);
    const after3 = actor3.getSnapshot().context.taskPrompt!;
    expect(after3).toBe('[Phase: phase-4] multi-phase project');
    expect(after3).not.toContain('phase-3');
    expect(after3).not.toContain('phase-2');
    actor3.stop();
  });

  it('preserves original task without prefix when no phase transition occurs', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'simple task' });
    actor.send({ type: 'TASK_INIT_SKIP' });

    // Full D.1 cycle without phase transition: CODING → OBSERVING → GOD_DECIDING → EXECUTING → DONE
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({
      type: 'DECISION_READY',
      envelope: makeEnvelope([{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done' }]),
    });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });

    expect(actor.getSnapshot().context.taskPrompt).toBe('simple task');
    actor.stop();
  });

  it('MANUAL_FALLBACK without pendingPhaseId does not add prefix', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'no phase task' });
    actor.send({ type: 'TASK_INIT_SKIP' });

    // CODING → OBSERVING → GOD_DECIDING → MANUAL_FALLBACK → CODING
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'MANUAL_FALLBACK_REQUIRED' });
    actor.send({ type: 'USER_CONFIRM', action: 'continue' });

    expect(actor.getSnapshot().context.taskPrompt).toBe('no phase task');
    actor.stop();
  });
});
