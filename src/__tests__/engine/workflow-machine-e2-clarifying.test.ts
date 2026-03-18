/**
 * Card E.2: CLARIFYING state — God-mediated multi-turn clarification + resume semantics.
 * Source: FR-012 (God-Mediated Clarification), FR-013 (Resume After Interrupt)
 *
 * Tests:
 * - AC-1: God can ask multi-round clarification questions
 * - AC-2: Main work chain frozen during clarification (no coder/reviewer)
 * - AC-3: God can resume original task chain after clarification
 * - AC-4: Resume preserves original task, phase, active role
 * - AC-5: God can rewrite subsequent message/action based on clarification
 * - AC-6: Resume doesn't lose pre-interrupt observation history
 * - AC-7: CLARIFYING state correctly defined in state machine
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

/** Helper: advance from REVIEWING through full Observe→Decide→Act cycle */
function advanceFromReviewing(
  actor: ReturnType<typeof startActor>,
  actions: GodDecisionEnvelope['actions'],
) {
  actor.send({ type: 'REVIEW_COMPLETE', output: 'review done' });
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
  actor.send({ type: 'DECISION_READY', envelope: makeEnvelope(actions) });
  actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
}

/** Helper: get to CLARIFYING from CODING via interrupt → God request_user_input */
function advanceToClarifyingFromCoding(actor: ReturnType<typeof startActor>) {
  // Interrupt during CODING
  actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
  // → OBSERVING → GOD_DECIDING → EXECUTING → CLARIFYING
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('human_interrupt', 'human')] });
  actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'What would you like to change?' }]) });
  actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
}

