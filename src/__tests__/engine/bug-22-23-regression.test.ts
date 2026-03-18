/**
 * Regression tests for BUG-22 and BUG-23.
 *
 * BUG-22 [P0]: Fallback envelope death spiral.
 *   buildFallbackEnvelope returns actions: [] → executeActions returns [] →
 *   currentObservations replaced with [] → next God call has no context →
 *   produces another bad output → infinite loop with no progress.
 *   Fix: (a) buildFallbackEnvelope includes a wait action instead of empty actions.
 *   (b) Workflow machine preserves observations when execution results are empty.
 *
 * BUG-23 [P1]: God extraction failures lose diagnostic info.
 *   extractWithRetry returns null for all failure paths, losing the specific
 *   error (no JSON block? parse error? schema validation?) and the raw output.
 *   Fix: Return structured error details instead of null. Add fallback extraction
 *   for common LLM output variations (case-insensitive code fences, bare JSON).
 */

import { describe, it, expect, vi } from 'vitest';
import { createActor } from 'xstate';
import { workflowMachine, type WorkflowContext } from '../../engine/workflow-machine.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import { GodDecisionEnvelopeSchema } from '../../types/god-envelope.js';
import { extractWithRetry, extractGodJson } from '../../parsers/god-json-extractor.js';
import { stripAnsiEscapes } from '../../god/god-decision-service.js';
import { createMockWatchdog } from '../helpers/mock-watchdog.js';

// ── Shared helpers ──

function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
}

function makeObs(
  type: Observation['type'] = 'work_output',
  source: Observation['source'] = 'coder',
  summary = `test ${type}`,
): Observation {
  return { source, type, summary, severity: 'info', timestamp: new Date().toISOString()};
}

function makeEnvelope(
  actions: GodDecisionEnvelope['actions'] = [],
  messages: GodDecisionEnvelope['messages'] = [],
): GodDecisionEnvelope {
  return {
    diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions,
    messages: messages.length > 0 ? messages : [{ target: 'system_log', content: 'log' }],
  };
}

// ══════════════════════════════════════════════════════════════════
// BUG-22 [P0]: Fallback envelope death spiral
// ══════════════════════════════════════════════════════════════════

describe('BUG-22 regression: fallback envelope must not lose observations', () => {
  describe('buildFallbackEnvelope has meaningful actions', () => {
    it('fallback envelope from god-decision-service includes a wait action', async () => {
      // Import buildFallbackEnvelope indirectly by testing the module
      const { GodDecisionService } = await import('../../god/god-decision-service.js');

      // Create a mock adapter that always throws (simulating adapter failure)
      const mockAdapter = {
        name: 'mock',
        displayName: 'Mock',
        version: '0.0.0',
        toolUsePolicy: 'forbid' as const,
        isInstalled: async () => true,
        getVersion: async () => '0.0.0',
        buildArgs: () => [],
        execute: async function* () {
          throw new Error('Simulated adapter failure');
        },
        kill: async () => {},
        isRunning: () => false,
      };

      const service = new GodDecisionService(mockAdapter, createMockWatchdog());

      const envelope = await service.makeDecision(
        [makeObs('work_output', 'coder', 'Coder did some work')],
        {
          taskGoal: 'test task',
          currentPhaseId: 'phase-1',
          previousDecisions: [],
          availableAdapters: ['mock'],
          activeRole: null,
          sessionDir: '/tmp/test-bug22',
        },
      );

      // BUG-22 fix: fallback envelope should have at least one action (wait)
      // so that observations flow correctly through the execution pipeline
      expect(envelope.actions.length).toBeGreaterThan(0);
      expect(envelope.actions[0].type).toBe('wait');
    });
  });

  describe('workflow machine preserves observations when execution results are empty', () => {
    it('observations are preserved when EXECUTION_COMPLETE has empty results', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });

      // Coder completes
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });

      // Observations classified
      const coderObs = makeObs('work_output', 'coder', 'Important coder analysis');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [coderObs] });

      // God decision ready (with empty actions, like fallback)
      actor.send({
        type: 'DECISION_READY',
        envelope: makeEnvelope([]),
      });

      expect(actor.getSnapshot().value).toBe('EXECUTING');

      // Execution complete with empty results (fallback scenario)
      actor.send({ type: 'EXECUTION_COMPLETE', results: [] });

      // BUG-22 fix: should re-enter GOD_DECIDING with preserved observations
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      const ctx = actor.getSnapshot().context;
      expect(ctx.currentObservations.length).toBeGreaterThan(0);
      expect(ctx.currentObservations[0].summary).toBe('Important coder analysis');

      actor.stop();
    });

    it('observations are replaced normally when execution produces new results', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });

      actor.send({ type: 'CODE_COMPLETE', output: 'done' });

      const coderObs = makeObs('work_output', 'coder', 'Old observation');
      actor.send({ type: 'OBSERVATIONS_READY', observations: [coderObs] });

      actor.send({
        type: 'DECISION_READY',
        envelope: makeEnvelope([{ type: 'wait', reason: 'test' }]),
      });

      const newObs = makeObs('phase_progress_signal', 'runtime', 'New execution result');
      actor.send({ type: 'EXECUTION_COMPLETE', results: [newObs] });

      // Normal case: observations should be replaced with execution results
      expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
      const ctx = actor.getSnapshot().context;
      expect(ctx.currentObservations).toHaveLength(1);
      expect(ctx.currentObservations[0].summary).toBe('New execution result');

      actor.stop();
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-23 [P1]: God extraction robustness
// ══════════════════════════════════════════════════════════════════

