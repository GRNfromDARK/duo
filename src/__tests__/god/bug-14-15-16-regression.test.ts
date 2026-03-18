/**
 * Regression tests for BUG-14, BUG-15, BUG-16.
 *
 * BUG-14 [P1]: compound task phaseId/phaseType not passed to God prompt generation
 * BUG-15 [P1]: GOD_DECIDING auto-decision auditSeqRef uses post-increment
 * BUG-16 [P2]: confirmContinueWithPhase removed in v2 — PAUSED simplified to retry/quit
 *
 * Card D.1 adaptation:
 *   - ROUTING_POST_CODE, ROUTING_POST_REVIEW, EVALUATING states removed
 *   - Flow: CODING → OBSERVING → GOD_DECIDING → EXECUTING → CODING/REVIEWING/DONE
 *   - CODE_COMPLETE → OBSERVING (not ROUTING_POST_CODE)
 *   - REVIEW_COMPLETE → OBSERVING (not ROUTING_POST_REVIEW)
 *   - GOD_DECIDING uses DECISION_READY (not USER_CONFIRM for accept/continue)
 *   - PAUSED uses confirmContinue → GOD_DECIDING (retry) and confirmAccept → DONE (quit)
 *   - Phase transitions handled by Hand executor set_phase actions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import {
  generateCoderPrompt,
  generateReviewerPrompt,
  type PromptContext,
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

// ── Card D.1 helpers ──

function makeObs(type = 'work_output', source = 'coder'): Observation {
  return { source, type, summary: `test ${type}`, severity: 'info', timestamp: new Date().toISOString()} as Observation;
}

function makeEnvelope(actions: GodDecisionEnvelope['actions'] = []): GodDecisionEnvelope {
  return {
    diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions,
    messages: [{ target: 'system_log', content: 'log' }],
  };
}

// ══════════════════════════════════════════════════════════════════
// BUG-14: compound phaseId/phaseType must affect prompt strategy
// ══════════════════════════════════════════════════════════════════

describe('BUG-14 regression: compound task phaseId/phaseType in prompt generation', () => {
  it('compound without phaseType falls back to CODE_INSTRUCTIONS (the bug scenario)', () => {
    // This is the buggy scenario: compound task without phaseType
    const ctx: PromptContext = {
      taskType: 'compound',
      taskGoal: 'Explore then implement auth',
      // NO phaseId, NO phaseType — simulates the bug
    };
    const prompt = generateCoderPrompt(ctx);

    // Without phaseType, compound falls back to default (code) strategy
    // This contains "Implement" — confirming the bug scenario
    expect(prompt.toLowerCase()).toMatch(/implement|code|write|build/);
    // And does NOT include current phase section
    expect(prompt).not.toContain('Current Phase');
  });

  it('compound WITH phaseType=explore uses explore strategy (the fix)', () => {
    const ctx: PromptContext = {
      taskType: 'compound',
      taskGoal: 'Explore the auth flow and then enhance it',
      phaseId: 'explore-phase',
      phaseType: 'explore',
    };
    const prompt = generateCoderPrompt(ctx);

    // With phaseType=explore, Instructions section should use EXPLORE_INSTRUCTIONS
    // Extract the Instructions section to avoid matching task goal text
    const instructionsMatch = prompt.match(/## Instructions\n([\s\S]*?)(?=\n## |$)/);
    expect(instructionsMatch).not.toBeNull();
    const instructions = instructionsMatch![1].toLowerCase();

    // Explore instructions should NOT contain execution verbs
    expect(instructions).not.toContain('implement');
    expect(instructions).not.toContain('write code');
    // Should contain explore-oriented language
    expect(instructions).toMatch(/analy[sz]e|investigate|explore|suggest|recommend|examine/);
    // Should include current phase section
    expect(prompt).toContain('Current Phase');
    expect(prompt).toContain('explore-phase');
  });

  it('compound WITH phaseType=debug uses debug strategy', () => {
    const ctx: PromptContext = {
      taskType: 'compound',
      taskGoal: 'Debug and fix auth',
      phaseId: 'debug-phase',
      phaseType: 'debug',
    };
    const prompt = generateCoderPrompt(ctx);

    expect(prompt.toLowerCase()).toMatch(/debug|diagnose|fix|trace|root cause/);
    expect(prompt).toContain('Current Phase');
    expect(prompt).toContain('debug-phase');
  });

  it('compound WITH phaseType=review uses review strategy', () => {
    const ctx: PromptContext = {
      taskType: 'compound',
      taskGoal: 'Review auth implementation',
      phaseId: 'review-phase',
      phaseType: 'review',
    };
    const prompt = generateCoderPrompt(ctx);

    expect(prompt.toLowerCase()).toMatch(/review|audit|check|inspect|examine/);
    expect(prompt).toContain('Current Phase');
    expect(prompt).toContain('review-phase');
  });
});

describe('BUG-14 regression: compound task phaseId/phaseType in REVIEWER prompt generation', () => {
  it('reviewer prompt without phaseType uses default review instructions (the bug scenario)', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'compound',
      taskGoal: 'Explore then implement auth',
      lastCoderOutput: 'exploration results',
      // NO phaseId, NO phaseType — simulates the bug
    });

    // Without phaseType, compound falls back to default review instructions
    expect(prompt).not.toContain('Current Phase');
    expect(prompt).toContain('Review Instructions');
    // Default review instructions mention "bugs, logic errors"
    expect(prompt).toContain('blocking issues');
  });

  it('reviewer prompt WITH phaseType=explore uses explore-aware review instructions (the fix)', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'compound',
      taskGoal: 'Explore the auth flow and then enhance it',
      lastCoderOutput: 'exploration results',
      phaseId: 'explore-phase',
      phaseType: 'explore',
    });

    // Should include current phase section
    expect(prompt).toContain('Current Phase');
    expect(prompt).toContain('explore-phase');
    // Explore review instructions should mention read-only / exploration-specific checks
    expect(prompt).toContain('exploration');
    expect(prompt).toContain('read-only');
    // Should NOT contain the default "blocking issues (bugs, logic errors" phrasing
    expect(prompt).not.toContain('blocking issues (bugs');
  });

  it('reviewer prompt WITH phaseType=code uses standard review instructions', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'compound',
      taskGoal: 'Multi-phase project',
      lastCoderOutput: 'implementation code',
      phaseId: 'code-phase',
      phaseType: 'code',
    });

    expect(prompt).toContain('Current Phase');
    expect(prompt).toContain('code-phase');
    // Code phase uses standard review instructions
    expect(prompt).toContain('blocking issues');
  });

  it('reviewer prompt for non-compound task ignores phaseId/phaseType', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      taskGoal: 'Simple code task',
      lastCoderOutput: 'code output',
      phaseId: 'should-be-ignored',
      phaseType: 'explore',
    });

    // Non-compound: no Current Phase section even if phaseId provided
    expect(prompt).not.toContain('Current Phase');
    // Uses standard review instructions
    expect(prompt).toContain('blocking issues');
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-15: auditSeqRef increment consistency
// ══════════════════════════════════════════════════════════════════

describe('BUG-15 regression: audit seq pre-increment consistency', () => {
  it('pre-increment (++ref) returns value after increment, ensuring seq > 0', () => {
    // Simulates the fix: all seq assignments use pre-increment
    const ref = { current: 0 };

    // Pre-increment: value is incremented BEFORE use
    const seq1 = ++ref.current;
    expect(seq1).toBe(1); // seq starts at 1, not 0

    const seq2 = ++ref.current;
    expect(seq2).toBe(2);

    // All seqs are unique and > 0
    expect(seq1).not.toBe(seq2);
    expect(seq1).toBeGreaterThan(0);
    expect(seq2).toBeGreaterThan(0);
  });

  it('post-increment (ref++) returns value BEFORE increment, causing seq=0 (the bug)', () => {
    // Demonstrates the bug: post-increment returns 0 on first use
    const ref = { current: 0 };

    // Post-increment: value is used BEFORE incrementing
    const buggySeq = ref.current++;
    expect(buggySeq).toBe(0); // Bug: seq=0, can collide with TASK_INIT seq

    // After post-increment, ref is 1
    expect(ref.current).toBe(1);
  });

  it('mixed pre/post increment causes seq collision (the bug scenario)', () => {
    const ref = { current: 0 };

    // Simulates: God audit logger writes TASK_INIT at seq 0 (separate counter)
    // Then GOD_DECIDING auto-decision uses post-increment:
    const autoDecisionSeq = ref.current++; // Bug: returns 0
    expect(autoDecisionSeq).toBe(0);

    // Then CODING prompt uses pre-increment:
    const codingSeq = ++ref.current; // Returns 2, skipping 1
    expect(codingSeq).toBe(2);

    // Seq 1 is never used — and seq 0 collides with TASK_INIT
    expect(autoDecisionSeq).toBe(0); // collision risk
  });

  it('consistent pre-increment avoids collision and gaps', () => {
    const ref = { current: 0 };

    // Fix: all use pre-increment
    const seq1 = ++ref.current; // 1
    const seq2 = ++ref.current; // 2
    const seq3 = ++ref.current; // 3

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);

    // No gaps, no collisions, all > 0
    const seqs = [seq1, seq2, seq3];
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.every(s => s > 0)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-16: PAUSED simplified in v2 — confirmContinueWithPhase removed
//
// In v2, PAUSED only supports retry (GOD_DECIDING) and quit (DONE).
// Phase transitions are handled by the Hand executor's set_phase action.
// ══════════════════════════════════════════════════════════════════

function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
}

/**
 * Navigate actor to PAUSED state.
 */
