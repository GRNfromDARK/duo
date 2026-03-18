/**
 * Regression tests for BUG-17 and BUG-18.
 *
 * BUG-17 [P1]: REVIEWING useEffect God prompt path drops interruptInstruction
 * BUG-18 [P2]: XState taskPrompt accumulates [Phase: ...] prefixes across transitions
 *
 * Adapted for Card D.1 state machine topology:
 *   CODING → OBSERVING → GOD_DECIDING → EXECUTING → CODING/REVIEWING/DONE
 *   Phase transitions via God's set_phase action; pendingPhaseId consumed in PAUSED.
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

function startActor(input?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: input ?? {} });
  actor.start();
  return actor;
}

/**
 * Card D.1 replacement for the old advanceToPhaseTransition helper.
 *
 * Drives the machine through a full CODING → OBSERVING → GOD_DECIDING cycle
 * then triggers PAUSE_REQUIRED → USER_CONFIRM (continue) → GOD_DECIDING (retry).
 *
 * In v2, PAUSED no longer consumes pendingPhaseId — phase transitions are
 * handled by the Hand executor via set_phase actions.
 */
function advanceToPaused(
  actor: ReturnType<typeof startActor>,
) {
  // CODING → OBSERVING
  actor.send({ type: 'CODE_COMPLETE', output: 'done' });
  // OBSERVING → GOD_DECIDING
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
  // GOD_DECIDING → PAUSED
  actor.send({ type: 'PAUSE_REQUIRED' });
}

// ══════════════════════════════════════════════════════════════════
// BUG-17: generateReviewerPrompt must accept and use instruction
// ══════════════════════════════════════════════════════════════════

describe('BUG-17 regression: generateReviewerPrompt instruction support', () => {
  it('includes instruction in reviewer prompt when provided', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
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
      taskGoal: 'Build API',
      lastCoderOutput: 'code output',
    });

    expect(prompt).not.toContain('God Instruction');
  });

  it('instruction appears before review instructions (high priority)', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
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

describe('BUG-18 regression: taskPrompt preserved through PAUSED transitions', () => {
  it('preserves original task without prefix when no phase transition occurs', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'simple task' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });

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

  it('PAUSED → GOD_DECIDING on USER_CONFIRM continue preserves taskPrompt', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'no phase task' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });

    // CODING → OBSERVING → GOD_DECIDING → PAUSED → GOD_DECIDING (retry)
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
    actor.send({ type: 'PAUSE_REQUIRED' });
    actor.send({ type: 'USER_CONFIRM', action: 'continue' });

    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    expect(actor.getSnapshot().context.taskPrompt).toBe('no phase task');
    actor.stop();
  });
});
