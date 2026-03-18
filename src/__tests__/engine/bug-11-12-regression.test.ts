/**
 * Regression tests for BUG-11 [P1] and BUG-12 [P2].
 *
 * BUG-11 [P1]: pendingReviewerInstructionRef missing — God's reviewer instructions
 *   via send_to_reviewer or envelope messages are not stored/consumed in REVIEWING.
 *   Fix: Added pendingReviewerInstructionRef, saved in GOD_DECIDING and EXECUTING,
 *   consumed in REVIEWING useEffect.
 *
 * BUG-12 [P2]: resolvePostExecutionTarget silently ignores multiple routing actions.
 *   Fix: Added detectRoutingConflicts() to detect and warn when multiple routing
 *   actions exist in a single envelope.
 */
import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import {
  workflowMachine,
  detectRoutingConflicts,
  type WorkflowContext,
} from '../../engine/workflow-machine.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import { dispatchMessages, type DispatchContext } from '../../god/message-dispatcher.js';
import { executeActions, type HandExecutionContext, type HandAdapter } from '../../god/hand-executor.js';
import { GodAuditLogger } from '../../god/god-audit.js';
import { vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Shared helpers ──

function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
}

function makeObs(type: Observation['type'] = 'work_output', source: Observation['source'] = 'coder'): Observation {
  return { source, type, summary: `test ${type}`, severity: 'info', timestamp: new Date().toISOString()};
}

function makeEnvelope(actions: GodDecisionEnvelope['actions'] = [], messages: GodDecisionEnvelope['messages'] = []): GodDecisionEnvelope {
  return {
    diagnosis: { summary: 'test', currentGoal: 'test', currentPhaseId: 'p1', notableObservations: [] },
    authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
    actions,
    messages: messages.length > 0 ? messages : [{ target: 'system_log', content: 'log' }],
  };
}

function createHandContext(overrides: Partial<HandExecutionContext> = {}): HandExecutionContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug-11-12-'));
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
      ['coder', { kill: vi.fn(async () => {}) }],
      ['reviewer', { kill: vi.fn(async () => {}) }],
    ]),
    adapterConfig: new Map<string, string>([
      ['coder', 'claude-code'],
      ['reviewer', 'claude-code'],
    ]),
    auditLogger: new GodAuditLogger(tmpDir),
    sessionDir: tmpDir,
    cwd: tmpDir,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════
// BUG-11 [P1]: God's reviewer instructions must be stored and consumable
// ══════════════════════════════════════════════════════════════════

