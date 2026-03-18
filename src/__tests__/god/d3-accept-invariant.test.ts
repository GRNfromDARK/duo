/**
 * Tests for Card D.3: Accept Rationale + Action-Backed enforcement
 * Source: FR-016 (State Changes Must Be Action-Backed), FR-017 (Accept Must Carry Rationale)
 * Acceptance Criteria: AC-1 through AC-8
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GodAction } from '../../types/god-actions.js';
import type { EnvelopeMessage } from '../../types/god-envelope.js';
import { GodAuditLogger } from '../../god/god-audit.js';
import {
  executeActions,
  type HandExecutionContext,
  type HandAdapter,
} from '../../god/hand-executor.js';
import {
  checkNLInvariantViolations,
} from '../../god/message-dispatcher.js';

// ── Test Helpers ──

function createMockAdapter(): HandAdapter {
  return { kill: vi.fn(async () => {}) };
}

function createContext(overrides: Partial<HandExecutionContext> = {}): HandExecutionContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-d3-test-'));
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

// ══════════════════════════════════════════════════════════════
// Task 1: Hand Executor Accept Enforcement
// ══════════════════════════════════════════════════════════════

describe('Card D.3 Task 1: Hand Executor Accept Enforcement', () => {
  let ctx: HandExecutionContext;

  afterEach(() => {
    if (ctx) cleanupContext(ctx);
  });

  // AC-1: All accept decisions traceable (rationale field non-empty)
  describe('AC-1: all accept decisions traceable', () => {
    it('reviewer_aligned accept succeeds without extra envelope messages', async () => {
      ctx = createContext({ envelopeMessages: [] });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Approved' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.taskCompleted).toBe(true);
    });

    it('accept without envelopeMessages field (backward compat) still works', async () => {
      ctx = createContext(); // no envelopeMessages

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Approved' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.taskCompleted).toBe(true);
    });
  });

  // AC-2: God override accept must have system_log explaining why
  describe('AC-2: god_override accept requires system_log message', () => {
    it('returns violation when god_override has no system_log in envelope messages', async () => {
      ctx = createContext({
        envelopeMessages: [
          { target: 'coder', content: 'Continue working' },
        ],
      });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'Override reviewer' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(results[0].summary).toContain('god_override');
      expect(ctx.taskCompleted).toBe(false);
    });

    it('returns violation when god_override has empty envelope messages', async () => {
      ctx = createContext({ envelopeMessages: [] });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'Override' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(ctx.taskCompleted).toBe(false);
    });

    it('succeeds when god_override has system_log in envelope messages', async () => {
      ctx = createContext({
        envelopeMessages: [
          { target: 'system_log', content: 'Override: reviewer findings are outdated' },
        ],
      });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'Override reviewer' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.taskCompleted).toBe(true);
    });
  });

  // AC-3: forced_stop accept must have user summary message
  describe('AC-3: forced_stop accept requires user summary message', () => {
    it('returns violation when forced_stop has no user message', async () => {
      ctx = createContext({
        envelopeMessages: [
          { target: 'system_log', content: 'Stopping due to failures' },
        ],
      });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Forced stop' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(results[0].summary).toContain('forced_stop');
      expect(ctx.taskCompleted).toBe(false);
    });

    it('returns violation when forced_stop has empty envelope messages', async () => {
      ctx = createContext({ envelopeMessages: [] });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Stop' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('runtime_invariant_violation');
      expect(ctx.taskCompleted).toBe(false);
    });

    it('succeeds when forced_stop has user message', async () => {
      ctx = createContext({
        envelopeMessages: [
          { target: 'user', content: 'Task stopped: repeated failures after 3 retries' },
        ],
      });

      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Forced stop' }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.taskCompleted).toBe(true);
    });
  });

  // AC-6: Audit records complete accept rationale + authority
  describe('AC-6: audit records complete accept rationale + authority', () => {
    it('audit entry includes rationale, summary, and envelopeMessages for god_override', async () => {
      ctx = createContext({
        envelopeMessages: [
          { target: 'system_log', content: 'Override: reviewer findings outdated' },
        ],
      });
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'Override reviewer' }],
        ctx,
      );

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'accept_task',
          decision: expect.objectContaining({
            rationale: 'god_override',
            summary: 'Override reviewer',
            envelopeMessages: expect.arrayContaining([
              expect.objectContaining({ target: 'system_log' }),
            ]),
          }),
        }),
      );
    });

    it('audit entry includes envelopeMessages for forced_stop', async () => {
      ctx = createContext({
        envelopeMessages: [
          { target: 'user', content: 'Task stopped after failures' },
        ],
      });
      const appendSpy = vi.spyOn(ctx.auditLogger!, 'append');

      await executeActions(
        [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Stopped' }],
        ctx,
      );

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decisionType: 'accept_task',
          decision: expect.objectContaining({
            rationale: 'forced_stop',
            envelopeMessages: expect.arrayContaining([
              expect.objectContaining({ target: 'user' }),
            ]),
          }),
        }),
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════
// Task 2: Runtime Invariant Checks (NL → Action consistency)
// ══════════════════════════════════════════════════════════════

describe('Card D.3 Task 2: Runtime Invariant Checks', () => {
  // AC-4: Phase change in NL without set_phase action → violation
  describe('AC-4: phase change NL without set_phase → violation', () => {
    it('detects "进入 phase-3" without set_phase action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: '我们现在进入 phase-3 来做代码审查' },
      ];
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'Start review' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-2',
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].type).toBe('runtime_invariant_violation');
      expect(violations[0].summary).toContain('phase');
    });

    it('detects "enter phase-2" without set_phase action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: 'We will now enter phase-2 for review' },
      ];
      const actions: GodAction[] = [];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].type).toBe('runtime_invariant_violation');
    });

    it('detects "transition to phase" without set_phase action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'system_log', content: 'transition to phase-3 now' },
      ];
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'work' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-2',
      });

      expect(violations.length).toBeGreaterThan(0);
    });

    it('no violation when set_phase action is present', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: '进入 phase-3' },
      ];
      const actions: GodAction[] = [
        { type: 'set_phase', phaseId: 'phase-3' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-2',
      });

      expect(violations).toHaveLength(0);
    });
  });

  // AC-5: Accept in NL without accept_task action → violation
  describe('AC-5: accept NL without accept_task → violation', () => {
    it('detects "accept" in NL without accept_task action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: 'I will accept the task result now' },
      ];
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'Good job' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].type).toBe('runtime_invariant_violation');
      expect(violations[0].summary).toContain('accept');
    });

    it('detects "接受任务" without accept_task action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: '现在接受任务结果' },
      ];
      const actions: GodAction[] = [];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations.length).toBeGreaterThan(0);
    });

    it('no violation when accept_task action is present', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: 'I accept the result' },
      ];
      const actions: GodAction[] = [
        { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Done' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations).toHaveLength(0);
    });
  });

  // Adapter switch in NL without switch_adapter action → violation
  describe('adapter switch NL without switch_adapter → violation', () => {
    it('detects "切换 adapter" without switch_adapter action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'system_log', content: '切换 adapter 到 codex 以降低成本' },
      ];
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'Continue' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].type).toBe('runtime_invariant_violation');
    });

    it('detects "switch adapter" without switch_adapter action', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'system_log', content: 'Will switch adapter to codex for cost' },
      ];
      const actions: GodAction[] = [];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations.length).toBeGreaterThan(0);
    });

    it('no violation when switch_adapter action is present', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'system_log', content: 'switch adapter to codex' },
      ];
      const actions: GodAction[] = [
        { type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'Cost' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations).toHaveLength(0);
    });
  });

  // No violations for benign messages
  describe('no violations for benign messages', () => {
    it('no violations when no state-change keywords found', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'Please implement the login feature' },
        { target: 'user', content: 'Working on your request' },
      ];
      const actions: GodAction[] = [
        { type: 'send_to_coder', message: 'Implement login' },
      ];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      expect(violations).toHaveLength(0);
    });

    it('empty messages → no violations', () => {
      const violations = checkNLInvariantViolations([], [], {
        phaseId: 'phase-1',
      });

      expect(violations).toHaveLength(0);
    });

    it('multiple violations reported for multiple NL inconsistencies', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: 'I accept the result and we enter phase-3' },
      ];
      const actions: GodAction[] = [];

      const violations = checkNLInvariantViolations(messages, actions, {
        phaseId: 'phase-1',
      });

      // Should detect both accept and phase violations
      expect(violations.length).toBeGreaterThanOrEqual(2);
    });
  });
});
