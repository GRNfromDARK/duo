/**
 * Card F.3: Sovereign God Runtime — End-to-End Integration Tests
 *
 * Verifies the complete pipeline:
 *   Observation Classifier → God Decision Service → Hand Executor
 *   → Message Dispatcher → Audit Logger
 *
 * 7 test scenarios + 3 KPI metrics validation.
 *
 * Tests module integration, NOT React rendering.
 * Uses mock adapters to simulate God/Coder/Reviewer CLI output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActor } from 'xstate';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  workflowMachine,
  type WorkflowContext,
} from '../../engine/workflow-machine.js';
import type { Observation } from '../../types/observation.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import type { GodAction } from '../../types/god-actions.js';
import {
  classifyOutput,
  guardNonWorkOutput,
  IncidentTracker,
} from '../../god/observation-classifier.js';
import { processWorkerOutput } from '../../god/observation-integration.js';
import { executeActions, type HandExecutionContext } from '../../god/hand-executor.js';
import { dispatchMessages, checkNLInvariantViolations } from '../../god/message-dispatcher.js';
import { GodAuditLogger, logReviewerOverrideAudit, logEnvelopeDecision } from '../../god/god-audit.js';

// ── Helpers ──

let tmpDir: string;
let sessionDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duo-sovereign-integ-'));
  sessionDir = join(tmpDir, 'session');
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a test Observation. */
function makeObs(
  type: Observation['type'] = 'work_output',
  source: Observation['source'] = 'coder',
  overrides?: Partial<Observation>,
): Observation {
  return {
    source,
    type,
    summary: `test ${type}`,
    severity: 'info',
    timestamp: new Date().toISOString(),
    round: 0,
    ...overrides,
  };
}

/** Create a test GodDecisionEnvelope. */
function makeEnvelope(
  actions: GodDecisionEnvelope['actions'] = [],
  overrides?: Partial<GodDecisionEnvelope>,
): GodDecisionEnvelope {
  return {
    diagnosis: {
      summary: 'test',
      currentGoal: 'test',
      currentPhaseId: 'p1',
      notableObservations: [],
    },
    authority: {
      userConfirmation: 'not_required',
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned',
    },
    actions,
    messages: [{ target: 'system_log', content: 'log' }],
    ...overrides,
  };
}

function startActor(context?: Partial<WorkflowContext>) {
  const actor = createActor(workflowMachine, { input: context });
  actor.start();
  return actor;
}

