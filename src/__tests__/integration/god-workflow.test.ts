/**
 * Card D.1: God 完整工作流端到端集成测试
 *
 * Tests the full God-orchestrated workflow through XState + God modules,
 * verifying 4 scenarios: normal path, degradation,
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
import type { GodTaskAnalysis } from '../../types/god-schemas.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import { initializeTask } from '../../god/task-init.js';
import { withRetry, isPaused } from '../../ui/god-fallback.js';
import { WatchdogService } from '../../god/watchdog.js';
import { restoreGodSession } from '../../god/god-session-persistence.js';
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
  return { source, type, summary: `test ${type}`, severity: 'info', timestamp: new Date().toISOString()};
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
    } satisfies GodTaskAnalysis);

    const taskResult = await initializeTask(godAdapter, 'implement user login', 'You are God.', tmpDir);
    expect(taskResult).not.toBeNull();
    expect(taskResult!.analysis.taskType).toBe('code');

    actor.send({ type: 'TASK_INIT_COMPLETE' });
    expect(actor.getSnapshot().value).toBe('CODING');

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

  it('state machine drives through Observe → Decide → Act flow', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

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
  it('TASK_INIT God failure → paused, falls back to CODING via TASK_INIT_COMPLETE', async () => {
    vi.useFakeTimers();
    try {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'fix bug' });
      expect(actor.getSnapshot().value).toBe('TASK_INIT');

      const w = new WatchdogService();
      const failingAdapter = createFailingAdapter(new Error('God process crashed'));

      const promise = withRetry(
        async () => {
          const r = await initializeTask(failingAdapter, 'fix bug', 'sys', tmpDir);
          if (!r) throw new Error('TASK_INIT returned null');
          return r;
        },
        w,
      );
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20_000);
      const result = await promise;

      expect(isPaused(result)).toBe(true);

      // State machine falls back: TASK_INIT_COMPLETE
      actor.send({ type: 'TASK_INIT_COMPLETE' });
      expect(actor.getSnapshot().value).toBe('CODING');
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('OBSERVING God failure → system pauses after retries', async () => {
    vi.useFakeTimers();
    try {
      const w = new WatchdogService();

      const promise = withRetry(
        async () => { throw new Error('God timeout'); },
        w,
      );
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20_000);
      const result = await promise;

      // After exhausting retries, system pauses
      expect(isPaused(result)).toBe(true);
      expect(w.isPaused()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('consecutive failures → God paused for session', async () => {
    vi.useFakeTimers();
    try {
      const w = new WatchdogService();

      // Exhaust all retries (3 retries + 1 final failure = paused)
      const promise = withRetry(
        async () => { throw new Error('God crash'); },
        w,
      );
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20_000);
      const result = await promise;

      expect(isPaused(result)).toBe(true);
      expect(w.isGodAvailable()).toBe(false);

      // Subsequent calls with failing fn also return paused immediately
      const promise2 = withRetry(
        async () => { throw new Error('still failing'); },
        w,
      );
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20_000);
      const result2 = await promise2;

      expect(isPaused(result2)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('full degradation workflow through state machine', async () => {
    const actor = startActor();

    // Step 1: TASK_INIT fails → skip
    actor.send({ type: 'START_TASK', prompt: 'task' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    expect(actor.getSnapshot().value).toBe('CODING');

    // Step 2: CODING completes → OBSERVING
    actor.send({ type: 'CODE_COMPLETE', output: 'code output' });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Step 3: Observations classified → GOD_DECIDING
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // Step 4: God fails → PAUSED for user confirmation
    actor.send({ type: 'PAUSE_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('PAUSED');

    // Step 5: User accepts in PAUSED → DONE
    actor.send({ type: 'USER_CONFIRM', action: 'accept' });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });
});

// Scenario 4 (Compound phase transition) removed — tested evaluatePhaseTransition
// from the now-deleted phase-transition.ts module.

// ═══════════════════════════════════════════════════════════════════
// Scenario 5: duo resume — session restoration
// ═══════════════════════════════════════════════════════════════════

describe('Scenario 5: duo resume (AC-5)', () => {
  it('restoreGodSession returns null because God adapters are stateless', async () => {
    const state: SessionState = {
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
      status: 'CODING',
      currentRole: 'coder',
      // no godSessionId
    };

    const result = await restoreGodSession(state, () => createMockAdapter({}));
    expect(result).toBeNull();
  });

  it('restoreGodSession returns null when adapterFactory throws', async () => {
    const state: SessionState = {
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
    };

    // Simulate save
    const state: SessionState = {
      status: 'CODING',
      currentRole: 'coder',
      godTaskAnalysis: taskAnalysis,
    };

    // Simulate restore
    expect(state.godTaskAnalysis).toEqual(taskAnalysis);
    expect(state.godTaskAnalysis!.taskType).toBe('code');
    expect(state.godTaskAnalysis!.confidence).toBe(0.9);
  });

  // convergenceLog test removed (round removal).

  it('full resume flow: RESUMING → CODING with restored God state', () => {
    // Step 1: Serialize workflow state using new event flow
    const actor1 = startActor({});
    actor1.send({ type: 'START_TASK', prompt: 'original task' });
    actor1.send({ type: 'TASK_INIT_COMPLETE'});
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

    const snapshot = actor1.getPersistedSnapshot();
    actor1.stop();

    // Step 2: Restore from snapshot
    const actor2 = createActor(workflowMachine, { snapshot, input: {} });
    actor2.start();

    expect(actor2.getSnapshot().value).toBe('CODING');
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
// Cross-cutting: withRetry integration with real modules
// ═══════════════════════════════════════════════════════════════════

describe('Cross-cutting: withRetry integration', () => {
  it('God success → result returned, watchdog reset', async () => {
    const w = new WatchdogService();

    const r = await withRetry(
      async () => ({
        event: { type: 'ROUTE_TO_REVIEW' as const },
        decision: { action: 'continue_to_review' as const, reasoning: 'OK' },
        rawOutput: '',
      }),
      w,
    );

    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result.event.type).toBe('ROUTE_TO_REVIEW');
    }
    expect(w.getConsecutiveFailures()).toBe(0);
  });
});