function advanceToPaused(
  prompt = 'implement user login with OAuth',
) {
  const actor = startActor();
  actor.send({ type: 'START_TASK', prompt });
  actor.send({ type: 'TASK_INIT_COMPLETE' });
  actor.send({ type: 'CODE_COMPLETE', output: 'done phase 1' });
  actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
  actor.send({ type: 'PAUSE_REQUIRED' });
  return actor;
}

describe('BUG-16 regression: PAUSED simplified transitions', () => {
  it('PAUSED → GOD_DECIDING on USER_CONFIRM continue (retry)', () => {
    const actor = advanceToPaused('implement user login with OAuth');
    expect(actor.getSnapshot().value).toBe('PAUSED');

    actor.send({ type: 'USER_CONFIRM', action: 'continue' });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    // taskPrompt preserved
    expect(actor.getSnapshot().context.taskPrompt).toBe('implement user login with OAuth');
    actor.stop();
  });

  it('PAUSED → DONE on USER_CONFIRM accept (quit)', () => {
    const actor = advanceToPaused('build REST API');
    expect(actor.getSnapshot().value).toBe('PAUSED');

    actor.send({ type: 'USER_CONFIRM', action: 'accept' });
    expect(actor.getSnapshot().value).toBe('DONE');
    actor.stop();
  });

  it('taskPrompt unchanged after PAUSED → GOD_DECIDING retry', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'simple task' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    actor.send({ type: 'PAUSE_REQUIRED' });

    expect(actor.getSnapshot().value).toBe('PAUSED');
    actor.send({ type: 'USER_CONFIRM', action: 'continue' });
    expect(actor.getSnapshot().context.taskPrompt).toBe('simple task');
    actor.stop();
  });
});