describe('BUG-23 regression: extraction robustness for God output', () => {
  const validEnvelopeJson = JSON.stringify({
    diagnosis: { summary: 'test', currentGoal: 'goal', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions: [{ type: 'send_to_coder', message: 'implement feature' }],
    messages: [{ target: 'system_log', content: 'log entry' }],
  });

  describe('extractGodJson handles case-insensitive code fences', () => {
    it('extracts JSON from ```JSON (uppercase) code block', () => {
      const output = '```JSON\n' + validEnvelopeJson + '\n```';
      const result = extractGodJson(output, GodDecisionEnvelopeSchema);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });

    it('extracts JSON from ```Json (mixed case) code block', () => {
      const output = '```Json\n' + validEnvelopeJson + '\n```';
      const result = extractGodJson(output, GodDecisionEnvelopeSchema);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });
  });

  describe('extractGodJson handles bare JSON without code fences', () => {
    it('extracts valid envelope from bare JSON output', () => {
      const output = validEnvelopeJson;
      const result = extractGodJson(output, GodDecisionEnvelopeSchema);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });

    it('extracts valid envelope from JSON with leading/trailing text', () => {
      const output = 'Here is my decision:\n' + validEnvelopeJson + '\n\nThat is my analysis.';
      const result = extractGodJson(output, GodDecisionEnvelopeSchema);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });
  });

  describe('extractWithRetry returns error details instead of null', () => {
    it('returns error result with details when no JSON block found', async () => {
      const output = 'This is just plain text with no JSON';
      const result = await extractWithRetry(
        output,
        GodDecisionEnvelopeSchema,
        async () => 'still no JSON here',
      );

      // BUG-23 fix: should return error details, not null
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      if (!result!.success) {
        expect(result!.error.toLowerCase()).toContain('no json');
      }
    });

    it('returns error result with Zod details when schema validation fails', async () => {
      const invalidJson = JSON.stringify({ diagnosis: 'wrong type' });
      const output = '```json\n' + invalidJson + '\n```';
      const retryOutput = '```json\n' + invalidJson + '\n```';

      const result = await extractWithRetry(
        output,
        GodDecisionEnvelopeSchema,
        async () => retryOutput,
      );

      // BUG-23 fix: should return error details, not null
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      if (!result!.success) {
        expect(result!.error).toBeTruthy();
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// Task input sanitization: strip terminal escape sequences
// ══════════════════════════════════════════════════════════════════

describe('Task input sanitization', () => {
  it('strips ANSI escape sequences from task text', () => {
    const dirty = 'Build a feature[<0;168;54M[<0;168;54m';
    expect(stripAnsiEscapes(dirty)).toBe('Build a feature');
  });

  it('preserves clean task text unchanged', () => {
    const clean = 'Build a login page with OAuth support';
    expect(stripAnsiEscapes(clean)).toBe(clean);
  });

  it('strips standard ANSI color codes', () => {
    const colored = '\x1b[31mError\x1b[0m: something failed';
    expect(stripAnsiEscapes(colored)).toBe('Error: something failed');
  });
});