describe('BUG-11 regression: pendingReviewerMessage propagation', () => {
  describe('dispatchMessages returns pendingReviewerMessage from envelope messages', () => {
    it('reviewer-targeted message is captured in DispatchResult.pendingReviewerMessage', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug11-'));
      const ctx: DispatchContext = {
        pendingCoderMessage: null,
        pendingReviewerMessage: null,
        displayToUser: vi.fn(),
        auditLogger: new GodAuditLogger(tmpDir),
      };

      const result = dispatchMessages(
        [{ target: 'reviewer', content: 'Focus on security vulnerabilities' }],
        ctx,
      );

      expect(result.pendingReviewerMessage).toBe('Focus on security vulnerabilities');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('both coder and reviewer messages are captured independently', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug11-'));
      const ctx: DispatchContext = {
        pendingCoderMessage: null,
        pendingReviewerMessage: null,
        displayToUser: vi.fn(),
        auditLogger: new GodAuditLogger(tmpDir),
      };

      const result = dispatchMessages(
        [
          { target: 'coder', content: 'Implement the feature' },
          { target: 'reviewer', content: 'Review the implementation' },
        ],
        ctx,
      );

      expect(result.pendingCoderMessage).toBe('Implement the feature');
      expect(result.pendingReviewerMessage).toBe('Review the implementation');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('hand executor stores pendingReviewerMessage from send_to_reviewer', () => {
    it('send_to_reviewer action sets pendingReviewerMessage on HandExecutionContext', async () => {
      const ctx = createHandContext();
      try {
        await executeActions(
          [{ type: 'send_to_reviewer', message: 'Check for edge cases' }],
          ctx,
        );

        expect(ctx.pendingReviewerMessage).toBe('Check for edge cases');
      } finally {
        fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
      }
    });

    it('send_to_coder and send_to_reviewer in same envelope both store their messages', async () => {
      const ctx = createHandContext();
      try {
        await executeActions(
          [
            { type: 'send_to_coder', message: 'Implement feature' },
            { type: 'send_to_reviewer', message: 'Review after coder' },
          ],
          ctx,
        );

        expect(ctx.pendingCoderMessage).toBe('Implement feature');
        expect(ctx.pendingReviewerMessage).toBe('Review after coder');
      } finally {
        fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
      }
    });
  });

  describe('workflow machine routes send_to_reviewer to REVIEWING state', () => {
    it('send_to_reviewer routes from EXECUTING to REVIEWING', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });

      // Advance to EXECUTING with send_to_reviewer
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      actor.send({
        type: 'DECISION_READY',
        envelope: makeEnvelope([{ type: 'send_to_reviewer', message: 'Review this' }]),
      });

      expect(actor.getSnapshot().value).toBe('EXECUTING');

      actor.send({
        type: 'EXECUTION_COMPLETE',
        results: [makeObs('phase_progress_signal', 'runtime')],
      });

      expect(actor.getSnapshot().value).toBe('REVIEWING');
      expect(actor.getSnapshot().context.activeProcess).toBe('reviewer');
      actor.stop();
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-12 [P2]: detectRoutingConflicts detects multiple routing actions
// ══════════════════════════════════════════════════════════════════

describe('BUG-12 regression: multiple routing action conflict detection', () => {
  describe('detectRoutingConflicts', () => {
    it('returns empty array for null envelope', () => {
      expect(detectRoutingConflicts(null)).toEqual([]);
    });

    it('returns empty array for envelope with no actions', () => {
      const envelope = makeEnvelope([]);
      expect(detectRoutingConflicts(envelope)).toEqual([]);
    });

    it('returns empty array for single routing action', () => {
      const envelope = makeEnvelope([
        { type: 'send_to_coder', message: 'implement' },
      ]);
      expect(detectRoutingConflicts(envelope)).toEqual([]);
    });

    it('returns empty array for non-routing actions only', () => {
      const envelope = makeEnvelope([
        { type: 'set_phase', phaseId: 'p2', summary: 'Next phase' },
        { type: 'emit_summary', content: 'Summary text' },
      ]);
      expect(detectRoutingConflicts(envelope)).toEqual([]);
    });

    it('returns empty array for single routing action mixed with non-routing', () => {
      const envelope = makeEnvelope([
        { type: 'set_phase', phaseId: 'p2', summary: 'Phase 2' },
        { type: 'send_to_reviewer', message: 'review this' },
        { type: 'emit_summary', content: 'Summary' },
      ]);
      expect(detectRoutingConflicts(envelope)).toEqual([]);
    });

    it('detects conflict: send_to_coder + send_to_reviewer', () => {
      const envelope = makeEnvelope([
        { type: 'send_to_coder', message: 'implement feature' },
        { type: 'send_to_reviewer', message: 'review previous code' },
      ]);
      const conflicts = detectRoutingConflicts(envelope);
      expect(conflicts).toEqual(['send_to_coder', 'send_to_reviewer']);
    });

    it('detects conflict: send_to_coder + accept_task', () => {
      const envelope = makeEnvelope([
        { type: 'send_to_coder', message: 'implement' },
        { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done' },
      ]);
      const conflicts = detectRoutingConflicts(envelope);
      expect(conflicts).toEqual(['send_to_coder', 'accept_task']);
    });

    it('detects conflict: request_user_input + send_to_reviewer', () => {
      const envelope = makeEnvelope([
        { type: 'request_user_input', question: 'What scope?' },
        { type: 'send_to_reviewer', message: 'review' },
      ]);
      const conflicts = detectRoutingConflicts(envelope);
      expect(conflicts).toEqual(['request_user_input', 'send_to_reviewer']);
    });

    it('detects conflict: retry_role + resume_after_interrupt', () => {
      const envelope = makeEnvelope([
        { type: 'retry_role', role: 'coder', hint: 'try again' },
        { type: 'resume_after_interrupt', resumeStrategy: 'continue' },
      ]);
      const conflicts = detectRoutingConflicts(envelope);
      expect(conflicts).toEqual(['retry_role', 'resume_after_interrupt']);
    });

    it('detects conflict with three routing actions', () => {
      const envelope = makeEnvelope([
        { type: 'send_to_coder', message: 'code' },
        { type: 'send_to_reviewer', message: 'review' },
        { type: 'accept_task', rationale: 'forced_stop', summary: 'stop' },
      ]);
      const conflicts = detectRoutingConflicts(envelope);
      expect(conflicts).toHaveLength(3);
      expect(conflicts).toContain('send_to_coder');
      expect(conflicts).toContain('send_to_reviewer');
      expect(conflicts).toContain('accept_task');
    });
  });

  describe('resolvePostExecutionTarget still uses first routing action', () => {
    it('send_to_coder takes priority over send_to_reviewer when first', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      actor.send({
        type: 'DECISION_READY',
        envelope: makeEnvelope([
          { type: 'send_to_coder', message: 'code' },
          { type: 'send_to_reviewer', message: 'review' },
        ]),
      });

      expect(actor.getSnapshot().value).toBe('EXECUTING');

      actor.send({
        type: 'EXECUTION_COMPLETE',
        results: [makeObs('phase_progress_signal', 'runtime')],
      });

      // First routing action wins: send_to_coder → CODING
      expect(actor.getSnapshot().value).toBe('CODING');
      actor.stop();
    });

    it('send_to_reviewer takes priority when it comes first', () => {
      const actor = startActor();
      actor.send({ type: 'START_TASK', prompt: 'test' });
      actor.send({ type: 'TASK_INIT_COMPLETE' });
      actor.send({ type: 'CODE_COMPLETE', output: 'done' });
      actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs()] });
      actor.send({
        type: 'DECISION_READY',
        envelope: makeEnvelope([
          { type: 'send_to_reviewer', message: 'review' },
          { type: 'send_to_coder', message: 'code' },
        ]),
      });

      actor.send({
        type: 'EXECUTION_COMPLETE',
        results: [makeObs('phase_progress_signal', 'runtime')],
      });

      // First routing action wins: send_to_reviewer → REVIEWING
      expect(actor.getSnapshot().value).toBe('REVIEWING');
      actor.stop();
    });
  });
});
