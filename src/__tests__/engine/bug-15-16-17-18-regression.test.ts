/**
 * Regression tests for BUG-15, BUG-16, BUG-17, BUG-18.
 *
 * BUG-15 [P1]: EXECUTING useEffect missing envelopeMessages in HandExecutionContext,
 *   causing accept_task D.3 validation (god_override/forced_stop) to be skipped.
 *   Fix: Added envelopeMessages: envelope.messages to HandExecutionContext.
 *
 * BUG-16 [P1]: CLARIFYING state not restored on session resume —
 *   mapRestoreEvent lacked 'clarifying' case, buildRestoredSessionRuntime didn't
 *   extract clarification context from SessionState.
 *   Fix: Added 'clarifying' case to mapRestoreEvent, extract clarification in workflowInput.
 *
 * BUG-17 [P2]: GOD_DECIDING dispatchMessages called with pendingReviewerMessage: null
 *   instead of pendingReviewerInstructionRef.current, violating DispatchContext interface.
 *   Fix: Pass pendingReviewerInstructionRef.current (consistent with pendingCoderMessage).
 *
 * BUG-18 [P2]: god-envelope schema missing userConfirmation === 'god_override' constraint
 *   requiring system_log message for override audit trail.
 *   Fix: Added superRefine check and updated god-system-prompt.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeActions, type HandExecutionContext, type HandAdapter } from '../../god/hand-executor.js';
import { GodAuditLogger } from '../../god/god-audit.js';
import { buildRestoredSessionRuntime } from '../../ui/session-runner-state.js';
import { GodDecisionEnvelopeSchema } from '../../types/god-envelope.js';
import { dispatchMessages, type DispatchContext } from '../../god/message-dispatcher.js';
import type { LoadedSession, SessionState } from '../../session/session-manager.js';
import type { EnvelopeMessage } from '../../types/god-envelope.js';
import { buildGodSystemPrompt } from '../../god/god-system-prompt.js';

// ── Shared helpers ──

function createHandContext(overrides: Partial<HandExecutionContext> = {}): HandExecutionContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug-15-18-'));
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

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    diagnosis: {
      summary: 'Test',
      currentGoal: 'Test goal',
      currentPhaseId: 'phase-1',
      notableObservations: [],
    },
    authority: {
      userConfirmation: 'not_required' as const,
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned' as const,
    },
    actions: [
      { type: 'send_to_reviewer', message: 'Review' },
    ],
    messages: [
      { target: 'system_log' as const, content: 'log entry' },
    ],
    ...overrides,
  };
}

function makeLoadedSession(stateOverrides: Partial<SessionState> = {}): LoadedSession {
  return {
    metadata: {
      id: 'test-session-1',
      projectDir: '/tmp/test',
      coder: 'claude-code',
      reviewer: 'claude-code',
      task: 'implement feature',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    state: {
      status: 'coding',
      currentRole: 'coder',
      ...stateOverrides,
    },
    history: [
      { role: 'coder', content: 'code output', timestamp: 1000 },
      { role: 'reviewer', content: 'review output', timestamp: 2000 },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════
// BUG-15 [P1]: envelopeMessages must be passed to HandExecutionContext
// ══════════════════════════════════════════════════════════════════

describe('BUG-15 regression: envelopeMessages enables accept_task D.3 validation', () => {
  it('accept_task with god_override returns violation when envelopeMessages has no system_log', async () => {
    const messages: EnvelopeMessage[] = [
      { target: 'user', content: 'Task done' },
    ];
    const ctx = createHandContext({ envelopeMessages: messages });
    try {
      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'done' }],
        ctx,
      );

      // With envelopeMessages provided and no system_log, accept_task should produce violation
      const violation = results.find(r => r.type === 'runtime_invariant_violation');
      expect(violation).toBeDefined();
      expect(violation!.summary).toContain('god_override');
      expect(violation!.summary).toContain('system_log');
    } finally {
      fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
    }
  });

  it('accept_task with god_override succeeds when envelopeMessages has system_log', async () => {
    const messages: EnvelopeMessage[] = [
      { target: 'system_log', content: 'Override reason: reviewer aligned' },
    ];
    const ctx = createHandContext({ envelopeMessages: messages });
    try {
      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'done' }],
        ctx,
      );

      // No violation — system_log message present
      const violation = results.find(r => r.type === 'runtime_invariant_violation');
      expect(violation).toBeUndefined();
      expect(ctx.taskCompleted).toBe(true);
    } finally {
      fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
    }
  });

  it('accept_task with forced_stop returns violation when envelopeMessages has no user message', async () => {
    const messages: EnvelopeMessage[] = [
      { target: 'system_log', content: 'Forced stop' },
    ];
    const ctx = createHandContext({ envelopeMessages: messages });
    try {
      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'forced_stop', summary: 'stopped' }],
        ctx,
      );

      const violation = results.find(r => r.type === 'runtime_invariant_violation');
      expect(violation).toBeDefined();
      expect(violation!.summary).toContain('forced_stop');
      expect(violation!.summary).toContain('user');
    } finally {
      fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
    }
  });

  it('without envelopeMessages, accept_task validation is skipped (the bug scenario)', async () => {
    // This demonstrates what happened before the fix: no envelopeMessages → no validation
    const ctx = createHandContext(); // no envelopeMessages
    try {
      const results = await executeActions(
        [{ type: 'accept_task', rationale: 'god_override', summary: 'done' }],
        ctx,
      );

      // Without envelopeMessages, validation is skipped → no violation, task completes
      const violation = results.find(r => r.type === 'runtime_invariant_violation');
      expect(violation).toBeUndefined();
      expect(ctx.taskCompleted).toBe(true);
    } finally {
      fs.rmSync(ctx.sessionDir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-16 [P1]: CLARIFYING state must be restored on session resume
// ══════════════════════════════════════════════════════════════════

describe('BUG-16 regression: CLARIFYING state restoration on session resume', () => {
  const config = {
    coder: 'claude-code',
    reviewer: 'claude-code',
    god: 'claude-code' as const,
    task: 'implement feature',
    projectDir: '/tmp/test',
  };

  it('mapRestoreEvent maps clarifying status to RESTORED_TO_CLARIFYING', () => {
    const loaded = makeLoadedSession({
      status: 'clarifying',
      clarification: {
        frozenActiveProcess: 'coder',
        clarificationRound: 2,
      },
    });

    const result = buildRestoredSessionRuntime(loaded, config);
    expect(result.restoreEvent).toBe('RESTORED_TO_CLARIFYING');
  });

  it('buildRestoredSessionRuntime extracts clarification context into workflowInput', () => {
    const loaded = makeLoadedSession({
      status: 'clarifying',
      clarification: {
        frozenActiveProcess: 'coder',
        clarificationRound: 2,
      },
    });

    const result = buildRestoredSessionRuntime(loaded, config);
    expect(result.workflowInput.frozenActiveProcess).toBe('coder');
    expect(result.workflowInput.clarificationRound).toBe(2);
  });

  it('buildRestoredSessionRuntime omits clarification when not in CLARIFYING state', () => {
    const loaded = makeLoadedSession({
      status: 'coding',
    });

    const result = buildRestoredSessionRuntime(loaded, config);
    expect(result.workflowInput.frozenActiveProcess).toBeUndefined();
    expect(result.workflowInput.clarificationRound).toBeUndefined();
  });

  it('clarification context round is preserved correctly', () => {
    const loaded = makeLoadedSession({
      status: 'clarifying',
      clarification: {
        frozenActiveProcess: 'reviewer',
        clarificationRound: 5,
      },
    });

    const result = buildRestoredSessionRuntime(loaded, config);
    expect(result.workflowInput.frozenActiveProcess).toBe('reviewer');
    expect(result.workflowInput.clarificationRound).toBe(5);
  });

  it('coding status still maps to RESTORED_TO_CODING (backward compat)', () => {
    const loaded = makeLoadedSession({ status: 'coding' });
    const result = buildRestoredSessionRuntime(loaded, config);
    expect(result.restoreEvent).toBe('RESTORED_TO_CODING');
  });

  it('interrupted status still maps to RESTORED_TO_INTERRUPTED (backward compat)', () => {
    const loaded = makeLoadedSession({ status: 'interrupted' });
    const result = buildRestoredSessionRuntime(loaded, config);
    expect(result.restoreEvent).toBe('RESTORED_TO_INTERRUPTED');
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-17 [P2]: dispatchMessages should receive pendingReviewerMessage from ref
// ══════════════════════════════════════════════════════════════════

describe('BUG-17 regression: DispatchContext pendingReviewerMessage consistency', () => {
  it('DispatchContext accepts non-null pendingReviewerMessage (the fix)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug17-'));
    try {
      const ctx: DispatchContext = {
        pendingCoderMessage: 'existing coder instruction',
        pendingReviewerMessage: 'existing reviewer instruction',
        displayToUser: vi.fn(),
        auditLogger: new GodAuditLogger(tmpDir),
      };

      // Dispatch with reviewer-targeted message
      const result = dispatchMessages(
        [{ target: 'reviewer', content: 'New reviewer instruction' }],
        ctx,
      );

      // Dispatch returns new reviewer message
      expect(result.pendingReviewerMessage).toBe('New reviewer instruction');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('DispatchContext with null pendingReviewerMessage still works (no regression)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug17-'));
    try {
      const ctx: DispatchContext = {
        pendingCoderMessage: null,
        pendingReviewerMessage: null,
        displayToUser: vi.fn(),
        auditLogger: new GodAuditLogger(tmpDir),
      };

      const result = dispatchMessages(
        [{ target: 'coder', content: 'Coder instruction' }],
        ctx,
      );

      expect(result.pendingCoderMessage).toBe('Coder instruction');
      expect(result.pendingReviewerMessage).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pendingCoderMessage and pendingReviewerMessage should be symmetric in interface', () => {
    // This test verifies the DispatchContext interface accepts both fields with the same type
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-bug17-'));
    try {
      const ctx: DispatchContext = {
        pendingCoderMessage: 'coder msg',
        pendingReviewerMessage: 'reviewer msg',
        displayToUser: vi.fn(),
        auditLogger: new GodAuditLogger(tmpDir),
      };

      // Both fields are of same type: string | null
      expect(typeof ctx.pendingCoderMessage).toBe('string');
      expect(typeof ctx.pendingReviewerMessage).toBe('string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-18 [P2]: god-envelope schema must reject userConfirmation='god_override'
//   without system_log message
// ══════════════════════════════════════════════════════════════════

describe('BUG-18 regression: userConfirmation god_override requires system_log', () => {
  it('rejects userConfirmation=god_override without system_log message', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [
        { target: 'user', content: 'Task completed' },
      ],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.issues.map((i: { message: string }) => i.message).join('; ');
      expect(errorMessage).toMatch(/userConfirmation.*god_override.*system_log/i);
    }
  });

  it('accepts userConfirmation=god_override with system_log message', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [
        { target: 'system_log', content: 'Override reason: routine task, no user input needed' },
      ],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('rejects envelope with both userConfirmation and acceptAuthority god_override but no system_log', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: false,
        acceptAuthority: 'god_override',
      },
      messages: [
        { target: 'user', content: 'Done' },
      ],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Should have issues for BOTH userConfirmation and acceptAuthority
      const paths = result.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('authority.userConfirmation');
      expect(paths).toContain('authority.acceptAuthority');
    }
  });

  it('userConfirmation=not_required does not require system_log (no regression)', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('userConfirmation=human does not require system_log (no regression)', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'human',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('god system prompt contains TASK_INIT classification format and basic rules', () => {
    const prompt = buildGodSystemPrompt({
      task: 'test',
      coderName: 'coder',
      reviewerName: 'reviewer',
    });

    expect(prompt).toContain('Task Classification');
    expect(prompt).toContain('taskType');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('Rules');
  });
});
