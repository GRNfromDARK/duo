/**
 * Card D.1: God 完整工作流端到端集成测试
 *
 * Tests the full God-orchestrated workflow through XState + God modules,
 * verifying all 5 scenarios: normal path, degradation, auto-decision,
 * compound phase transition, and duo resume.
 *
 * Uses mock adapters to simulate God/Coder/Reviewer CLI output.
 * Tests module integration, NOT React rendering.
 *
 * Updated for Card D.1 state machine topology:
 *   CODING → OBSERVING → GOD_DECIDING → EXECUTING → CODING/REVIEWING/DONE
 *   Removed states: ROUTING_POST_CODE, ROUTING_POST_REVIEW, EVALUATING
 *   New events: OBSERVATIONS_READY, DECISION_READY, EXECUTION_COMPLETE, INCIDENT_DETECTED
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActor } from 'xstate';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  workflowMachine,
  type WorkflowContext,
} from '../../engine/workflow-machine.js';
import type { CLIAdapter, ExecOptions, OutputChunk } from '../../types/adapter.js';
import type { GodTaskAnalysis, GodPostCoderDecision, GodPostReviewerDecision, GodConvergenceJudgment, GodAutoDecision } from '../../types/god-schemas.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import { initializeTask } from '../../god/task-init.js';
import { routePostCoder, routePostReviewer } from '../../god/god-router.js';
import { evaluateConvergence, type ConvergenceLogEntry } from '../../god/god-convergence.js';
import { makeAutoDecision } from '../../god/auto-decision.js';
import { DegradationManager, type FallbackServices } from '../../god/degradation-manager.js';
import { withGodFallback, withGodFallbackSync } from '../../ui/god-fallback.js';
import { evaluatePhaseTransition, type Phase } from '../../god/phase-transition.js';
import { restoreGodSession } from '../../god/god-session-persistence.js';
import { ContextManager } from '../../session/context-manager.js';
import { ConvergenceService } from '../../decision/convergence-service.js';
import { ChoiceDetector } from '../../decision/choice-detector.js';
import type { SessionState } from '../../session/session-manager.js';
import * as godAudit from '../../god/god-audit.js';

// ── Mock audit to avoid filesystem side effects ──

vi.mock('../../god/god-audit.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../god/god-audit.js')>();
  return {
    ...original,
    appendAuditLog: vi.fn(),
  };
});

// ── Helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duo-god-integ-'));
  mkdirSync(join(tmpDir, 'session'), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a test Observation. */
function makeObs(type: Observation['type'] = 'work_output', source: Observation['source'] = 'coder'): Observation {
  return { source, type, summary: `test ${type}`, severity: 'info', timestamp: new Date().toISOString(), round: 0 };
}

/** Create a test GodDecisionEnvelope. */
function makeEnvelope(actions: GodDecisionEnvelope['actions'] = []): GodDecisionEnvelope {
  return {
    diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions,
    messages: [{ target: 'system_log', content: 'log' }],
  };
}

/** Create a mock CLIAdapter that returns a JSON code block wrapping the given object. */
function createMockAdapter(responseJson: Record<string, unknown>): CLIAdapter {
  const jsonBlock = '```json\n' + JSON.stringify(responseJson) + '\n```';
  return {
    name: 'mock-god',
    displayName: 'Mock God',
    version: '1.0.0',
    isInstalled: async () => true,
    getVersion: async () => '1.0.0',
    execute: vi.fn((_prompt: string, _opts: ExecOptions): AsyncIterable<OutputChunk> => {
      const chunks: OutputChunk[] = [
        { type: 'text', content: jsonBlock, timestamp: Date.now() },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < chunks.length) return { value: chunks[i++], done: false };
              return { value: undefined as unknown as OutputChunk, done: true };
            },
          };
        },
      };
    }),
    kill: async () => {},
    isRunning: () => false,
  };
}

/** Create a mock adapter that returns different responses on successive calls. */
function createSequentialAdapter(responses: Record<string, unknown>[]): CLIAdapter {
  let callIndex = 0;
  return {
    name: 'mock-god-seq',
    displayName: 'Mock God Sequential',
    version: '1.0.0',
    isInstalled: async () => true,
    getVersion: async () => '1.0.0',
    execute: vi.fn((_prompt: string, _opts: ExecOptions): AsyncIterable<OutputChunk> => {
      const idx = Math.min(callIndex++, responses.length - 1);
      const jsonBlock = '```json\n' + JSON.stringify(responses[idx]) + '\n```';
      const chunks: OutputChunk[] = [
        { type: 'text', content: jsonBlock, timestamp: Date.now() },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < chunks.length) return { value: chunks[i++], done: false };
              return { value: undefined as unknown as OutputChunk, done: true };
            },
          };
        },
      };
    }),
    kill: async () => {},
    isRunning: () => false,
  };
}