function makeHandExecutionContext(overrides?: Partial<HandExecutionContext>): HandExecutionContext {
  return {
    currentPhaseId: 'p1',
    pendingCoderMessage: null,
    pendingReviewerMessage: null,
    adapters: new Map(),
    auditLogger: new GodAuditLogger(sessionDir),
    activeRole: null,
    taskCompleted: false,
    waitState: { active: false, reason: null, estimatedSeconds: null },
    clarificationState: { active: false, question: null },
    interruptResumeStrategy: null,
    adapterConfig: new Map(),
    round: 0,
    sessionDir,
    cwd: tmpDir,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Test 1: Normal Flow — Coder → Review → Accept
// ═══════════════════════════════════════════════════════════════════

describe('Test 1: Normal Flow (AC-1)', () => {
  it('Coder output → classify work_output → God decides review → Reviewer output → God decides accept with rationale and complete audit', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'implement feature X' });
    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 5 });
    expect(actor.getSnapshot().value).toBe('CODING');

    // ── Step 1: Coder produces output ──
    const coderRaw = 'function featureX() { return "implemented"; }';
    const coderResult = processWorkerOutput(coderRaw, 'coder', { round: 0 });

    // Verify classification
    expect(coderResult.observation.type).toBe('work_output');
    expect(coderResult.observation.source).toBe('coder');
    expect(coderResult.isWork).toBe(true);
    expect(coderResult.shouldRouteToGod).toBe(false);

    // Since it's work, send CODE_COMPLETE → OBSERVING
    actor.send({ type: 'CODE_COMPLETE', output: coderRaw });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // ── Step 2: Observations classified, God decides review ──
    actor.send({ type: 'OBSERVATIONS_READY', observations: [coderResult.observation] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    const envelopeToReview = makeEnvelope([
      { type: 'send_to_reviewer', message: 'Review the feature X implementation' },
    ]);

    // Execute Hand actions
    const ctx1 = makeHandExecutionContext();
    const execResults1 = await executeActions(envelopeToReview.actions, ctx1);
    expect(execResults1).toHaveLength(1);
    expect(execResults1[0].type).toBe('phase_progress_signal');
    expect(ctx1.pendingReviewerMessage).toBe('Review the feature X implementation');
    expect(ctx1.activeRole).toBe('reviewer');

    // Dispatch messages
    const displayedMessages: string[] = [];
    const dispatchCtx1 = {
      pendingCoderMessage: null,
      pendingReviewerMessage: null,
      displayToUser: (msg: string) => displayedMessages.push(msg),
      auditLogger: new GodAuditLogger(sessionDir),
      round: 0,
    };
    dispatchMessages(envelopeToReview.messages, dispatchCtx1);

    // Log envelope decision
    logEnvelopeDecision(new GodAuditLogger(sessionDir), {
      round: 0,
      observations: [coderResult.observation],
      envelope: envelopeToReview,
      executionResults: execResults1,
    });

    // State machine: DECISION_READY → EXECUTING → REVIEWING
    actor.send({ type: 'DECISION_READY', envelope: envelopeToReview });
    expect(actor.getSnapshot().value).toBe('EXECUTING');
    actor.send({ type: 'EXECUTION_COMPLETE', results: execResults1 });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    // ── Step 3: Reviewer approves ──
    const reviewRaw = 'Code looks good. All edge cases handled. [APPROVED]';
    const reviewResult = processWorkerOutput(reviewRaw, 'reviewer', { round: 0 });
    expect(reviewResult.observation.type).toBe('review_output');
    expect(reviewResult.observation.source).toBe('reviewer');
    expect(reviewResult.isWork).toBe(true);

    actor.send({ type: 'REVIEW_COMPLETE', output: reviewRaw });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    actor.send({ type: 'OBSERVATIONS_READY', observations: [reviewResult.observation] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // ── Step 4: God decides accept with rationale ──
    const envelopeAccept = makeEnvelope(
      [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Reviewer approved, all criteria met.' }],
      {
        authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'reviewer_aligned' },
      },
    );

    const ctx2 = makeHandExecutionContext();
    ctx2.envelopeMessages = envelopeAccept.messages;
    const execResults2 = await executeActions(envelopeAccept.actions, ctx2);
    expect(execResults2).toHaveLength(1);
    expect(ctx2.taskCompleted).toBe(true);

    // Verify accept_task has rationale
    const acceptAction = envelopeAccept.actions.find(a => a.type === 'accept_task');
    expect(acceptAction).toBeDefined();
    expect((acceptAction as Extract<GodAction, { type: 'accept_task' }>).rationale).toBe('reviewer_aligned');

    // Log audit
    const auditLogger = new GodAuditLogger(sessionDir);
    logEnvelopeDecision(auditLogger, {
      round: 0,
      observations: [reviewResult.observation],
      envelope: envelopeAccept,
      executionResults: execResults2,
    });

    // Verify audit record exists and is complete
    const entries = auditLogger.getEntries({ type: 'god_decision' });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry.decisionType).toBe('god_decision');
    expect(lastEntry.inputSummary).toContain('review_output');
    expect(lastEntry.outputSummary).toContain('accept_task');

    // State machine: → DONE
    actor.send({ type: 'DECISION_READY', envelope: envelopeAccept });
    expect(actor.getSnapshot().value).toBe('EXECUTING');
    actor.send({ type: 'EXECUTION_COMPLETE', results: execResults2 });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 2: External Fault — quota_exhausted does NOT advance
// ═══════════════════════════════════════════════════════════════════

describe('Test 2: External Fault (AC-2)', () => {
  it('quota_exhausted is classified as incident, not work_output; God decides switch_adapter', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'fix bug' });
    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 5 });
    expect(actor.getSnapshot().value).toBe('CODING');

    // ── Coder hits quota ──
    const quotaRaw = "You're out of extra usage · resets 7pm (Asia/Shanghai)";
    const quotaResult = processWorkerOutput(quotaRaw, 'coder', { round: 0 });

    // Verify: classified as quota_exhausted, NOT work_output
    expect(quotaResult.observation.type).toBe('quota_exhausted');
    expect(quotaResult.observation.severity).toBe('error');
    expect(quotaResult.isWork).toBe(false);
    expect(quotaResult.shouldRouteToGod).toBe(true);

    // Since it's NOT work, do NOT send CODE_COMPLETE.
    // Instead, send INCIDENT_DETECTED → OBSERVING
    actor.send({ type: 'INCIDENT_DETECTED', observation: quotaResult.observation });
    expect(actor.getSnapshot().value).toBe('OBSERVING');

    // Observations go to God
    actor.send({ type: 'OBSERVATIONS_READY', observations: [quotaResult.observation] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides to switch adapter and retry
    const envelopeSwitchRetry = makeEnvelope([
      { type: 'switch_adapter', role: 'coder', adapter: 'openai-codex', reason: 'quota_exhausted on claude-code' },
      { type: 'retry_role', role: 'coder', hint: 'Continue the bug fix with new adapter' },
    ]);

    const ctx = makeHandExecutionContext();
    const execResults = await executeActions(envelopeSwitchRetry.actions, ctx);
    expect(execResults).toHaveLength(2);
    expect(execResults[0].type).toBe('phase_progress_signal'); // switch (not-implemented warning)
    expect(execResults[0].severity).toBe('warning');
    expect(execResults[1].type).toBe('phase_progress_signal'); // retry succeeded
    // switch_adapter is not yet implemented, so adapterConfig stays unchanged (empty map)
    expect(ctx.adapterConfig.has('coder')).toBe(false);
    expect(ctx.activeRole).toBe('coder');

    // Verify switch_adapter action is in the envelope
    const switchAction = envelopeSwitchRetry.actions.find(a => a.type === 'switch_adapter');
    expect(switchAction).toBeDefined();

    // State machine routes back to CODING via retry_role
    actor.send({ type: 'DECISION_READY', envelope: envelopeSwitchRetry });
    expect(actor.getSnapshot().value).toBe('EXECUTING');
    actor.send({ type: 'EXECUTION_COMPLETE', results: execResults });
    expect(actor.getSnapshot().value).toBe('CODING');

    actor.stop();
  });

  it('auth_failed does NOT trigger CODE_COMPLETE', () => {
    const authRaw = 'Error: authentication failed, unauthorized (403)';
    const result = processWorkerOutput(authRaw, 'coder', { round: 0 });
    expect(result.observation.type).toBe('auth_failed');
    expect(result.isWork).toBe(false);
    expect(result.shouldRouteToGod).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 3: Empty Output — not treated as work_output
// ═══════════════════════════════════════════════════════════════════

describe('Test 3: Empty Output (AC-3)', () => {
  it('empty output classified as empty_output, God retries then stops', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'generate code' });
    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 5 });
    expect(actor.getSnapshot().value).toBe('CODING');

    // ── First empty output ──
    const emptyResult1 = processWorkerOutput('', 'coder', { round: 0 });
    expect(emptyResult1.observation.type).toBe('empty_output');
    expect(emptyResult1.observation.severity).toBe('warning');
    expect(emptyResult1.isWork).toBe(false);

    // IncidentTracker escalates severity on consecutive empty
    const tracker = new IncidentTracker();
    const escalated1 = tracker.trackAndEscalate(emptyResult1.observation);
    expect(escalated1.severity).toBe('warning'); // first time: still warning

    // Route as incident
    actor.send({ type: 'INCIDENT_DETECTED', observation: emptyResult1.observation });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    actor.send({ type: 'OBSERVATIONS_READY', observations: [emptyResult1.observation] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides: retry coder
    const envelopeRetry = makeEnvelope([
      { type: 'retry_role', role: 'coder', hint: 'Previous output was empty, please produce code output' },
    ]);
    actor.send({ type: 'DECISION_READY', envelope: envelopeRetry });
    expect(actor.getSnapshot().value).toBe('EXECUTING');
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('CODING');

    // ── Second empty output ──
    const emptyResult2 = processWorkerOutput('   ', 'coder', { round: 1 });
    expect(emptyResult2.observation.type).toBe('empty_output');

    const escalated2 = tracker.trackAndEscalate(emptyResult2.observation);
    expect(escalated2.severity).toBe('error'); // escalated: 2nd consecutive

    actor.send({ type: 'INCIDENT_DETECTED', observation: escalated2 });
    expect(actor.getSnapshot().value).toBe('OBSERVING');
    actor.send({ type: 'OBSERVATIONS_READY', observations: [escalated2] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God decides: stop (forced_stop) after repeated empty
    const envelopeStop = makeEnvelope(
      [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Coder producing empty output repeatedly. Stopping task.' }],
      {
        authority: { userConfirmation: 'not_required', reviewerOverride: false, acceptAuthority: 'forced_stop' },
        messages: [
          { target: 'system_log', content: 'Forced stop due to repeated empty output' },
          { target: 'user', content: 'Task stopped: coder unable to produce output after retries.' },
        ],
      },
    );

    actor.send({ type: 'DECISION_READY', envelope: envelopeStop });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    const ctx = makeHandExecutionContext({ envelopeMessages: envelopeStop.messages });
    const execResults = await executeActions(envelopeStop.actions, ctx);
    expect(ctx.taskCompleted).toBe(true);

    actor.send({ type: 'EXECUTION_COMPLETE', results: execResults });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });

  it('whitespace-only output is classified as empty_output, not work_output', () => {
    const ws1 = processWorkerOutput('', 'coder', { round: 0 });
    expect(ws1.observation.type).toBe('empty_output');
    expect(ws1.isWork).toBe(false);

    const ws2 = processWorkerOutput('   \n\t  ', 'coder', { round: 0 });
    expect(ws2.observation.type).toBe('empty_output');
    expect(ws2.isWork).toBe(false);

    const ws3 = processWorkerOutput('\n', 'reviewer', { round: 0 });
    expect(ws3.observation.type).toBe('empty_output');
    expect(ws3.isWork).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 5: Reviewer Override — God overrides reviewer's changes_requested
// ═══════════════════════════════════════════════════════════════════

describe('Test 5: Reviewer Override (AC-5)', () => {
  it('Reviewer says changes_requested → God overrides → accept with audit trail', async () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'implement auth' });
    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 5 });

    // Fast-forward to REVIEWING
    actor.send({ type: 'CODE_COMPLETE', output: 'auth code' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    const envToReview = makeEnvelope([{ type: 'send_to_reviewer', message: 'Review auth' }]);
    actor.send({ type: 'DECISION_READY', envelope: envToReview });
    actor.send({ type: 'EXECUTION_COMPLETE', results: [makeObs('phase_progress_signal', 'runtime')] });
    expect(actor.getSnapshot().value).toBe('REVIEWING');

    // ── Reviewer says CHANGES_REQUESTED ──
    const reviewRaw = 'Missing edge case for empty password. [CHANGES_REQUESTED]';
    const reviewResult = processWorkerOutput(reviewRaw, 'reviewer', { round: 0 });
    expect(reviewResult.observation.type).toBe('review_output');
    expect(reviewResult.observation.rawRef).toContain('[CHANGES_REQUESTED]');

    actor.send({ type: 'REVIEW_COMPLETE', output: reviewRaw });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [reviewResult.observation] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // ── God overrides reviewer → accept ──
    const overrideReason = 'Edge case is non-critical for MVP scope. Accepting to meet deadline.';
    const envelopeOverride = makeEnvelope(
      [{ type: 'accept_task', rationale: 'god_override', summary: 'Overriding reviewer: edge case deferred to next sprint.' }],
      {
        authority: {
          userConfirmation: 'not_required',
          reviewerOverride: true,
          acceptAuthority: 'god_override',
        },
        messages: [
          { target: 'system_log', content: overrideReason },
          { target: 'user', content: 'Task accepted. Minor edge case deferred.' },
        ],
      },
    );

    // Execute with envelope messages for validation
    const ctx = makeHandExecutionContext({ envelopeMessages: envelopeOverride.messages });
    const execResults = await executeActions(envelopeOverride.actions, ctx);
    expect(execResults).toHaveLength(1);
    expect(execResults[0].type).toBe('phase_progress_signal'); // no violation
    expect(ctx.taskCompleted).toBe(true);

    // ── Verify audit: reviewerOverride is tracked ──
    const auditLogger = new GodAuditLogger(sessionDir);

    // Log via logReviewerOverrideAudit
    logReviewerOverrideAudit(auditLogger, {
      round: 0,
      reviewerObservation: reviewResult.observation,
      envelope: envelopeOverride,
    });

    const overrideEntries = auditLogger.getEntries({ type: 'reviewer_override' });
    expect(overrideEntries).toHaveLength(1);
    expect(overrideEntries[0].decisionType).toBe('reviewer_override');
    const decision = overrideEntries[0].decision as Record<string, unknown>;
    expect(decision.reviewerVerdict).toBe('CHANGES_REQUESTED');
    expect(decision.godVerdict).toBe('god_override');
    expect(decision.overrideReason).toContain('non-critical');

    // Log via logEnvelopeDecision for full tracking
    logEnvelopeDecision(auditLogger, {
      round: 0,
      observations: [reviewResult.observation],
      envelope: envelopeOverride,
      executionResults: execResults,
    });

    const godDecisionEntries = auditLogger.getEntries({ type: 'god_decision' });
    expect(godDecisionEntries).toHaveLength(1);
    const godDecision = godDecisionEntries[0].decision as Record<string, unknown>;
    // Verify overrides are tracked (NFR-002)
    expect(godDecision.overrides).toBeDefined();
    const overrides = godDecision.overrides as Record<string, unknown>;
    expect(overrides.reviewerOverride).toBe(true);
    expect(overrides.reviewerOriginalConclusion).toBe('CHANGES_REQUESTED');
    expect(overrides.reviewerOverrideReason).toContain('non-critical');

    // State machine → DONE
    actor.send({ type: 'DECISION_READY', envelope: envelopeOverride });
    actor.send({ type: 'EXECUTION_COMPLETE', results: execResults });
    expect(actor.getSnapshot().value).toBe('DONE');

    actor.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 6: State Change Enforcement — NL cannot implicitly change state
// ═══════════════════════════════════════════════════════════════════

describe('Test 6: State Change Enforcement (AC-6)', () => {
  it('God NL says "accept" but no accept_task action → runtime_invariant_violation', () => {
    // God says "accept" in NL messages but has no accept_task action
    const messages = [
      { target: 'user' as const, content: 'I accept the task result, looks good.' },
      { target: 'system_log' as const, content: 'Accepting task based on review.' },
    ];
    const actions: GodAction[] = [
      // Only send_to_coder, NO accept_task
      { type: 'send_to_coder', message: 'Continue working' },
    ];

    const violations = checkNLInvariantViolations(messages, actions, { round: 0, phaseId: 'p1' });

    // Should detect the NL/action mismatch
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const acceptViolation = violations.find(v => v.summary.includes('accept'));
    expect(acceptViolation).toBeDefined();
    expect(acceptViolation!.type).toBe('runtime_invariant_violation');
    expect(acceptViolation!.severity).toBe('error');
  });

  it('God NL says "transition to phase" but no set_phase action → violation', () => {
    const messages = [
      { target: 'coder' as const, content: 'Let me transition to phase 2 now.' },
    ];
    const actions: GodAction[] = [
      { type: 'send_to_coder', message: 'Start phase 2 work' },
    ];

    const violations = checkNLInvariantViolations(messages, actions, { round: 0, phaseId: 'p1' });
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const phaseViolation = violations.find(v => v.summary.includes('phase'));
    expect(phaseViolation).toBeDefined();
    expect(phaseViolation!.type).toBe('runtime_invariant_violation');
  });

  it('God NL says "switch adapter" but no switch_adapter action → violation', () => {
    const messages = [
      { target: 'system_log' as const, content: 'Will switch adapter to codex.' },
    ];
    const actions: GodAction[] = [];

    const violations = checkNLInvariantViolations(messages, actions, { round: 0, phaseId: 'p1' });
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const switchViolation = violations.find(v => v.summary.includes('adapter'));
    expect(switchViolation).toBeDefined();
  });

  it('consistent NL + actions produces no violations', () => {
    const messages = [
      { target: 'system_log' as const, content: 'Accepting task: all criteria met.' },
    ];
    const actions: GodAction[] = [
      { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'All criteria met' },
    ];

    const violations = checkNLInvariantViolations(messages, actions, { round: 0, phaseId: 'p1' });
    expect(violations).toHaveLength(0);
  });

  it('state machine does not advance when envelope has no action-backed state change', () => {
    const actor = startActor();
    actor.send({ type: 'START_TASK', prompt: 'task' });
    actor.send({ type: 'TASK_INIT_COMPLETE', maxRounds: 5 });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'OBSERVATIONS_READY', observations: [makeObs('work_output', 'coder')] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');

    // God sends envelope with NO actions (only messages)
    const emptyEnvelope = makeEnvelope([], {
      messages: [
        { target: 'user', content: 'I accept the result.' }, // NL says accept but no action
        { target: 'system_log', content: 'log' },
      ],
    });

    actor.send({ type: 'DECISION_READY', envelope: emptyEnvelope });
    expect(actor.getSnapshot().value).toBe('EXECUTING');

    // EXECUTION_COMPLETE with no action targets → back to GOD_DECIDING, NOT DONE
    actor.send({ type: 'EXECUTION_COMPLETE', results: [] });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
    // NOT DONE — state machine correctly rejects implicit accept

    actor.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 7: Incident Consecutive Failure Tracking
// ═══════════════════════════════════════════════════════════════════

describe('Test 7: Consecutive Failure Tracking (AC-7)', () => {
  it('work output resets IncidentTracker counts', () => {
    const tracker = new IncidentTracker();

    // 2 consecutive quota_exhausted
    tracker.trackAndEscalate(makeObs('quota_exhausted', 'runtime', { severity: 'error' }));
    tracker.trackAndEscalate(makeObs('quota_exhausted', 'runtime', { severity: 'error' }));
    expect(tracker.getConsecutiveCount('quota_exhausted')).toBe(2);

    // Work output resets
    tracker.trackAndEscalate(makeObs('work_output', 'coder'));
    expect(tracker.getConsecutiveCount('quota_exhausted')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// KPI Verification — NFR-003, God Explicitness, NFR-002
// ═══════════════════════════════════════════════════════════════════

describe('KPI: External Fault False Advancement Rate = 0 (NFR-003, AC-8)', () => {
  const FAULT_OUTPUTS = [
    { raw: "You're out of extra usage · resets 7pm", expectedType: 'quota_exhausted' },
    { raw: 'Error 429: rate limit exceeded', expectedType: 'quota_exhausted' },
    { raw: 'Too many requests, please try again later', expectedType: 'quota_exhausted' },
    { raw: 'Authentication failed: unauthorized', expectedType: 'auth_failed' },
    { raw: 'Error 403 forbidden', expectedType: 'auth_failed' },
    { raw: 'invalid api key provided', expectedType: 'auth_failed' },
    { raw: '', expectedType: 'empty_output' },
    { raw: '   \n\t  ', expectedType: 'empty_output' },
  ];

  for (const { raw, expectedType } of FAULT_OUTPUTS) {
    it(`"${raw.slice(0, 40)}..." → ${expectedType}, isWork=false`, () => {
      const result = processWorkerOutput(raw, 'coder', { round: 0 });
      expect(result.observation.type).toBe(expectedType);
      expect(result.isWork).toBe(false);
      expect(result.shouldRouteToGod).toBe(true);
    });

    it(`"${raw.slice(0, 40)}..." from reviewer → ${expectedType}, isWork=false`, () => {
      const result = processWorkerOutput(raw, 'reviewer', { round: 0 });
      expect(result.observation.type).toBe(expectedType);
      expect(result.isWork).toBe(false);
    });
  }
});

describe('KPI: God Decision Explicitness = 100% (AC-9)', () => {
  it('every action in Hand catalog maps to a structural execution, not NL inference', async () => {
    // Verify: all 11 action types execute through executeActions without error
    const actionTypes: GodAction[] = [
      { type: 'send_to_coder', message: 'do work' },
      { type: 'send_to_reviewer', message: 'review it' },
      { type: 'stop_role', role: 'coder', reason: 'timeout' },
      { type: 'retry_role', role: 'coder', hint: 'try again' },
      { type: 'switch_adapter', role: 'coder', adapter: 'alt', reason: 'quota' },
      { type: 'set_phase', phaseId: 'p2', summary: 'next phase' },
      { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'done' },
      { type: 'wait', reason: 'cooldown' },
      { type: 'request_user_input', question: 'what next?' },
      { type: 'resume_after_interrupt', resumeStrategy: 'continue' },
      { type: 'emit_summary', content: 'summary text' },
    ];

    const ctx = makeHandExecutionContext();
    ctx.adapters.set('coder', { kill: async () => {} });

    const results = await executeActions(actionTypes, ctx);

    // All 11 should produce results (no throws)
    expect(results).toHaveLength(11);

    // All should be phase_progress_signal (successful execution)
    for (const result of results) {
      expect(result.type).toBe('phase_progress_signal');
    }
  });

  it('accept_task always carries rationale and logs audit', async () => {
    const testRationales: Array<'reviewer_aligned' | 'god_override' | 'forced_stop'> = [
      'reviewer_aligned',
      'god_override',
      'forced_stop',
    ];

    for (const rationale of testRationales) {
      const messages = [
        { target: 'system_log' as const, content: `Reason: ${rationale}` },
        { target: 'user' as const, content: 'Task complete summary.' },
      ];

      const ctx = makeHandExecutionContext({
        envelopeMessages: messages,
      });

      const results = await executeActions(
        [{ type: 'accept_task', rationale, summary: `accepted via ${rationale}` }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('phase_progress_signal');
      expect(ctx.taskCompleted).toBe(true);

      // Audit entry recorded
      const entries = ctx.auditLogger!.getEntries({ type: 'accept_task' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('KPI: Critical Override Auditability = 100% (NFR-002, AC-10)', () => {
  it('userConfirmation=god_override is tracked in audit', () => {
    const auditLogger = new GodAuditLogger(sessionDir);

    const envelope = makeEnvelope(
      [{ type: 'accept_task', rationale: 'god_override', summary: 'God overrides user confirmation' }],
      {
        authority: {
          userConfirmation: 'god_override',
          reviewerOverride: false,
          acceptAuthority: 'god_override',
        },
        messages: [{ target: 'system_log', content: 'Override reason: deadline pressure' }],
      },
    );

    logEnvelopeDecision(auditLogger, {
      round: 1,
      observations: [makeObs('review_output', 'reviewer')],
      envelope,
      executionResults: [makeObs('phase_progress_signal', 'runtime')],
    });

    const entries = auditLogger.getEntries({ type: 'god_decision' });
    expect(entries).toHaveLength(1);
    const decision = entries[0].decision as Record<string, unknown>;
    expect(decision.overrides).toBeDefined();
    const overrides = decision.overrides as Record<string, unknown>;
    expect(overrides.userConfirmationOverride).toBe(true);
    expect(overrides.userConfirmationOverrideReason).toContain('deadline');
  });

  it('reviewerOverride=true is tracked with original conclusion', () => {
    const auditLogger = new GodAuditLogger(sessionDir);

    const reviewerObs = makeObs('review_output', 'reviewer', {
      rawRef: 'Code has issues. [CHANGES_REQUESTED]',
      summary: 'Changes requested by reviewer',
    });

    const envelope = makeEnvelope(
      [{ type: 'accept_task', rationale: 'god_override', summary: 'Override reviewer' }],
      {
        authority: {
          userConfirmation: 'not_required',
          reviewerOverride: true,
          acceptAuthority: 'god_override',
        },
        messages: [{ target: 'system_log', content: 'Override: issue is cosmetic, not blocking' }],
      },
    );

    logEnvelopeDecision(auditLogger, {
      round: 1,
      observations: [reviewerObs],
      envelope,
      executionResults: [makeObs('phase_progress_signal', 'runtime')],
    });

    const entries = auditLogger.getEntries({ type: 'god_decision' });
    expect(entries).toHaveLength(1);
    const decision = entries[0].decision as Record<string, unknown>;
    const overrides = decision.overrides as Record<string, unknown>;
    expect(overrides.reviewerOverride).toBe(true);
    expect(overrides.reviewerOriginalConclusion).toBe('CHANGES_REQUESTED');
    expect(overrides.reviewerOverrideReason).toContain('cosmetic');
  });

  it('switch_adapter is auditable through Hand executor (returns not-implemented warning)', async () => {
    const ctx = makeHandExecutionContext();
    const switchAction: GodAction = {
      type: 'switch_adapter',
      role: 'god',
      adapter: 'openai-gpt4',
      reason: 'Primary adapter quota exhausted',
    };

    const results = await executeActions([switchAction], ctx);
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain('switch_adapter');
    expect(results[0].summary).toContain('not yet implemented');
    expect(results[0].severity).toBe('warning');
    // adapterConfig stays unchanged since switch is not implemented (empty map)
    expect(ctx.adapterConfig.has('god')).toBe(false);
  });

  it('god_override accept_task without system_log message → violation (D.3 enforcement)', async () => {
    const ctx = makeHandExecutionContext({
      envelopeMessages: [
        // NO system_log message — violation
        { target: 'user', content: 'Done!' },
      ],
    });

    const results = await executeActions(
      [{ type: 'accept_task', rationale: 'god_override', summary: 'Override without reason' }],
      ctx,
    );

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('runtime_invariant_violation');
    expect(results[0].summary).toContain('system_log');
    expect(ctx.taskCompleted).toBe(false); // NOT completed due to violation
  });

  it('forced_stop accept_task without user message → violation', async () => {
    const ctx = makeHandExecutionContext({
      envelopeMessages: [
        // NO user message — violation for forced_stop
        { target: 'system_log', content: 'Stopping due to failures' },
      ],
    });

    const results = await executeActions(
      [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Stop without user summary' }],
      ctx,
    );

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('runtime_invariant_violation');
    expect(results[0].summary).toContain('user-targeted');
    expect(ctx.taskCompleted).toBe(false);
  });
});
