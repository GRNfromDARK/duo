/**
 * Tests for Hand Executor (Card C.2)
 * Source: FR-007 (Structured Hand Catalog), FR-016 (State Changes Must Be Action-Backed)
 * Acceptance Criteria: AC-1 through AC-8
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GodAction } from '../../types/god-actions.js';
import type { Observation } from '../../types/observation.js';
import { GodAuditLogger } from '../../god/god-audit.js';
import {
  executeActions,
  type HandExecutionContext,
  type HandAdapter,
} from '../../god/hand-executor.js';

// ── Test Helpers ──

function createMockAdapter(shouldKillFail = false): HandAdapter {
  const killFn = shouldKillFail
    ? vi.fn(async () => { throw new Error('kill failed'); })
    : vi.fn(async () => {});
  return { kill: killFn };
}

function createContext(overrides: Partial<HandExecutionContext> = {}): HandExecutionContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-hand-exec-'));
  return {
    currentPhaseId: 'phase-1',
    pendingCoderMessage: null,
    pendingReviewerMessage: null,
    activeRole: null,
    taskCompleted: false,
    waitState: { active: false, reason: null, estimatedSeconds: null },
    clarificationState: { active: false, question: null },
    interruptResumeStrategy: null,
    adapters: new Map<string, HandAdapter>([
      ['coder', createMockAdapter()],
      ['reviewer', createMockAdapter()],
    ]),
    adapterConfig: new Map<string, string>([
      ['coder', 'claude-code'],
      ['reviewer', 'claude-code'],
      ['god', 'claude-code'],
    ]),
    auditLogger: new GodAuditLogger(tmpDir),
    sessionDir: tmpDir,
    cwd: tmpDir,
    ...overrides,
  };
}

function cleanupContext(ctx: HandExecutionContext): void {
  try {
    fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Tests ──

describe('HandExecutor', () => {
  let ctx: HandExecutionContext;

  beforeEach(() => {
    ctx = createContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
  });

  // ── AC-1: All 11 GodAction types have executor logic ──

  describe('AC-1: all 11 action types have executor logic', () => {
    it('send_to_coder sets pendingCoderMessage and activeRole', async () => {
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'Implement the login page' },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.pendingCoderMessage).toBe('Implement the login page');
      expect(ctx.activeRole).toBe('coder');
      expect(results).toHaveLength(1);
    });

    it('send_to_reviewer sets pendingReviewerMessage and activeRole', async () => {
      const actions: GodAction[] = [
        { type: 'send_to_reviewer', message: 'Review the implementation' },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.pendingReviewerMessage).toBe('Review the implementation');
      expect(ctx.activeRole).toBe('reviewer');
      expect(results).toHaveLength(1);
    });

    it('set_phase updates currentPhaseId', async () => {
      const actions: GodAction[] = [
        { type: 'set_phase', phaseId: 'phase-2', summary: 'Moving to review' },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.currentPhaseId).toBe('phase-2');
      expect(results).toHaveLength(1);
    });

    it('accept_task marks task completed', async () => {
      const actions: GodAction[] = [
        { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'All checks passed' },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.taskCompleted).toBe(true);
      expect(results).toHaveLength(1);
    });

    it('stop_role calls adapter.kill()', async () => {
      const coderAdapter = createMockAdapter();
      ctx.adapters.set('coder', coderAdapter);

      const actions: GodAction[] = [
        { type: 'stop_role', role: 'coder', reason: 'Quota exhausted' },
      ];

      const results = await executeActions(actions, ctx);

      expect(coderAdapter.kill).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('retry_role kills adapter and sets pending message with hint', async () => {
      const coderAdapter = createMockAdapter();
      ctx.adapters.set('coder', coderAdapter);

      const actions: GodAction[] = [
        { type: 'retry_role', role: 'coder', hint: 'Focus on edge cases' },
      ];

      const results = await executeActions(actions, ctx);

      expect(coderAdapter.kill).toHaveBeenCalled();
      expect(ctx.pendingCoderMessage).toBe('Focus on edge cases');
      expect(ctx.activeRole).toBe('coder');
      expect(results).toHaveLength(1);
    });

    it('retry_role without hint sets empty pending message', async () => {
      const reviewerAdapter = createMockAdapter();
      ctx.adapters.set('reviewer', reviewerAdapter);

      const actions: GodAction[] = [
        { type: 'retry_role', role: 'reviewer' },
      ];

      const results = await executeActions(actions, ctx);

      expect(reviewerAdapter.kill).toHaveBeenCalled();
      expect(ctx.pendingReviewerMessage).toBe('');
      expect(ctx.activeRole).toBe('reviewer');
      expect(results).toHaveLength(1);
    });

    it('switch_adapter returns warning observation indicating not yet implemented', async () => {
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'Performance' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe('warning');
      expect(results[0].summary).toContain('not yet implemented');
      // adapterConfig should NOT change since the action has no effect
      expect(ctx.adapterConfig.get('coder')).toBe('claude-code');
    });

    it('wait sets waitState', async () => {
      const actions: GodAction[] = [
        { type: 'wait', reason: 'Rate limited', estimatedSeconds: 300 },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.waitState.active).toBe(true);
      expect(ctx.waitState.reason).toBe('Rate limited');
      expect(ctx.waitState.estimatedSeconds).toBe(300);
      expect(results).toHaveLength(1);
    });

    it('request_user_input sets clarificationState', async () => {
      const actions: GodAction[] = [
        { type: 'request_user_input', question: 'Which approach do you prefer?' },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.clarificationState.active).toBe(true);
      expect(ctx.clarificationState.question).toBe('Which approach do you prefer?');
      expect(results).toHaveLength(1);
    });

    it('resume_after_interrupt sets interruptResumeStrategy', async () => {
      ctx.clarificationState = { active: true, question: 'test?' };

      const actions: GodAction[] = [
        { type: 'resume_after_interrupt', resumeStrategy: 'continue' },
      ];

      const results = await executeActions(actions, ctx);

      expect(ctx.interruptResumeStrategy).toBe('continue');
      expect(ctx.clarificationState.active).toBe(false);
      expect(results).toHaveLength(1);
    });

    it('emit_summary writes to audit', async () => {
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      const actions: GodAction[] = [
        { type: 'emit_summary', content: 'Task completed successfully' },
      ];

      const results = await executeActions(actions, ctx);

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'emit_summary',
          outputSummary: expect.stringContaining('Task completed successfully'),
        }),
      );
      expect(results).toHaveLength(1);
    });
  });

  // ── AC-2: Hand execution returns result Observation ──

  describe('AC-2: returns result observations', () => {
    it('each action returns an observation with source=runtime, type=phase_progress_signal', async () => {
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'do work' },
        { type: 'set_phase', phaseId: 'phase-2' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(2);
      for (const obs of results) {
        expect(obs.source).toBe('runtime');
        expect(obs.type).toBe('phase_progress_signal');
        expect(obs.timestamp).toBeDefined();
        // round field removed from observations
      }
    });

    it('observation summary describes the executed action', async () => {
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'implement feature' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results[0].summary).toContain('send_to_coder');
    });
  });

  // ── AC-3: set_phase updates context.currentPhaseId ──

  describe('AC-3: set_phase updates context', () => {
    it('updates currentPhaseId in context', async () => {
      expect(ctx.currentPhaseId).toBe('phase-1');

      await executeActions([{ type: 'set_phase', phaseId: 'phase-3' }], ctx);

      expect(ctx.currentPhaseId).toBe('phase-3');
    });

    it('records phase transition in audit log', async () => {
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      await executeActions(
        [{ type: 'set_phase', phaseId: 'phase-2', summary: 'Moving to review' }],
        ctx,
      );

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'phase_transition',
          outputSummary: expect.stringContaining('phase-2'),
        }),
      );
    });
  });

  // ── AC-4: accept_task records rationale to audit ──

  describe('AC-4: accept_task records rationale to audit', () => {
    it('logs rationale and summary to audit on accept_task', async () => {
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'God decided to accept' }],
        ctx,
      );

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'accept_task',
          outputSummary: expect.stringContaining('god_override'),
        }),
      );
    });

    it('logs reviewer_aligned rationale', async () => {
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      await executeActions(
        [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Reviewer approved' }],
        ctx,
      );

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'accept_task',
          outputSummary: expect.stringContaining('reviewer_aligned'),
        }),
      );
    });

    it('logs forced_stop rationale', async () => {
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      await executeActions(
        [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Forced to stop' }],
        ctx,
      );

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'accept_task',
          outputSummary: expect.stringContaining('forced_stop'),
        }),
      );
    });
  });

  // ── AC-5: Rule engine check before execution ──

  describe('AC-5: rule engine check before execution', () => {
    it('blocked action produces runtime_invariant_violation observation instead of executing', async () => {
      // Mock evaluateRules to return blocked for this test
      const ruleEngine = await import('../../god/rule-engine.js');
      const evalSpy = vi.spyOn(ruleEngine, 'evaluateRules').mockReturnValueOnce({
        blocked: true,
        results: [
          {
            ruleId: 'R-002',
            level: 'block',
            matched: true,
            description: 'System critical directory access',
            details: 'test block',
          },
        ],
      });

      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'test' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(results[0].summary).toContain('blocked');
      // Adapter config should NOT have changed (action was blocked)
      expect(ctx.adapterConfig.get('coder')).toBe('claude-code');

      evalSpy.mockRestore();
    });

    it('non-blocked action executes normally', async () => {
      const actions: GodAction[] = [
        { type: 'set_phase', phaseId: 'phase-2' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.currentPhaseId).toBe('phase-2');
    });
  });

  // ── AC-6: Execution failure generates runtime_invariant_violation ──

  describe('AC-6: execution failure generates violation observation', () => {
    it('generates runtime_invariant_violation when adapter.kill() fails', async () => {
      const failingAdapter = createMockAdapter(true); // kill() throws
      ctx.adapters.set('coder', failingAdapter);

      const actions: GodAction[] = [
        { type: 'stop_role', role: 'coder', reason: 'test stop' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(results[0].severity).toBe('error');
      expect(results[0].summary).toContain('stop_role');
    });

    it('continues executing remaining actions after one fails', async () => {
      const failingAdapter = createMockAdapter(true);
      ctx.adapters.set('coder', failingAdapter);

      const actions: GodAction[] = [
        { type: 'stop_role', role: 'coder', reason: 'will fail' },
        { type: 'set_phase', phaseId: 'phase-2' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(2);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(results[1].type).toBe('phase_progress_signal');
      expect(ctx.currentPhaseId).toBe('phase-2');
    });
  });

  // ── Sequential execution ──

  describe('sequential execution', () => {
    it('executes actions in order, each seeing the state from previous', async () => {
      const actions: GodAction[] = [
        { type: 'set_phase', phaseId: 'phase-2' },
        { type: 'send_to_coder', message: 'work in phase 2' },
        { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results).toHaveLength(3);
      expect(ctx.currentPhaseId).toBe('phase-2');
      expect(ctx.pendingCoderMessage).toBe('work in phase 2');
      expect(ctx.taskCompleted).toBe(true);
    });

    it('returns empty array for empty actions', async () => {
      const results = await executeActions([], ctx);
      expect(results).toEqual([]);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('stop_role with missing adapter still returns observation', async () => {
      ctx.adapters.clear();

      const actions: GodAction[] = [
        { type: 'stop_role', role: 'coder', reason: 'no adapter' },
      ];

      const results = await executeActions(actions, ctx);

      // Should produce a violation since adapter is missing
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('runtime');
    });

    it('switch_adapter for god role also returns not-implemented warning', async () => {
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'god', adapter: 'codex', reason: 'Fallback' },
      ];

      const results = await executeActions(actions, ctx);

      expect(results[0].severity).toBe('warning');
      expect(results[0].summary).toContain('not yet implemented');
      expect(ctx.adapterConfig.get('god')).toBe('claude-code');
    });

    it('resume_after_interrupt with stop strategy', async () => {
      ctx.clarificationState = { active: true, question: 'test?' };

      const actions: GodAction[] = [
        { type: 'resume_after_interrupt', resumeStrategy: 'stop' },
      ];

      await executeActions(actions, ctx);

      expect(ctx.interruptResumeStrategy).toBe('stop');
      expect(ctx.clarificationState.active).toBe(false);
    });

    it('wait without estimatedSeconds', async () => {
      const actions: GodAction[] = [
        { type: 'wait', reason: 'Waiting for user' },
      ];

      await executeActions(actions, ctx);

      expect(ctx.waitState.active).toBe(true);
      expect(ctx.waitState.reason).toBe('Waiting for user');
      expect(ctx.waitState.estimatedSeconds).toBeNull();
    });
  });

  // ── Regression: BUG-3 (P2) — auditLogger null safety ──
  describe('regression: auditLogger null does not crash actions', () => {
    function createNullLoggerContext(overrides: Partial<HandExecutionContext> = {}): HandExecutionContext {
      return {
        currentPhaseId: 'phase-1',
        pendingCoderMessage: null,
        pendingReviewerMessage: null,
        activeRole: null,
        taskCompleted: false,
        waitState: { active: false, reason: null, estimatedSeconds: null },
        clarificationState: { active: false, question: null },
        interruptResumeStrategy: null,
        adapters: new Map<string, HandAdapter>([
          ['coder', createMockAdapter()],
          ['reviewer', createMockAdapter()],
        ]),
        adapterConfig: new Map<string, string>([
          ['coder', 'claude-code'],
          ['reviewer', 'claude-code'],
        ]),
        auditLogger: null,
        sessionDir: '/tmp/test-null-logger',
        cwd: '/tmp/test-null-logger',
        ...overrides,
      };
    }

    it('set_phase succeeds with null auditLogger', async () => {
      const nullCtx = createNullLoggerContext();
      const actions: GodAction[] = [
        { type: 'set_phase', phaseId: 'phase-2', summary: 'Moving on' },
      ];

      const results = await executeActions(actions, nullCtx);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(nullCtx.currentPhaseId).toBe('phase-2');
    });

    it('accept_task succeeds with null auditLogger', async () => {
      const nullCtx = createNullLoggerContext();
      const actions: GodAction[] = [
        { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Done' },
      ];

      const results = await executeActions(actions, nullCtx);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(nullCtx.taskCompleted).toBe(true);
    });

    it('emit_summary succeeds with null auditLogger', async () => {
      const nullCtx = createNullLoggerContext();
      const actions: GodAction[] = [
        { type: 'emit_summary', content: 'Summary text' },
      ];

      const results = await executeActions(actions, nullCtx);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
    });

    it('multiple actions with null auditLogger all succeed without violation', async () => {
      const nullCtx = createNullLoggerContext();
      const actions: GodAction[] = [
        { type: 'set_phase', phaseId: 'phase-2', summary: 'Start' },
        { type: 'send_to_coder', message: 'Do work' },
        { type: 'accept_task', rationale: 'forced_stop', summary: 'Forced' },
        { type: 'emit_summary', content: 'All done' },
      ];

      const results = await executeActions(actions, nullCtx);

      expect(results).toHaveLength(4);
      // None should be violations
      for (const obs of results) {
        expect(obs.type).toBe('phase_progress_signal');
      }
    });
  });
});