/** Create a mock adapter that always throws. */
function createFailingAdapter(error: Error): CLIAdapter {
  return {
    name: 'mock-god-fail',
    displayName: 'Mock God Failing',
    version: '1.0.0',
    isInstalled: async () => true,
    getVersion: async () => '1.0.0',
    execute: vi.fn((_prompt: string, _opts: ExecOptions): AsyncIterable<OutputChunk> => {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<OutputChunk>> {
              throw error;
            },
          };
        },
      };
    }),
    kill: async () => {},
    isRunning: () => false,
  };
}

function createFallbackServices(): FallbackServices {
  return {
    contextManager: new ContextManager({ contextWindowSize: 200000, promptsDir: join(tmpDir, 'prompts') }),
    convergenceService: new ConvergenceService({ maxRounds: 20 }),
    choiceDetector: new ChoiceDetector(),
  };
}

function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
}

const sessionDir = () => join(tmpDir, 'session');

// ═══════════════════════════════════════════════════════════════════
// Scenario 1: Normal God-orchestrated workflow path
// ═══════════════════════════════════════════════════════════════════

describe('Scenario 1: Normal God workflow path (AC-1)', () => {
  it('full workflow: TASK_INIT → CODING → OBSERVING → GOD_DECIDING → EXECUTING → REVIEWING → OBSERVING → GOD_DECIDING → EXECUTING → DONE', async () => {
    const actor = startActor();

    // ── Step 1: TASK_INIT ──
    actor.send({ type: 'START_TASK', prompt: 'implement user login' });
    expect(actor.getSnapshot().value).toBe('TASK_INIT');

    const godAdapter = createMockAdapter({
      taskType: 'code',
      reasoning: 'User wants login feature — coding task.',
      confidence: 0.9,
      suggestedMaxRounds: 5,
      terminationCriteria: ['Login form renders', 'Auth works', 'Tests pass'],
    } satisfies GodTaskAnalysis);

    const taskResult = await initializeTask(godAdapter, 'implement user login', 'You are God.', tmpDir);
    expect(taskResult).not.toBeNull();
    expect(taskResult!.analysis.taskType).toBe('code');
    expect(taskResult!.analysis.suggestedMaxRounds).toBe(5);

    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: taskResult!.analysis.suggestedMaxRounds });
    expect(actor.getSnapshot().value).toBe('CODING');
    expect(actor.getSnapshot().context.maxRounds).toBe(5);

    // ── Step 2: Coder produces output → OBSERVING (not ROUTING_POST_CODE) ──
    actor.send({ type: 'CODE_COMPLETE', output: 'function login() { /* auth logic */ }' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Observations classified, God decides to send to reviewer
    const obs1 = [makeObs('work_output', 'coder')];
    actor.send({ type: 'OBSERVATIONS_READY', observations: obs1 });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides: send_to_reviewer
    const envelopeToReview = makeEnvelope([{ type: 'send_to_reviewer', message: 'Review the login implementation' }]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeToReview });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // Hand executor completes → routes to REVIEWING
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    // ── Step 3: Reviewer produces output → OBSERVING ──
    actor.send({ type: 'REVIEW_COMPLETE', output: 'Missing input validation. Fix line 5.' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // God decides: send back to coder (route_to_coder equivalent)
    const obs2 = [makeObs('review_output', 'reviewer')];
    actor.send({ type: 'OBSERVATIONS_READY', observations: obs2 });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    const envelopeToCoder = makeEnvelope([{ type: 'send_to_coder', message: 'Fix input validation on line 5' }]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeToCoder });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // EXECUTION_COMPLETE routes to CODING (round increments)
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CODING');
    expect(actor.getSnapshot().context.round).toBe(1);

    // ── Step 4: Round 2 — Coder fixes → Reviewer approves → DONE ──
    actor.send({ type: 'CODE_COMPLETE', output: 'function login() { validateInput(); /* auth */ }' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    const envelopeToReview2 = makeEnvelope([{ type: 'send_to_reviewer', message: 'Review the fix' }]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeToReview2 });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    actor.send({ type: 'REVIEW_COMPLETE', output: 'All issues resolved. [APPROVED]' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // ── Step 5: God decides to accept → EXECUTING → DONE ──
    const envelopeAccept = makeEnvelope([
      { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'All criteria met, code approved.' },
    ]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeAccept });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });

  it('God modules produce correct types for state machine events', async () => {
    // Verify type compatibility between God modules and XState events
    const adapter = createMockAdapter({
      action: 'continue_to_review',
      reasoning: 'OK',
    } satisfies GodPostCoderDecision);

    const result = await routePostCoder(adapter, 'output', {
      round: 0, maxRounds: 10, taskGoal: 'test', sessionDir: sessionDir(), seq: 1,
    });

    // The legacy routePostCoder still works as a module, but the state machine
    // now uses Observe → Decide → Act. Verify the new event flow instead.
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_SKIP' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Use new events to drive to REVIEWING
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    const envelope = makeEnvelope([{ type: 'send_to_reviewer', message: 'review it' }]);
    actor.send({ type: 'DECISION_READY', envelope });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    actor.send({ type: 'EXECUTION_COMPLETE', results: [] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    actor.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 2: God degradation fallback path
// ═══════════════════════════════════════════════════════════════════

describe('Scenario 2: God degradation path (AC-2)', () => {
  it('TASK_INIT God failure → fallback to CODING directly via TASK_INIT_SKIP', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'fix bug' });
    expect(actor.getSnapshot().value).toBe('TASK_INIT');

    const dm = new DegradationManager({ fallbackServices: createFallbackServices() });
    const failingAdapter = createFailingAdapter(new Error('God process crashed'));

    const { result, usedGod } = await withGodFallback(
      dm,
      async () => {
        const r = await initializeTask(failingAdapter, 'fix bug', 'sys', tmpDir);
        if (!r) throw new Error('TASK_INIT returned null');
        return r;
      },
      () => null, // fallback: no task analysis
      'process_exit',
    );

    expect(usedGod).toBe(false);
    expect(result).toBeNull();

    // State machine falls back: TASK_INIT_SKIP
    actor.send({ type: 'TASK_INIT_SKIP' });
    expect(actor.getSnapshot().value).toBe('CODING');
    actor.stop();
  });

  it('OBSERVING God failure → fallback to v1 ChoiceDetector via MANUAL_FALLBACK', async () => {
    const dm = new DegradationManager({ fallbackServices: createFallbackServices() });
    const failingAdapter = createFailingAdapter(new Error('God timeout'));

    const { result, usedGod } = await withGodFallback(
      dm,
      () => routePostCoder(failingAdapter, 'code output', {
        round: 0, maxRounds: 10, taskGoal: 'test', sessionDir: sessionDir(), seq: 1,
      }),
      () => ({ event: { type: 'OBSERVATIONS_READY' as const, observations: [makeObs()] }, decision: { action: 'continue_to_review' as const, reasoning: 'v1 fallback' }, rawOutput: '' }),
      'process_exit',
    );

    // After retry-fail cycle, should have fallen back
    expect(usedGod).toBe(false);
    expect(result.event.type).toBe('OBSERVATIONS_READY');
  });

  it('3 consecutive failures → L4 → God disabled for session', async () => {
    const dm = new DegradationManager({ fallbackServices: createFallbackServices() });
    const failingAdapter = createFailingAdapter(new Error('God crash'));

    // Failure 1 (triggers retry)
    await withGodFallback(
      dm,
      () => routePostCoder(failingAdapter, 'output', {
        round: 0, maxRounds: 10, taskGoal: 'test', sessionDir: sessionDir(), seq: 1,
      }),
      () => ({ event: { type: 'OBSERVATIONS_READY' as const, observations: [makeObs()] }, decision: { action: 'continue_to_review' as const, reasoning: 'fb' }, rawOutput: '' }),
      'process_exit',
    );
    // After withGodFallback: fail → retry → fail = 2 consecutive failures

    // Failure 3 (triggers L4)
    await withGodFallback(
      dm,
      () => routePostCoder(failingAdapter, 'output', {
        round: 1, maxRounds: 10, taskGoal: 'test', sessionDir: sessionDir(), seq: 2,
      }),
      () => ({ event: { type: 'OBSERVATIONS_READY' as const, observations: [makeObs()] }, decision: { action: 'continue_to_review' as const, reasoning: 'fb' }, rawOutput: '' }),
      'process_exit',
    );

    expect(dm.isGodAvailable()).toBe(false);
    expect(dm.getState().level).toBe('L4');
    expect(dm.getState().godDisabled).toBe(true);

    // Subsequent calls skip God entirely
    const goodAdapter = createMockAdapter({ action: 'continue_to_review', reasoning: 'OK' });
    const { usedGod } = await withGodFallback(
      dm,
      () => routePostCoder(goodAdapter, 'output', {
        round: 2, maxRounds: 10, taskGoal: 'test', sessionDir: sessionDir(), seq: 3,
      }),
      () => ({ event: { type: 'OBSERVATIONS_READY' as const, observations: [makeObs()] }, decision: { action: 'continue_to_review' as const, reasoning: 'fb' }, rawOutput: '' }),
      'process_exit',
    );

    expect(usedGod).toBe(false);
    // Good adapter should NOT have been called
    expect(goodAdapter.execute).not.toHaveBeenCalled();
  });

  it('full degradation workflow through state machine', async () => {
    const actor = startActor();

    // Step 1: TASK_INIT fails → skip
    actor.send({ type: 'START_TASK', prompt: 'task' });
    actor.send({ type: 'TASK_INIT_SKIP' });
    expect(actor.getSnapshot().value).toBe('CODING');

    // Step 2: CODING completes → OBSERVING
    actor.send({ type: 'CODE_COMPLETE', output: 'code output' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Step 3: Observations classified → GOD_DECIDING
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // Step 4: God fails → MANUAL_FALLBACK for user confirmation
    actor.send({ type: 'MANUAL_FALLBACK_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('MANUAL_FALLBACK');

    // Step 5: User accepts in MANUAL_FALLBACK → DONE
    actor.send({ type: 'USER_CONFIRM', action: 'accept' });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 3: Agent auto-decision in GOD_DECIDING
// ═══════════════════════════════════════════════════════════════════

describe('Scenario 3: Auto-decision in GOD_DECIDING (AC-3)', () => {
  it('God auto-decision: continue_with_instruction → DECISION_READY → EXECUTING → CODING', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'implement feature' });
    actor.send({ type: 'TASK_INIT_SKIP' });
    actor.send({ type: 'CODE_COMPLETE', output: 'v1' });
    // CODING → OBSERVING
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God makes auto-decision
    const godAdapter = createMockAdapter({
      action: 'continue_with_instruction',
      reasoning: 'Convergence reached but could improve error handling.',
      instruction: 'Add error handling to the login function',
    } satisfies GodAutoDecision);

    const noopRuleEngine = () => ({ blocked: false, results: [] });

    const result = await makeAutoDecision(godAdapter, {
      round: 1, maxRounds: 5, taskGoal: 'implement feature',
      sessionDir: sessionDir(), seq: 10, waitingReason: 'converged',
    }, noopRuleEngine);

    expect(result.decision.action).toBe('continue_with_instruction');
    expect(result.decision.instruction).toBe('Add error handling to the login function');
    expect(result.blocked).toBe(false);

    // Execute the decision via new event flow: DECISION_READY → EXECUTING → EXECUTION_COMPLETE
    const envelope = makeEnvelope([{ type: 'send_to_coder', message: 'Add error handling to the login function' }]);
    actor.send({ type: 'DECISION_READY', envelope });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CODING');
    // Round increments when EXECUTION_COMPLETE routes to CODING
    expect(actor.getSnapshot().context.round).toBe(1);

    actor.stop();
  });

  it('God auto-decision: accept → DECISION_READY → EXECUTING → DONE', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'task' });
    actor.send({ type: 'TASK_INIT_SKIP' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    const godAdapter = createMockAdapter({
      action: 'accept',
      reasoning: 'Task fully completed.',
    } satisfies GodAutoDecision);

    const result = await makeAutoDecision(godAdapter, {
      round: 0, maxRounds: 5, taskGoal: 'task',
      sessionDir: sessionDir(), seq: 5, waitingReason: 'converged',
    }, () => ({ blocked: false, results: [] }));

    expect(result.decision.action).toBe('accept');
    expect(result.blocked).toBe(false);

    // Via new flow: DECISION_READY with accept_task action → EXECUTING → DONE
    const envelopeAccept = makeEnvelope([
      { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Task complete' },
    ]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeAccept });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });

  it('God auto-decision: invalid request_human output falls back to autonomous continue', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'task' });
    actor.send({ type: 'TASK_INIT_SKIP' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    const godAdapter = createMockAdapter({
      action: 'request_human',
      reasoning: 'Ambiguous requirement, need human input.',
    });

    const result = await makeAutoDecision(godAdapter, {
      round: 0, maxRounds: 5, taskGoal: 'task',
      sessionDir: sessionDir(), seq: 5, waitingReason: 'converged',
    }, () => ({ blocked: false, results: [] }));

    expect(result.decision.action).toBe('continue_with_instruction');
    expect(result.reasoning).toContain('Local fallback');

    // State machine remains in GOD_DECIDING until the caller sends DECISION_READY.
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    actor.stop();
  });

  it('rule engine blocks suspicious continue_with_instruction', async () => {
    const godAdapter = createMockAdapter({
      action: 'continue_with_instruction',
      reasoning: 'Need to run system command.',
      instruction: 'rm -rf /etc/hosts',
    } satisfies GodAutoDecision);

    // Rule engine blocks dangerous commands
    const blockingRuleEngine = () => ({
      blocked: true,
      results: [{
        ruleId: 'R-002',
        level: 'block' as const,
        matched: true,
        description: 'System directory modification blocked',
      }],
    });

    const result = await makeAutoDecision(godAdapter, {
      round: 0, maxRounds: 5, taskGoal: 'task',
      sessionDir: sessionDir(), seq: 5, waitingReason: 'converged',
    }, blockingRuleEngine);

    expect(result.blocked).toBe(true);
    expect(result.decision.action).toBe('continue_with_instruction');
  });

  it('auto-decision writes audit log (AC-027)', async () => {
    const godAdapter = createMockAdapter({
      action: 'accept',
      reasoning: 'Complete.',
    } satisfies GodAutoDecision);

    await makeAutoDecision(godAdapter, {
      round: 1, maxRounds: 5, taskGoal: 'task',
      sessionDir: sessionDir(), seq: 10, waitingReason: 'converged',
    }, () => ({ blocked: false, results: [] }));

    expect(godAudit.appendAuditLog).toHaveBeenCalled();
    const calls = (godAudit.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1].decisionType).toBe('AUTO_DECISION');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 4: Compound task with phase transition
// ═══════════════════════════════════════════════════════════════════

describe('Scenario 4: Compound phase transition (AC-4)', () => {
  const phases: Phase[] = [
    { id: 'explore', name: 'Exploration', type: 'explore', description: 'Explore the codebase' },
    { id: 'code', name: 'Implementation', type: 'code', description: 'Implement the feature' },
    { id: 'review-final', name: 'Final Review', type: 'review', description: 'Final review' },
  ];

  it('TASK_INIT compound → phase transition via set_phase action → new phase CODING', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'compound task' });

    // God identifies compound task
    const taskAdapter = createMockAdapter({
      taskType: 'compound',
      reasoning: 'Multi-phase task: explore then code.',
      confidence: 0.85,
      suggestedMaxRounds: 10,
      terminationCriteria: ['Exploration complete', 'Feature implemented'],
      phases: phases.map(p => ({ id: p.id, name: p.name, type: p.type, description: p.description })),
    } satisfies GodTaskAnalysis);

    const taskResult = await initializeTask(taskAdapter, 'compound task', 'sys', tmpDir);
    expect(taskResult).not.toBeNull();
    expect(taskResult!.analysis.taskType).toBe('compound');
    expect(taskResult!.analysis.phases).toHaveLength(3);

    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 10 });
    expect(actor.getSnapshot().value).toBe('CODING');

    // ── Phase 1: explore ──
    actor.send({ type: 'CODE_COMPLETE', output: 'explored codebase' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides: send to reviewer
    const envelopeToReview = makeEnvelope([{ type: 'send_to_reviewer', message: 'Review exploration' }]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeToReview });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    actor.send({ type: 'REVIEW_COMPLETE', output: 'exploration looks complete' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God says phase_transition via legacy module (for module integration testing)
    const phaseTransitionAdapter = createMockAdapter({
      action: 'phase_transition',
      reasoning: 'Exploration complete, ready to implement.',
      confidenceScore: 0.9,
      progressTrend: 'improving',
      nextPhaseId: 'code',
    } satisfies GodPostReviewerDecision);

    const postReviewResult = await routePostReviewer(
      phaseTransitionAdapter,
      'exploration looks complete',
      { round: 0, maxRounds: 10, taskGoal: 'compound task', sessionDir: sessionDir(), seq: 3 },
    );

    expect(postReviewResult.event.type).toBe('PHASE_TRANSITION');

    // Evaluate phase transition via legacy module
    const convergenceLog: ConvergenceLogEntry[] = [{
      round: 0,
      timestamp: new Date().toISOString(),
      classification: 'approved',
      shouldTerminate: false,
      blockingIssueCount: 0,
      criteriaProgress: [{ criterion: 'Exploration complete', satisfied: true }],
      summary: 'Exploration phase complete',
    }];

    const currentPhase = phases[0];
    const godDecision = postReviewResult.decision as GodPostReviewerDecision;

    const transitionResult = evaluatePhaseTransition(currentPhase, phases, convergenceLog, godDecision);
    expect(transitionResult.shouldTransition).toBe(true);
    expect(transitionResult.nextPhaseId).toBe('code');
    expect(transitionResult.previousPhaseSummary).toContain('explore');

    // In Card D.1, phase transitions happen via set_phase action in the envelope.
    // God produces DECISION_READY with set_phase + send_to_coder actions.
    const envelopePhaseTransition = makeEnvelope([
      { type: 'set_phase', phaseId: 'code', summary: 'Exploration complete, transitioning to implementation' },
      { type: 'send_to_coder', message: 'Begin implementation phase' },
    ]);

    actor.send({ type: 'DECISION_READY', envelope: envelopePhaseTransition });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // EXECUTION_COMPLETE routes to CODING (round increments since send_to_coder was in actions)
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CODING');

    actor.stop();
  });

  it('self-transition guard prevents hallucinated nextPhaseId', () => {
    const convergenceLog: ConvergenceLogEntry[] = [];
    const godDecision: GodPostReviewerDecision = {
      action: 'phase_transition',
      reasoning: 'Transition to same phase (hallucination).',
      confidenceScore: 0.8,
      progressTrend: 'improving',
      nextPhaseId: 'explore', // same as current — hallucination
    };

    const result = evaluatePhaseTransition(phases[0], phases, convergenceLog, godDecision);
    expect(result.shouldTransition).toBe(false);
  });

  it('sequential phase fallback when nextPhaseId not specified', () => {
    const convergenceLog: ConvergenceLogEntry[] = [];
    const godDecision: GodPostReviewerDecision = {
      action: 'phase_transition',
      reasoning: 'Done with current phase.',
      confidenceScore: 0.8,
      progressTrend: 'improving',
      // no nextPhaseId — should use sequential next
    };

    const result = evaluatePhaseTransition(phases[0], phases, convergenceLog, godDecision);
    expect(result.shouldTransition).toBe(true);
    expect(result.nextPhaseId).toBe('code'); // sequential next after 'explore'
  });

  it('last phase cannot transition forward without explicit nextPhaseId', () => {
    const convergenceLog: ConvergenceLogEntry[] = [];
    const godDecision: GodPostReviewerDecision = {
      action: 'phase_transition',
      reasoning: 'Done.',
      confidenceScore: 0.8,
      progressTrend: 'improving',
    };

    const result = evaluatePhaseTransition(phases[2], phases, convergenceLog, godDecision);
    expect(result.shouldTransition).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 5: duo resume — session restoration
// ═══════════════════════════════════════════════════════════════════

describe('Scenario 5: duo resume (AC-5)', () => {
  it('restoreGodSession returns null because God adapters are stateless', async () => {
    const state: SessionState = {
      round: 3,
      status: 'CODING',
      currentRole: 'coder',
      godSessionId: 'god-session-abc',
      godAdapter: 'mock-god',
    };

    const adapterFactory = (name: string): CLIAdapter => createMockAdapter({ action: 'continue_to_review', reasoning: 'ok' });

    const result = await restoreGodSession(state, adapterFactory);
    expect(result).toBeNull();
  });

  it('restoreGodSession returns null when godSessionId missing (graceful degradation)', async () => {
    const state: SessionState = {
      round: 3,
      status: 'CODING',
      currentRole: 'coder',
      // no godSessionId
    };

    const result = await restoreGodSession(state, () => createMockAdapter({}));
    expect(result).toBeNull();
  });

  it('restoreGodSession returns null when adapterFactory throws', async () => {
    const state: SessionState = {
      round: 3,
      status: 'CODING',
      currentRole: 'coder',
      godSessionId: 'god-session-abc',
      godAdapter: 'unknown-adapter',
    };

    const result = await restoreGodSession(state, () => { throw new Error('Unknown adapter'); });
    expect(result).toBeNull();
  });

  it('taskAnalysis persisted and restored from SessionState', () => {
    const taskAnalysis: GodTaskAnalysis = {
      taskType: 'code',
      reasoning: 'Coding task.',
      confidence: 0.9,
      suggestedMaxRounds: 5,
      terminationCriteria: ['Tests pass'],
    };

    // Simulate save
    const state: SessionState = {
      round: 2,
      status: 'CODING',
      currentRole: 'coder',
      godTaskAnalysis: taskAnalysis,
    };

    // Simulate restore
    expect(state.godTaskAnalysis).toEqual(taskAnalysis);
    expect(state.godTaskAnalysis!.taskType).toBe('code');
    expect(state.godTaskAnalysis!.suggestedMaxRounds).toBe(5);
  });

  it('convergenceLog persisted and restored from SessionState', () => {
    const convergenceLog: ConvergenceLogEntry[] = [
      {
        round: 0,
        timestamp: '2026-03-12T00:00:00Z',
        classification: 'changes_requested',
        shouldTerminate: false,
        blockingIssueCount: 2,
        criteriaProgress: [{ criterion: 'Tests pass', satisfied: false }],
        summary: 'Round 0: changes_requested, blocking=2',
      },
      {
        round: 1,
        timestamp: '2026-03-12T00:01:00Z',
        classification: 'approved',
        shouldTerminate: true,
        blockingIssueCount: 0,
        criteriaProgress: [{ criterion: 'Tests pass', satisfied: true }],
        summary: 'Round 1: approved, blocking=0',
      },
    ];

    const state: SessionState = {
      round: 2,
      status: 'god_deciding',
      currentRole: 'coder',
      godConvergenceLog: convergenceLog,
    };

    expect(state.godConvergenceLog).toHaveLength(2);
    expect(state.godConvergenceLog![1].classification).toBe('approved');
    expect(state.godConvergenceLog![1].shouldTerminate).toBe(true);
  });

  it('degradationState persisted and restored via DegradationManager', () => {
    // Simulate L2 state with prior failures
    const dm1 = new DegradationManager({ fallbackServices: createFallbackServices() });
    dm1.handleGodFailure({ kind: 'process_exit', message: 'crash1' });
    dm1.handleGodFailure({ kind: 'process_exit', message: 'crash2' });

    const serialized = dm1.serializeState();
    expect(serialized.consecutiveFailures).toBe(2);
    expect(serialized.level).not.toBe('L1');

    // Simulate save to SessionState
    const state: SessionState = {
      round: 2,
      status: 'CODING',
      currentRole: 'coder',
      degradationState: serialized,
    };

    // Simulate restore
    const dm2 = new DegradationManager({
      fallbackServices: createFallbackServices(),
      restoredState: state.degradationState,
    });

    expect(dm2.getState().consecutiveFailures).toBe(2);
    expect(dm2.isGodAvailable()).toBe(true); // not L4 yet

    // One more failure → L4
    dm2.handleGodFailure({ kind: 'timeout', message: 'crash3' });
    expect(dm2.isGodAvailable()).toBe(false);
    expect(dm2.getState().level).toBe('L4');
  });

  it('full resume flow: RESUMING → CODING with restored God state', () => {
    // Step 1: Serialize workflow state using new event flow
    const actor1 = startActor({ maxRounds: 5 });
    actor1.send({ type: 'START_TASK', prompt: 'original task' });
    actor1.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 5 });
    // CODING → OBSERVING → GOD_DECIDING → EXECUTING → REVIEWING
    actor1.send({ type: 'CODE_COMPLETE', output: 'v1' });
    actor1.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    const envelopeToReview = makeEnvelope([{ type: 'send_to_reviewer', message: 'Review v1' }]);
    actor1.send({ type: 'DECISION_READY', envelope: envelopeToReview });
    actor1.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor1.getSnapshot().value).toBe('REVIEWING');

    // REVIEWING → OBSERVING → GOD_DECIDING → EXECUTING → CODING (round++)
    actor1.send({ type: 'REVIEW_COMPLETE', output: 'fix issues' });
    actor1.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
    const envelopeToCoder = makeEnvelope([{ type: 'send_to_coder', message: 'Fix issues' }]);
    actor1.send({ type: 'DECISION_READY', envelope: envelopeToCoder });
    actor1.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor1.getSnapshot().value).toBe('CODING');
    expect(actor1.getSnapshot().context.round).toBe(1);

    const snapshot = actor1.getPersistedSnapshot();
    actor1.stop();

    // Step 2: Restore from snapshot
    const actor2 = createActor(workflowMachine, { snapshot, input: {} });
    actor2.start();

    expect(actor2.getSnapshot().value).toBe('CODING');
    expect(actor2.getSnapshot().context.round).toBe(1);
    expect(actor2.getSnapshot().context.maxRounds).toBe(5);
    expect(actor2.getSnapshot().context.taskPrompt).toBe('original task');

    // Step 3: Continue workflow from restored state → DONE
    actor2.send({ type: 'CODE_COMPLETE', output: 'v2' });
    actor2.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    const envelopeToReview2 = makeEnvelope([{ type: 'send_to_reviewer', message: 'Review v2' }]);
    actor2.send({ type: 'DECISION_READY', envelope: envelopeToReview2 });
    actor2.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor2.getSnapshot().value).toBe('REVIEWING');

    actor2.send({ type: 'REVIEW_COMPLETE', output: '[APPROVED]' });
    actor2.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('review_output', 'reviewer')] });
    const envelopeAccept = makeEnvelope([
      { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Approved' },
    ]);
    actor2.send({ type: 'DECISION_READY', envelope: envelopeAccept });
    actor2.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor2.getSnapshot().value).toBe('DONE');

    actor2.stop();
  });

  it('resume via RESUME_SESSION event path', () => {
    const actor = startActor();
    actor.send({ type: 'RESUME_SESSION', sessionId: 'session-123' });
    expect(actor.getSnapshot().value).toBe('RESUMING');
    expect(actor.getSnapshot().context.sessionId).toBe('session-123');

    actor.send({ type: 'RESTORED_TO_CODING' });
    expect(actor.getSnapshot().value).toBe('CODING');

    // Can continue normal workflow from here
    actor.send({ type: 'CODE_COMPLETE', output: 'resumed code' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-cutting: withGodFallback integration with real modules
// ═══════════════════════════════════════════════════════════════════

describe('Cross-cutting: withGodFallback integration', () => {
  it('God success → usedGod=true, DM reset to L1', async () => {
    const dm = new DegradationManager({ fallbackServices: createFallbackServices() });
    // Add a prior failure
    dm.handleGodFailure({ kind: 'process_exit', message: 'prior' });
    expect(dm.getState().consecutiveFailures).toBe(1);

    const adapter = createMockAdapter({
      action: 'continue_to_review',
      reasoning: 'OK',
    } satisfies GodPostCoderDecision);

    const { result, usedGod } = await withGodFallback(
      dm,
      () => routePostCoder(adapter, 'output', {
        round: 0, maxRounds: 10, taskGoal: 'test', sessionDir: sessionDir(), seq: 1,
      }),
      () => ({ event: { type: 'OBSERVATIONS_READY' as const, observations: [makeObs()] }, decision: { action: 'continue_to_review' as const, reasoning: 'fb' }, rawOutput: '' }),
      'process_exit',
    );

    expect(usedGod).toBe(true);
    // routePostCoder still returns legacy event types for backward compat
    expect(result.event.type).toBe('ROUTE_TO_REVIEW');
    expect(dm.getState().consecutiveFailures).toBe(0);
    expect(dm.getState().level).toBe('L1');
  });

  it('withGodFallbackSync for prompt generation fallback', () => {
    const dm = new DegradationManager({ fallbackServices: createFallbackServices() });

    const { result, usedGod } = withGodFallbackSync(
      dm,
      () => 'God-generated prompt: Focus on error handling.',
      () => 'V1 prompt: Please review the code.',
    );

    expect(usedGod).toBe(true);
    expect(result).toBe('God-generated prompt: Focus on error handling.');
  });

  it('withGodFallbackSync catches throw and falls back', () => {
    const dm = new DegradationManager({ fallbackServices: createFallbackServices() });

    const { result, usedGod } = withGodFallbackSync(
      dm,
      () => { throw new Error('prompt gen failed'); },
      () => 'V1 fallback prompt',
    );

    expect(usedGod).toBe(false);
    expect(result).toBe('V1 fallback prompt');
  });
});