describe('Card E.2: CLARIFYING state', () => {
  // ── AC-7: CLARIFYING state correctly defined ──

  describe('AC-7: CLARIFYING state definition', () => {
    it('request_user_input routes to CLARIFYING (not INTERRUPTED)', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'what?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      actor.stop();
    });

    it('CLARIFYING state has correct initial context', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'what?' }]);
      const ctx = actor.getSnapshot().context;
      expect(ctx.clarificationRound).toBe(1);
      expect(ctx.activeProcess).toBeNull();
      actor.stop();
    });

    it('CLARIFYING accepts OBSERVATIONS_READY → GOD_DECIDING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'what?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');

      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });
  });

  // ── AC-1: God can ask multi-round questions ──

  describe('AC-1: multi-round clarification', () => {
    it('God can ask a second question after first answer', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'Q1?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      expect(actor.getSnapshot().context.clarificationRound).toBe(1);

      // User answers Q1 → God asks Q2
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'Q2?' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      expect(actor.getSnapshot().context.clarificationRound).toBe(2);
      actor.stop();
    });

    it('God can ask three rounds of questions then resume', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'Q1?' }]);

      // Round 2
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'Q2?' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });

      // Round 3
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'Q3?' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().context.clarificationRound).toBe(3);

      // Resume
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'resume_after_interrupt', resumeStrategy: 'continue' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('CODING');
      actor.stop();
    });
  });

  // ── AC-2: main work chain frozen during clarification ──

  describe('AC-2: work chain frozen', () => {
    it('CLARIFYING does not accept CODE_COMPLETE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'Q?' }]);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');

      actor.send({ type: 'CODE_COMPLETE', output: 'should be ignored' });
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      actor.stop();
    });

    it('CLARIFYING does not accept REVIEW_COMPLETE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'Q?' }]);

      actor.send({ type: 'REVIEW_COMPLETE', output: 'should be ignored' });
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      actor.stop();
    });

    it('activeProcess is null during CLARIFYING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'Q?' }]);
      expect(actor.getSnapshot().context.activeProcess).toBeNull();
      actor.stop();
    });
  });

  // ── AC-3: resume original task chain ──

  describe('AC-3: resume after clarification', () => {
    it('resume_after_interrupt(continue) → CODING when interrupted from CODING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      // Interrupt during CODING → freeze active process as 'coder'
      advanceToClarifyingFromCoding(actor);
      expect(actor.getSnapshot().value).toBe('CLARIFYING');

      // User answers, God resumes
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'resume_after_interrupt', resumeStrategy: 'continue' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('CODING');
      expect(actor.getSnapshot().context.activeProcess).toBe('coder');
      actor.stop();
    });

    it('resume_after_interrupt(continue) → REVIEWING when interrupted from REVIEWING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      // Get to REVIEWING
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      expect(actor.getSnapshot().value).toBe('REVIEWING');

      // Interrupt during REVIEWING
      actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('human_interrupt', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'Q?' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      expect(actor.getSnapshot().context.frozenActiveProcess).toBe('reviewer');

      // Resume with continue
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'resume_after_interrupt', resumeStrategy: 'continue' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('REVIEWING');
      expect(actor.getSnapshot().context.activeProcess).toBe('reviewer');
      actor.stop();
    });

    it('resume_after_interrupt(redirect) → GOD_DECIDING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceToClarifyingFromCoding(actor);

      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'resume_after_interrupt', resumeStrategy: 'redirect' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });

    it('resume_after_interrupt(stop) → DONE', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceToClarifyingFromCoding(actor);

      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([
        { type: 'resume_after_interrupt', resumeStrategy: 'stop' },
        { type: 'accept_task', rationale: 'forced_stop', summary: 'User requested stop' },
      ]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('DONE');
      actor.stop();
    });
  });

  // ── AC-4: resume preserves original context ──

  describe('AC-4: context preservation', () => {
    it('frozenActiveProcess is set when INCIDENT_DETECTED in CODING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
      expect(actor.getSnapshot().context.frozenActiveProcess).toBe('coder');
      actor.stop();
    });

    it('frozenActiveProcess is set when INCIDENT_DETECTED in REVIEWING', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'send_to_reviewer', message: 'review' }]);
      actor.send({ type: 'INCIDENT_DETECTED', observation: makeObs('human_interrupt', 'human') });
      expect(actor.getSnapshot().context.frozenActiveProcess).toBe('reviewer');
      actor.stop();
    });

    it('frozenActiveProcess persists across multi-round clarification', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceToClarifyingFromCoding(actor);
      expect(actor.getSnapshot().context.frozenActiveProcess).toBe('coder');

      // Round 2
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'Q2?' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().context.frozenActiveProcess).toBe('coder');
      actor.stop();
    });

    it('taskPrompt preserved through clarification', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'build feature X');
      advanceToClarifyingFromCoding(actor);
      expect(actor.getSnapshot().context.taskPrompt).toBe('build feature X');
      actor.stop();
    });

    it('frozenActiveProcess cleared after successful resume', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceToClarifyingFromCoding(actor);

      // Resume
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'resume_after_interrupt', resumeStrategy: 'continue' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().value).toBe('CODING');
      expect(actor.getSnapshot().context.frozenActiveProcess).toBeNull();
      expect(actor.getSnapshot().context.clarificationRound).toBe(0);
      actor.stop();
    });
  });

  // ── AC-6: observation history preserved ──

  describe('AC-6: observation history', () => {
    it('clarificationObservations accumulate across rounds', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceFromCoding(actor, [{ type: 'request_user_input', question: 'Q1?' }]);

      const answer1 = makeObs('clarification_answer', 'human');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [answer1] });
      expect(actor.getSnapshot().context.clarificationObservations.length).toBe(1);

      // Round 2
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'request_user_input', question: 'Q2?' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });

      const answer2 = makeObs('clarification_answer', 'human');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [answer2] });
      expect(actor.getSnapshot().context.clarificationObservations.length).toBe(2);
      actor.stop();
    });

    it('clarificationObservations cleared after resume', () => {
      const actor = startActor();
      sendStartAndSkipInit(actor, 'test');
      advanceToClarifyingFromCoding(actor);

      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      actor.send({ type: 'DECISION_READY', envelope: makeEnvelope([{ type: 'resume_after_interrupt', resumeStrategy: 'continue' }]) });
      actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
      expect(actor.getSnapshot().context.clarificationObservations).toEqual([]);
      actor.stop();
    });
  });

  // ── Session resume: RESTORED_TO_CLARIFYING ──

  describe('session resume', () => {
    it('RESUMING → CLARIFYING on RESTORED_TO_CLARIFYING', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      actor.send({ type: 'RESTORED_TO_CLARIFYING' });
      expect(actor.getSnapshot().value).toBe('CLARIFYING');
      actor.stop();
    });
  });

  // ── Backward compatibility ──

  describe('backward compatibility', () => {
    it('INTERRUPTED state still exists for RESTORED_TO_INTERRUPTED', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      actor.send({ type: 'RESTORED_TO_INTERRUPTED' });
      expect(actor.getSnapshot().value).toBe('INTERRUPTED');
      actor.stop();
    });

    it('INTERRUPTED still accepts OBSERVATIONS_READY → GOD_DECIDING', () => {
      const actor = startActor();
      actor.send({ type: 'RESUME_SESSION', sessionId: 'abc' });
      actor.send({ type: 'RESTORED_TO_INTERRUPTED' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('clarification_answer', 'human')] });
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      actor.stop();
    });
  });
});
